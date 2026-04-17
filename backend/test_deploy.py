import os
import subprocess
import time
import shutil

# Configuration for testing
REPO_URL = "https://github.com/your-username/your-test-repo.git" # Replace with your test repo
PROJECT_NAME = "test_deploy_app"
DEPLOYMENTS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "deployments"))
HOST_PORT = 5001
CONTAINER_PORT = 5000

def run_cmd(cmd, cwd=None):
    """Run a command and print its output line by line."""
    print(f"\n>>> Running: {' '.join(cmd)}")
    try:
        process = subprocess.Popen(
            cmd,
            cwd=cwd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,            # Line buffered
            universal_newlines=True
        )
        
        full_output = []
        for line in process.stdout:
            print(f"| {line}", end="")
            full_output.append(line)
            
        process.wait()
        
        if process.returncode != 0:
            print(f"\n[ERROR] Command failed with exit code {process.returncode}")
            return False, "".join(full_output)
            
        return True, "".join(full_output)
        
    except Exception as e:
        print(f"\n[ERROR] Exception executing command: {e}")
        return False, str(e)

def main():
    print(f"--- Starting minimal deploy test for {PROJECT_NAME} ---")
    
    # Ensure deployments dir exists
    if not os.path.exists(DEPLOYMENTS_DIR):
        os.makedirs(DEPLOYMENTS_DIR)
        
    project_dir = os.path.join(DEPLOYMENTS_DIR, PROJECT_NAME)
    
    # 1. Clean up existing test state if needed
    if os.path.exists(project_dir):
        print(f"Cleaning up existing directory {project_dir}...")
        # Sometimes Windows locks files (like .git), so try to remove strictly, handle errors
        def on_rm_error(func, path, exc_info):
            os.chmod(path, 0o777)
            os.unlink(path)
        shutil.rmtree(project_dir, onerror=on_rm_error)
        
    print(f"Stopping and removing any existing container named {PROJECT_NAME}...")
    subprocess.run(["docker", "rm", "-f", PROJECT_NAME], capture_output=True)

    # 2. Clone the repo
    print("\n[Step 1] Cloning repository...")
    success, out = run_cmd(["git", "clone", REPO_URL, project_dir])
    if not success:
        print("Failed to clone repository. Make sure the URL is correct.")
        return

    # 3. Build docker image
    print("\n[Step 2] Building Docker image...")
    success, out = run_cmd(["docker", "build", "-t", PROJECT_NAME, "."], cwd=project_dir)
    if not success:
        print("Failed to build Docker image.")
        return

    # 4. Run docker container
    print(f"\n[Step 3] Running container '{PROJECT_NAME}' on port {HOST_PORT}...")
    run_args = [
        "docker", "run", "-d",
        "--name", PROJECT_NAME,
        "-p", f"{HOST_PORT}:{CONTAINER_PORT}",
        "--memory", "512m",
        "--cpus", "0.5",
        PROJECT_NAME
    ]
    
    success, out = run_cmd(run_args)
    if not success:
        print("Failed to start Docker container.")
        return
        
    container_id = out.strip()
    
    # 5. Wait and inspect
    print("\n[Step 4] Waiting 3 seconds to check container health...")
    time.sleep(3)
    
    print("\n[Step 5] Inspecting container state...")
    result = subprocess.run(
        ["docker", "inspect", "-f", "{{.State.Running}}", PROJECT_NAME],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True
    )
    
    if result.returncode == 0 and result.stdout.strip() == "true":
        print(f"\n=== SUCCESS ===")
        print(f"Container ID: {container_id}")
        print(f"App is running at: http://localhost:{HOST_PORT}")
        print("\nTo clean up, run:")
        print(f"docker rm -f {PROJECT_NAME}")
    else:
        print("\n=== ERROR ===")
        print("Container started but is no longer running. It likely crashed.")
        print("Fetching logs:")
        logs_result = subprocess.run(["docker", "logs", PROJECT_NAME], capture_output=True, text=True)
        print(logs_result.stdout)
        print(logs_result.stderr)

if __name__ == "__main__":
    main()
