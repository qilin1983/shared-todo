// Test helpers: load server.js in this process with a throwaway data directory,
// and talk to it over HTTP like the browser does. Each test file runs in its own
// process (node --test), so each file gets its own server and database.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Starts server.js once per process and resolves with its base URL. The server
 * keeps listening until the process exits (run with --test-force-exit).
 */
let started;
export function startServer() {
  started ??= (async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-test-'));
    const port = await freePort();
    Object.assign(process.env, { PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir });
    const log = console.log;
    console.log = () => {}; // silence the start-up banner
    try {
      await import(pathToFileURL(path.join(ROOT, 'server.js')).href);
      const base = `http://127.0.0.1:${port}`;
      // app.listen is asynchronous; wait until it accepts connections.
      for (let i = 0; i < 100; i++) {
        try { await fetch(base + '/api/me'); break; } catch { await new Promise((r) => setTimeout(r, 50)); }
      }
      return { base, dataDir };
    } finally {
      console.log = log;
    }
  })();
  return started;
}

/** A signed-in (or not yet signed-in) HTTP client with its own cookie jar. */
export function client(base) {
  let cookie = '';
  async function request(method, url, { json, form, headers = {}, raw = false } = {}) {
    const opts = { method, headers: { 'X-Requested-With': 'fetch', ...headers }, redirect: 'manual' };
    if (cookie) opts.headers.Cookie = cookie;
    if (json !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = typeof json === 'string' ? json : JSON.stringify(json);
    } else if (form) {
      opts.body = form;
    }
    const res = await fetch(base + url, opts);
    const set = res.headers.getSetCookie();
    for (const c of set) {
      const [pair] = c.split(';');
      const [name, value] = pair.split('=');
      if (name === 'sid') cookie = value ? `sid=${value}` : '';
    }
    if (raw) return res;
    const text = await res.text();
    let body = text;
    try { body = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    return { status: res.status, body, headers: res.headers };
  }
  return {
    get cookie() { return cookie; },
    set cookie(v) { cookie = v; },
    get: (url, o) => request('GET', url, o),
    post: (url, json, o = {}) => request('POST', url, { json, ...o }),
    patch: (url, json, o = {}) => request('PATCH', url, { json, ...o }),
    put: (url, json, o = {}) => request('PUT', url, { json, ...o }),
    del: (url, o) => request('DELETE', url, o),
    request,
  };
}

let userSeq = 0;
/** Registers a fresh user and returns a signed-in client plus the user's id. */
export async function newUser(base, prefix = 'user') {
  const c = client(base);
  const username = `${prefix}${process.pid}_${++userSeq}`.slice(0, 32);
  const res = await c.post('/api/register', { username, password: 'password123' });
  if (res.status !== 201) throw new Error(`register failed: ${JSON.stringify(res.body)}`);
  c.id = res.body.id;
  c.username = username;
  return c;
}

// A 1x1 PNG.
export const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

export function photoForm(fields = {}, files = [{ name: 'a.png', type: 'image/png', data: PNG }], field = 'photos') {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  for (const f of files) fd.append(field, new Blob([f.data], { type: f.type }), f.name);
  return fd;
}
