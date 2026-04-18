import os
import subprocess
import time
from datetime import datetime, timedelta
import bcrypt
from flask import Flask, request, jsonify, Response, g
from werkzeug.middleware.proxy_fix import ProxyFix
from flask_cors import CORS
from dotenv import load_dotenv
from sqlalchemy import inspect, text
import requests
import queue
import threading

load_dotenv()

from models import db, User, Project, Build, Session, Team, TeamMember
import pipeline

app = Flask(__name__)
app.wsgi_app = ProxyFix(app.wsgi_app)
CORS(app, supports_credentials=True)

# Path to local SQLite db
basedir = os.path.abspath(os.path.dirname(__file__))
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///' + os.path.join(basedir, 'cit_deploy.db')
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
# Allow concurrent reads (SSE) and writes (pipeline) without blocking each other.
# timeout=20 means SQLite will retry for 20s before raising "database is locked".
app.config['SQLALCHEMY_ENGINE_OPTIONS'] = {
    'connect_args': {'timeout': 20, 'check_same_thread': False}
}

db.init_app(app)

with app.app_context():
    db.create_all()
    # Enable WAL journal mode — this is the real fix for the SSE/pipeline lock contention.
    # WAL lets readers and writers coexist without blocking each other.
    with db.engine.connect() as conn:
        conn.execute(text("PRAGMA journal_mode=WAL"))
        conn.commit()
    inspector = inspect(db.engine)
    # Re-inspect after create_all so new tables are visible
    inspector = inspect(db.engine)
    existing_cols = [c['name'] for c in inspector.get_columns('projects')]
    if 'dockerfile_path' not in existing_cols:
        with db.engine.connect() as conn:
            conn.execute(text(
                "ALTER TABLE projects ADD COLUMN dockerfile_path VARCHAR(256) NOT NULL DEFAULT 'Dockerfile'"
            ))
            conn.commit()
        print("[migrate] Added dockerfile_path column to projects table")
    if 'internal_port' not in existing_cols:
        with db.engine.connect() as conn:
            conn.execute(text("ALTER TABLE projects ADD COLUMN internal_port INTEGER NOT NULL DEFAULT 5000"))
            conn.commit()
        print("[migrate] Added internal_port column to projects table")
    if 'env_vars' not in existing_cols:
        with db.engine.connect() as conn:
            conn.execute(text("ALTER TABLE projects ADD COLUMN env_vars TEXT NOT NULL DEFAULT '{}'"))
            conn.commit()
        print("[migrate] Added env_vars column to projects table")
    if 'team_id' not in existing_cols:
        with db.engine.connect() as conn:
            conn.execute(text("ALTER TABLE projects ADD COLUMN team_id VARCHAR(36)"))
            conn.commit()
        print("[migrate] Added team_id column to projects table")
    existing_user_cols = [c['name'] for c in inspector.get_columns('users')]
    for col, ddl in [
        ('email', 'VARCHAR(254)'),
        ('password_hash', 'VARCHAR(128)'),
        ('name', 'VARCHAR(100)'),
        ('is_admin', 'BOOLEAN NOT NULL DEFAULT 0'),
    ]:
        if col not in existing_user_cols:
            with db.engine.connect() as conn:
                conn.execute(text(f"ALTER TABLE users ADD COLUMN {col} {ddl}"))
                conn.commit()
            print(f"[migrate] Added {col} column to users table")

# --- Middleware ---

@app.before_request
def load_user():
    g.user = None
    if request.method != 'OPTIONS':
        auth_header = request.headers.get('Authorization')
        if auth_header and auth_header.startswith('Bearer '):
            token = auth_header.split(' ')[1]
            session = Session.query.filter_by(token=token).first()
            if session:
                g.user = User.query.get(session.user_id)

def require_auth(f):
    def wrapper(*args, **kwargs):
        if not g.user:
            return jsonify({'error': 'Unauthorized'}), 401
        return f(*args, **kwargs)
    wrapper.__name__ = f.__name__
    return wrapper

