# CIT Deploy — Full Project Summary for Claude Code

## Context: What is the CIT Program?

This project is for a high school Computer Information Technology (CIT) program. The CIT program has its own dedicated servers that serve two purposes:

1. **Learning infrastructure** — students practice backend assignments using Flask, SQL, and similar technologies on the CIT servers
2. **Project deployment** — student-led teams build real software projects for actual clients, which get deployed and hosted on the CIT servers

Currently, deploying a student project to the CIT server is a painful manual process: the teacher has to go to GitHub, create a new directory on the server, manually set things up, and wire everything together by hand. This is the core problem we are solving.

---

## The Project: CIT Deploy

**CIT Deploy** is an internal Platform-as-a-Service (PaaS) — think a stripped-down version of Railway or Render — built specifically for the CIT program's server. The goal is that any student project team can log in, paste their GitHub repo URL, and have their app automatically cloned, built, containerized, and served at a real URL — with zero manual intervention from the teacher.

This is the senior final project for an Enterprise Architecture course. It is worth one classwork, one quiz, and two test grades. Groups of 2-4 are allowed and expected to produce higher quality work than solo students.

### Deliverables
- **Deliverable 1 (Classwork):** Project plan — what we're building and how, tracked in Trello or Microsoft Planner
- **Deliverable 2 (Quiz):** Midpoint burndown chart showing completed vs remaining work
- **Deliverable 3 (Test):** Final product and full documentation

---

## What the Final Product Looks Like (Full Vision)

### Core Pipeline
When a student submits a GitHub repo, the system:
1. `git clone`s the repo into a project directory
2. Runs `docker build` to containerize it
3. Runs `docker run` with an assigned port and resource limits
4. Generates and writes an Nginx config file for that project
5. Runs `nginx -t` to validate the config, then `nginx -s reload`
6. Marks the project as live in the database
7. The project is now accessible at `projectname.cit.school.com`

Every project is required to include a `Dockerfile` in its repo. This keeps the pipeline stack-agnostic — it doesn't care if the project is Python/Flask, Node/Next.js, Go, or anything else. Docker is the contract between the project and the deployment system.

For projects with multiple services (e.g. a Flask backend + a Next.js frontend), they use a `docker-compose.yml` and the pipeline runs `docker compose up --build` instead.

### Tech Stack
- **Frontend:** React (with Vite), styled to look like a proper developer dashboard
- **Backend:** Flask (Python) REST API
- **Database:** PostgreSQL (or SQLite for local dev)
- **Deployment Engine:** Python subprocess module running Docker commands
- **Process/Container Runtime:** Docker (and Docker Compose for multi-service projects)
- **Reverse Proxy:** Nginx (auto-configured by the pipeline, not touched manually)
- **Auth:** GitHub OAuth

### Database Schema (4 tables for Phase 1)

```sql
users
  id, github_id, username, avatar_url, access_token, created_at

projects
  id, user_id, name, repo_url, port, status, container_id, created_at

builds
  id, project_id, status (building/success/failed), logs, started_at, finished_at

sessions
  id, user_id, token, expires_at
```

### Flask API Endpoints

```
Auth:
POST /auth/github          → handles GitHub OAuth callback, creates session
POST /auth/logout

Projects:
GET  /projects             → list all projects belonging to the current user
POST /projects             → create new project (triggers first deploy)
GET  /projects/:id         → get single project details
DELETE /projects/:id       → delete project, stop + remove container, delete nginx config

Deployments:
POST /projects/:id/deploy  → trigger a redeploy from latest commit
POST /projects/:id/stop    → stop the container
POST /projects/:id/restart → restart the container
GET  /projects/:id/logs    → SSE endpoint that streams live build/run logs
GET  /projects/:id/builds  → list of past builds with status and logs

Status:
GET  /projects/:id/status  → check current container status (running/stopped/errored)
```

