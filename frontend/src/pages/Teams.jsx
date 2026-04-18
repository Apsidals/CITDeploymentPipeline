import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Users, X } from 'lucide-react';
import { getTeams, createTeam } from '../api';
import { useToast } from '../toast';

function NewTeamModal({ open, onClose, onCreated }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  useEffect(() => {
    if (!open) return;
    setName('');
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const submit = async (e) => {
    e.preventDefault();
    if (busy || !name.trim()) return;
    setBusy(true);
    try {
      const team = await createTeam(name.trim());
      toast('Team created', 'ok');
      onCreated(team);
    } catch {
      toast('Failed to create team', 'err');
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="head">
          <div>
            <h2>New team</h2>
            <p className="muted" style={{ fontSize: 13, marginTop: 4 }}>
              Invite members and share projects with your team.
            </p>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <X />
          </button>
        </div>
        <div className="body">
          <div className="field">
            <label>Team name</label>
            <input
              className="input"
              autoFocus
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Awesome Team"
            />
          </div>
        </div>
        <div className="actions">
          <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy || !name.trim()}>
            {busy ? <><span className="spinner" /> Creating…</> : 'Create team'}
          </button>
        </div>
      </form>
    </div>
  );
}

export default function Teams({ user }) {
  const [teams, setTeams] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);

  const load = async () => {
    try {
      const data = await getTeams();
      setTeams(data);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Workspace</div>
          <h1 style={{ marginTop: 6 }}>Teams</h1>
          <p className="sub">Collaborate on projects with your classmates.</p>
        </div>
        {user?.is_admin && (
          <button className="btn primary" onClick={() => setShowModal(true)}>
            <Plus size={14} /> New team
          </button>
        )}
      </div>

      {loading ? (
        <div className="projects">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="card" style={{ height: 110 }}>
              <div className="skeleton" style={{ height: 14, width: '40%', marginBottom: 14 }} />
              <div className="skeleton" style={{ height: 12, width: '60%' }} />
            </div>
          ))}
        </div>
      ) : teams.length === 0 ? (
        <div className="empty">
          <Users size={32} />
          <h3>No teams yet</h3>
          <p>{user?.is_admin ? 'Create a team to share projects and collaborate with others.' : 'Ask an admin to add you to a team.'}</p>
          {user?.is_admin && (
            <button className="btn primary" onClick={() => setShowModal(true)}>
              <Plus size={14} /> New team
            </button>
          )}
        </div>
      ) : (
        <div className="projects">
          {teams.map((t) => (
            <Link to={`/teams/${t.id}`} key={t.id} className="project-card">
              <div className="head">
                <div className="name truncate">
                  <Users size={15} color="var(--fg-3)" />
                  <span>{t.name}</span>
                </div>
                <span className="role-badge">{t.my_role}</span>
              </div>
              <div className="repo truncate" style={{ marginTop: 8 }}>
                <span className="muted">{t.member_count} member{t.member_count !== 1 ? 's' : ''}</span>
              </div>
            </Link>
          ))}
        </div>
      )}

      {user?.is_admin && (
        <NewTeamModal
          open={showModal}
          onClose={() => setShowModal(false)}
          onCreated={(team) => {
            setTeams((prev) => [team, ...prev]);
            setShowModal(false);
          }}
        />
      )}
    </>
  );
}