def require_project_owner(f):
    def wrapper(project_id, *args, **kwargs):
        project = Project.query.get(project_id)
        if not project:
            return jsonify({'error': 'Project not found'}), 404
        if g.user.is_admin:
            pass
        elif project.user_id == g.user.id:
            pass
        elif project.team_id and TeamMember.query.filter_by(team_id=project.team_id, user_id=g.user.id).first():
            pass
        else:
            return jsonify({'error': 'Forbidden'}), 403
        return f(project, *args, **kwargs)
    wrapper.__name__ = f.__name__
    return wrapper

def require_admin(f):
    def wrapper(*args, **kwargs):
        if not g.user or not g.user.is_admin:
            return jsonify({'error': 'Forbidden'}), 403
        return f(*args, **kwargs)
    wrapper.__name__ = f.__name__
    return wrapper

# --- Helpers ---

def _user_dict(user):
    return {
        'id': user.id,
        'username': user.username,
        'name': user.name,
        'email': user.email,
        'avatar_url': user.avatar_url,
        'is_admin': user.is_admin,
        'github_connected': user.github_id is not None,
    }

# --- Auth Endpoints ---

@app.route('/auth/github', methods=['POST'])
def auth_github():
    data = request.json
    code = data.get('code')
    
    if not code:
        return jsonify({'error': 'Code is required'}), 400
        
    client_id = os.getenv('GITHUB_CLIENT_ID')
    client_secret = os.getenv('GITHUB_CLIENT_SECRET')
    
    # 1. Exchange code for access token
    token_resp = requests.post(
        'https://github.com/login/oauth/access_token',
        headers={'Accept': 'application/json'},
        data={
            'client_id': client_id,
            'client_secret': client_secret,
            'code': code
        }
    )
    token_json = token_resp.json()
    access_token = token_json.get('access_token')
    
    if not access_token:
        return jsonify({'error': 'Failed to get access token', 'details': token_json}), 400
        
    # 2. Get user info
    user_resp = requests.get(
        'https://api.github.com/user',
        headers={
            'Authorization': f'token {access_token}',
            'Accept': 'application/json'
        }
    )
    user_json = user_resp.json()
    
    if 'id' not in user_json:
        return jsonify({'error': 'Failed to get user info from GitHub'}), 400
        
    # 3. Upsert user — check by github_id first, then by email to link accounts
    github_id = user_json['id']
    username = user_json.get('login', f'user_{github_id}')
    avatar_url = user_json.get('avatar_url', '')
    gh_email = (user_json.get('email') or '').strip().lower() or None

    user = User.query.filter_by(github_id=github_id).first()
    if not user and gh_email:
        user = User.query.filter_by(email=gh_email).first()
    if not user:
        user = User(github_id=github_id, username=username, avatar_url=avatar_url, access_token=access_token)
        db.session.add(user)
    else:
        user.github_id = github_id
        user.username = username
        user.avatar_url = avatar_url
        user.access_token = access_token

    db.session.commit()

    # 4. Create session
    expires_at = datetime.utcnow() + timedelta(days=7)
    session_rcd = Session(user_id=user.id, expires_at=expires_at)
    db.session.add(session_rcd)
    db.session.commit()

    return jsonify({
        'token': session_rcd.token,
        'user': _user_dict(user),
    })

