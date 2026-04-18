import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Activity, Box, ChevronDown, ExternalLink, Play, Plus,
  RotateCw, ShieldCheck, Square, Trash2, Users,
} from 'lucide-react';
import {
  getAdminStats, getAdminProjects, getAdminUsers, getAdminTeams, getAdminResources,
  adminUpdateUser, adminSetPassword, adminDeleteUser,
  adminDeployProject, adminStopProject, adminRestartProject, adminDeleteProject,
  adminDeleteTeam, updateProject,
} from '../api';
import { useToast } from '../toast';

/* -------------------- Helpers -------------------- */

function relTime(iso) {
  if (!iso) return '—';
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return `${Math.max(1, Math.floor(diff))}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function parseEnvVars(jsonStr) {
  try {
    const obj = JSON.parse(jsonStr || '{}');
    return Object.entries(obj).map(([key, value]) => ({ id: `${key}-${Math.random()}`, key, value }));
  } catch { return []; }
}

function envRowsToObj(rows) {
  const obj = {};
  rows.forEach(({ key, value }) => { if (key.trim()) obj[key.trim()] = value; });
  return obj;
}

/* -------------------- Sub-components -------------------- */

function ResourceBar({ pct, label }) {
  const cls = pct > 85 ? 'err' : pct > 60 ? 'warn' : '';
  return (
    <div style={{ minWidth: 110 }}>
      <div className="resource-bar">
        <div className={`resource-bar-fill ${cls}`} style={{ width: `${Math.min(Math.max(pct, 0), 100)}%` }} />
      </div>
      {label && <div style={{ fontSize: 10.5, color: 'var(--fg-3)', marginTop: 3 }}>{label}</div>}
    </div>
  );
}

function AuthChip({ githubConnected, hasPassword }) {
  if (githubConnected && hasPassword) return <span className="auth-chip both">Both</span>;
  if (githubConnected) return <span className="auth-chip github">GitHub</span>;
  return <span className="auth-chip email">Email</span>;
}

function EnvVarsEditor({ rows, onChange }) {
  const add = () => onChange([...rows, { id: Date.now(), key: '', value: '' }]);
  const remove = (id) => onChange(rows.filter((r) => r.id !== id));
  const update = (id, field, val) => onChange(rows.map((r) => (r.id === id ? { ...r, [field]: val } : r)));
  return (
    <div className="env-editor">
      {rows.map((r) => (
        <div key={r.id} className="env-row">
          <input className="input mono env-key" placeholder="KEY" value={r.key} onChange={(e) => update(r.id, 'key', e.target.value)} />
          <input className="input mono env-val" placeholder="value" value={r.value} onChange={(e) => update(r.id, 'value', e.target.value)} />
          <button type="button" className="icon-btn" onClick={() => remove(r.id)}><Trash2 size={12} /></button>
        </div>
      ))}
      <button type="button" className="btn ghost sm" onClick={add} style={{ marginTop: 6 }}>
        <Plus size={12} /> Add variable
      </button>
    </div>
  );
}

/* -------------------- Overview tab -------------------- */

function Overview({ stats, resources }) {
  const { containers = [], totals = {} } = resources;
  const totalMemPct = totals.mem_limit_mb > 0 ? (totals.mem_used_mb / totals.mem_limit_mb) * 100 : 0;

  const cards = [
    { label: 'Users',    value: stats?.users    ?? '—', color: 'var(--fg-0)' },
    { label: 'Projects', value: stats?.projects ?? '—', color: 'var(--fg-0)' },
    { label: 'Teams',    value: stats?.teams    ?? '—', color: 'var(--fg-0)' },
    { label: 'Running',  value: stats?.running  ?? '—', color: 'var(--ok)'   },
    { label: 'Building', value: stats?.building ?? '—', color: 'var(--warn)' },
    { label: 'Errored',  value: stats?.errored  ?? '—', color: 'var(--err)'  },
  ];

  function fmtMb(mb) {
    if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
    return `${Math.round(mb)} MB`;
  }

  return (
    <div>
      {/* 6-card stat strip */}
      <div className="stats six" style={{ marginBottom: 24 }}>
        {cards.map((c) => (
          <div key={c.label} className="stat">
            <span className="label">{c.label}</span>
            <span className="value" style={{ color: c.color, fontSize: 26 }}>{c.value}</span>
          </div>
        ))}
      </div>

      {/* Total resource utilization */}
      {containers.length > 0 && (
        <div className="profile-section" style={{ marginBottom: 24 }}>
          <div className="profile-section-head">
            <h3>Total resource utilization — {containers.length} container{containers.length !== 1 ? 's' : ''}</h3>
          </div>
          <div className="profile-section-body">
            <div style={{ display: 'flex', gap: 56, flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--fg-3)', marginBottom: 6 }}>Combined CPU</div>
                <div style={{
                  fontSize: 32, fontWeight: 700, marginBottom: 6,
                  color: totals.cpu_pct > 80 ? 'var(--err)' : totals.cpu_pct > 60 ? 'var(--warn)' : 'var(--ok)',
                }}>
                  {totals.cpu_pct}%
                </div>
                <div style={{ width: 200 }}>
                  <ResourceBar pct={Math.min(totals.cpu_pct, 100)} />
                </div>
                <div style={{ fontSize: 11, color: 'var(--fg-3)', marginTop: 4 }}>sum across all containers</div>
              </div>
              <div>
                <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--fg-3)', marginBottom: 6 }}>Combined Memory</div>
                <div style={{ fontSize: 32, fontWeight: 700, marginBottom: 6 }}>
                  {fmtMb(totals.mem_used_mb)}
                </div>
                <div style={{ width: 200 }}>
                  <ResourceBar pct={totalMemPct} />
                </div>
                <div style={{ fontSize: 11, color: 'var(--fg-3)', marginTop: 4 }}>
                  of {fmtMb(totals.mem_limit_mb)} total limit
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Per-container table */}
      {containers.length === 0 ? (
        <div className="empty" style={{ padding: 48 }}>
          <Activity size={28} />
          <h3 style={{ marginTop: 14 }}>No containers running</h3>
          <p>Deploy a project to see resource usage here.</p>
        </div>
      ) : (
        <div className="profile-section">
          <div className="profile-section-head"><h3>Per-container usage</h3></div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: 'var(--bg-2)', borderBottom: '1px solid var(--border)' }}>
                  {['Project', 'Service', 'CPU %', '', 'Memory', ''].map((h, i) => (
                    <th key={i} style={{ padding: '10px 16px', textAlign: 'left', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--fg-3)', fontWeight: 600, whiteSpace: 'nowrap' }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {containers.map((c) => (
                  <tr key={c.container_name} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ padding: '11px 16px', fontWeight: 500 }}>
                      {c.project_id
                        ? <Link to={`/projects/${c.project_id}`} style={{ color: 'var(--fg-0)', textDecoration: 'none' }}>{c.project_name}</Link>
                        : <span style={{ color: 'var(--fg-2)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>{c.container_name}</span>
                      }
                    </td>
                    <td style={{ padding: '11px 16px', fontSize: 12 }}>
                      {c.service_name
                        ? <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--fg-2)' }}>{c.service_name}</span>
                        : <span style={{ color: 'var(--fg-3)' }}>—</span>}
                    </td>
                    <td style={{ padding: '11px 16px', fontFamily: 'var(--font-mono)', fontSize: 12, color: c.cpu_pct > 85 ? 'var(--err)' : c.cpu_pct > 60 ? 'var(--warn)' : 'var(--ok)', whiteSpace: 'nowrap' }}>
                      {c.cpu_pct}%
                    </td>
                    <td style={{ padding: '11px 16px', minWidth: 130 }}>
                      <ResourceBar pct={c.cpu_pct} />
                    </td>
                    <td style={{ padding: '11px 16px', fontFamily: 'var(--font-mono)', fontSize: 12, whiteSpace: 'nowrap' }}>
                      {c.mem_used_mb} MB / {c.mem_limit_mb} MB
                    </td>
                    <td style={{ padding: '11px 16px', minWidth: 130 }}>
                      <ResourceBar pct={c.mem_pct} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

/* -------------------- Deployments tab -------------------- */

function Deployments({ projects, resources, onRefresh }) {
  const toast = useToast();
  const [expandedId, setExpandedId] = useState(null);
  const [editState, setEditState] = useState({});
  const [envOpen, setEnvOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [busy, setBusy] = useState({});

  const resourceMap = useMemo(() => {
    const m = {};
    (resources.containers || []).forEach((c) => {
      if (c.project_id) {
        if (!m[c.project_id]) m[c.project_id] = [];
        m[c.project_id].push(c);
      }
    });
    return m;
  }, [resources]);

  const filtered = useMemo(() => {
    return projects.filter((p) => {
      if (statusFilter !== 'all' && p.status !== statusFilter) return false;
      if (search) {
        const q = search.toLowerCase();
        return p.name.toLowerCase().includes(q) || (p.owner_username || '').toLowerCase().includes(q);
      }
      return true;
    });
  }, [projects, statusFilter, search]);

  const toggle = (p) => {
    if (expandedId === p.id) { setExpandedId(null); return; }
    setExpandedId(p.id);
    setEnvOpen(false);
    setEditState({
      dockerfilePath: p.dockerfile_path || 'Dockerfile',
      internalPort: String(p.internal_port || 5000),
      envRows: parseEnvVars(p.env_vars),
    });
  };

  const doAction = async (projectId, fn, label) => {
    setBusy((b) => ({ ...b, [projectId]: label }));
    try {
      await fn(projectId);
      toast(`${label} succeeded`, 'ok');
      onRefresh();
    } catch (err) {
      if (err?.response?.status === 409) toast('Deploy already in progress', 'warn');
      else toast(`${label} failed`, 'err');
    } finally {
      setBusy((b) => { const n = { ...b }; delete n[projectId]; return n; });
    }
  };

  const saveField = async (projectId, field, value) => {
    try {
      await updateProject(projectId, { [field]: value });
      toast('Saved', 'ok');
      onRefresh();
    } catch { toast('Save failed', 'err'); }
  };

  const saveEnvVars = async (projectId) => {
    try {
      await updateProject(projectId, { env_vars: envRowsToObj(editState.envRows || []) });
      toast('Environment variables saved', 'ok');
    } catch { toast('Failed to save env vars', 'err'); }
  };

  const COLS = '16px 1fr 130px 110px 70px 70px 16px';

  return (
    <div>
      <div className="admin-filter-bar">
        <input
          className="input"
          placeholder="Search by project name or owner…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ flex: 1, maxWidth: 300 }}
        />
        <select className="input" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={{ width: 150 }}>
          {['all', 'running', 'stopped', 'building', 'errored'].map((s) => (
            <option key={s} value={s}>{s === 'all' ? 'All statuses' : s.charAt(0).toUpperCase() + s.slice(1)}</option>
          ))}
        </select>
        <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>{filtered.length} project{filtered.length !== 1 ? 's' : ''}</span>
      </div>

      <div className="admin-table">
        <div className="admin-table-head" style={{ gridTemplateColumns: COLS }}>
          <span />
          <span>Project</span>
          <span>Owner</span>
          <span>Team</span>
          <span>Port</span>
          <span>Age</span>
          <span />
        </div>

        {filtered.length === 0 ? (
          <div style={{ padding: '32px 18px', textAlign: 'center', color: 'var(--fg-3)', fontSize: 13 }}>
            No projects match this filter.
          </div>
        ) : filtered.map((p) => {
          const res = resourceMap[p.id];
          const rowBusy = busy[p.id];
          const isOpen = expandedId === p.id;

          return (
            <div key={p.id} className="admin-row">
              <div
                className={`admin-row-summary ${isOpen ? 'open' : ''}`}
                style={{ gridTemplateColumns: COLS }}
                onClick={() => toggle(p)}
              >
                <span className={`status ${p.status}`} style={{ padding: 0, background: 'transparent', border: 0 }}>
                  <span className="dot" />
                </span>
                <div style={{ minWidth: 0, display: 'flex', alignItems: 'center', gap: 7 }}>
                  <div style={{ fontWeight: 500, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {p.name}
                  </div>
                  {p.is_compose && <span className="compose-chip">compose</span>}
                </div>
                <span style={{ fontSize: 12, color: 'var(--fg-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {p.owner_username || '—'}
                </span>
                <span>
                  {p.team_name
                    ? <span className="team-chip">{p.team_name}</span>
                    : <span style={{ color: 'var(--fg-3)', fontSize: 12 }}>—</span>}
                </span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--fg-2)' }}>:{p.port}</span>
                <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>{relTime(p.created_at)}</span>
                <ChevronDown size={13} color="var(--fg-3)" style={{ transform: isOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s', flexShrink: 0 }} />
              </div>

              {isOpen && (
                <div className="admin-row-detail">
                  {/* Action buttons */}
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <Link to={`/projects/${p.id}`} className="btn sm ghost" style={{ textDecoration: 'none' }}>
                      <ExternalLink size={12} /> Open
                    </Link>
                    <button className="btn sm" disabled={!!rowBusy || p.status === 'building'} onClick={() => doAction(p.id, adminDeployProject, 'Deploy')}>
                      <Play size={12} /> {rowBusy === 'Deploy' ? 'Deploying…' : 'Deploy'}
                    </button>
                    <button className="btn sm" disabled={!!rowBusy || p.status !== 'running'} onClick={() => doAction(p.id, adminRestartProject, 'Restart')}>
                      <RotateCw size={12} /> Restart
                    </button>
                    <button className="btn sm" disabled={!!rowBusy || p.status !== 'running'} onClick={() => doAction(p.id, adminStopProject, 'Stop')}>
                      <Square size={12} /> Stop
                    </button>
                    <button
                      className="btn sm danger"
                      disabled={!!rowBusy}
                      onClick={async () => {
                        if (!window.confirm(`Delete "${p.name}"? This cannot be undone.`)) return;
                        await doAction(p.id, adminDeleteProject, 'Delete');
                        setExpandedId(null);
                      }}
                    >
                      <Trash2 size={12} /> Delete
                    </button>
                  </div>

                  {/* Resource bars */}
                  {res && res.length > 0 && (
                    <div>
                      {res.length === 1 ? (
                        <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap' }}>
                          <div>
                            <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--fg-3)', marginBottom: 6 }}>CPU</div>
                            <ResourceBar pct={res[0].cpu_pct} label={`${res[0].cpu_pct}%`} />
                          </div>
                          <div>
                            <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--fg-3)', marginBottom: 6 }}>Memory</div>
                            <ResourceBar pct={res[0].mem_pct} label={`${res[0].mem_used_mb} MB / ${res[0].mem_limit_mb} MB`} />
                          </div>
                        </div>
                      ) : (
                        <div>
                          <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--fg-3)', marginBottom: 8 }}>
                            Per-service resources ({res.length} services)
                          </div>
                          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                            <thead>
                              <tr style={{ color: 'var(--fg-3)', fontSize: 11 }}>
                                <th style={{ textAlign: 'left', padding: '4px 8px 6px 0', fontWeight: 600 }}>Service</th>
                                <th style={{ textAlign: 'left', padding: '4px 8px 6px', fontWeight: 600 }}>CPU</th>
                                <th style={{ padding: '4px 8px 6px', minWidth: 110 }} />
                                <th style={{ textAlign: 'left', padding: '4px 8px 6px', fontWeight: 600 }}>Memory</th>
                                <th style={{ padding: '4px 8px 6px', minWidth: 110 }} />
                              </tr>
                            </thead>
                            <tbody>
                              {res.map((svc) => (
                                <tr key={svc.container_name}>
                                  <td style={{ padding: '5px 8px 5px 0', fontFamily: 'var(--font-mono)', color: 'var(--fg-1)' }}>{svc.service_name || svc.container_name}</td>
                                  <td style={{ padding: '5px 8px', color: svc.cpu_pct > 85 ? 'var(--err)' : svc.cpu_pct > 60 ? 'var(--warn)' : 'var(--ok)', fontFamily: 'var(--font-mono)' }}>{svc.cpu_pct}%</td>
                                  <td style={{ padding: '5px 8px' }}><ResourceBar pct={svc.cpu_pct} /></td>
                                  <td style={{ padding: '5px 8px', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>{svc.mem_used_mb} / {svc.mem_limit_mb} MB</td>
                                  <td style={{ padding: '5px 8px' }}><ResourceBar pct={svc.mem_pct} /></td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Editable config fields */}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                    <div className="field" style={{ marginBottom: 0 }}>
                      <label>Dockerfile path</label>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <input
                          className="input mono"
                          style={{ flex: 1 }}
                          value={editState.dockerfilePath || ''}
                          onChange={(e) => setEditState((s) => ({ ...s, dockerfilePath: e.target.value }))}
                          onKeyDown={(e) => { if (e.key === 'Enter') saveField(p.id, 'dockerfile_path', editState.dockerfilePath.trim() || 'Dockerfile'); }}
                        />
                        <button className="btn sm ghost" onClick={() => saveField(p.id, 'dockerfile_path', editState.dockerfilePath.trim() || 'Dockerfile')}>Save</button>
                      </div>
                    </div>
                    <div className="field" style={{ marginBottom: 0 }}>
                      <label>Container port</label>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <input
                          className="input mono"
                          type="number"
                          min="1"
                          max="65535"
                          style={{ flex: 1 }}
                          value={editState.internalPort || ''}
                          onChange={(e) => setEditState((s) => ({ ...s, internalPort: e.target.value }))}
                          onKeyDown={(e) => { if (e.key === 'Enter') saveField(p.id, 'internal_port', parseInt(editState.internalPort, 10) || 5000); }}
                        />
                        <button className="btn sm ghost" onClick={() => saveField(p.id, 'internal_port', parseInt(editState.internalPort, 10) || 5000)}>Save</button>
                      </div>
                    </div>
                  </div>

                  {/* Env vars */}
                  <div>
                    <button className="btn sm ghost" onClick={() => setEnvOpen((o) => !o)} style={{ marginBottom: envOpen ? 10 : 0 }}>
                      <ChevronDown size={12} style={{ transform: envOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }} />
                      {' '}Environment variables ({(editState.envRows || []).length})
                    </button>
                    {envOpen && (
                      <div>
                        <EnvVarsEditor
                          rows={editState.envRows || []}
                          onChange={(rows) => setEditState((s) => ({ ...s, envRows: rows }))}
                        />
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
                          <button className="btn sm" onClick={() => saveEnvVars(p.id)}>Save variables</button>
                          <span style={{ fontSize: 11, color: 'var(--fg-3)' }}>Redeploy required for changes to take effect</span>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Meta row */}
                  <div style={{ display: 'flex', gap: 20, fontSize: 12, color: 'var(--fg-2)', flexWrap: 'wrap', paddingTop: 2 }}>
                    <span><span style={{ color: 'var(--fg-3)' }}>Ext. port:</span> {p.port}</span>
                    <span><span style={{ color: 'var(--fg-3)' }}>Builds:</span> {p.build_count}</span>
                    <span>
                      <span style={{ color: 'var(--fg-3)' }}>Repo:</span>{' '}
                      <a href={p.repo_url} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>
                        {p.repo_url.replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '')}
                      </a>
                    </span>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* -------------------- Users tab -------------------- */

function UsersTab({ users, currentUserId, onRefresh }) {
  const toast = useToast();
  const [expandedId, setExpandedId] = useState(null);
  const [pwInput, setPwInput] = useState('');
  const [pwBusy, setPwBusy] = useState(false);
  const [actionBusy, setActionBusy] = useState({});

  const toggle = (userId) => {
    setExpandedId(expandedId === userId ? null : userId);
    setPwInput('');
  };

  const toggleAdmin = async (userId, currentIsAdmin) => {
    setActionBusy((b) => ({ ...b, [userId]: true }));
    try {
      await adminUpdateUser(userId, { is_admin: !currentIsAdmin });
      toast(`Admin ${!currentIsAdmin ? 'granted' : 'revoked'}`, 'ok');
      onRefresh();
    } catch (err) {
      toast(err?.response?.data?.error || 'Failed', 'err');
    } finally {
      setActionBusy((b) => { const n = { ...b }; delete n[userId]; return n; });
    }
  };

  const setPassword = async (userId) => {
    if (pwInput.length < 8) { toast('Minimum 8 characters', 'err'); return; }
    setPwBusy(true);
    try {
      await adminSetPassword(userId, pwInput);
      toast('Password updated', 'ok');
      setPwInput('');
    } catch (err) {
      toast(err?.response?.data?.error || 'Failed to set password', 'err');
    } finally {
      setPwBusy(false);
    }
  };

  const deleteUser = async (userId, username) => {
    if (!window.confirm(`Delete "${username}"? Their projects will remain but the account is gone.`)) return;
    try {
      await adminDeleteUser(userId);
      toast('User deleted', 'ok');
      setExpandedId(null);
      onRefresh();
    } catch (err) {
      toast(err?.response?.data?.error || 'Failed to delete user', 'err');
    }
  };

  const COLS = '32px 1fr 160px 80px 60px 70px 16px';

  return (
    <div className="admin-table">
      <div className="admin-table-head" style={{ gridTemplateColumns: COLS }}>
        <span />
        <span>User</span>
        <span>Email</span>
        <span>Auth</span>
        <span>Projects</span>
        <span>Joined</span>
        <span />
      </div>

      {users.map((u) => {
        const isSelf = u.id === currentUserId;
        const isOpen = expandedId === u.id;

        return (
          <div key={u.id} className="admin-row">
            <div
              className={`admin-row-summary ${isOpen ? 'open' : ''}`}
              style={{ gridTemplateColumns: COLS }}
              onClick={() => toggle(u.id)}
            >
              {u.avatar_url
                ? <img src={u.avatar_url} alt="" style={{ width: 26, height: 26, borderRadius: '50%' }} />
                : (
                  <div style={{ width: 26, height: 26, borderRadius: '50%', background: 'var(--bg-3)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 600 }}>
                    {((u.name || u.username) || '?').slice(0, 1).toUpperCase()}
                  </div>
                )
              }
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.name || u.username}</div>
                  {u.name && <div style={{ fontSize: 11, color: 'var(--fg-3)' }}>@{u.username}</div>}
                </div>
                {u.is_admin && <span className="badge-admin">Admin</span>}
                {isSelf && <span style={{ fontSize: 10, color: 'var(--fg-3)', whiteSpace: 'nowrap' }}>(you)</span>}
              </div>
              <span style={{ fontSize: 12, color: 'var(--fg-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {u.email || '—'}
              </span>
              <AuthChip githubConnected={u.github_connected} hasPassword={u.has_password} />
              <span style={{ fontSize: 12, color: 'var(--fg-2)' }}>{u.project_count}</span>
              <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>{relTime(u.created_at)}</span>
              <ChevronDown size={13} color="var(--fg-3)" style={{ transform: isOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s', flexShrink: 0 }} />
            </div>

            {isOpen && (
              <div className="admin-row-detail">
                {isSelf ? (
                  <span style={{ fontSize: 12, color: 'var(--fg-3)', fontStyle: 'italic' }}>
                    Cannot modify your own account from the admin panel. Use the profile page.
                  </span>
                ) : (
                  <>
                    {/* Set password */}
                    <div>
                      <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--fg-3)', marginBottom: 6 }}>Set password</div>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <input
                          className="input"
                          type="password"
                          placeholder="New password (min 8 chars)"
                          value={pwInput}
                          onChange={(e) => setPwInput(e.target.value)}
                          style={{ flex: 1, maxWidth: 300 }}
                          onKeyDown={(e) => { if (e.key === 'Enter') setPassword(u.id); }}
                          autoComplete="new-password"
                        />
                        <button className="btn sm" onClick={() => setPassword(u.id)} disabled={pwBusy || pwInput.length < 8}>
                          {pwBusy ? 'Saving…' : 'Set password'}
                        </button>
                      </div>
                    </div>

                    {/* Actions */}
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <button
                        className={`btn sm ${u.is_admin ? 'ghost' : ''}`}
                        onClick={() => toggleAdmin(u.id, u.is_admin)}
                        disabled={actionBusy[u.id]}
                      >
                        <ShieldCheck size={12} />
                        {u.is_admin ? 'Revoke admin' : 'Make admin'}
                      </button>
                      <button
                        className="btn sm danger"
                        onClick={() => deleteUser(u.id, u.username)}
                        disabled={actionBusy[u.id]}
                      >
                        <Trash2 size={12} /> Delete user
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* -------------------- Teams tab -------------------- */

function TeamsTab({ teams, onRefresh }) {
  const toast = useToast();
  const [expandedId, setExpandedId] = useState(null);

  const deleteTeam = async (team) => {
    if (!window.confirm(`Delete "${team.name}"? Projects will become personal — nothing is deleted.`)) return;
    try {
      await adminDeleteTeam(team.id);
      toast('Team deleted', 'ok');
      setExpandedId(null);
      onRefresh();
    } catch (err) {
      toast(err?.response?.data?.error || 'Failed to delete team', 'err');
    }
  };

  const COLS = '1fr 130px 80px 80px 80px 16px';

  return (
    <div className="admin-table">
      <div className="admin-table-head" style={{ gridTemplateColumns: COLS }}>
        <span>Team</span>
        <span>Created by</span>
        <span>Members</span>
        <span>Projects</span>
        <span>Created</span>
        <span />
      </div>

      {teams.length === 0 ? (
        <div style={{ padding: '32px 18px', textAlign: 'center', color: 'var(--fg-3)', fontSize: 13 }}>
          No teams yet. Create one from the Teams page.
        </div>
      ) : teams.map((t) => {
        const isOpen = expandedId === t.id;

        return (
          <div key={t.id} className="admin-row">
            <div
              className={`admin-row-summary ${isOpen ? 'open' : ''}`}
              style={{ gridTemplateColumns: COLS }}
              onClick={() => setExpandedId(isOpen ? null : t.id)}
            >
              <div style={{ fontWeight: 500, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {t.name}
              </div>
              <span style={{ fontSize: 12, color: 'var(--fg-2)' }}>{t.created_by_username || '—'}</span>
              <span style={{ fontSize: 12, color: 'var(--fg-2)' }}>{t.member_count}</span>
              <span style={{ fontSize: 12, color: 'var(--fg-2)' }}>{t.project_count}</span>
              <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>{relTime(t.created_at)}</span>
              <ChevronDown size={13} color="var(--fg-3)" style={{ transform: isOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s', flexShrink: 0 }} />
            </div>

            {isOpen && (
              <div className="admin-row-detail">
                {/* Members */}
                <div>
                  <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--fg-3)', marginBottom: 8 }}>Members</div>
                  {t.members.length === 0 ? (
                    <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>No members</span>
                  ) : (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {t.members.map((m) => (
                        <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 8px 3px 6px', background: 'var(--bg-2)', borderRadius: 'var(--r-md)', border: '1px solid var(--border)', fontSize: 12 }}>
                          {m.avatar_url
                            ? <img src={m.avatar_url} alt="" style={{ width: 16, height: 16, borderRadius: '50%' }} />
                            : <div style={{ width: 16, height: 16, borderRadius: '50%', background: 'var(--bg-3)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, fontWeight: 600 }}>
                                {((m.name || m.username) || '?').slice(0, 1).toUpperCase()}
                              </div>
                          }
                          <span>{m.name || m.username}</span>
                          <span className={`role-badge ${m.role}`} style={{ padding: '1px 5px', fontSize: 9 }}>{m.role}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Actions */}
                <div style={{ display: 'flex', gap: 8 }}>
                  <Link to={`/teams/${t.id}`} className="btn sm ghost" style={{ textDecoration: 'none' }}>
                    <ExternalLink size={12} /> Manage members
                  </Link>
                  <button className="btn sm danger" onClick={() => deleteTeam(t)}>
                    <Trash2 size={12} /> Delete team
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* -------------------- Main Admin page -------------------- */

export default function Admin({ user }) {
  const navigate = useNavigate();
  const toast = useToast();

  const [tab, setTab] = useState('overview');
  const [stats, setStats] = useState(null);
  const [projects, setProjects] = useState([]);
  const [users, setUsers] = useState([]);
  const [teams, setTeams] = useState([]);
  const [resources, setResources] = useState({ containers: [], totals: {} });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (user !== undefined && !user?.is_admin) {
      toast('Admin access required', 'err');
      navigate('/');
    }
  }, [user, navigate, toast]);

  const loadAll = useCallback(async () => {
    try {
      const [s, p, u, t, r] = await Promise.all([
        getAdminStats(),
        getAdminProjects(),
        getAdminUsers(),
        getAdminTeams(),
        getAdminResources(),
      ]);
      setStats(s);
      setProjects(p);
      setUsers(u);
      setTeams(t);
      setResources(r);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAll();
    const interval = setInterval(() => {
      getAdminResources().then(setResources).catch(() => {});
    }, 10000);
    return () => clearInterval(interval);
  }, [loadAll]);

  if (!user?.is_admin) return null;

  const TABS = [
    { id: 'overview',     label: 'Overview',     icon: <Activity size={14} /> },
    { id: 'deployments',  label: 'Deployments',  icon: <Box size={14} /> },
    { id: 'users',        label: 'Users',        icon: <Users size={14} /> },
    { id: 'teams',        label: 'Teams',        icon: <Users size={14} /> },
  ];

  return (
    <div>
      <div className="page-head" style={{ marginBottom: 24 }}>
        <div>
          <div className="eyebrow">System</div>
          <h1 style={{ marginTop: 6 }}>Admin</h1>
          <p className="sub">Platform-wide visibility and control.</p>
        </div>
      </div>

      <div className="tab-nav">
        {TABS.map((t) => (
          <button key={t.id} className={`tab-btn ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="loading-center"><span className="spinner" style={{ marginRight: 10 }} /> Loading…</div>
      ) : (
        <>
          {tab === 'overview'    && <Overview stats={stats} resources={resources} />}
          {tab === 'deployments' && <Deployments projects={projects} resources={resources} onRefresh={loadAll} />}
          {tab === 'users'       && <UsersTab users={users} currentUserId={user.id} onRefresh={loadAll} />}
          {tab === 'teams'       && <TeamsTab teams={teams} onRefresh={loadAll} />}
        </>
      )}
    </div>
  );
}
