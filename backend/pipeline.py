import json
import os
import subprocess
import threading
import shutil
import time
from datetime import datetime
from models import db, Build, Project

DEPLOYMENTS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "deployments"))
BUILD_TIMEOUT = 300  # 5 minutes

COMPOSE_FILES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']

PORT_START = 5000
PORT_END   = 5999

_deploy_locks: dict = {}
_locks_mutex = threading.Lock()
_active_procs: dict = {}
_port_lock   = threading.Lock()


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
        if process.returncode in (-9, -15):
            return False
        if process.returncode != 0:
            append_log(build_id, f"\n[ERROR] Command exited with code {process.returncode}\n")
            return False
        return True
    except Exception as e:
        append_log(build_id, f"\n[ERROR] Exception: {e}\n")
        if project_id:
            _active_procs.pop(project_id, None)
        return False


# ── Compose helpers ────────────────────────────────────────────────────────────

def _detect_compose(project_dir):
    """Return the compose filename found in project_dir, or None."""
    for name in COMPOSE_FILES:
        if os.path.exists(os.path.join(project_dir, name)):
            return name
    return None


def _parse_compose(compose_path):
    """
    Parse a compose file. Returns (service_names, explicit_ports).
    explicit_ports is a list of {service, host_port, container_port}.
    """
    import yaml
    with open(compose_path, 'r', encoding='utf-8') as f:
        data = yaml.safe_load(f) or {}

    services = list((data.get('services') or {}).keys())
    ports = []

    for svc, cfg in (data.get('services') or {}).items():
        for entry in (cfg or {}).get('ports', []):
            try:
                s = str(entry).strip()
                if ':' in s:
                    # Could be "host:container" or "ip:host:container"
                    parts = s.split(':')
                    host_port = int(parts[-2])
                    container_port = int(parts[-1].split('/')[0])
                    ports.append({'service': svc, 'host_port': host_port, 'container_port': container_port})
                # If just a container port ("3000") with random host — skip;
                # we discover it post-startup
            except (ValueError, IndexError, TypeError):
                pass
            if isinstance(entry, dict):
                target = entry.get('target')
                published = entry.get('published')
                if target and published:
                    try:
                        ports.append({'service': svc, 'host_port': int(published), 'container_port': int(target)})
                    except (ValueError, TypeError):
                        pass

    return services, ports


def _get_allocated_docker_ports():
    """Return the set of host port numbers currently bound by any running Docker container."""
    result = subprocess.run(
        ["docker", "ps", "--format", "{{.Ports}}"],
        capture_output=True, text=True
    )
    allocated = set()
    for line in result.stdout.splitlines():
        for segment in line.split(','):
            segment = segment.strip()
            if '->' in segment:
                host_part = segment.split('->')[0]
                port_str = host_part.rsplit(':', 1)[-1]
                try:
                    allocated.add(int(port_str))
                except ValueError:
                    pass
    return allocated


def _assign_and_reserve_compose_ports(project_id, explicit_ports):
    """
    Atomically reserve one host port per explicit port mapping, then persist
    the reservation to the DB before returning.  All N ports are selected and
    committed inside a single _port_lock acquisition so concurrent deploys
    cannot steal ports from each other between grabs.

    Returns a list of remapped {service, host_port, container_port} dicts.
    If explicit_ports is empty, returns [] immediately without locking.
    """
    if not explicit_ports:
        return []

    app = get_app()
    with _port_lock:
        with app.app_context():
            # Collect every port already registered in the DB.
            used_db = set()
            for row in db.session.query(Project.port, Project.id, Project.compose_ports).all():
                used_db.add(row[0])
                if row[1] != project_id:
                    try:
                        for p in json.loads(row[2] or '[]'):
                            used_db.add(p['host_port'])
                    except Exception:
                        pass

            used_docker = _get_allocated_docker_ports()
            used = used_db | used_docker

            # Allocate all N ports in one pass — no re-entering the lock.
            remapped = []
            candidate = PORT_START
            for ep in explicit_ports:
                while candidate in used or candidate in {r['host_port'] for r in remapped}:
                    candidate += 1
                    if candidate > PORT_END:
                        raise Exception(
                            f"Port registry exhausted — no free ports in {PORT_START}–{PORT_END}"
                        )
                remapped.append({
                    'service': ep['service'],
                    'host_port': candidate,
                    'container_port': ep['container_port'],
                })
                candidate += 1

            # Persist the reservation immediately so the next concurrent deploy
            # sees these ports as taken before we even start docker compose up.
            project = db.session.get(Project, project_id)
            project.compose_ports = json.dumps(remapped)
            db.session.commit()

    return remapped