@app.route('/auth/register', methods=['POST'])
def register():
    data = request.json or {}
    name = (data.get('name') or '').strip()
    email = (data.get('email') or '').strip().lower()
    password = data.get('password') or ''

    if not email or not password:
        return jsonify({'error': 'email and password required'}), 400
    if len(password) < 8:
        return jsonify({'error': 'Password must be at least 8 characters'}), 400
    if User.query.filter_by(email=email).first():
        return jsonify({'error': 'Email already registered'}), 409

    username_base = email.split('@')[0]
    username = username_base
    counter = 1
    while User.query.filter_by(username=username).first():
        username = f'{username_base}{counter}'
        counter += 1

    pw_hash = bcrypt.hashpw(password.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')
    user = User(email=email, password_hash=pw_hash, name=name or None, username=username)
    db.session.add(user)
    db.session.commit()

    expires_at = datetime.utcnow() + timedelta(days=7)
    session_rcd = Session(user_id=user.id, expires_at=expires_at)
    db.session.add(session_rcd)
    db.session.commit()

    return jsonify({'token': session_rcd.token, 'user': _user_dict(user)}), 201


@app.route('/auth/login', methods=['POST'])
def login_email():
    data = request.json or {}
    email = (data.get('email') or '').strip().lower()
    password = data.get('password') or ''

    if not email or not password:
        return jsonify({'error': 'email and password required'}), 400

    user = User.query.filter_by(email=email).first()
    if not user:
        return jsonify({'error': 'Invalid email or password'}), 401
    if not user.password_hash:
        return jsonify({'error': 'This account uses GitHub login', 'github_only': True}), 401
    if not bcrypt.checkpw(password.encode('utf-8'), user.password_hash.encode('utf-8')):
        return jsonify({'error': 'Invalid email or password'}), 401

    expires_at = datetime.utcnow() + timedelta(days=7)
    session_rcd = Session(user_id=user.id, expires_at=expires_at)
    db.session.add(session_rcd)
    db.session.commit()

    return jsonify({'token': session_rcd.token, 'user': _user_dict(user)})


@app.route('/auth/logout', methods=['POST'])
@require_auth
def logout():
    auth_header = request.headers.get('Authorization')
    if auth_header:
        token = auth_header.split(' ')[1]
        session = Session.query.filter_by(token=token).first()
        if session:
            db.session.delete(session)
            db.session.commit()
    return jsonify({'success': True})


@app.route('/auth/me', methods=['GET'])
@require_auth
def get_me():
    return jsonify(_user_dict(g.user))


@app.route('/auth/me', methods=['PATCH'])
@require_auth
def update_me():
    data = request.json or {}
    if 'name' in data:
        g.user.name = (data['name'] or '').strip() or None
        db.session.commit()
    return jsonify(_user_dict(g.user))


@app.route('/auth/github/connect', methods=['POST'])
@require_auth
def connect_github():
    data = request.json or {}
    code = data.get('code')
    if not code:
        return jsonify({'error': 'code required'}), 400

    client_id = os.getenv('GITHUB_CLIENT_ID')
    client_secret = os.getenv('GITHUB_CLIENT_SECRET')

    token_resp = requests.post(
        'https://github.com/login/oauth/access_token',
        headers={'Accept': 'application/json'},
        data={'client_id': client_id, 'client_secret': client_secret, 'code': code},
    )
    access_token = token_resp.json().get('access_token')
    if not access_token:
        return jsonify({'error': 'Failed to get access token from GitHub'}), 400

    user_resp = requests.get(
        'https://api.github.com/user',
        headers={'Authorization': f'token {access_token}', 'Accept': 'application/json'},
    )
    user_json = user_resp.json()
    if 'id' not in user_json:
        return jsonify({'error': 'Failed to get user info from GitHub'}), 400

    github_id = user_json['id']
    existing = User.query.filter_by(github_id=github_id).first()
    if existing and existing.id != g.user.id:
        return jsonify({'error': 'This GitHub account is already linked to another user'}), 409

    g.user.github_id = github_id
    g.user.access_token = access_token
    g.user.avatar_url = user_json.get('avatar_url', g.user.avatar_url)
    if not g.user.username or g.user.username == g.user.email.split('@')[0] if g.user.email else False:
        g.user.username = user_json.get('login', g.user.username)
    db.session.commit()
    return jsonify(_user_dict(g.user))


@app.route('/auth/github/connect', methods=['DELETE'])
@require_auth
def disconnect_github():
    if not g.user.password_hash:
        return jsonify({'error': 'Cannot disconnect GitHub: no password set on this account'}), 400
    g.user.github_id = None
    g.user.access_token = None
    db.session.commit()
    return jsonify(_user_dict(g.user))

# --- Project Management Ends ---

@app.route('/projects', methods=['GET'])
@require_auth
def get_projects():
    team_ids = [m.team_id for m in TeamMember.query.filter_by(user_id=g.user.id).all()]
    if team_ids:
        projects = Project.query.filter(
            db.or_(Project.user_id == g.user.id, Project.team_id.in_(team_ids))
        ).order_by(Project.created_at.desc()).all()
    else:
        projects = Project.query.filter_by(user_id=g.user.id).order_by(Project.created_at.desc()).all()
    return jsonify([{
        'id': p.id,
        'name': p.name,
        'repo_url': p.repo_url,
        'port': p.port,
        'status': p.status,
        'created_at': p.created_at.isoformat(),
        'user_id': p.user_id,
        'team_id': p.team_id,
        'team_name': p.team.name if p.team_id and p.team else None,
    } for p in projects])

@app.route('/projects', methods=['POST'])
@require_auth
def create_project():
    import json as _json
    data = request.json
    name = data.get('name')
    repo_url = data.get('repo_url')

    if not name or not repo_url:
        return jsonify({'error': 'name and repo_url required'}), 400

    team_id = data.get('team_id') or None
    if team_id:
        if not Team.query.get(team_id):
            return jsonify({'error': 'Team not found'}), 404
        if not g.user.is_admin and not TeamMember.query.filter_by(team_id=team_id, user_id=g.user.id).first():
            return jsonify({'error': 'You are not a member of that team'}), 403

    dockerfile_path = (data.get('dockerfile_path') or 'Dockerfile').strip() or 'Dockerfile'

    raw_internal_port = data.get('internal_port')
    try:
        internal_port = int(raw_internal_port) if raw_internal_port else 5000
    except (ValueError, TypeError):
        internal_port = 5000

    raw_env = data.get('env_vars') or {}
    if isinstance(raw_env, dict):
        env_vars_str = _json.dumps({str(k).strip(): str(v) for k, v in raw_env.items() if str(k).strip()})
    else:
        env_vars_str = '{}'

    # Assign external port (auto-increment from 5000)
    max_port_proj = Project.query.order_by(Project.port.desc()).first()
    port = max_port_proj.port + 1 if max_port_proj and max_port_proj.port >= 5000 else 5000

    project = Project(
        user_id=g.user.id,
        team_id=team_id,
        name=name,
        repo_url=repo_url,
        port=port,
        dockerfile_path=dockerfile_path,
        internal_port=internal_port,
        env_vars=env_vars_str,
    )
    db.session.add(project)
    db.session.commit()

    pipeline.trigger_deploy(project.id)

    return jsonify({
        'id': project.id,
        'name': project.name,
        'port': project.port,
        'status': project.status,
        'dockerfile_path': project.dockerfile_path,
        'internal_port': project.internal_port,
        'env_vars': project.env_vars,
    }), 201

@app.route('/projects/<project_id>', methods=['GET'])
@require_auth
@require_project_owner
def get_project(project):
    return jsonify({
        'id': project.id,
        'name': project.name,
        'repo_url': project.repo_url,
        'port': project.port,
        'status': project.status,
        'container_id': project.container_id,
        'dockerfile_path': project.dockerfile_path or 'Dockerfile',
        'internal_port': project.internal_port or 5000,
        'env_vars': project.env_vars or '{}',
        'created_at': project.created_at.isoformat(),
        'user_id': project.user_id,
        'team_id': project.team_id,
        'team_name': project.team.name if project.team_id and project.team else None,
    })

@app.route('/projects/<project_id>', methods=['PATCH'])
@require_auth
@require_project_owner
def update_project(project):
    import json as _json
    data = request.json or {}
    if 'name' in data:
        name = data['name'].strip()
        if name:
            project.name = name
    if 'dockerfile_path' in data:
        path = (data['dockerfile_path'] or 'Dockerfile').strip() or 'Dockerfile'
        project.dockerfile_path = path
    if 'internal_port' in data:
        try:
            project.internal_port = int(data['internal_port']) if data['internal_port'] else 5000
        except (ValueError, TypeError):
            project.internal_port = 5000
    if 'env_vars' in data:
        raw_env = data['env_vars']
        if isinstance(raw_env, dict):
            project.env_vars = _json.dumps({str(k).strip(): str(v) for k, v in raw_env.items() if str(k).strip()})
        else:
            project.env_vars = '{}'
    db.session.commit()
    return jsonify({
        'id': project.id,
        'name': project.name,
        'dockerfile_path': project.dockerfile_path,
        'internal_port': project.internal_port or 5000,
        'env_vars': project.env_vars or '{}',
    })

@app.route('/projects/<project_id>', methods=['DELETE'])
@require_auth
@require_project_owner
def delete_project(project):
    pipeline.stop_container(project.id)
    # the container removal in docker would need to be done cleanly. For now just delete record
    db.session.delete(project)
    db.session.commit()
    return jsonify({'success': True})

# --- Deployment / Controls ---

@app.route('/projects/<project_id>/deploy', methods=['POST'])
@require_auth
@require_project_owner
def deploy_project(project):
    build_id = pipeline.trigger_deploy(project.id)
    if build_id is None:
        return jsonify({'error': 'A deploy is already in progress for this project'}), 409
    return jsonify({'success': True, 'build_id': build_id}), 202

@app.route('/projects/<project_id>/stop', methods=['POST'])
@require_auth
@require_project_owner
def stop_project(project):
    pipeline.stop_container(project.id)
    return jsonify({'success': True})

@app.route('/projects/<project_id>/restart', methods=['POST'])
@require_auth
@require_project_owner
def restart_project(project):
    pipeline.restart_container(project.id)
    return jsonify({'success': True})

@app.route('/projects/<project_id>/status', methods=['GET'])
@require_auth
@require_project_owner
def project_status(project):
    return jsonify({'status': project.status})

@app.route('/projects/<project_id>/builds', methods=['GET'])
@require_auth
@require_project_owner
def project_builds(project):
    builds = Build.query.filter_by(project_id=project.id).order_by(Build.started_at.desc()).all()
    return jsonify([{
        'id': b.id,
        'status': b.status,
        'started_at': b.started_at.isoformat(),
        'finished_at': b.finished_at.isoformat() if b.finished_at else None
    } for b in builds])

# --- Log Streaming (SSE) ---

@app.route('/projects/<project_id>/logs', methods=['GET'])
def stream_logs(project_id):
    # For SSE, it's difficult to send auth headers from browser EventSource cleanly
    # so we'll pass token as query param
    token = request.args.get('token')
    if not token:
        return jsonify({'error': 'Unauthorized'}), 401
    session = Session.query.filter_by(token=token).first()
    if not session:
        return jsonify({'error': 'Unauthorized'}), 401
    user = User.query.get(session.user_id)
    
    project = Project.query.get(project_id)
    if not project:
        return jsonify({'error': 'Forbidden'}), 403
    is_team_member = project.team_id and TeamMember.query.filter_by(team_id=project.team_id, user_id=user.id).first()
    if not (user.is_admin or project.user_id == user.id or is_team_member):
        return jsonify({'error': 'Forbidden'}), 403

    def generate():
        # Get the latest build
        with app.app_context():
            build = Build.query.filter_by(project_id=project.id).order_by(Build.started_at.desc()).first()
            if not build:
                yield "data: No builds found\n\n"
                return
            
            build_id = build.id
            last_len = 0
            
            # Send an initial connection burst
            yield "data: Connected to log stream\n\n"
            
            while True:
                db.session.expire_all()
                b = db.session.get(Build, build_id)
                if not b:
                    break
                    
                if len(b.logs) > last_len:
                    new_logs = b.logs[last_len:]
                    # SSE formats by splitting on newlines
                    for line in new_logs.split('\n'):
                        if line: # avoid empty double newlines
                            yield f"data: {line}\n\n"
                    last_len = len(b.logs)
                
                if b.status in ['success', 'failed', 'errored']:
                    # Final burst just in case
                    if len(b.logs) > last_len:
                        new_logs = b.logs[last_len:]
                        for line in new_logs.split('\n'):
                            if line:
                                yield f"data: {line}\n\n"
                    yield "event: done\ndata: Build Finished.\n\n"
                    break
                    
                time.sleep(1)

    return Response(generate(), mimetype='text/event-stream')

@app.route('/projects/<project_id>/runtime-logs', methods=['GET'])
def stream_runtime_logs(project_id):
    token = request.args.get('token')
    if not token:
        return jsonify({'error': 'Unauthorized'}), 401
    session = Session.query.filter_by(token=token).first()
    if not session:
        return jsonify({'error': 'Unauthorized'}), 401
    user = User.query.get(session.user_id)

    project = Project.query.get(project_id)
    if not project:
        return jsonify({'error': 'Forbidden'}), 403
    is_team_member = project.team_id and TeamMember.query.filter_by(team_id=project.team_id, user_id=user.id).first()
    if not (user.is_admin or project.user_id == user.id or is_team_member):
        return jsonify({'error': 'Forbidden'}), 403

    project_name = f"cit-deploy-{project.id[:8]}"

    def generate():
        inspect_result = subprocess.run(
            ["docker", "inspect", "--format", "{{.State.Running}}", project_name],
            capture_output=True, text=True
        )
        if inspect_result.returncode != 0 or inspect_result.stdout.strip() != 'true':
            yield "data: Container is not currently running.\n\n"
            yield "event: done\ndata: \n\n"
            return

        yield "data: Connected to runtime logs\n\n"

        process = subprocess.Popen(
            ["docker", "logs", "--follow", "--tail", "100", project_name],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            encoding='utf-8',
            errors='replace'
        )
        try:
            for line in process.stdout:
                line = line.rstrip('\n')
                if line:
                    yield f"data: {line}\n\n"
        except GeneratorExit:
            process.kill()
            return
        finally:
            process.wait()

        yield "event: done\ndata: Container stopped.\n\n"

    return Response(generate(), mimetype='text/event-stream')


# --- Team Endpoints ---

def _team_dict(team, my_role=None):
    return {
        'id': team.id,
        'name': team.name,
        'created_by': team.created_by,
        'created_at': team.created_at.isoformat(),
        'member_count': len(team.members),
        'my_role': my_role,
    }

def _member_dict(member):
    user = User.query.get(member.user_id)
    return {
        'id': member.id,
        'user_id': member.user_id,
        'username': user.username if user else None,
        'name': user.name if user else None,
        'avatar_url': user.avatar_url if user else None,
        'role': member.role,
        'joined_at': member.joined_at.isoformat(),
    }


@app.route('/teams', methods=['GET'])
@require_auth
def get_teams():
    memberships = TeamMember.query.filter_by(user_id=g.user.id).all()
    result = []
    for m in memberships:
        team = Team.query.get(m.team_id)
        if team:
            d = _team_dict(team, my_role=m.role)
            result.append(d)
    return jsonify(result)


@app.route('/teams', methods=['POST'])
@require_auth
def create_team():
    data = request.json or {}
    name = (data.get('name') or '').strip()
    if not name:
        return jsonify({'error': 'name required'}), 400
    team = Team(name=name, created_by=g.user.id)
    db.session.add(team)
    db.session.flush()
    member = TeamMember(team_id=team.id, user_id=g.user.id, role='admin')
    db.session.add(member)
    db.session.commit()
    return jsonify(_team_dict(team, my_role='admin')), 201


@app.route('/teams/<team_id>', methods=['GET'])
@require_auth
def get_team(team_id):
    team = Team.query.get(team_id)
    if not team:
        return jsonify({'error': 'Team not found'}), 404
    membership = TeamMember.query.filter_by(team_id=team_id, user_id=g.user.id).first()
    if not membership and not g.user.is_admin:
        return jsonify({'error': 'Forbidden'}), 403
    d = _team_dict(team, my_role=membership.role if membership else None)
    d['members'] = [_member_dict(m) for m in team.members]
    d['projects'] = [{
        'id': p.id,
        'name': p.name,
        'status': p.status,
        'port': p.port,
        'created_at': p.created_at.isoformat(),
    } for p in team.projects]
    return jsonify(d)


@app.route('/teams/<team_id>', methods=['DELETE'])
@require_auth
def delete_team(team_id):
    team = Team.query.get(team_id)
    if not team:
        return jsonify({'error': 'Team not found'}), 404
    membership = TeamMember.query.filter_by(team_id=team_id, user_id=g.user.id).first()
    if not g.user.is_admin and (not membership or membership.role != 'admin'):
        return jsonify({'error': 'Forbidden'}), 403
    db.session.delete(team)
    db.session.commit()
    return jsonify({'success': True})


@app.route('/teams/<team_id>/members', methods=['GET'])
@require_auth
def get_team_members(team_id):
    team = Team.query.get(team_id)
    if not team:
        return jsonify({'error': 'Team not found'}), 404
    membership = TeamMember.query.filter_by(team_id=team_id, user_id=g.user.id).first()
    if not membership and not g.user.is_admin:
        return jsonify({'error': 'Forbidden'}), 403
    return jsonify([_member_dict(m) for m in team.members])


@app.route('/teams/<team_id>/members', methods=['POST'])
@require_auth
def add_team_member(team_id):
    team = Team.query.get(team_id)
    if not team:
        return jsonify({'error': 'Team not found'}), 404
    membership = TeamMember.query.filter_by(team_id=team_id, user_id=g.user.id).first()
    if not g.user.is_admin and (not membership or membership.role != 'admin'):
        return jsonify({'error': 'Forbidden'}), 403
    data = request.json or {}
    user_id = data.get('user_id')
    role = data.get('role', 'member')
    if role not in ('admin', 'member'):
        role = 'member'
    if not user_id:
        return jsonify({'error': 'user_id required'}), 400
    if not User.query.get(user_id):
        return jsonify({'error': 'User not found'}), 404
    existing = TeamMember.query.filter_by(team_id=team_id, user_id=user_id).first()
    if existing:
        return jsonify({'error': 'User is already a member'}), 409
    new_member = TeamMember(team_id=team_id, user_id=user_id, role=role)
    db.session.add(new_member)
    db.session.commit()
    return jsonify(_member_dict(new_member)), 201


@app.route('/teams/<team_id>/members/<user_id>', methods=['DELETE'])
@require_auth
def remove_team_member(team_id, user_id):
    team = Team.query.get(team_id)
    if not team:
        return jsonify({'error': 'Team not found'}), 404
    membership = TeamMember.query.filter_by(team_id=team_id, user_id=g.user.id).first()
    is_team_admin = membership and membership.role == 'admin'
    is_self = g.user.id == user_id
    if not g.user.is_admin and not is_team_admin and not is_self:
        return jsonify({'error': 'Forbidden'}), 403
    target = TeamMember.query.filter_by(team_id=team_id, user_id=user_id).first()
    if not target:
        return jsonify({'error': 'Member not found'}), 404
    db.session.delete(target)
    db.session.commit()
    return jsonify({'success': True})


@app.route('/users/search', methods=['GET'])
@require_auth
def search_users():
    # Only team admins (on any team) or site admins can search
    is_any_team_admin = TeamMember.query.filter_by(user_id=g.user.id, role='admin').first()
    if not g.user.is_admin and not is_any_team_admin:
        return jsonify({'error': 'Forbidden'}), 403
    q = (request.args.get('q') or '').strip()
    if not q:
        return jsonify([])
    pattern = f'%{q}%'
    users = User.query.filter(
        db.or_(User.username.ilike(pattern), User.name.ilike(pattern))
    ).limit(20).all()
    return jsonify([{
        'id': u.id,
        'username': u.username,
        'name': u.name,
        'avatar_url': u.avatar_url,
    } for u in users])


if __name__ == '__main__':
    app.run(port=8000, debug=True)
