// Shared helpers, state and the people directory used by every screen.

export const $ = (sel, root = document) => root.querySelector(sel);

/** Tiny element builder. Children that are strings become text nodes (never HTML). */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

/** replaceChildren that, like h(), skips null/false and flattens nested arrays. */
export function fill(el, ...children) {
  el.replaceChildren(...children.flat(Infinity).filter((c) => c != null && c !== false));
}

// Identifies this tab so live updates caused by our own actions can be skipped.
export const CLIENT_ID = Math.random().toString(36).slice(2) + Date.now().toString(36);
export const TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Set by app.js: called when the server says we're signed out. */
export const hooks = { onSignedOut: () => {} };

export async function api(path, { method = 'GET', json, form } = {}) {
  const opts = { method, headers: {} };
  if (method !== 'GET') {
    opts.headers['X-Requested-With'] = 'fetch';
    opts.headers['X-Client-Id'] = CLIENT_ID;
  }
  if (json !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(json);
  } else if (form) {
    opts.body = form;
  }
  const res = await fetch('/api' + path, opts);
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && !['/me', '/login'].includes(path)) hooks.onSignedOut();
    throw new Error(data?.error || `Request failed (${res.status})`);
  }
  return data;
}

let toastTimer;
export function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3500);
}

export async function attempt(fn) {
  try {
    return await fn();
  } catch (err) {
    toast(err.message);
  }
}

export const remember = (key, value) => { try { localStorage.setItem(key, value); } catch {} };
export const recall = (key, fallback) => { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } };

export const isFinePointer = () => matchMedia('(pointer: fine)').matches;

// ---------------------------------------------------------------- dates

export function formatDate(sqlDate) {
  const d = new Date(sqlDate.replace(' ', 'T') + 'Z');
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** "Today 3:00 PM", "Tomorrow 9:00 AM", "Mon, Sep 29, 3:00 PM" */
export function formatWhen(ms) {
  const d = new Date(ms);
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const day = new Date(d); day.setHours(0, 0, 0, 0);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((day - today) / 86400000);
  if (diff === 0) return `Today ${time}`;
  if (diff === 1) return `Tomorrow ${time}`;
  if (diff === -1) return `Yesterday ${time}`;
  const opts = { weekday: 'short', month: 'short', day: 'numeric' };
  if (d.getFullYear() !== today.getFullYear()) opts.year = 'numeric';
  return `${d.toLocaleDateString(undefined, opts)}, ${time}`;
}

/** "just now", "5 min ago", "3 h ago", then a date. */
export function timeAgo(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return formatWhen(ms);
}

// <input type="datetime-local"> works in local time, "YYYY-MM-DDTHH:MM".
export function toLocalInput(ms) {
  if (ms == null) return '';
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export const fromLocalInput = (s) => (s ? new Date(s).getTime() : null);

// ---------------------------------------------------------------- photos

const MAX_PHOTO_MB = 10;
export function acceptImages(fileList) {
  const ok = [];
  for (const f of fileList) {
    if (!f.type.startsWith('image/')) toast(`${f.name || 'File'} is not an image`);
    else if (f.size > MAX_PHOTO_MB * 1024 * 1024) toast(`${f.name} is over ${MAX_PHOTO_MB} MB`);
    else ok.push(f);
  }
  return ok;
}

export function viewPhoto(url) {
  $('#photo-full').src = url;
  $('#photo-dialog').showModal();
}

// ---------------------------------------------------------------- state

export const state = {
  me: null,
  lists: [],
  view: 'dashboard', // 'dashboard' | 'list' | 'search'
  dashboard: null,
  dashScope: recall('dashScope', 'all'), // all | mine | shared | assigned | created
  dashWhen: 'any',                         // any | overdue | today | week
  dashLabel: '',
  currentId: null,
  current: null,
  hideDone: recall('hideDone', '0') === '1',
  onlyMine: false,
  labelFilter: '',
  sort: recall('sort', 'smart'),           // smart | priority | custom
  draftBody: '',     // text typed into the add form, kept across re-renders
  pendingPhotos: [], // File[] waiting to be attached to a new item
  editingItemId: null,
  openThreads: new Set(),  // item ids whose comment thread is expanded
  comments: new Map(),     // item id -> comments[]
  addingSubtaskTo: null,   // item id with the "add sub-task" box open
  reminders: [],
  searchQuery: '',
};

// ---------------------------------------------------------------- people directory

export const people = new Map();

export async function loadPeople() {
  const list = await api('/users');
  people.clear();
  for (const u of list) people.set(u.id, u);
}

export function nameOf(id, fallback = 'someone') {
  if (id === state.me?.id) {
    const me = people.get(id) ?? state.me;
    return me.display_name || me.username;
  }
  const u = people.get(id);
  return u ? u.display_name || u.username : fallback;
}

function initials(name) {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '?') + (parts.length > 1 ? parts.at(-1)[0] : '')).toUpperCase();
}

/** Round avatar: the person's picture if they have one, otherwise coloured initials. */
export function avatar(id, size = 'sm') {
  const u = people.get(id);
  const name = nameOf(id, '?');
  if (u?.avatar_version) {
    return h('img', { class: `avatar ${size}`, src: `/api/users/${id}/avatar?v=${u.avatar_version}`, alt: '', title: name, loading: 'lazy' });
  }
  return h('span', { class: `avatar ${size} hue-${(id ?? 0) % 8}`, title: name, 'aria-hidden': 'true' }, initials(name));
}

/** Avatar + name, e.g. for "assigned to" and comment authors. */
export function person(id, { you = true, size = 'sm', fallback } = {}) {
  const label = you && id === state.me?.id ? 'You' : nameOf(id, fallback);
  return h('span', { class: 'person' }, avatar(id, size), h('span', { class: 'person-name' }, label));
}

// ---------------------------------------------------------------- highlighting

/** Returns text as nodes with case-insensitive matches of `q` wrapped in <mark>. */
export function highlight(text, q) {
  if (!q) return [text];
  const out = [];
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  let i = 0;
  for (;;) {
    const j = lower.indexOf(needle, i);
    if (j < 0) break;
    if (j > i) out.push(text.slice(i, j));
    out.push(h('mark', {}, text.slice(j, j + needle.length)));
    i = j + needle.length;
  }
  out.push(text.slice(i));
  return out;
}