def _patch_compose_ports(project_dir, compose_file, remapped_ports):
    """
    Directly rewrite port bindings in the cloned compose file so Docker sees
    the remapped host ports.  Override files can't do this because Docker Compose
    merges list fields instead of replacing them, which would leave both the
    original and remapped port active simultaneously.
    """
    import yaml
    compose_path = os.path.join(project_dir, compose_file)
    with open(compose_path, 'r', encoding='utf-8') as f:
        data = yaml.safe_load(f) or {}

    # (service, container_port) -> new host_port
    remap = {(rp['service'], rp['container_port']): rp['host_port'] for rp in remapped_ports}

    for svc, cfg in (data.get('services') or {}).items():
        if not cfg or not cfg.get('ports'):
            continue
        new_ports = []
        for entry in cfg['ports']:
            if isinstance(entry, dict):
                target = entry.get('target')
                if target is not None:
                    new_host = remap.get((svc, int(target)))
                    if new_host is not None:
                        entry = dict(entry)
                        entry['published'] = new_host
            else:
                s = str(entry).strip()
                if ':' in s:
                    parts = s.split(':')
                    try:
                        container_port = int(parts[-1].split('/')[0])
                        new_host = remap.get((svc, container_port))
                        if new_host is not None:
                            parts[-2] = str(new_host)
                            entry = ':'.join(parts)
                    except (ValueError, IndexError):
                        pass
            new_ports.append(entry)
        cfg['ports'] = new_ports

    with open(compose_path, 'w', encoding='utf-8') as f:
        yaml.dump(data, f, default_flow_style=False, allow_unicode=True)


def _write_compose_override(project_dir, services):
    """Write docker-compose.override.yml capping every service at 512 MB / 0.5 CPU."""
    lines = ['# Auto-generated by CIT Deploy - do not edit\n', 'services:\n']
    for svc in services:
        lines.append(f'  {svc}:\n')
        lines.append(f'    mem_limit: 512m\n')
        lines.append(f'    cpus: 0.5\n')
    with open(os.path.join(project_dir, 'docker-compose.override.yml'), 'w', encoding='utf-8') as f:
        f.writelines(lines)


def _write_env_file(project_dir, env_dict):
    """Write cit-deploy.env for docker compose --env-file."""
    path = os.path.join(project_dir, 'cit-deploy.env')
    with open(path, 'w') as f:
        for k, v in env_dict.items():
            f.write(f"{k}={v}\n")
    return path


def _check_compose_health(project_name, project_dir, services, build_id):
    """
    Verify each service has at least one running container.
    Returns list of failed service names.
    """
    failed = []
    for svc in services:
        result = subprocess.run(
            ["docker", "compose", "-p", project_name, "ps", "-q", svc],
            capture_output=True, text=True, cwd=project_dir
        )
        container_ids = [l.strip() for l in result.stdout.strip().split('\n') if l.strip()]
        if not container_ids:
            failed.append(svc)
            continue
        inspect = subprocess.run(
            ["docker", "inspect", "--format", "{{.State.Running}}", container_ids[0]],
            capture_output=True, text=True
        )
        if inspect.stdout.strip() != 'true':
            # Grab last logs from crashed service
            log_result = subprocess.run(
                ["docker", "compose", "-p", project_name, "logs", "--tail", "25", svc],
                capture_output=True, text=True, cwd=project_dir
            )
            crash = (log_result.stdout + log_result.stderr).strip()
            if crash:
                append_log(build_id, f"\n--- {svc} output before crash ---\n{crash}\n")
            failed.append(svc)
    return failed


