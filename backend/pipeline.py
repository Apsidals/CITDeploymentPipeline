import os
import subprocess
import threading
import shutil
import time
from datetime import datetime
from models import db, Build, Project

DEPLOYMENTS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "deployments"))
BUILD_TIMEOUT = 300  # 5 minutes

# Per-project deploy locks — prevents concurrent deploys on the same project
_deploy_locks: dict = {}
_locks_mutex = threading.Lock()

# Tracks the currently-running Popen per project so the timeout can kill it
_active_procs: dict = {}


def _get_lock(project_id: str) -> threading.Lock:
    with _locks_mutex:
        if project_id not in _deploy_locks:
            _deploy_locks[project_id] = threading.Lock()
        return _deploy_locks[project_id]


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


def run_cmd_with_logging(cmd, build_id, cwd=None, project_id=None):
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

        if project_id:
            _active_procs[project_id] = process

        for line in process.stdout:
            append_log(build_id, line)

        process.wait()

        if project_id:
            _active_procs.pop(project_id, None)

        if process.returncode not in (0, -9, -15):  # allow killed-by-signal
            append_log(build_id, f"\n[ERROR] Command failed with exit code {process.returncode}\n")
            return False

        if process.returncode in (-9, -15):
            return False  # killed by timeout

        return True

    except Exception as e:
        append_log(build_id, f"\n[ERROR] Exception executing command: {e}\n")
        if project_id:
            _active_procs.pop(project_id, None)
        return False


