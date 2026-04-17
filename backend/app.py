import os
import time
from datetime import datetime
from flask import Flask, request, jsonify, Response, g
from werkzeug.middleware.proxy_fix import ProxyFix
from flask_cors import CORS
from dotenv import load_dotenv
from sqlalchemy import inspect, text
import requests
import queue
import threading

load_dotenv()

from models import db, User, Project, Build, Session
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
    # One-time migration: add dockerfile_path column to existing databases
    inspector = inspect(db.engine)
    existing_cols = [c['name'] for c in inspector.get_columns('projects')]
    if 'dockerfile_path' not in existing_cols:
        with db.engine.connect() as conn:
            conn.execute(text(
                "ALTER TABLE projects ADD COLUMN dockerfile_path VARCHAR(256) NOT NULL DEFAULT 'Dockerfile'"
            ))
            conn.commit()
        print("[migrate] Added dockerfile_path column to projects table")

# --- Middleware ---

@app.before_request
def load_user():
    g.user = None
    if request.method != 'OPTIONS' and not request.path.startswith('/auth/'):
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
        if project.user_id != g.user.id:
            return jsonify({'error': 'Forbidden'}), 403
        return f(project, *args, **kwargs)
    wrapper.__name__ = f.__name__
    return wrapper

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
        
    # 3. Upsert user
    github_id = user_json['id']
    username = user_json.get('login', f'user_{github_id}')
    avatar_url = user_json.get('avatar_url', '')
    
    user = User.query.filter_by(github_id=github_id).first()
    if not user:
        user = User(github_id=github_id, username=username, avatar_url=avatar_url, access_token=access_token)
        db.session.add(user)
    else:
        user.username = username
        user.avatar_url = avatar_url
        user.access_token = access_token
        
    db.session.commit()
    
    # 4. Create session
    import datetime
    expires_at = datetime.datetime.utcnow() + datetime.timedelta(days=7)
    session_rcd = Session(user_id=user.id, expires_at=expires_at)
    db.session.add(session_rcd)
    db.session.commit()
    
    return jsonify({
        'token': session_rcd.token,
        'user': {
            'id': user.id,
            'username': user.username,
            'avatar_url': user.avatar_url
        }
    })

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
    return jsonify({
        'id': g.user.id,
        'username': g.user.username,
        'avatar_url': g.user.avatar_url
    })

# --- Project Management Ends ---

@app.route('/projects', methods=['GET'])
@require_auth
def get_projects():
    projects = Project.query.filter_by(user_id=g.user.id).order_by(Project.created_at.desc()).all()
    return jsonify([{
        'id': p.id,
        'name': p.name,
        'repo_url': p.repo_url,
        'port': p.port,
        'status': p.status,
        'created_at': p.created_at.isoformat()
    } for p in projects])

@app.route('/projects', methods=['POST'])
@require_auth
def create_project():
    data = request.json
    name = data.get('name')
    repo_url = data.get('repo_url')
    
    if not name or not repo_url:
        return jsonify({'error': 'name and repo_url required'}), 400

    dockerfile_path = (data.get('dockerfile_path') or 'Dockerfile').strip() or 'Dockerfile'

    # Assign port (simple autoincrement from 5000)
    max_port_proj = Project.query.order_by(Project.port.desc()).first()
    port = max_port_proj.port + 1 if max_port_proj and max_port_proj.port >= 5000 else 5000

    project = Project(
        user_id=g.user.id,
        name=name,
        repo_url=repo_url,
        port=port,
        dockerfile_path=dockerfile_path
    )
    db.session.add(project)
    db.session.commit()

    # Trigger first deploy (lock can't be held on a brand-new project)
    pipeline.trigger_deploy(project.id)

    return jsonify({
        'id': project.id,
        'name': project.name,
        'port': project.port,
        'status': project.status,
        'dockerfile_path': project.dockerfile_path
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
        'created_at': project.created_at.isoformat()
    })

@app.route('/projects/<project_id>', methods=['PATCH'])
@require_auth
@require_project_owner
def update_project(project):
    data = request.json or {}
    if 'name' in data:
        name = data['name'].strip()
        if name:
            project.name = name
    if 'dockerfile_path' in data:
        path = (data['dockerfile_path'] or 'Dockerfile').strip() or 'Dockerfile'
        project.dockerfile_path = path
    db.session.commit()
    return jsonify({
        'id': project.id,
        'name': project.name,
        'dockerfile_path': project.dockerfile_path
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
    if not project or project.user_id != user.id:
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

if __name__ == '__main__':
    app.run(port=8000, debug=True)
