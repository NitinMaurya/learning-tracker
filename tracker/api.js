// Thin client over server.py's SQLite JSON API.
// Every statement hits the real database file — there is no in-browser copy.

export const TABLES = ['phases', 'breaks', 'claims', 'confusions', 'parked', 'sources', 'sessions'];

export const q = (v) =>
  v === null || v === undefined ? 'NULL' : "'" + String(v).replace(/'/g, "''") + "'";

export const uid = () =>
  Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9);

export const today = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};
export const now = () => new Date().toISOString();

async function post(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error || 'request failed');
  return data;
}

export async function all(sql, params = []) {
  return (await post('/api/sql', { sql, params })).rows;
}

export async function run(sql, params = []) {
  return post('/api/sql', { sql, params });
}

// Writes land in the file immediately; kept so callers read the same as before.
export async function save() {}

export async function exportJson() {
  const res = await fetch('/api/export');
  return res.json();
}

export async function load(data) {
  await post('/api/restore', data);
}

export async function boot() {
  await all('SELECT count(*) AS n FROM phases');
}

/* ---------- documents ---------- */

const b64 = (file) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });

export async function upload(file, phaseId) {
  return post('/api/upload', {
    phase_id: phaseId,
    name: file.name,
    mime: file.type,
    data: await b64(file),
  });
}

export async function deleteDoc(id) {
  return post('/api/delete-doc', { id });
}

export async function deleteRoadmap(id) {
  return post('/api/delete-roadmap', { id });
}

/* ---------- roadmap import ---------- */

export async function importParse(markdown, name) {
  return post('/api/import-parse', { markdown, name });
}

export async function importCommit(proposal) {
  return post('/api/import-commit', { proposal });
}
