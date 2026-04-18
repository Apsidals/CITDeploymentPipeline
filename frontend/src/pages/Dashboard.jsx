import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Plus, Rocket, X, Box, Activity, CircleOff, Trash2
} from 'lucide-react';
import { getProjects, createProject, getTeams } from '../api';
import { useToast } from '../toast';

const GithubIcon = ({ size = 13 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M12 .5C5.65.5.5 5.65.5 12a11.5 11.5 0 0 0 7.86 10.92c.58.11.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.56-.29-5.25-1.28-5.25-5.7 0-1.26.45-2.29 1.18-3.1-.12-.29-.51-1.46.11-3.04 0 0 .97-.31 3.18 1.18a11.08 11.08 0 0 1 5.78 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.58.23 2.75.11 3.04.74.81 1.18 1.84 1.18 3.1 0 4.43-2.7 5.41-5.27 5.69.42.36.79 1.06.79 2.14v3.17c0 .31.21.68.8.56A11.5 11.5 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z" />
  </svg>
);

function relTime(iso) {
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return `${Math.max(1, Math.floor(diff))}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function shortRepo(url) {
  if (!url) return '';
  return url.replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '');
}

function ProjectCard({ p }) {
  const ref = useRef(null);
  const onMove = (e) => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    ref.current.style.setProperty('--mx', `${e.clientX - r.left}px`);
  };
  return (
    <Link to={`/projects/${p.id}`} className="project-card" ref={ref} onMouseMove={onMove}>
      <div className="head">
        <div className="name truncate">
          <Box size={15} color="var(--fg-3)" />
          <span>{p.name}</span>
        </div>
        <span className={`status ${p.status}`}>
          <span className="dot" />
          {p.status}
        </span>
      </div>
      <div className="repo truncate">
        <GithubIcon />
        <span className="truncate">{shortRepo(p.repo_url)}</span>
      </div>
      <div className="foot">
        <span style={{ display: 'flex', gap: 4, alignItems: 'center', minWidth: 0 }}>
          {p.team_name && <span className="team-chip">{p.team_name}</span>}
          {p.is_compose && <span className="compose-chip">compose</span>}
          {!p.team_name && !p.is_compose && <span className="port">:{p.port}</span>}
        </span>
        <span>{relTime(p.created_at)}</span>
      </div>
    </Link>
  );
}

function EnvVarsEditor({ rows, onChange }) {
  const addRow = () => onChange([...rows, { id: Date.now(), key: '', value: '' }]);
  const removeRow = (id) => onChange(rows.filter((r) => r.id !== id));
  const updateRow = (id, field, val) =>
    onChange(rows.map((r) => (r.id === id ? { ...r, [field]: val } : r)));

  return (
    <div className="env-editor">
      {rows.map((r) => (
        <div key={r.id} className="env-row">
          <input
            className="input mono env-key"
            placeholder="VARIABLE_NAME"
            value={r.key}
            onChange={(e) => updateRow(r.id, 'key', e.target.value)}
          />
          <input
            className="input mono env-val"
            placeholder="value"
            value={r.value}
            onChange={(e) => updateRow(r.id, 'value', e.target.value)}
          />
          <button type="button" className="icon-btn" onClick={() => removeRow(r.id)} title="Remove">
            <Trash2 size={13} />
          </button>
        </div>
      ))}
      <button type="button" className="btn ghost sm" onClick={addRow} style={{ marginTop: 6 }}>
        <Plus size={12} /> Add variable
      </button>
    </div>
  );
}

function NewProjectModal({ open, onClose, onCreated, teams }) {
  const [name, setName] = useState('');
  const [repo, setRepo] = useState('');
  const [buildMode, setBuildMode] = useState('dockerfile');
  const [startCommand, setStartCommand] = useState('');
  const [dockerfilePath, setDockerfilePath] = useState('');
  const [internalPort, setInternalPort] = useState('');
  const [envRows, setEnvRows] = useState([]);
  const [teamId, setTeamId] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  useEffect(() => {
    if (!open) return;
    setTeamId('');
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const handleClose = () => {
    setBuildMode('dockerfile');
    setStartCommand('');
    setDockerfilePath('');
    setInternalPort('');
    setEnvRows([]);
    setTeamId('');
    onClose();
  };

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    const envVarsObj = {};
    envRows.forEach(({ key, value }) => {
      if (key.trim()) envVarsObj[key.trim()] = value;
    });
    try {
      const payload = {
        name: name.trim(),
        repo_url: repo.trim(),
        build_mode: buildMode,
        start_command: startCommand.trim() || null,
        dockerfile_path: dockerfilePath.trim() || 'Dockerfile',
        internal_port: internalPort ? parseInt(internalPort, 10) : null,
        env_vars: envVarsObj,
        team_id: teamId || null,
      };
      const res = await import('../api').then(m => m.api.post('/projects', payload));
      toast('Deploy started', 'ok');
      onCreated(res.data);
    } catch (err) {
      console.error(err);
      toast('Failed to create project', 'err');
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={handleClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="head">
          <div>
            <h2>New deployment</h2>
            <p className="muted" style={{ fontSize: 13, marginTop: 4 }}>
              We'll clone, build, and run your repo in a container.
            </p>
          </div>
          <button type="button" className="icon-btn" onClick={handleClose} aria-label="Close">
            <X />
          </button>
        </div>
        <div className="body">
          <div className="field">
            <label>Project name</label>
            <input
              className="input"
              autoFocus
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-flask-app"
            />
          </div>
          <div className="field">
            <label>GitHub repository</label>
            <input
              className="input mono"
              required
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              placeholder="https://github.com/username/repo.git"
            />
          </div>
          <div className="field">
            <label>Build mode</label>
            <div style={{ display: 'flex', gap: 8 }}>
              {[['dockerfile', 'Dockerfile'], ['nixpacks', 'Nixpacks (auto-detect)']].map(([val, label]) => (
                <button
                  key={val}
                  type="button"
                  onClick={() => setBuildMode(val)}
                  style={{
                    flex: 1,
                    padding: '7px 12px',
                    borderRadius: 6,
                    border: buildMode === val ? '1.5px solid var(--accent, #7c6cfa)' : '1.5px solid var(--border, #333)',
                    background: buildMode === val ? 'var(--accent-dim, #2a2545)' : 'transparent',
                    color: buildMode === val ? 'var(--accent, #7c6cfa)' : 'var(--muted, #888)',
                    cursor: 'pointer',
                    fontSize: 13,
                    fontWeight: buildMode === val ? 600 : 400,
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            {buildMode === 'nixpacks' && (
              <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                Nixpacks auto-detects your stack — no Dockerfile needed. Works great for Flask, Node, and more.
              </p>
            )}
          </div>
          {buildMode === 'nixpacks' && (
          <div className="field">
            <label>Start command <span className="dim">(optional — auto-detected from app.py, main.py, etc.)</span></label>
            <input
              className="input mono"
              value={startCommand}
              onChange={(e) => setStartCommand(e.target.value)}
              placeholder="python app.py"
            />
          </div>
          )}
          {buildMode === 'dockerfile' && (
          <div className="field">
            <label>Dockerfile path <span className="dim">(optional)</span></label>
            <input
              className="input mono"
              value={dockerfilePath}
              onChange={(e) => setDockerfilePath(e.target.value)}
              placeholder="Dockerfile"
            />
          </div>
          )}
          <div className="field">
            <label>
              Container port <span className="dim">(optional — default 5000)</span>
            </label>
            <input
              className="input mono"
              type="number"
              min="1"
              max="65535"
              value={internalPort}
              onChange={(e) => setInternalPort(e.target.value)}
              placeholder="5000"
            />
          </div>
          <div className="field">
            <label>Environment variables <span className="dim">(optional)</span></label>
            <EnvVarsEditor rows={envRows} onChange={setEnvRows} />
          </div>
          {teams && teams.length > 0 && (
            <div className="field">
              <label>Team <span className="dim">(optional)</span></label>
              <select
                className="input"
                value={teamId}
                onChange={(e) => setTeamId(e.target.value)}
              >
                <option value="">Personal</option>
                {teams.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </div>
          )}
        </div>
        <div className="actions">
          <button type="button" className="btn ghost" onClick={handleClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy || !name || !repo}>
            {busy ? <><span className="spinner" /> Deploying…</> : <><Rocket size={14} /> Deploy</>}
          </button>
        </div>
      </form>
    </div>
  );
}

function SkeletonCards() {
  return (
    <div className="projects">
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="card" style={{ height: 150 }}>
          <div className="skeleton" style={{ height: 14, width: '40%', marginBottom: 14 }} />
          <div className="skeleton" style={{ height: 12, width: '70%', marginBottom: 10 }} />
          <div className="skeleton" style={{ height: 12, width: '55%' }} />
        </div>
      ))}
    </div>
  );
}

export default function Dashboard({ user: appUser }) {
  const [projects, setProjects] = useState([]);
  const [teams, setTeams] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const navigate = useNavigate();

  const load = async () => {
    try {
      const [projData, teamData] = await Promise.all([getProjects(), getTeams()]);
      setProjects(projData);
      setTeams(teamData);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    const interval = setInterval(() => {
      setProjects((curr) => {
        if (curr.some((p) => p.status === 'building')) {
          getProjects().then(setProjects).catch(() => {});
        }
        return curr;
      });
    }, 4000);
    return () => clearInterval(interval);
  }, []);

  const stats = useMemo(() => {
    const running = projects.filter((p) => p.status === 'running').length;
    const building = projects.filter((p) => p.status === 'building').length;
    const stopped = projects.filter(
      (p) => p.status !== 'running' && p.status !== 'building'
    ).length;
    return { total: projects.length, running, building, stopped, teams: teams.length };
  }, [projects, teams]);

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Workspace</div>
          <h1 style={{ marginTop: 6 }}>Your deployments</h1>
          <p className="sub">Deploy any Dockerized repo. We'll handle the rest.</p>
        </div>
        <button className="btn primary" onClick={() => setShowModal(true)}>
          <Plus size={14} /> New project
        </button>
      </div>

      <div className="stats">
        <div className="stat">
          <span className="label">Total</span>
          <span className="value">
            <Box size={18} color="var(--fg-2)" /> {stats.total}
          </span>
        </div>
        <div className="stat">
          <span className="label">Running</span>
          <span className="value" style={{ color: 'var(--ok)' }}>
            <Activity size={18} /> {stats.running}
          </span>
        </div>
        <div className="stat">
          <span className="label">Idle / stopped</span>
          <span className="value">
            <CircleOff size={18} color="var(--fg-2)" /> {stats.stopped}
          </span>
        </div>
        <div className="stat">
          <span className="label">Teams</span>
          <span className="value">
            <Box size={18} color="var(--fg-2)" /> {stats.teams}
          </span>
        </div>
      </div>

      {loading ? (
        <SkeletonCards />
      ) : projects.length === 0 ? (
        <div className="empty">
          <Rocket size={32} />
          <h3>No deployments yet</h3>
          <p>Paste a GitHub repo with a Dockerfile to ship your first project.</p>
          <button className="btn primary" onClick={() => setShowModal(true)}>
            <Plus size={14} /> New project
          </button>
        </div>
      ) : (
        <div className="projects">
          {projects.map((p) => (
            <ProjectCard key={p.id} p={p} />
          ))}
        </div>
      )}

      <NewProjectModal
        open={showModal}
        onClose={() => setShowModal(false)}
        onCreated={(proj) => navigate(`/projects/${proj.id}`)}
        teams={teams}
      />
    </>
  );
}
