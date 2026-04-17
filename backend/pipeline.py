import os
import subprocess
import threading
import shutil
from datetime import datetime
from models import db, Build, Project

DEPLOYMENTS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "deployments"))

def get_app():
    from app import app
    return app

def append_log(build_id, text):
    app = get_app()
    with app.app_context():
        build = db.session.get(Build, build_id)
        if build:
            build.logs += text
            db.session.commit()

def run_cmd_with_logging(cmd, build_id, cwd=None):
    append_log(build_id, f">>> Running: {' '.join(cmd)}\n")
    try:
        process = subprocess.Popen(
            cmd,
            cwd=cwd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            encoding='utf-8',
            errors='replace'
        )
        
        for line in process.stdout:
            append_log(build_id, line)
            
        process.wait()
        
        if process.returncode != 0:
            append_log(build_id, f"\n[ERROR] Command failed with exit code {process.returncode}\n")
            return False
            
        return True
        
    except Exception as e:
        append_log(build_id, f"\n[ERROR] Exception executing command: {e}\n")
        return False

def deploy_project_task(project_id, build_id):
    app = get_app()
    with app.app_context():
        project = db.session.get(Project, project_id)
        build = db.session.get(Build, build_id)
        
        if not project or not build:
            return
            
        build.status = 'building'
        project.status = 'building'
        db.session.commit()
        
        project_name = f"cit-deploy-{project.id[:8]}"
        project_dir = os.path.join(DEPLOYMENTS_DIR, project_name)
        
        append_log(build_id, "--- Starting Deploy Pipeline ---\n")
        append_log(build_id, f"Stopping existing container {project_name} if exists...\n")
        subprocess.run(["docker", "rm", "-f", project_name], capture_output=True)

        if not os.path.exists(DEPLOYMENTS_DIR):
            os.makedirs(DEPLOYMENTS_DIR)

        if os.path.exists(project_dir):
            append_log(build_id, f"Cleaning up existing directory {project_dir}...\n")
            def on_rm_error(func, path, exc_info):
                os.chmod(path, 0o777)
                os.unlink(path)
            shutil.rmtree(project_dir, onerror=on_rm_error)

        # 1. Clone repo
        append_log(build_id, "\n[Step 1] Cloning repository...\n")
        success = run_cmd_with_logging(["git", "clone", project.repo_url, project_dir], build_id)
        if not success:
            build.status = 'failed'
            project.status = 'errored'
            build.finished_at = datetime.utcnow()
            db.session.commit()
            return

        # 2. Build Docker Image
        append_log(build_id, "\n[Step 2] Building Docker image...\n")
        success = run_cmd_with_logging(["docker", "build", "-t", project_name, "."], build_id, cwd=project_dir)
        if not success:
            build.status = 'failed'
            project.status = 'errored'
            build.finished_at = datetime.utcnow()
            db.session.commit()
            return

        # 3. Run Docker Container
        append_log(build_id, f"\n[Step 3] Running container '{project_name}' on port {project.port}...\n")
        # Assume dockerfile exposes a port or webserver runs. Mapping inner port 5000 in phase 1.
        run_args = [
            "docker", "run", "-d",
            "--name", project_name,
            "-p", f"{project.port}:5000",
            "--memory", "512m",
            "--cpus", "0.5",
            project_name
        ]
        
        success = run_cmd_with_logging(run_args, build_id)
        if not success:
            build.status = 'failed'
            project.status = 'errored'
            build.finished_at = datetime.utcnow()
            db.session.commit()
            return

        # Get container ID
        result = subprocess.run(["docker", "ps", "-q", "-f", f"name={project_name}"], capture_output=True, text=True)
        container_id = result.stdout.strip()
        
        append_log(build_id, f"\n[SUCCESS] Container started with ID {container_id}\n")
        
        project.container_id = container_id
        project.status = 'running'
        build.status = 'success'
        build.finished_at = datetime.utcnow()
        db.session.commit()

def trigger_deploy(project_id):
    app = get_app()
    with app.app_context():
        project = db.session.get(Project, project_id)
        build = Build(project_id=project.id)
        db.session.add(build)
        db.session.commit()
        
        t = threading.Thread(target=deploy_project_task, args=(project.id, build.id))
        t.start()
        return build.id

def stop_container(project_id):
    app = get_app()
    with app.app_context():
        project = db.session.get(Project, project_id)
        if project:
            project_name = f"cit-deploy-{project.id[:8]}"
            subprocess.run(["docker", "stop", project_name], capture_output=True)
            project.status = 'stopped'
            db.session.commit()

def restart_container(project_id):
    app = get_app()
    with app.app_context():
        project = db.session.get(Project, project_id)
        if project:
            project_name = f"cit-deploy-{project.id[:8]}"
            res = subprocess.run(["docker", "restart", project_name], capture_output=True)
            if res.returncode == 0:
                project.status = 'running'
            else:
                project.status = 'errored'
            db.session.commit()
