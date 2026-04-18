import React, { useEffect, useState, useCallback } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { Trash2, UserMinus, Box } from 'lucide-react';
import { getTeam, deleteTeam, addTeamMember, removeTeamMember, searchUsers } from '../api';
import { useToast } from '../toast';

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

export default function TeamDetails({ user: appUser }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();

  const [team, setTeam] = useState(null);
  const [loading, setLoading] = useState(true);

  const [searchQ, setSearchQ] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [addingId, setAddingId] = useState(null);

  const load = useCallback(async () => {
    try {
      const data = await getTeam(id);
      setTeam(data);
    } catch (err) {
      if (err?.response?.status === 403 || err?.response?.status === 404) {
        navigate('/teams');
      }
    } finally {
      setLoading(false);
    }
  }, [id, navigate]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!searchQ.trim()) { setSearchResults([]); return; }
    const t = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await searchUsers(searchQ.trim());
        const memberIds = new Set(team?.members?.map((m) => m.user_id) || []);
        setSearchResults(res.filter((u) => !memberIds.has(u.id)));
      } catch {
        setSearchResults([]);
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [searchQ, team?.members]);

  const handleAdd = async (userId) => {
    setAddingId(userId);
    try {
      await addTeamMember(id, userId);
      await load();
      setSearchQ('');
      setSearchResults([]);
      toast('Member added', 'ok');
    } catch (err) {
      toast(err?.response?.data?.error || 'Failed to add member', 'err');
    } finally {
      setAddingId(null);
    }
  };

  const handleRemove = async (userId) => {
    if (!window.confirm('Remove this member from the team?')) return;
    try {
      await removeTeamMember(id, userId);
      await load();
      toast('Member removed', 'ok');
    } catch (err) {
      toast(err?.response?.data?.error || 'Failed to remove member', 'err');
    }
  };

  const handleDelete = async () => {
    if (!window.confirm(`Delete team "${team.name}"? This cannot be undone.`)) return;
    try {
      await deleteTeam(id);
      toast('Team deleted', 'ok');
      navigate('/teams');
    } catch (err) {
      toast(err?.response?.data?.error || 'Failed to delete team', 'err');
    }
  };

  const myRole = team?.my_role;
  const canManage = appUser?.is_admin || myRole === 'admin';

  if (loading) {
    return (
      <div>
        <div className="skeleton" style={{ height: 20, width: 200, marginBottom: 32 }} />
        <div className="skeleton" style={{ height: 180, marginBottom: 16 }} />
      </div>
    );
  }

  if (!team) return null;

  const projects = team.projects || [];

  return (
    <>
      <div className="page-head" style={{ marginBottom: 28 }}>
        <div>
          <div className="eyebrow">
            <Link to="/teams" style={{ color: 'var(--fg-3)', textDecoration: 'none' }}>Teams</Link>
            {' / '}
            {team.name}
          </div>
          <h1 style={{ marginTop: 6 }}>{team.name}</h1>
          <p className="sub">{team.member_count} member{team.member_count !== 1 ? 's' : ''}</p>
        </div>
        {canManage && (
          <button className="btn danger" onClick={handleDelete}>
            <Trash2 size={14} /> Delete team
          </button>
        )}
      </div>

      {/* Members */}
      <div className="profile-section" style={{ marginBottom: 24 }}>
        <div className="profile-section-head">
          <h3>Members</h3>
        </div>
        <div className="profile-section-body" style={{ padding: 0 }}>
          {team.members.map((m) => (
            <div key={m.id} className="member-row">
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                {m.avatar_url ? (
                  <img src={m.avatar_url} alt="" style={{ width: 28, height: 28, borderRadius: '50%' }} />
                ) : (
                  <div style={{
                    width: 28, height: 28, borderRadius: '50%',
                    background: 'var(--bg-3)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 12, fontWeight: 600, color: 'var(--fg-1)',
                  }}>
                    {((m.name || m.username) || '?').slice(0, 1).toUpperCase()}
                  </div>
                )}
                <div>
                  <div style={{ fontSize: 13, fontWeight: 500 }}>{m.name || m.username}</div>
                  {m.name && <div style={{ fontSize: 11, color: 'var(--fg-3)' }}>@{m.username}</div>}
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span className={`role-badge ${m.role}`}>{m.role}</span>
                {canManage && m.user_id !== appUser?.id && (
                  <button
                    className="icon-btn"
                    title="Remove member"
                    onClick={() => handleRemove(m.user_id)}
                  >
                    <UserMinus size={13} />
                  </button>
                )}
              </div>
            </div>
          ))}

          {canManage && (
            <div style={{ padding: '12px 18px', borderTop: '1px solid var(--border)' }}>
              <div className="field" style={{ marginBottom: 0 }}>
                <label>Add member</label>
                <input
                  className="input"
                  placeholder="Search by username or name…"
                  value={searchQ}
                  onChange={(e) => setSearchQ(e.target.value)}
                />
              </div>
              {(searchResults.length > 0 || searching) && (
                <div style={{
                  marginTop: 6,
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--r-md)',
                  overflow: 'hidden',
                  background: 'var(--bg-1)',
                }}>
                  {searching && (
                    <div style={{ padding: '10px 14px', fontSize: 12, color: 'var(--fg-3)' }}>
                      Searching…
                    </div>
                  )}
                  {searchResults.map((u) => (
                    <div key={u.id} style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      padding: '8px 14px', borderBottom: '1px solid var(--border)',
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        {u.avatar_url ? (
                          <img src={u.avatar_url} alt="" style={{ width: 22, height: 22, borderRadius: '50%' }} />
                        ) : (
                          <div style={{
                            width: 22, height: 22, borderRadius: '50%',
                            background: 'var(--bg-3)',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            fontSize: 10, fontWeight: 600,
                          }}>
                            {((u.name || u.username) || '?').slice(0, 1).toUpperCase()}
                          </div>
                        )}
                        <span style={{ fontSize: 13 }}>{u.name || u.username}</span>
                        {u.name && <span style={{ fontSize: 11, color: 'var(--fg-3)' }}>@{u.username}</span>}
                      </div>
                      <button
                        className="btn sm"
                        disabled={addingId === u.id}
                        onClick={() => handleAdd(u.id)}
                      >
                        {addingId === u.id ? 'Adding…' : 'Add'}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Team projects */}
      <div className="profile-section">
        <div className="profile-section-head">
          <h3>Projects</h3>
        </div>
        <div className="profile-section-body">
          {projects.length === 0 ? (
            <p className="muted" style={{ fontSize: 13 }}>No projects assigned to this team yet.</p>
          ) : (
            <div className="projects" style={{ marginTop: 0 }}>
              {projects.map((p) => (
                <Link to={`/projects/${p.id}`} key={p.id} className="project-card">
                  <div className="head">
                    <div className="name truncate">
                      <Box size={14} color="var(--fg-3)" />
                      <span>{p.name}</span>
                    </div>
                    <span className={`status ${p.status}`}>
                      <span className="dot" />{p.status}
                    </span>
                  </div>
                  <div className="foot" style={{ marginTop: 'auto' }}>
                    <span className="port">:{p.port}</span>
                    <span>{relTime(p.created_at)}</span>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