def deploy_project_task(project_id, build_id, lock: threading.Lock):
    app = get_app()
    with app.app_context():
        project = db.session.get(Project, project_id)
        build = db.session.get(Build, build_id)

        if not project or not build:
            lock.release()
            return

        build.status = 'building'
        project.status = 'building'
        db.session.commit()

        project_name = f"cit-deploy-{project.id[:8]}"
        project_dir = os.path.join(DEPLOYMENTS_DIR, project_name)

        # Timeout machinery
        timed_out = threading.Event()

        def _on_timeout():
            timed_out.set()
            proc = _active_procs.get(project_id)
            if proc:
                try:
                    proc.kill()
                except Exception:
                    pass

        timer = threading.Timer(BUILD_TIMEOUT, _on_timeout)
        timer.start()

        try:
            append_log(build_id, "--- Starting Deploy Pipeline ---\n")
            append_log(build_id, f"Stopping existing container '{project_name}' if running...\n")
            subprocess.run(["docker", "rm", "-f", project_name], capture_output=True)

            os.makedirs(DEPLOYMENTS_DIR, exist_ok=True)

            # ── Step 1: Clone or pull ─────────────────────────────────────
            if os.path.exists(os.path.join(project_dir, ".git")):
                append_log(build_id, "\n[Step 1/4] Pulling latest changes...\n")
                success = run_cmd_with_logging(
                    ["git", "-C", project_dir, "fetch", "--all"],
                    build_id, project_id=project_id
                )
                if success:
                    success = run_cmd_with_logging(
                        ["git", "-C", project_dir, "reset", "--hard", "origin/HEAD"],
                        build_id, project_id=project_id
                    )
            else:
                if os.path.exists(project_dir):
                    append_log(build_id, "Cleaning up incomplete directory...\n")

                    def on_rm_error(func, path, exc_info):
                        os.chmod(path, 0o777)
                        os.unlink(path)

                    shutil.rmtree(project_dir, onerror=on_rm_error)

                append_log(build_id, "\n[Step 1/4] Cloning repository...\n")
                success = run_cmd_with_logging(
                    ["git", "clone", project.repo_url, project_dir],
                    build_id, project_id=project_id
                )
            if timed_out.is_set():
                raise Exception("Build timed out after 5 minutes")
            if not success:
                raise Exception("git clone failed — check the repo URL and make sure it's public")

            # ── Dockerfile validation ──────────────────────────────────────
            raw_path = (project.dockerfile_path or 'Dockerfile').strip() or 'Dockerfile'
            normalized_df = os.path.normpath(raw_path)
            if os.path.isabs(normalized_df) or normalized_df.startswith('..'):
                raise Exception(f"Invalid dockerfile_path '{raw_path}' — must be a relative path within the repo")

            dockerfile_abs = os.path.join(project_dir, normalized_df)
            if not os.path.exists(dockerfile_abs):
                raise Exception(
                    f"No Dockerfile found at '{normalized_df}'. "
                    "Add a Dockerfile to your repo or update the Dockerfile path in project settings."
                )

            append_log(build_id, f"[✓] Dockerfile found at '{normalized_df}'\n")

            # ── Step 2: Build ──────────────────────────────────────────────
            append_log(build_id, "\n[Step 2/4] Building Docker image...\n")
            success = run_cmd_with_logging(
                ["docker", "build", "--progress=plain", "-t", project_name, "-f", normalized_df, "."],
                build_id, cwd=project_dir, project_id=project_id
            )
            if timed_out.is_set():
                raise Exception("Build timed out after 5 minutes")
            if not success:
                raise Exception("docker build failed — check the Dockerfile and build output above")

            # ── Step 3: Run ────────────────────────────────────────────────
            append_log(build_id, f"\n[Step 3/4] Starting container on port {project.port}...\n")
            run_args = [
                "docker", "run", "-d",
                "--name", project_name,
                "-p", f"{project.port}:5000",
                "--memory", "512m",
                "--cpus", "0.5",
                project_name
            ]
            success = run_cmd_with_logging(run_args, build_id, project_id=project_id)
            if timed_out.is_set():
                raise Exception("Build timed out after 5 minutes")
            if not success:
                raise Exception("docker run failed — see output above")

            # ── Step 4: Health check ───────────────────────────────────────
            append_log(build_id, "\n[Step 4/4] Health check (waiting 3s)...\n")
            time.sleep(3)

            if timed_out.is_set():
                raise Exception("Build timed out after 5 minutes")

            inspect_result = subprocess.run(
                ["docker", "inspect", "--format",
                 "{{.State.Running}} {{.State.ExitCode}}", project_name],
                capture_output=True, text=True
            )
            if inspect_result.returncode != 0:
                raise Exception("Container disappeared immediately after start — docker inspect failed")

            parts = inspect_result.stdout.strip().split()
            is_running = len(parts) > 0 and parts[0] == 'true'
            exit_code = parts[1] if len(parts) > 1 else '?'

            if not is_running:
                log_result = subprocess.run(
                    ["docker", "logs", "--tail", "30", project_name],
                    capture_output=True, text=True
                )
                crash_output = (log_result.stdout + log_result.stderr).strip()
                if crash_output:
                    append_log(build_id, f"\n--- Container output before crash ---\n{crash_output}\n")
                raise Exception(
                    f"Container exited immediately (exit code {exit_code}). "
                    "Check the logs above for the crash reason."
                )

            # ── Success ────────────────────────────────────────────────────
            result = subprocess.run(
                ["docker", "ps", "-q", "-f", f"name={project_name}"],
                capture_output=True, text=True
            )
            container_id = result.stdout.strip()

            project.container_id = container_id
            project.status = 'running'
            build.status = 'success'
            build.finished_at = datetime.utcnow()
            db.session.commit()

            append_log(build_id, f"\n[✓] Deployed successfully — container {container_id[:12]} on port {project.port}\n")

            # ── Cleanup ────────────────────────────────────────────────────
            append_log(build_id, "\n[Cleanup] Pruning dangling Docker images...\n")
            subprocess.run(["docker", "image", "prune", "-f"], capture_output=True)
            append_log(build_id, "[✓] Cleanup done\n")

        except Exception as e:
            if timed_out.is_set():
                append_log(build_id, f"\n[TIMEOUT] Build exceeded {BUILD_TIMEOUT}s limit and was killed\n")
            else:
                append_log(build_id, f"\n[FAILED] {e}\n")
            project.status = 'errored'
            build.status = 'failed'
            build.finished_at = datetime.utcnow()
            db.session.commit()

        finally:
            timer.cancel()
            _active_procs.pop(project_id, None)
            lock.release()


def trigger_deploy(project_id):
    lock = _get_lock(project_id)
    if not lock.acquire(blocking=False):
        return None  # deploy already in progress

    app = get_app()
    with app.app_context():
        project = db.session.get(Project, project_id)
        build = Build(project_id=project.id)
        db.session.add(build)
        db.session.commit()

        t = threading.Thread(target=deploy_project_task, args=(project.id, build.id, lock))
        t.daemon = True
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
