import axios from 'axios';

const API_URL = 'http://localhost:8000';

export const api = axios.create({
  baseURL: API_URL,
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

export const setAuthToken = (token) => {
  if (token) {
    localStorage.setItem('token', token);
  } else {
    localStorage.removeItem('token');
  }
};

export const getAuthToken = () => {
  return localStorage.getItem('token');
};

export const loginWithGithub = async (code) => {
  const res = await api.post('/auth/github', { code });
  return res.data;
};

export const logout = async () => {
  try {
    await api.post('/auth/logout');
  } catch (e) {
    console.error(e);
  }
  setAuthToken(null);
  window.location.href = '/login';
};

export const fetchMe = async () => {
    const res = await api.get('/auth/me');
    return res.data;
}

export const getProjects = async () => {
  const res = await api.get('/projects');
  return res.data;
};

export const createProject = async (name, repo_url, dockerfile_path = 'Dockerfile', internal_port = null, env_vars = {}) => {
  const res = await api.post('/projects', { name, repo_url, dockerfile_path, internal_port, env_vars });
  return res.data;
};

export const updateProject = async (id, data) => {
  const res = await api.patch(`/projects/${id}`, data);
  return res.data;
};

export const getProject = async (id) => {
  const res = await api.get(`/projects/${id}`);
  return res.data;
};

export const getProjectStatus = async (id) => {
    const res = await api.get(`/projects/${id}/status`);
    return res.data;
}

export const getProjectBuilds = async (id) => {
    const res = await api.get(`/projects/${id}/builds`);
    return res.data;
}

export const deployProject = async (id) => {
  const res = await api.post(`/projects/${id}/deploy`);
  return res.data;
};

export const stopProject = async (id) => {
  const res = await api.post(`/projects/${id}/stop`);
  return res.data;
};

export const restartProject = async (id) => {
  const res = await api.post(`/projects/${id}/restart`);
  return res.data;
};

export const deleteProject = async (id) => {
    const res = await api.delete(`/projects/${id}`);
    return res.data;
};

export const getSSEUrl = (projectId) => {
    const token = getAuthToken();
    return `${API_URL}/projects/${projectId}/logs?token=${token}`;
}

export const getRuntimeLogsUrl = (projectId) => {
    const token = getAuthToken();
    return `${API_URL}/projects/${projectId}/runtime-logs?token=${token}`;
}

export const registerUser = async (name, email, password) => {
    const res = await api.post('/auth/register', { name, email, password });
    return res.data;
};

export const loginWithEmail = async (email, password) => {
    const res = await api.post('/auth/login', { email, password });
    return res.data;
};

export const updateMe = async (data) => {
    const res = await api.patch('/auth/me', data);
    return res.data;
};

export const connectGithub = async (code) => {
    const res = await api.post('/auth/github/connect', { code });
    return res.data;
};

export const disconnectGithub = async () => {
    const res = await api.delete('/auth/github/connect');
    return res.data;
};

export const getTeams = async () => {
    const res = await api.get('/teams');
    return res.data;
};

export const createTeam = async (name) => {
    const res = await api.post('/teams', { name });
    return res.data;
};

export const getTeam = async (id) => {
    const res = await api.get(`/teams/${id}`);
    return res.data;
};

export const deleteTeam = async (id) => {
    const res = await api.delete(`/teams/${id}`);
    return res.data;
};

export const getTeamMembers = async (id) => {
    const res = await api.get(`/teams/${id}/members`);
    return res.data;
};

export const addTeamMember = async (teamId, userId, role = 'member') => {
    const res = await api.post(`/teams/${teamId}/members`, { user_id: userId, role });
    return res.data;
};

export const removeTeamMember = async (teamId, userId) => {
    const res = await api.delete(`/teams/${teamId}/members/${userId}`);
    return res.data;
};

export const searchUsers = async (q) => {
    const res = await api.get('/users/search', { params: { q } });
    return res.data;
};