### Frontend Views
- **Login page** — GitHub OAuth button
- **Dashboard** — grid of all the user's projects showing name, status badge (running/stopped/errored), URL, and last deploy time. "New Project" button.
- **New Project form** — fields for project name and GitHub repo URL, submit triggers deploy
- **Project page** — the main project dashboard with:
  - Current status indicator (live/building/stopped/errored)
  - Deploy, Stop, Restart buttons
  - Live log terminal (SSE stream of build output, styled like a terminal)
  - Build history list (timestamp, pass/fail, expandable logs)
  - Project URL link
  - Basic project info (repo, port, created date)
- **Admin view** (teacher account) — sees all projects from all users, can control any of them

### Log Streaming (SSE)
The deploy pipeline runs in a background thread. As it executes, it writes log lines to the build record in the DB. The `/projects/:id/logs` endpoint is a Server-Sent Events (SSE) stream — it tails the build log and pushes new lines to the frontend as `data: <line>\n\n`. The frontend opens this SSE connection when a deploy starts and appends each incoming line to a terminal-styled `<pre>` element. The stream closes when the build finishes (success or failure).

### Security / Access Control
- All API endpoints (except auth) require a valid session token
- Ownership is enforced server-side — you can only control your own projects, regardless of what the UI shows
- Every container is run with resource limits: `--memory 512m --cpus 0.5` to prevent one bad project from taking down the server
- Teacher account has an admin flag in the users table that bypasses ownership checks

### Edge Cases to Handle (post-Phase 1 hardening)
- Build failures: capture full stderr, store it, mark project as errored, show the student exactly what failed
- Container starts then immediately crashes: health check a few seconds after `docker run` using `docker inspect`
- Port conflicts: DB-enforced port registry, always check before assigning
- Private repos: support GitHub personal access tokens for cloning
- No Dockerfile: reject immediately with a clear error before attempting anything
- Nginx config validation: always run `nginx -t` before reloading — if it fails, abort without touching live config
- Server restart recovery: on startup, check DB for projects marked "running" and restart their containers
- Disk cleanup: scheduled job runs `docker image prune` to prevent old build layers from filling the disk
- Concurrent deploys: lock mechanism so two simultaneous deploys on the same project queue rather than collide
- Deploy timeouts: kill any build that hangs longer than 5 minutes, mark as failed
- Custom Nginx options (future): a text field in the UI for custom Nginx directives that get injected into the generated config
- Team membership (future): multiple students can belong to one project and all have deploy access
- Multiple environments (future): dev/staging/production environments per project, each on their own subdomain

---

## Phase 1: Local Laptop Development

The goal of Phase 1 is to build and validate the entire core system locally on a personal laptop before touching the CIT server. **Nginx is intentionally excluded from Phase 1** — on the laptop, projects just get assigned a port and are accessed at `localhost:<port>`. Nginx gets wired in when moving to the actual server.

### Local Environment
- Docker Desktop — already installed ✅
- PostgreSQL or SQLite — already installed ✅
- Flask backend running on `localhost:8000`
- React frontend running on `localhost:5173` (Vite default)
- Deployed student projects accessible at `localhost:5001`, `localhost:5002`, etc.
- **ngrok** — install this. It exposes localhost to a public URL, which is required for GitHub OAuth to work locally since GitHub needs to redirect back to a real URL after auth.

### Phase 1 Build Order

**Step 1 — The pipeline script (start here, before any UI or API)**

Create a standalone Python script `test_deploy.py`. This script proves the core loop works before building anything around it. It should:
1. Accept a GitHub repo URL (hardcoded for testing)
2. `git clone` the repo into a local `/deployments/<project_name>/` directory
3. Run `docker build -t <project_name> .` and capture output
4. Run `docker run -d --name <project_name> -p 5001:5000 --memory 512m --cpus 0.5 <project_name>`
5. Wait 3 seconds, then check `docker inspect <container_id>` to verify it's still running
6. Print success with the container ID and port, or print the error output if it failed

To test this you need a test GitHub repo. Create a minimal repo with:
- `app.py` — a Flask hello world app that runs on port 5000
- `requirements.txt` — just `flask`
- `Dockerfile` — installs requirements and runs the app

