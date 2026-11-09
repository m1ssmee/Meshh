import { useEffect, useRef } from 'react';

async function req(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export const api = {
  project: () => req('GET', '/api/project'),
  gitInit: () => req('POST', '/api/project/git-init'),
  meta: () => req('GET', '/api/meta'),
  config: (patch) => req('PUT', '/api/config', patch),

  agents: () => req('GET', '/api/agents'),
  saveAgent: (agent, prevName) => req('PUT', `/api/agents/${encodeURIComponent(prevName || '_new')}`, agent),
  deleteAgent: (name) => req('DELETE', `/api/agents/${encodeURIComponent(name)}`),
  addTemplate: (template) => req('POST', '/api/agents/from-template', { template }),
  starterTeam: () => req('POST', '/api/agents/starter-team'),

  skills: () => req('GET', '/api/skills'),
  saveSkill: (skill, prevName) => req('PUT', `/api/skills/${encodeURIComponent(prevName || '_new')}`, skill),
  deleteSkill: (name) => req('DELETE', `/api/skills/${encodeURIComponent(name)}`),

  guidelines: () => req('GET', '/api/guidelines'),
  saveGuidelines: (text) => req('PUT', '/api/guidelines', { text }),

  runs: () => req('GET', '/api/runs'),
  run: (id) => req('GET', `/api/runs/${id}`),
  createRun: (task) => req('POST', '/api/runs', { task }),
  updatePlan: (id, plan) => req('PUT', `/api/runs/${id}/plan`, plan),
  approve: (id) => req('POST', `/api/runs/${id}/approve`),
  stopRun: (id) => req('POST', `/api/runs/${id}/stop`),
  stopTask: (id, task) => req('POST', `/api/runs/${id}/tasks/${task}/stop`),
  message: (id, task, text) => req('POST', `/api/runs/${id}/tasks/${task}/message`, { text }),
  diff: (id) => req('GET', `/api/runs/${id}/diff`),
  apply: (id, body) => req('POST', `/api/runs/${id}/apply`, body),
  discard: (id) => req('POST', `/api/runs/${id}/discard`),
  deleteRun: (id) => req('DELETE', `/api/runs/${id}`),
};

// Live updates from the server. Reconnects automatically.
export function useLive(onMessage) {
  const handler = useRef(onMessage);
  handler.current = onMessage;
  useEffect(() => {
    let ws;
    let closed = false;
    let retry;
    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/ws`);
      ws.onmessage = (e) => {
        try {
          handler.current(JSON.parse(e.data));
        } catch {}
      };
      ws.onclose = () => {
        if (!closed) retry = setTimeout(connect, 1500);
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      ws?.close();
    };
  }, []);
}

export function formatTokens(n) {
  if (!n) return '0';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

export function timeAgo(iso) {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}
