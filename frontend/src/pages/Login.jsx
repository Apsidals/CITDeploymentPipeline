import React from 'react';

const GithubIcon = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M12 .5C5.65.5.5 5.65.5 12a11.5 11.5 0 0 0 7.86 10.92c.58.11.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.56-.29-5.25-1.28-5.25-5.7 0-1.26.45-2.29 1.18-3.1-.12-.29-.51-1.46.11-3.04 0 0 .97-.31 3.18 1.18a11.08 11.08 0 0 1 5.78 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.58.23 2.75.11 3.04.74.81 1.18 1.84 1.18 3.1 0 4.43-2.7 5.41-5.27 5.69.42.36.79 1.06.79 2.14v3.17c0 .31.21.68.8.56A11.5 11.5 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z" />
  </svg>
);

export default function Login() {
  const handleLogin = () => {
    const rawClientId = import.meta.env.VITE_GITHUB_CLIENT_ID || 'Ov23li0BK7zb87XjJzf8';
    const CLIENT_ID = rawClientId.trim();
    window.location.href = `https://github.com/login/oauth/authorize?client_id=${CLIENT_ID}&scope=repo`;
  };

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="brand-mark">CD</div>
        <h1>Welcome to CIT Deploy</h1>
        <p>Sign in to deploy, manage, and monitor your class projects on the CIT server.</p>

        <button className="btn primary block" onClick={handleLogin} style={{ padding: '12px 16px', fontSize: 14 }}>
          <GithubIcon size={16} />
          Continue with GitHub
        </button>

        <div className="auth-footer">
          By continuing, you agree to deploy only code you own or are authorized to deploy.
        </div>
      </div>
    </div>
  );
}
