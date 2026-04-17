import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Play, Square, RotateCw, Trash2, ExternalLink, ArrowLeft, Copy,
  Terminal as TerminalIcon, History, Check, Download, Trash
} from 'lucide-react';
import {
  getProject, getProjectBuilds, deployProject, stopProject, restartProject,
  deleteProject, getSSEUrl
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

/* -------------------- Terminal -------------------- */

function Terminal({ lines, connected, onClear }) {
  const scrollRef = useRef(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const toast = useToast();

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
    a.download = `build-logs-${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="terminal-wrap">
      <div className="terminal-head">
        <div className="lights">
          <span /><span /><span />
        </div>
        <div className="title">
          <TerminalIcon size={13} />
          build.log {connected && <span className="status running" style={{ fontSize: 10, padding: '2px 6px' }}><span className="dot" />live</span>}
        </div>
        <div className="tools">
          <button className="icon-btn" onClick={copy} title="Copy logs">
            <Copy />
          </button>
          <button className="icon-btn" onClick={download} title="Download">
            <Download />
          </button>
          <button className="icon-btn" onClick={onClear} title="Clear view">
            <Trash />
          </button>
        </div>
      </div>

      <div className="terminal" ref={scrollRef}>
        {lines.length === 0 ? (
          <div className="placeholder">Waiting for logs — trigger a deploy to see output stream here.</div>
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
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={(e) => setAutoScroll(e.target.checked)}
          />
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

export default function ProjectDetails() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();

  const [project, setProject] = useState(null);
  const [builds, setBuilds] = useState([]);
  const [lines, setLines] = useState([]);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [streaming, setStreaming] = useState(false);

  const esRef = useRef(null);

  const loadProject = useCallback(async () => {
    try {
      const p = await getProject(id);
      setProject(p);
      const bs = await getProjectBuilds(id).catch(() => []);
      setBuilds(bs);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [id]);

  const connectLogStream = useCallback(() => {
    if (esRef.current) esRef.current.close();
    setLines([]);
    const es = new EventSource(getSSEUrl(id));
    setStreaming(true);

    es.onmessage = (event) => {
      setLines((prev) => {
        const next = [...prev, { text: event.data, cls: classifyLine(event.data) }];
        return next.length > MAX_LINES ? next.slice(-MAX_LINES) : next;
      });
    };
    es.addEventListener('done', () => {
      es.close();
      setStreaming(false);
      loadProject();
    });
    es.onerror = () => {
      es.close();
      setStreaming(false);
    };
    esRef.current = es;
  }, [id, loadProject]);

  useEffect(() => {
    loadProject();
    return () => esRef.current?.close();
  }, [loadProject]);

  // Auto-connect stream when status is building
  useEffect(() => {
    if (project?.status === 'building' && (!esRef.current || esRef.current.readyState === EventSource.CLOSED)) {
      connectLogStream();
    }
  }, [project, connectLogStream]);

  // Soft-poll project state during build
  useEffect(() => {
    if (project?.status !== 'building') return;
    const t = setInterval(loadProject, 3500);
    return () => clearInterval(t);
  }, [project, loadProject]);

  const runAction = async (fn, okMsg) => {
    try {
      await fn(id);
      if (okMsg) toast(okMsg, 'ok');
      if (fn === deployProject) connectLogStream();
      loadProject();
    } catch {
      toast('Action failed', 'err');
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
      <span className="crumb" onClick={() => navigate('/')}>
        <ArrowLeft size={14} /> Projects
      </span>

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
          <button className="btn danger" onClick={handleDelete} disabled={isBuilding}>
            <Trash2 size={14} /> Delete
          </button>
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
          <span className="k">Port</span>
          <span className="v mono">{project.port}</span>
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
          <span className="k">Actions</span>
          <span className="v">
            <button className="btn sm ghost" onClick={copyUrl} style={{ padding: '4px 8px' }}>
              {copied ? <><Check size={12} /> Copied</> : <><Copy size={12} /> Copy URL</>}
            </button>
          </span>
        </div>
      </div>

      <Terminal
        lines={lines}
        connected={streaming}
        onClear={() => setLines([])}
      />

      <BuildHistory builds={builds} />
    </div>
  );
}