Once `test_deploy.py` runs cleanly against this test repo, the hard part is proven. Everything else is building around this.

**Step 2 — Flask API**

Wrap the pipeline logic from Step 1 into a Flask application. The pipeline should run in a background thread (use Python's `threading` module or Flask's `executor`) so that the HTTP request that triggers a deploy returns immediately with a 202 Accepted, and the actual work happens asynchronously.

Implement these endpoints for Phase 1:
```
POST /auth/github          
POST /auth/logout          
GET  /projects             
POST /projects             
GET  /projects/:id         
POST /projects/:id/deploy  
POST /projects/:id/stop    
POST /projects/:id/restart 
GET  /projects/:id/logs    (SSE)
GET  /projects/:id/status  
```

**Step 3 — Database**

Set up the 4-table schema above (users, projects, builds, sessions). For local dev SQLite is fine. Use SQLAlchemy as the ORM. The pipeline writes to the builds table as it runs — each log line gets appended so the SSE endpoint can tail it.

**Step 4 — GitHub OAuth**

Register a new OAuth App in GitHub Developer Settings. Set the callback URL to your ngrok URL + `/auth/github`. The flow:
1. Frontend redirects user to `https://github.com/login/oauth/authorize?client_id=<your_client_id>&scope=repo`
2. User approves, GitHub redirects to your callback URL with `?code=<code>`
3. Your Flask backend POSTs to `https://github.com/login/oauth/access_token` with the code to exchange it for an access token
4. Use that access token to call `https://api.github.com/user` to get the user's GitHub ID and username
5. Upsert the user in the DB, create a session record, return a session token to the frontend

The `scope=repo` is important — it lets you clone private repos later if needed.

**Step 5 — React Frontend**

Build the UI with these views:
- Login page with a "Login with GitHub" button
- Dashboard showing the user's projects as cards (name, status badge, port/URL, redeploy button)
- New Project form (project name + repo URL)
- Project page with status, control buttons (Deploy/Stop/Restart), and a live log terminal

For the log terminal: when the user is on a project page during an active deploy, open an EventSource connection to `/projects/:id/logs`. Append each incoming `event.data` line to a scrollable `<pre>` element styled with a monospace font and dark background. Auto-scroll to the bottom as lines come in. Close the EventSource when you receive a special `done` or `error` event.

For status: poll `/projects/:id/status` every 5 seconds and update the status badge accordingly. Stop polling when status is `running` or `errored` (stable states).

### What Phase 1 Does NOT Include (save for CIT server)
- Nginx config generation and reloading
- Subdomain routing (`projectname.cit.school.com`)
- Wildcard DNS
- Systemd service setup
- Server restart recovery (startup script)
- HTTPS / SSL / Certbot

### Definition of Done for Phase 1
- Can log in with a real GitHub account
- Can submit a GitHub repo URL with a valid Dockerfile
- The system clones it, builds it, runs it in Docker
- The build logs stream live into the UI as the build runs
- After deploy, the project is accessible at `localhost:<assigned_port>`
- Can stop, restart, and redeploy from the UI
- Cannot access or control another user's projects
- Build history is visible per project

---

## Important Notes for Claude Code

- This is a school project running on a shared CIT server, so security and resource limits matter — always include `--memory 512m --cpus 0.5` on every `docker run` call
- The pipeline is the core of the whole system — keep it clean, well-logged, and with clear error states (building / success / failed / errored)
- Every deploy endpoint must verify the requesting user owns the project — enforce this in the Flask route, not just in the UI
- For Phase 1 local development, replace any Nginx config generation steps with a simple log message like "Nginx config would be written here" so the code path exists but doesn't break on a machine without Nginx
- Use environment variables (`.env` file with `python-dotenv`) for all config: GitHub OAuth credentials, DB connection string, secret key, etc. Never hardcode secrets.
- The frontend should feel like a real developer tool — clean, dark theme, monospace logs, clear status indicators. Think Vercel or Railway's dashboard aesthetic.