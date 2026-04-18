import React, { useEffect, useState } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { Pencil } from 'lucide-react';
import { fetchMe, updateMe, disconnectGithub, getTeams } from '../api';
import { useToast } from '../toast';

const GithubIcon = ({ size = 15 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M12 .5C5.65.5.5 5.65.5 12a11.5 11.5 0 0 0 7.86 10.92c.58.11.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.56-.29-5.25-1.28-5.25-5.7 0-1.26.45-2.29 1.18-3.1-.12-.29-.51-1.46.11-3.04 0 0 .97-.31 3.18 1.18a11.08 11.08 0 0 1 5.78 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.58.23 2.75.11 3.04.74.81 1.18 1.84 1.18 3.1 0 4.43-2.7 5.41-5.27 5.69.42.36.79 1.06.79 2.14v3.17c0 .31.21.68.8.56A11.5 11.5 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z" />
  </svg>
);

export default function Profile({ user: appUser, setUser }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const [profile, setProfile] = useState(appUser || null);
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState('');
  const [disconnecting, setDisconnecting] = useState(false);
  const [teams, setTeams] = useState([]);

  useEffect(() => {
    fetchMe().then((u) => {
      setProfile(u);
      if (setUser) setUser(u);
    }).catch(() => {});
    getTeams().then(setTeams).catch(() => {});
  }, []);

  useEffect(() => {
    if (searchParams.get('error') === 'github_conflict') {
      toast('That GitHub account is already linked to another user', 'err');
    }
  }, []);

  const saveName = async () => {
    setEditingName(false);
    const val = nameInput.trim();
    if (val === (profile?.name || '')) return;
    try {
      const updated = await updateMe({ name: val || null });
      setProfile(updated);
      if (setUser) setUser(updated);
      toast('Name updated', 'ok');
    } catch {
      toast('Failed to update name', 'err');
    }
  };

  const handleConnectGithub = () => {
    const rawClientId = import.meta.env.VITE_GITHUB_CLIENT_ID || 'Ov23li0BK7zb87XjJzf8';
    window.location.href = `https://github.com/login/oauth/authorize?client_id=${rawClientId.trim()}&scope=repo`;
  };

  const handleDisconnectGithub = async () => {
    if (!window.confirm('Disconnect your GitHub account?')) return;
    setDisconnecting(true);
    try {
      const updated = await disconnectGithub();
      setProfile(updated);
      if (setUser) setUser(updated);
      toast('GitHub disconnected', 'ok');
    } catch (err) {
      toast(err?.response?.data?.error || 'Failed to disconnect GitHub', 'err');
    } finally {
      setDisconnecting(false);
    }
  };

  if (!profile) {
    return (
      <div>
        <div className="skeleton" style={{ height: 28, width: 140, marginBottom: 32 }} />
        <div className="skeleton" style={{ height: 120, marginBottom: 16 }} />
        <div className="skeleton" style={{ height: 100 }} />
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 560 }}>
      <div style={{ marginBottom: 28 }}>
        <h1 style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          Profile
          {profile.is_admin && <span className="badge-admin">Admin</span>}
        </h1>
        <p style={{ marginTop: 6 }}>Manage your account settings and GitHub connection.</p>
      </div>

      {/* Account info */}
      <div className="profile-section">
        <div className="profile-section-head">
          <h3>Account</h3>
        </div>
        <div className="profile-section-body">
          <div className="field">
            <label>Display name</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {editingName ? (
                <input
                  className="input"
                  style={{ flex: 1 }}
                  autoFocus
                  autoComplete="name"
                  value={nameInput}
                  onChange={(e) => setNameInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') saveName();
                    if (e.key === 'Escape') setEditingName(false);
                  }}
                  onBlur={saveName}
                />
              ) : (
                <>
                  <span style={{ flex: 1, fontSize: 13, color: 'var(--fg-0)' }}>
                    {profile.name || <span className="muted">Not set</span>}
                  </span>
                  <button
                    className="icon-btn"
                    style={{ width: 26, height: 26 }}
                    onClick={() => { setNameInput(profile.name || ''); setEditingName(true); }}
                    title="Edit name"
                  >
                    <Pencil size={12} />
                  </button>
                </>
              )}
            </div>
          </div>

          <div className="field" style={{ marginTop: 12 }}>
            <label>Username</label>
            <span style={{ fontSize: 13, color: 'var(--fg-1)', fontFamily: 'var(--font-mono)' }}>
              {profile.username}
            </span>
          </div>

          {profile.email && (
            <div className="field" style={{ marginTop: 12 }}>
              <label>Email</label>
              <span style={{ fontSize: 13, color: 'var(--fg-1)' }}>{profile.email}</span>
            </div>
          )}
        </div>
      </div>

      {/* GitHub connection */}
      <div className="profile-section" style={{ marginTop: 16 }}>
        <div className="profile-section-head">
          <h3 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <GithubIcon size={15} /> GitHub
          </h3>
        </div>
        <div className="profile-section-body">
          {profile.github_connected ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <div>
                <span className="status running" style={{ fontSize: 11 }}>
                  <span className="dot" /> Connected
                </span>
                <p style={{ marginTop: 6, fontSize: 12 }}>
                  Your GitHub account is linked. You can use "Continue with GitHub" to sign in.
                </p>
              </div>
              <button
                className="btn danger sm"
                onClick={handleDisconnectGithub}
                disabled={disconnecting}
              >
                {disconnecting ? 'Disconnecting…' : 'Disconnect'}
              </button>
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <div>
                <span className="status stopped" style={{ fontSize: 11 }}>
                  <span className="dot" /> Not connected
                </span>
                <p style={{ marginTop: 6, fontSize: 12 }}>
                  Link your GitHub account to enable OAuth login and private repo access.
                </p>
              </div>
              <button className="btn sm" onClick={handleConnectGithub}>
                <GithubIcon size={13} /> Connect GitHub
              </button>
            </div>
          )}
        </div>
      </div>
      {/* My Teams */}
      <div className="profile-section" style={{ marginTop: 16 }}>
        <div className="profile-section-head">
          <h3>My Teams</h3>
        </div>
        <div className="profile-section-body">
          {teams.length === 0 ? (
            <p style={{ fontSize: 13, color: 'var(--fg-3)' }}>
              You're not in any teams yet.{' '}
              <Link to="/teams" style={{ color: 'var(--fg-1)' }}>Create one</Link>
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {teams.map((t) => (
                <Link
                  key={t.id}
                  to={`/teams/${t.id}`}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    textDecoration: 'none', color: 'inherit', fontSize: 13,
                    padding: '8px 0', borderBottom: '1px solid var(--border)',
                  }}
                >
                  <span style={{ fontWeight: 500 }}>{t.name}</span>
                  <span className={`role-badge ${t.my_role}`}>{t.my_role}</span>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
