import fetch from 'node-fetch';

const BASE_URL = process.env.CLOAK_LOCAL_API_URL || 'http://127.0.0.1:49156';
const TOKEN = process.env.CLOAK_LOCAL_API_TOKEN;

const apiRequest = async (path, options = {}) => {
  if (!TOKEN) throw new Error('缺少 CLOAK_LOCAL_API_TOKEN');
  return await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...(options.headers || {})},
  });
};

export async function openProfile(windowId) {
  const response = await apiRequest('/profiles/open', {method: 'POST', body: JSON.stringify({windowId})});
  return await response.json();
}

export async function closeProfile(windowId) {
  const response = await apiRequest('/profiles/close', {method: 'POST', body: JSON.stringify({windowId})});
  return await response.json();
}
