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

export const createProject = async (name, repo_url, dockerfile_path = 'Dockerfile') => {
  const res = await api.post('/projects', { name, repo_url, dockerfile_path });
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