def _discover_ports(project_name, project_dir, services, explicit_ports):
    """
    Return final ports list. Explicit ports are kept as-is.
    For services not in explicit_ports, try docker compose port discovery.
    """
    covered_services = {p['service'] for p in explicit_ports}
    discovered = list(explicit_ports)

    for svc in services:
        if svc in covered_services:
            continue
        # Try to find any published port via docker compose port
        # We need to know the container port first — get it from inspect
        ps_result = subprocess.run(
            ["docker", "compose", "-p", project_name, "ps", "-q", svc],
            capture_output=True, text=True, cwd=project_dir
        )
        container_id = ps_result.stdout.strip().split('\n')[0].strip()
        if not container_id:
            continue
        inspect = subprocess.run(
            ["docker", "inspect", "--format", "{{json .NetworkSettings.Ports}}", container_id],
            capture_output=True, text=True
        )
        try:
            ports_data = json.loads(inspect.stdout.strip())
            for container_spec, bindings in (ports_data or {}).items():
                if bindings:
                    container_port = int(container_spec.split('/')[0])
                    host_port = int(bindings[0]['HostPort'])
                    discovered.append({'service': svc, 'host_port': host_port, 'container_port': container_port})
                    break
        except (json.JSONDecodeError, ValueError, TypeError, KeyError):
            pass

    return discovered


