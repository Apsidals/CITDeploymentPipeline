import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import {
  Play, Square, RotateCw, Trash2, ExternalLink, ArrowLeft, Copy,
  Terminal as TerminalIcon, History, Check, Download, Trash, Pencil, Plus, Settings2
} from 'lucide-react';
import {
  getProject, getProjectBuilds, deployProject, stopProject, restartProject,
  deleteProject, getSSEUrl, getRuntimeLogsUrl, updateProject
} from '../api';
import { useToast } from '../toast';

const GithubIcon = ({ size = 14, color }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={color || 'currentColor'} aria-hidden="true">
    <path d="M12 .5C5.65.5.5 5.65.5 12a11.5 11.5 0 0 0 7.86 10.92c.58.11.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.56-.29-5.25-1.28-5.25-5.7 0-1.26.45-2.29 1.18-3.1-.12-.29-.51-1.46.11-3.04 0 0 .97-.31 3.18 1.18a11.08 11.08 0 0 1 5.78 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.58.23 2.75.11 3.04.74.81 1.18 1.84 1.18 3.1 0 4.43-2.7 5.41-5.27 5.69.42.36.79 1.06.79 2.14v3.17c0 .31.21.68.8.56A11.5 11.5 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z" />
  </svg>
);

const MAX_LINES = 5000;

function relTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return `${Math.max(1, Math.floor(diff))}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function duration(a, b) {
  if (!a || !b) return '—';
  const s = Math.max(0, Math.floor((new Date(b) - new Date(a)) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return `${m}m ${rs}s`;
}

function shortRepo(url) {
  return (url || '').replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '');
}

function classifyLine(text) {
  const lower = text.toLowerCase();
  if (/(^|[^a-z])err(or)?([^a-z]|$)|failed|fatal|cannot|exited with code [1-9]/.test(lower)) return 'err';
  if (/(^|[^a-z])warn(ing)?/.test(lower)) return 'warn';
  if (/success|done|completed|listening|running on|=> success/.test(lower)) return 'ok';
  return '';
}

/* -------------------- EnvVarsEditor -------------------- */

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

/* -------------------- LogPanel -------------------- */

function LogPanel({
  logTab, setLogTab,
  deployLines, setDeployLines, deployStreaming,
  runtimeLines, setRuntimeLines, runtimeStreaming,
  isRunning,
}) {
  const scrollRef = useRef(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const toast = useToast();

  const lines = logTab === 'deploy' ? deployLines : runtimeLines;
  const streaming = logTab === 'deploy' ? deployStreaming : runtimeStreaming;
  const label = logTab === 'deploy' ? 'build.log' : 'runtime.log';
  const placeholder = logTab === 'deploy'
    ? 'Waiting for logs — trigger a deploy to see output here.'
    : isRunning ? 'Connecting to runtime logs…' : 'Container is not running.';

  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines, autoScroll]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(lines.map((l) => l.text).join('\n'));
      toast('Logs copied', 'ok');
    } catch {
      toast('Clipboard unavailable', 'err');
    }
  };

  const download = () => {
    const blob = new Blob([lines.map((l) => l.text).join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${label}-${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const clear = () => logTab === 'deploy' ? setDeployLines([]) : setRuntimeLines([]);

  return (
    <div className="log-panel">
      <div className="log-panel-head">
        <div className="log-panel-left">
          <TerminalIcon size={14} />
          <span className="log-panel-label">{label}</span>
          {streaming && (
            <span className="status running" style={{ fontSize: 10, padding: '2px 7px' }}>
              <span className="dot" />live
            </span>
          )}
        </div>
        <div className="log-seg">
          <button
            className={`log-seg-btn ${logTab === 'deploy' ? 'active' : ''}`}
            onClick={() => setLogTab('deploy')}
          >
            Deploy
          </button>
          <button
            className={`log-seg-btn ${logTab === 'runtime' ? 'active' : ''}`}
            onClick={() => setLogTab('runtime')}
          >
            Runtime
          </button>
        </div>
        <div className="log-panel-tools">
          <button className="icon-btn" onClick={copy} title="Copy logs"><Copy /></button>
          <button className="icon-btn" onClick={download} title="Download"><Download /></button>
          <button className="icon-btn" onClick={clear} title="Clear"><Trash /></button>
        </div>
      </div>

      <div className="terminal" ref={scrollRef}>
        {lines.length === 0 ? (
          <div className="placeholder">{placeholder}</div>
        ) : (
          lines.map((l, i) => (
            <div className="line" key={i}>
              <span className="gutter">{i + 1}</span>
              <span className={`content ${l.cls || ''}`}>{l.text}</span>
            </div>
          ))
        )}
      </div>

      <div className="terminal-foot">
        <label>
          <input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} />
          Auto-scroll
        </label>
        <span>{lines.length} line{lines.length === 1 ? '' : 's'}</span>
      </div>
    </div>
  );
}

/* -------------------- Build history -------------------- */

function BuildHistory({ builds }) {
  return (
    <div className="builds">
      <div className="builds-head">
        <div className="row">
          <History size={15} color="var(--fg-2)" />
          <h3>Build history</h3>
        </div>
        <span className="muted" style={{ fontSize: 12 }}>{builds.length} build{builds.length === 1 ? '' : 's'}</span>
      </div>
      {builds.length === 0 ? (
        <div style={{ padding: '24px 18px', color: 'var(--fg-3)', fontSize: 13 }}>
          No builds yet. Trigger a deploy to create the first one.
        </div>
      ) : (
        <div className="builds-list">
          {builds.map((b) => (
            <div key={b.id} className="build-row">
              <div className="dot-wrap">
                <span className={`status ${b.status}`} style={{ padding: 0, background: 'transparent', border: 0 }}>
                  <span className="dot" />
                </span>
              </div>
              <div className="meta-col">
                <span className="id">#{String(b.id).slice(0, 8)}</span>
                <span className="ago">
                  {relTime(b.started_at)} · {b.status}
                </span>
              </div>
              <span className="dur">{duration(b.started_at, b.finished_at)}</span>
              <span className={`status ${b.status}`}>
                <span className="dot" /> {b.status}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* -------------------- Page -------------------- */

export default function ProjectDetails({ user }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();

  const [project, setProject] = useState(null);
  const [builds, setBuilds] = useState([]);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  // Deploy log state
  const [deployLines, setDeployLines] = useState([]);
  const [deployStreaming, setDeployStreaming] = useState(false);
  const deployEsRef = useRef(null);

  // Runtime log state
  const [runtimeLines, setRuntimeLines] = useState([]);
  const [runtimeStreaming, setRuntimeStreaming] = useState(false);
  const runtimeEsRef = useRef(null);

  // Active log tab
  const [logTab, setLogTab] = useState('deploy');

  // Inline editing
  const [editingDockerfile, setEditingDockerfile] = useState(false);
  const [dockerfileInput, setDockerfileInput] = useState('');
  const [editingInternalPort, setEditingInternalPort] = useState(false);
  const [internalPortInput, setInternalPortInput] = useState('');

  // Env vars
  const [envRows, setEnvRows] = useState([]);
  const [envDirty, setEnvDirty] = useState(false);
  const [envSaved, setEnvSaved] = useState(false);

  const parseEnvVars = (jsonStr) => {
    try {
      const obj = JSON.parse(jsonStr || '{}');
      return Object.entries(obj).map(([key, value]) => ({ id: `${key}-${Date.now()}`, key, value }));
    } catch {
      return [];
    }
  };

  const envRowsToObj = (rows) => {
    const obj = {};
    rows.forEach(({ key, value }) => { if (key.trim()) obj[key.trim()] = value; });
    return obj;
  };

  const saveDockerfilePath = useCallback(async () => {
    setEditingDockerfile(false);
    const val = dockerfileInput.trim() || 'Dockerfile';
    if (val === (project?.dockerfile_path || 'Dockerfile')) return;
    try {
      await updateProject(id, { dockerfile_path: val });
      setProject((p) => ({ ...p, dockerfile_path: val }));
      toast('Dockerfile path updated', 'ok');
    } catch {
      toast('Failed to update Dockerfile path', 'err');
    }
  }, [dockerfileInput, project, id, toast]);

  const saveInternalPort = useCallback(async () => {
    setEditingInternalPort(false);
    const val = parseInt(internalPortInput, 10) || 5000;
    if (val === (project?.internal_port || 5000)) return;
    try {
      await updateProject(id, { internal_port: val });
      setProject((p) => ({ ...p, internal_port: val }));
      toast('Container port updated', 'ok');
    } catch {
      toast('Failed to update container port', 'err');
    }
  }, [internalPortInput, project, id, toast]);

  const saveEnvVars = async () => {
    try {
      await updateProject(id, { env_vars: envRowsToObj(envRows) });
      setEnvDirty(false);
      setEnvSaved(true);
      setTimeout(() => setEnvSaved(false), 3000);
      toast('Environment variables saved', 'ok');
    } catch {
      toast('Failed to save environment variables', 'err');
    }
  };

  const loadProject = useCallback(async () => {
    try {
      const p = await getProject(id);
      setProject(p);
      setEnvRows((prev) => {
        // Only overwrite env rows if not currently editing
        if (prev.length === 0) return parseEnvVars(p.env_vars);
        return prev;
      });
      const bs = await getProjectBuilds(id).catch(() => []);
      setBuilds(bs);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [id]);

  const connectDeployStream = useCallback(() => {
    if (deployEsRef.current) deployEsRef.current.close();
    setDeployLines([]);
    const es = new EventSource(getSSEUrl(id));
    setDeployStreaming(true);

    es.onmessage = (event) => {
      setDeployLines((prev) => {
        const next = [...prev, { text: event.data, cls: classifyLine(event.data) }];
        return next.length > MAX_LINES ? next.slice(-MAX_LINES) : next;
      });
    };
    es.addEventListener('done', () => {
      es.close();
      setDeployStreaming(false);
      loadProject();
    });
    es.onerror = () => {
      es.close();
      setDeployStreaming(false);
    };
    deployEsRef.current = es;
  }, [id, loadProject]);

  const connectRuntimeStream = useCallback(() => {
    if (runtimeEsRef.current) runtimeEsRef.current.close();
    setRuntimeLines([]);
    const es = new EventSource(getRuntimeLogsUrl(id));
    setRuntimeStreaming(true);

    es.onmessage = (event) => {
      setRuntimeLines((prev) => {
        const next = [...prev, { text: event.data, cls: classifyLine(event.data) }];
        return next.length > MAX_LINES ? next.slice(-MAX_LINES) : next;
      });
    };
    es.addEventListener('done', () => {
      es.close();
      setRuntimeStreaming(false);
    });
    es.onerror = () => {
      es.close();
      setRuntimeStreaming(false);
    };
    runtimeEsRef.current = es;
  }, [id]);

  useEffect(() => {
    loadProject();
    return () => {
      deployEsRef.current?.close();
      runtimeEsRef.current?.close();
    };
  }, [loadProject]);

  // Auto-connect deploy stream when building
  useEffect(() => {
    if (project?.status === 'building' && (!deployEsRef.current || deployEsRef.current.readyState === EventSource.CLOSED)) {
      connectDeployStream();
    }
  }, [project, connectDeployStream]);

  // Auto-connect runtime stream when tab is active and container is running
  useEffect(() => {
    if (logTab === 'runtime' && project?.status === 'running') {
      if (!runtimeEsRef.current || runtimeEsRef.current.readyState === EventSource.CLOSED) {
        connectRuntimeStream();
      }
    }
    if (logTab !== 'runtime') {
      runtimeEsRef.current?.close();
      setRuntimeStreaming(false);
    }
  }, [logTab, project?.status, connectRuntimeStream]);

  // Soft-poll during build
  useEffect(() => {
    if (project?.status !== 'building') return;
    const t = setInterval(loadProject, 3500);
    return () => clearInterval(t);
  }, [project, loadProject]);

  const runAction = async (fn, okMsg) => {
    try {
      await fn(id);
      if (okMsg) toast(okMsg, 'ok');
      if (fn === deployProject) {
        connectDeployStream();
        setLogTab('deploy');
      }
      loadProject();
    } catch (err) {
      if (err?.response?.status === 409) {
        toast('Deploy already in progress', 'warn');
      } else {
        toast('Action failed', 'err');
      }
    }
  };

  const handleDelete = async () => {
    if (!window.confirm('Delete this project? The container will be stopped and removed.')) return;
    try {
      await deleteProject(id);
      toast('Project deleted', 'ok');
      navigate('/');
    } catch {
      toast('Delete failed', 'err');
    }
  };

  const copyUrl = async () => {
    try {
      await navigator.clipboard.writeText(`http://localhost:${project.port}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      toast('Clipboard unavailable', 'err');
    }
  };

  if (loading) {
    return (
      <div>
        <div className="skeleton" style={{ height: 20, width: 140, marginBottom: 24 }} />
        <div className="skeleton" style={{ height: 40, width: 320, marginBottom: 12 }} />
        <div className="skeleton" style={{ height: 16, width: 260, marginBottom: 32 }} />
        <div className="skeleton" style={{ height: 80, marginBottom: 24 }} />
        <div className="skeleton" style={{ height: 480 }} />
      </div>
    );
  }
  if (!project) {
    return (
      <div className="empty">
        <h3>Project not found</h3>
        <p>It may have been deleted or you don't have access.</p>
        <button className="btn primary" onClick={() => navigate('/')}>Back to dashboard</button>
      </div>
    );
  }

  const isRunning = project.status === 'running';
  const isBuilding = project.status === 'building';

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 20 }}>
        <Link to="/" className="crumb" style={{ marginBottom: 0 }}>
          <ArrowLeft size={14} /> Projects
        </Link>
        {project.team_id && (
          <>
            <span style={{ color: 'var(--fg-3)', fontSize: 13 }}>/</span>
            <Link to={`/teams/${project.team_id}`} className="crumb" style={{ marginBottom: 0 }}>
              {project.team_name}
            </Link>
          </>
        )}
        <span style={{ color: 'var(--fg-3)', fontSize: 13 }}>/</span>
        <span style={{ fontSize: 13, color: 'var(--fg-1)', fontWeight: 500 }}>{project.name}</span>
      </div>

      <div className="project-header">
        <div>
          <h1>
            {project.name}
            <span className={`status ${project.status}`}>
              <span className="dot" /> {project.status}
            </span>
          </h1>
          <div className="repo">
            <GithubIcon size={14} color="var(--fg-3)" />
            <a href={project.repo_url} target="_blank" rel="noreferrer" className="truncate">
              {shortRepo(project.repo_url)}
            </a>
          </div>
        </div>

        <div className="actions-row">
          <button className="btn" onClick={() => runAction(deployProject, 'Deploy queued')} disabled={isBuilding}>
            <Play size={14} /> Deploy
          </button>
          <button className="btn" onClick={() => runAction(restartProject, 'Restarting')} disabled={!isRunning || isBuilding}>
            <RotateCw size={14} /> Restart
          </button>
          <button className="btn" onClick={() => runAction(stopProject, 'Stopped')} disabled={!isRunning || isBuilding}>
            <Square size={14} /> Stop
          </button>
          {(project.user_id === user?.id || user?.is_admin) && (
            <button className="btn danger" onClick={handleDelete} disabled={isBuilding}>
              <Trash2 size={14} /> Delete
            </button>
          )}
        </div>
      </div>

      <div className="meta-strip">
        <div className="meta">
          <span className="k">URL</span>
          <a
            className="v"
            href={`http://localhost:${project.port}`}
            target="_blank"
            rel="noreferrer"
            title="Open deployment"
          >
            localhost:{project.port}
            <ExternalLink size={12} />
          </a>
        </div>
        <div className="meta">
          <span className="k">Ext. port</span>
          <span className="v mono">{project.port}</span>
        </div>
        <div className="meta">
          <span className="k">Container port</span>
          <span className="v mono" style={{ gap: 6 }}>
            {editingInternalPort ? (
              <input
                className="input mono"
                style={{ padding: '2px 8px', fontSize: 12, height: 26, width: 70 }}
                type="number"
                min="1"
                max="65535"
                value={internalPortInput}
                onChange={(e) => setInternalPortInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') saveInternalPort();
                  if (e.key === 'Escape') setEditingInternalPort(false);
                }}
                onBlur={saveInternalPort}
                autoFocus
              />
            ) : (
              <>
                <span>{project.internal_port || 5000}</span>
                <button
                  className="icon-btn"
                  style={{ width: 22, height: 22 }}
                  onClick={() => {
                    setInternalPortInput(String(project.internal_port || 5000));
                    setEditingInternalPort(true);
                  }}
                  title="Edit container port"
                >
                  <Pencil size={11} />
                </button>
              </>
            )}
          </span>
        </div>
        <div className="meta">
          <span className="k">Container</span>
          <span className="v mono">
            {project.container_id ? project.container_id.substring(0, 12) : '—'}
          </span>
        </div>
        <div className="meta">
          <span className="k">Created</span>
          <span className="v">{relTime(project.created_at)}</span>
        </div>
        <div className="meta">
          <span className="k">Team</span>
          <span className="v">
            {project.team_id ? (
              <Link to={`/teams/${project.team_id}`} style={{ color: 'var(--fg-1)', textDecoration: 'none' }}>
                {project.team_name}
              </Link>
            ) : 'Personal'}
          </span>
        </div>
        <div className="meta">
          <span className="k">Dockerfile</span>
          <span className="v mono" style={{ gap: 6 }}>
            {editingDockerfile ? (
              <input
                className="input mono"
                style={{ padding: '2px 8px', fontSize: 12, height: 26 }}
                value={dockerfileInput}
                onChange={(e) => setDockerfileInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') saveDockerfilePath();
                  if (e.key === 'Escape') setEditingDockerfile(false);
                }}
                onBlur={saveDockerfilePath}
                autoFocus
              />
            ) : (
              <>
                <span className="truncate">{project.dockerfile_path || 'Dockerfile'}</span>
                <button
                  className="icon-btn"
                  style={{ width: 22, height: 22 }}
                  onClick={() => {
                    setDockerfileInput(project.dockerfile_path || 'Dockerfile');
                    setEditingDockerfile(true);
                  }}
                  title="Edit Dockerfile path"
                >
                  <Pencil size={11} />
                </button>
              </>
            )}
          </span>
        </div>
        <div className="meta">
          <span className="k">Actions</span>
          <span className="v">
            <button className="btn sm ghost" onClick={copyUrl} style={{ padding: '4px 8px' }}>
              {copied ? <><Check size={12} /> Copied</> : <><Copy size={12} /> Copy URL</>}
            </button>
          </span>
        </div>
      </div>

      <LogPanel
        logTab={logTab}
        setLogTab={setLogTab}
        deployLines={deployLines}
        setDeployLines={setDeployLines}
        deployStreaming={deployStreaming}
        runtimeLines={runtimeLines}
        setRuntimeLines={setRuntimeLines}
        runtimeStreaming={runtimeStreaming}
        isRunning={isRunning}
      />

      <BuildHistory builds={builds} />

      <div className="env-section">
        <div className="env-section-head">
          <div className="row">
            <Settings2 size={15} color="var(--fg-2)" />
            <h3>Environment variables</h3>
          </div>
          {envSaved && <span className="env-saved"><Check size={11} /> Saved</span>}
        </div>
        <div className="env-body">
          <EnvVarsEditor
            rows={envRows}
            onChange={(rows) => { setEnvRows(rows); setEnvDirty(true); setEnvSaved(false); }}
          />
        </div>
        <div className="env-section-foot">
          {envDirty && <span className="env-notice">Redeploy required for changes to take effect</span>}
          <button className="btn sm" onClick={saveEnvVars} disabled={!envDirty}>
            Save variables
          </button>
        </div>
      </div>

    </div>
  );
}
