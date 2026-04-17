import React, { useEffect, useState } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate, Link } from 'react-router-dom';
import { LogOut } from 'lucide-react';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import ProjectDetails from './pages/ProjectDetails';
import OAuthCallback from './pages/OAuthCallback';
import { getAuthToken, fetchMe, logout } from './api';
import { ToastProvider } from './toast';
import './index.css';

/* -------------------- Shell -------------------- */

function Topbar({ user }) {
  return (
    <header className="topbar">
      <Link to="/" className="brand">
        <span className="brand-mark">CD</span>
        <span>CIT Deploy</span>
        <span className="brand-divider" />
        <span className="muted" style={{ fontWeight: 500, fontSize: 13 }}>Phase 1</span>
      </Link>
      <div className="topbar-right">
        {user && (
          <>
            <div className="user-chip">
              {user.avatar_url ? (
                <img src={user.avatar_url} alt="" />
              ) : (
                <span className="brand-mark" style={{ width: 22, height: 22 }}>
                  {(user.username || '?').slice(0, 1).toUpperCase()}
                </span>
              )}
              <span className="hidden-sm">{user.username}</span>
            </div>
            <button className="btn ghost" onClick={() => logout()} title="Sign out">
              <LogOut size={14} />
              <span className="hidden-sm">Sign out</span>
            </button>
          </>
        )}
      </div>
    </header>
  );
}

function Protected({ children, user }) {
  if (user === undefined) {
    return (
      <div className="loading-center">
        <span className="spinner" style={{ marginRight: 10 }} /> Authenticating…
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

function Shell({ user, children }) {
  return (
    <div className="app">
      <Topbar user={user} />
      <main className="page">{children}</main>
    </div>
  );
}

/* -------------------- App -------------------- */

export default function App() {
  const [user, setUser] = useState(undefined);

  useEffect(() => {
    const token = getAuthToken();
    if (token) {
      fetchMe().then((u) => setUser(u)).catch(() => setUser(null));
    } else {
      setUser(null);
    }
  }, []);

  return (
    <ToastProvider>
      <Router>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/auth/github" element={<OAuthCallback setUser={setUser} />} />

          <Route
            path="/"
            element={
              <Protected user={user}>
                <Shell user={user}>
                  <Dashboard />
                </Shell>
              </Protected>
            }
          />
          <Route
            path="/projects/:id"
            element={
              <Protected user={user}>
                <Shell user={user}>
                  <ProjectDetails />
                </Shell>
              </Protected>
            }
          />
        </Routes>
      </Router>
    </ToastProvider>
  );
}
