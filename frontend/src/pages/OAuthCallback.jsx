import React, { useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { loginWithGithub, setAuthToken } from '../api';

export default function OAuthCallback({ setUser }) {
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const code = params.get('code');

    if (code) {
      loginWithGithub(code)
        .then((data) => {
          setAuthToken(data.token);
          setUser(data.user);
          navigate('/');
        })
        .catch((err) => {
          console.error('OAuth failed', err);
          navigate('/login');
        });
    } else {
      navigate('/login');
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
