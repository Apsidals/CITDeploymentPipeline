import React, { useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { loginWithGithub, connectGithub, setAuthToken, getAuthToken, fetchMe } from '../api';

export default function OAuthCallback({ setUser }) {
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const code = params.get('code');

    if (!code) {
      navigate('/login');
      return;
    }

    const existingToken = getAuthToken();

    if (existingToken) {
      // Already logged in — this is a GitHub connect request from Profile
      connectGithub(code)
        .then((user) => {
          if (setUser) setUser(user);
          navigate('/profile');
        })
        .catch((err) => {
          console.error('GitHub connect failed', err);
          navigate('/profile?error=github_conflict');
        });
    } else {
      loginWithGithub(code)
        .then((data) => {
          setAuthToken(data.token);
          if (setUser) setUser(data.user);
          navigate('/');
        })
        .catch((err) => {
          console.error('OAuth failed', err);
          navigate('/login');
        });
    }
  }, [location, navigate, setUser]);

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="brand-mark">CD</div>
        <h1>Signing you in</h1>
        <p>Exchanging your GitHub session — this takes a moment.</p>
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <span className="spinner" />
        </div>
      </div>
    </div>
  );
}