# ── Main deploy task ───────────────────────────────────────────────────────────

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

        timed_out = threading.Event()

        def _on_timeout():
            timed_out.set()
            proc = _active_procs.get(project_id)
            if proc:
                try: proc.kill()
                except Exception: pass

        timer = threading.Timer(BUILD_TIMEOUT, _on_timeout)
        timer.start()

        try:
            append_log(build_id, "--- Starting Deploy Pipeline ---\n")

            # ── Cleanup existing deployment ────────────────────────────────
            append_log(build_id, f"Stopping existing deployment '{project_name}' if running...\n")
            if project.is_compose and os.path.exists(project_dir):
                subprocess.run(
                    ["docker", "compose", "-p", project_name, "down"],
                    capture_output=True, cwd=project_dir
                )
            else:
                subprocess.run(["docker", "rm", "-f", project_name], capture_output=True)

            os.makedirs(DEPLOYMENTS_DIR, exist_ok=True)

            # ── Step 1: Clone or pull ──────────────────────────────────────
            if os.path.exists(os.path.join(project_dir, ".git")):
                append_log(build_id, "\n[Step 1] Pulling latest changes...\n")
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

                append_log(build_id, "\n[Step 1] Cloning repository...\n")
                success = run_cmd_with_logging(
                    ["git", "clone", project.repo_url, project_dir],
                    build_id, project_id=project_id
                )

            if timed_out.is_set():
                raise Exception("Build timed out after 5 minutes")
            if not success:
                raise Exception("git clone/pull failed — check the repo URL and make sure it's public")

            # ── Step 2: Detect compose vs single container ─────────────────
            compose_file = _detect_compose(project_dir)

            env_dict = {}
            try:
                env_dict = json.loads(project.env_vars or '{}')
            except Exception:
                pass

            if compose_file:
                # ════════════════════════════════════════════════════════════
                #  COMPOSE PATH
                # ════════════════════════════════════════════════════════════
                append_log(build_id, f"\n[✓] Compose file detected: {compose_file}\n")

                services, explicit_ports = _parse_compose(os.path.join(project_dir, compose_file))
                append_log(build_id, f"[✓] Services: {', '.join(services)}\n")

                # Atomically reserve host ports for every explicit binding.
                remapped_ports = _assign_and_reserve_compose_ports(project_id, explicit_ports)

                if remapped_ports:
                    for rp in remapped_ports:
                        original = next(
                            (ep['host_port'] for ep in explicit_ports if ep['service'] == rp['service'] and ep['container_port'] == rp['container_port']),
                            rp['container_port']
                        )
                        if original != rp['host_port']:
                            append_log(build_id, f"[port] {rp['service']}: {original}→{rp['host_port']} (remapped to avoid conflict)\n")
                        else:
                            append_log(build_id, f"[port] {rp['service']}: :{rp['host_port']}\n")
                    # Patch ports directly in the cloned compose file — override files
                    # merge lists instead of replacing them, which would leave both the
                    # original and remapped port active and cause a bind conflict.
                    _patch_compose_ports(project_dir, compose_file, remapped_ports)

                # Inject resource limits via override file (scalar values override correctly).
                _write_compose_override(project_dir, services)
                append_log(build_id, f"[✓] Resource limits applied: 512 MB / 0.5 CPU per service\n")

                # Build compose command
                cmd = ["docker", "compose", "-p", project_name]
                if env_dict:
                    _write_env_file(project_dir, env_dict)
                    cmd += ["--env-file", "cit-deploy.env"]
                    append_log(build_id, f"[env] Injecting {len(env_dict)} environment variable(s)\n")
                cmd += ["up", "--build", "-d"]

                append_log(build_id, f"\n[Step 2] Building and starting {len(services)} service(s)...\n")
                success = run_cmd_with_logging(cmd, build_id, cwd=project_dir, project_id=project_id)

                if timed_out.is_set():
                    raise Exception("Build timed out after 5 minutes")
                if not success:
                    raise Exception("docker compose up failed — check the build output above")

                # Health check
                append_log(build_id, "\n[Step 3] Health check (waiting 4s)...\n")
                time.sleep(4)

                if timed_out.is_set():
                    raise Exception("Build timed out after 5 minutes")

                failed_services = _check_compose_health(project_name, project_dir, services, build_id)
                if failed_services:
                    raise Exception(
                        f"Service(s) not running after startup: {', '.join(failed_services)}. "
                        "Check the output above for crash details."
                    )

                # Port discovery — use remapped ports as the authoritative base.
                final_ports = _discover_ports(project_name, project_dir, services, remapped_ports)

                # Update project record
                project.is_compose = True
                project.compose_ports = json.dumps(final_ports)
                if final_ports:
                    project.port = final_ports[0]['host_port']
                project.container_id = project_name  # composite identifier
                project.status = 'running'
                build.status = 'success'
                build.finished_at = datetime.utcnow()
                db.session.commit()

                if final_ports:
                    ports_str = ', '.join([f"{p['service']}→:{p['host_port']}" for p in final_ports])
                    append_log(build_id, f"\n[✓] Stack running — ports: {ports_str}\n")
                else:
                    append_log(build_id, f"\n[✓] Stack running ({len(services)} service(s))\n")

            else:
                # ════════════════════════════════════════════════════════════
                #  SINGLE CONTAINER PATH
                # ════════════════════════════════════════════════════════════
                raw_path = (project.dockerfile_path or 'Dockerfile').strip() or 'Dockerfile'
                normalized_df = os.path.normpath(raw_path)
                if os.path.isabs(normalized_df) or normalized_df.startswith('..'):
                    raise Exception(f"Invalid dockerfile_path '{raw_path}' — must be relative")

                dockerfile_abs = os.path.join(project_dir, normalized_df)
                if not os.path.exists(dockerfile_abs):
                    raise Exception(
                        f"No Dockerfile found at '{normalized_df}' and no compose file detected. "
                        "Add a Dockerfile or docker-compose.yml to your repo."
                    )
                append_log(build_id, f"[✓] Dockerfile found at '{normalized_df}'\n")

                # Build
                append_log(build_id, "\n[Step 2] Building Docker image...\n")
                df_dir = os.path.dirname(normalized_df)
                build_context = os.path.join(project_dir, df_dir) if df_dir else project_dir
                dockerfile_rel = os.path.basename(normalized_df) if df_dir else normalized_df
                success = run_cmd_with_logging(
                    ["docker", "build", "--progress=plain", "-t", project_name, "-f", dockerfile_rel, "."],
                    build_id, cwd=build_context, project_id=project_id
                )
                if timed_out.is_set():
                    raise Exception("Build timed out after 5 minutes")
                if not success:
                    raise Exception("docker build failed — check the Dockerfile and build output above")

                # Run
                internal_port = project.internal_port or 5000
                append_log(build_id, f"\n[Step 3] Starting container (ext:{project.port} → container:{internal_port})...\n")

                if env_dict:
                    append_log(build_id, f"[env] Injecting {len(env_dict)} environment variable(s)\n")

                run_args = [
                    "docker", "run", "-d",
                    "--name", project_name,
                    "-p", f"{project.port}:{internal_port}",
                    "-e", f"PORT={internal_port}",
                    "--memory", "512m",
                    "--cpus", "0.5",
                ]
                for key, value in env_dict.items():
                    run_args += ["-e", f"{key}={value}"]
                run_args.append(project_name)

                success = run_cmd_with_logging(run_args, build_id, project_id=project_id)
                if timed_out.is_set():
                    raise Exception("Build timed out after 5 minutes")
                if not success:
                    raise Exception("docker run failed — see output above")

                # Health check
                append_log(build_id, "\n[Step 4] Health check (waiting 3s)...\n")
                time.sleep(3)

                if timed_out.is_set():
                    raise Exception("Build timed out after 5 minutes")

                inspect_result = subprocess.run(
                    ["docker", "inspect", "--format",
                     "{{.State.Running}} {{.State.ExitCode}}", project_name],
                    capture_output=True, text=True
                )
                if inspect_result.returncode != 0:
                    raise Exception("Container disappeared immediately after start")

                parts = inspect_result.stdout.strip().split()
                is_running = len(parts) > 0 and parts[0] == 'true'
                exit_code = parts[1] if len(parts) > 1 else '?'

                if not is_running:
                    log_result = subprocess.run(
                        ["docker", "logs", "--tail", "30", project_name],
                        capture_output=True, text=True
                    )
                    crash = (log_result.stdout + log_result.stderr).strip()
                    if crash:
                        append_log(build_id, f"\n--- Container output before crash ---\n{crash}\n")
                    raise Exception(
                        f"Container exited immediately (exit code {exit_code}). "
                        "Check the logs above for the crash reason."
                    )

                result = subprocess.run(
                    ["docker", "ps", "-q", "-f", f"name={project_name}"],
                    capture_output=True, text=True
                )
                container_id = result.stdout.strip()

                project.is_compose = False
                project.compose_ports = '[]'
                project.container_id = container_id
                project.status = 'running'
                build.status = 'success'
                build.finished_at = datetime.utcnow()
                db.session.commit()

                append_log(build_id, f"\n[✓] Deployed — container {container_id[:12]} on port {project.port}\n")

            # Cleanup dangling images
            append_log(build_id, "\n[Cleanup] Pruning dangling Docker images...\n")
            subprocess.run(["docker", "image", "prune", "-f"], capture_output=True)
            append_log(build_id, "[✓] Done\n")

        except Exception as e:
            if timed_out.is_set():
                append_log(build_id, f"\n[TIMEOUT] Build exceeded {BUILD_TIMEOUT}s and was killed\n")
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
        return None
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
        if not project:
            return
        project_name = f"cit-deploy-{project.id[:8]}"
        if project.is_compose:
            project_dir = os.path.join(DEPLOYMENTS_DIR, project_name)
            subprocess.run(
                ["docker", "compose", "-p", project_name, "down"],
                capture_output=True, cwd=project_dir
            )
        else:
            subprocess.run(["docker", "stop", project_name], capture_output=True)
        project.status = 'stopped'
        db.session.commit()


def restart_container(project_id):
    app = get_app()
    with app.app_context():
        project = db.session.get(Project, project_id)
        if not project:
            return
        project_name = f"cit-deploy-{project.id[:8]}"
        if project.is_compose:
            project_dir = os.path.join(DEPLOYMENTS_DIR, project_name)
            res = subprocess.run(
                ["docker", "compose", "-p", project_name, "restart"],
                capture_output=True, cwd=project_dir
            )
        else:
            res = subprocess.run(["docker", "restart", project_name], capture_output=True)
        project.status = 'running' if res.returncode == 0 else 'errored'
        db.session.commit()
