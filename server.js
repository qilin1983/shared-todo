import express from 'express';
import multer from 'multer';
import webpush from 'web-push';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
// Set COOKIE_SECURE=1 when serving over HTTPS (recommended for anything beyond localhost).
const COOKIE_SECURE = process.env.COOKIE_SECURE === '1';
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'image/heif': '.heif',
};

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---------------------------------------------------------------- database

const db = new DatabaseSync(path.join(DATA_DIR, 'todo.db'));
db.exec(`
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS lists (
    id         INTEGER PRIMARY KEY,
    owner_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title      TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS list_shares (
    list_id  INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
    user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    can_edit INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (list_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS items (
    id         INTEGER PRIMARY KEY,
    list_id    INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
    body       TEXT NOT NULL DEFAULT '',
    done       INTEGER NOT NULL DEFAULT 0,
    due_at      INTEGER,            -- deadline, epoch ms
    remind_at   INTEGER,            -- when to remind, epoch ms
    reminded_at INTEGER,            -- when the push reminder went out
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS photos (
    id         INTEGER PRIMARY KEY,
    item_id    INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    filename   TEXT NOT NULL,
    mime       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS reminder_acks (
    item_id   INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    remind_at INTEGER NOT NULL,
    PRIMARY KEY (item_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint   TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    p256dh     TEXT NOT NULL,
    auth       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_items_remind ON items(remind_at) WHERE reminded_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_items_list ON items(list_id);
  CREATE INDEX IF NOT EXISTS idx_photos_item ON photos(item_id);
  CREATE INDEX IF NOT EXISTS idx_shares_user ON list_shares(user_id);
`);

// Columns added after the first release — add them to existing databases.
const ITEM_MIGRATIONS = {
  repeat: "TEXT NOT NULL DEFAULT 'none'",      // none | daily | weekdays | weekly | monthly | yearly
  repeat_anchor: 'INTEGER',                   // first due date of the series (keeps "31st" monthly stable)
  tz: 'TEXT',                                 // creator's time zone, for calendar-correct repeats
  last_done_at: 'INTEGER',                    // last time a repeating item was completed
  assigned_to: 'INTEGER REFERENCES users(id) ON DELETE SET NULL',
};
const itemCols = new Set(db.prepare('PRAGMA table_info(items)').all().map((c) => c.name));
for (const [col, def] of Object.entries(ITEM_MIGRATIONS)) {
  if (!itemCols.has(col)) db.exec(`ALTER TABLE items ADD COLUMN ${col} ${def}`);
}
db.exec('CREATE INDEX IF NOT EXISTS idx_items_assigned ON items(assigned_to)');

db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());

function tx(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function removeFiles(filenames) {
  for (const name of filenames) {
    fs.rm(path.join(UPLOAD_DIR, path.basename(name)), { force: true }, () => {});
  }
}

// ---------------------------------------------------------------- auth helpers

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [saltHex, hashHex] = stored.split(':');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

// Used to keep login timing the same whether or not the username exists.
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .run(sha256(token), userId, Date.now() + SESSION_MS);
  res.cookie('sid', token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: COOKIE_SECURE,
    maxAge: SESSION_MS,
    path: '/',
  });
}

// Simple in-memory brute-force protection for sign-in.
const failedLogins = new Map();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILS = 10;

function loginKey(req, username) {
  return `${req.ip}|${username.toLowerCase()}`;
}

function checkLoginRate(key) {
  const entry = failedLogins.get(key);
  if (entry && entry.until > Date.now() && entry.count >= LOGIN_MAX_FAILS) {
    throw new HttpError(429, 'Too many failed attempts. Try again in a few minutes.');
  }
}

function recordLoginFailure(key) {
  const entry = failedLogins.get(key);
  if (!entry || entry.until <= Date.now()) {
    failedLogins.set(key, { count: 1, until: Date.now() + LOGIN_WINDOW_MS });
  } else {
    entry.count += 1;
  }
}

// ---------------------------------------------------------------- access control

/** Returns 'owner' | 'edit' | 'view' | null for the given user on the given list. */
function listRole(listId, userId) {
  const row = db.prepare(`
    SELECT l.owner_id, s.can_edit
    FROM lists l
    LEFT JOIN list_shares s ON s.list_id = l.id AND s.user_id = ?
    WHERE l.id = ?`).get(userId, listId);
  if (!row) return null;
  if (row.owner_id === userId) return 'owner';
  if (row.can_edit === null) return null;
  return row.can_edit ? 'edit' : 'view';
}

const canEdit = (role) => role === 'owner' || role === 'edit';

/** Everyone who can see a list: the owner plus the people it's shared with. */
function listMembers(listId) {
  return db.prepare(`
    SELECT owner_id AS id FROM lists WHERE id = ?
    UNION SELECT user_id FROM list_shares WHERE list_id = ?`).all(listId, listId).map((r) => r.id);
}

/** Clear assignments pointing at people who no longer have access to the list. */
function dropStaleAssignments(listId) {
  db.prepare(`
    UPDATE items SET assigned_to = NULL
    WHERE list_id = ? AND assigned_to IS NOT NULL AND assigned_to NOT IN (
      SELECT owner_id FROM lists WHERE id = ? UNION SELECT user_id FROM list_shares WHERE list_id = ?)`)
    .run(listId, listId, listId);
}

// ---------------------------------------------------------------- repeating to-dos

const REPEATS = ['none', 'daily', 'weekdays', 'weekly', 'monthly', 'yearly'];
const DAY_MS = 86400000;

function validTimeZone(tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock parts of an instant in a time zone. */
function partsInTz(ms, tz) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  });
  const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second };
}

/** Instant for wall-clock parts in a time zone (day/month overflow is normalised). */
function fromTzParts({ y, m, d, h, mi, s }, tz) {
  const wall = Date.UTC(y, m - 1, d, h, mi, s);
  const offsetAt = (ms) => {
    const p = partsInTz(ms, tz);
    return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
  };
  let ms = wall - offsetAt(wall);
  ms = wall - offsetAt(ms); // second pass settles DST transitions
  return ms;
}

/**
 * Next due date for a repeating item: the first occurrence of the series that is after
 * both the current due date and now (so a long-overdue daily chore jumps to tomorrow,
 * not to yesterday).
 */
function nextOccurrence(item, now = Date.now()) {
  const tz = validTimeZone(item.tz) ? item.tz : 'UTC';
  const anchorMs = item.repeat_anchor ?? item.due_at;
  const a = partsInTz(anchorMs, tz);
  const floor = Math.max(item.due_at, now);

  if (item.repeat === 'weekdays') {
    const start = partsInTz(floor, tz);
    for (let i = 0; i < 10; i++) {
      const day = new Date(Date.UTC(start.y, start.m - 1, start.d + i));
      const dow = day.getUTCDay();
      if (dow === 0 || dow === 6) continue;
      const ms = fromTzParts({ y: day.getUTCFullYear(), m: day.getUTCMonth() + 1, d: day.getUTCDate(), h: a.h, mi: a.mi, s: a.s }, tz);
      if (ms > floor) return ms;
    }
  }

  const approx = { daily: DAY_MS, weekly: 7 * DAY_MS, monthly: 31 * DAY_MS, yearly: 366 * DAY_MS }[item.repeat];
  const kStart = Math.max(1, Math.floor((floor - anchorMs) / approx));
  for (let k = kStart; k < kStart + 1000; k++) {
    let p;
    if (item.repeat === 'daily') p = { ...a, d: a.d + k };
    else if (item.repeat === 'weekly') p = { ...a, d: a.d + 7 * k };
    else {
      const months = item.repeat === 'monthly' ? k : 12 * k;
      const first = new Date(Date.UTC(a.y, a.m - 1 + months, 1));
      const y = first.getUTCFullYear();
      const m = first.getUTCMonth() + 1;
      const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
      p = { ...a, y, m, d: Math.min(a.d, daysInMonth) }; // 31st → 30th/28th in short months
    }
    const ms = fromTzParts(p, tz);
    if (ms > floor) return ms;
  }
  return item.due_at + approx; // unreachable in practice
}

/**
 * Resolves the list for a request (from :listId, :itemId or :photoId) and checks the
 * caller's role. Lists the caller can't see are reported as 404 so they don't leak.
 */
function requireListAccess(level) {
  return (req, res, next) => {
    let listId;
    if (req.params.listId) {
      listId = Number(req.params.listId);
    } else if (req.params.itemId) {
      const item = db.prepare('SELECT id, list_id FROM items WHERE id = ?').get(Number(req.params.itemId));
      if (!item) throw new HttpError(404, 'Not found');
      req.item = item;
      listId = item.list_id;
    } else if (req.params.photoId) {
      const photo = db.prepare(`
        SELECT p.*, i.list_id FROM photos p JOIN items i ON i.id = p.item_id WHERE p.id = ?`)
        .get(Number(req.params.photoId));
      if (!photo) throw new HttpError(404, 'Not found');
      req.photo = photo;
      listId = photo.list_id;
    }
    const role = listRole(listId, req.user.id);
    if (!role) throw new HttpError(404, 'Not found');
    if (level === 'edit' && !canEdit(role)) throw new HttpError(403, 'You have view-only access to this list');
    if (level === 'owner' && role !== 'owner') throw new HttpError(403, 'Only the list owner can do that');
    req.listId = listId;
    req.role = role;
    next();
  };
}

// ---------------------------------------------------------------- uploads

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, crypto.randomUUID() + IMAGE_TYPES[file.mimetype]),
  }),
  limits: { fileSize: MAX_PHOTO_BYTES, files: 10 },
  fileFilter: (req, file, cb) => {
    if (IMAGE_TYPES[file.mimetype]) cb(null, true);
    else cb(new HttpError(400, `"${file.originalname}" is not a supported image (JPEG, PNG, GIF, WebP, HEIC)`));
  },
});

function insertPhotos(itemId, files = []) {
  const stmt = db.prepare('INSERT INTO photos (item_id, filename, mime) VALUES (?, ?, ?)');
  for (const f of files) stmt.run(itemId, f.filename, f.mimetype);
}

function photosFor(itemIds) {
  const byItem = new Map(itemIds.map((id) => [id, []]));
  if (itemIds.length === 0) return byItem;
  const rows = db.prepare(
    `SELECT id, item_id FROM photos WHERE item_id IN (${itemIds.map(() => '?').join(',')}) ORDER BY id`,
  ).all(...itemIds);
  for (const r of rows) byItem.get(r.item_id).push({ id: r.id, url: `/api/photos/${r.id}` });
  return byItem;
}

const ITEM_SELECT = `
  SELECT i.id, i.list_id, i.body, i.done, i.due_at, i.remind_at, i.repeat, i.last_done_at,
    i.created_at, i.updated_at, i.created_by AS created_by_id, u.username AS created_by,
    i.assigned_to AS assigned_to_id, ua.username AS assigned_to
  FROM items i
  LEFT JOIN users u ON u.id = i.created_by
  LEFT JOIN users ua ON ua.id = i.assigned_to`;

function itemView(itemId) {
  const item = db.prepare(`${ITEM_SELECT} WHERE i.id = ?`).get(itemId);
  item.done = !!item.done;
  item.photos = photosFor([itemId]).get(itemId);
  return item;
}

function parseRepeat(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return 'none';
  if (!REPEATS.includes(value)) throw new HttpError(400, 'Invalid repeat option');
  return value;
}

/** undefined = not supplied, null = unassign, otherwise must be someone on the list. */
function parseAssignee(value, listId) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const id = Number(value);
  if (!listMembers(listId).includes(id)) throw new HttpError(400, 'You can only assign people this list is shared with');
  return id;
}

function notifyAssignee(itemId, assigneeId, byUser) {
  if (assigneeId == null || assigneeId === byUser.id) return;
  const item = db.prepare('SELECT i.body, i.list_id, l.title FROM items i JOIN lists l ON l.id = i.list_id WHERE i.id = ?').get(itemId);
  pushToUsers([assigneeId], {
    title: `👤 ${byUser.username} assigned you a to-do`,
    body: `${item.title}: ${item.body.split('\n')[0].slice(0, 120) || 'Photo to-do'}`,
    tag: `assign-${itemId}`,
    url: `/#${item.list_id}`,
  });
}

/** Parses an optional epoch-ms timestamp: undefined = not supplied, null/'' = clear. */
function parseTime(value, field) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 32503680000000) throw new HttpError(400, `${field} is not a valid date`);
  return Math.round(n);
}

function cleanText(value, max, field) {
  if (typeof value !== 'string') throw new HttpError(400, `${field} is required`);
  const text = value.replace(/\r\n/g, '\n');
  if (text.length > max) throw new HttpError(400, `${field} is too long (max ${max} characters)`);
  return text;
}

// ---------------------------------------------------------------- app

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY === '1');

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy':
      "default-src 'self'; img-src 'self' blob:; style-src 'self'; script-src 'self'; object-src 'none'; frame-ancestors 'none'",
  });
  next();
});
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', express.json({ limit: '200kb' }));

// CSRF defence: state-changing API calls must carry a custom header, which a
// cross-site form or image can't send (and cross-origin fetch would need CORS).
app.use('/api', (req, res, next) => {
  if (req.method !== 'GET' && req.get('X-Requested-With') !== 'fetch') {
    throw new HttpError(403, 'Missing request header');
  }
  next();
});

// Attach req.user when a valid session cookie is present.
app.use('/api', (req, res, next) => {
  const token = parseCookies(req.headers.cookie).sid;
  if (token) {
    req.user = db.prepare(`
      SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ?`).get(sha256(token), Date.now());
  }
  next();
});

function requireAuth(req, res, next) {
  if (!req.user) throw new HttpError(401, 'Please sign in');
  next();
}

// ---- live updates (Server-Sent Events)

const streams = new Map(); // userId -> Set<res>

function emit(userIds, event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const id of new Set(userIds)) {
    for (const res of streams.get(id) ?? []) res.write(data);
  }
}

app.get('/api/events', requireAuth, (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write('retry: 5000\n\n');
  const userId = req.user.id;
  if (!streams.has(userId)) streams.set(userId, new Set());
  streams.get(userId).add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(ping);
    const set = streams.get(userId);
    set?.delete(res);
    if (set?.size === 0) streams.delete(userId);
  });
});

// After any successful change to a list, tell everyone on that list (including the
// author's other tabs/devices) so their screens refresh. Routes can override the
// audience with req.notifyUsers, e.g. when people lose access.
app.use('/api', (req, res, next) => {
  if (req.method !== 'GET') {
    res.on('finish', () => {
      if (res.statusCode >= 400 || !req.user) return;
      const users = req.notifyUsers ?? (req.listId ? listMembers(req.listId) : null);
      if (users?.length) emit(users, { type: 'change', listId: req.listId ?? null, source: req.get('X-Client-Id') || null });
    });
  }
  next();
});

// ---- accounts

app.post('/api/register', (req, res) => {
  const { username = '', password = '' } = req.body ?? {};
  if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username)) {
    throw new HttpError(400, 'Username must be 3–32 characters: letters, numbers, _ . -');
  }
  if (typeof password !== 'string' || password.length < 8 || password.length > 200) {
    throw new HttpError(400, 'Password must be at least 8 characters');
  }
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
    throw new HttpError(409, 'That username is taken');
  }
  const { lastInsertRowid } = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)')
    .run(username, hashPassword(password));
  const id = Number(lastInsertRowid);
  startSession(res, id);
  res.status(201).json({ id, username });
});

app.post('/api/login', (req, res) => {
  const { username = '', password = '' } = req.body ?? {};
  if (typeof username !== 'string' || typeof password !== 'string') throw new HttpError(400, 'Invalid request');
  const key = loginKey(req, username);
  checkLoginRate(key);
  const user = db.prepare('SELECT id, username, password_hash FROM users WHERE username = ?').get(username);
  const ok = verifyPassword(password, user ? user.password_hash : DUMMY_HASH) && !!user;
  if (!ok) {
    recordLoginFailure(key);
    throw new HttpError(401, 'Wrong username or password');
  }
  failedLogins.delete(key);
  startSession(res, user.id);
  res.json({ id: user.id, username: user.username });
});

app.post('/api/logout', (req, res) => {
  const token = parseCookies(req.headers.cookie).sid;
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  res.clearCookie('sid', { path: '/' });
  res.status(204).end();
});

app.get('/api/me', requireAuth, (req, res) => res.json(req.user));

// Everyone except yourself — the pool you can pick from when sharing.
app.get('/api/users', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT id, username FROM users WHERE id != ? ORDER BY username COLLATE NOCASE').all(req.user.id));
});

// ---- lists

function listsFor(me) {
  return db.prepare(`
    SELECT l.id, l.title, u.username AS owner,
      CASE WHEN l.owner_id = :me THEN 'owner' WHEN s.can_edit = 1 THEN 'edit' ELSE 'view' END AS role,
      (SELECT COUNT(*) FROM items i WHERE i.list_id = l.id AND i.done = 0) AS open_count,
      (SELECT COUNT(*) FROM items i WHERE i.list_id = l.id AND i.done = 0 AND i.due_at < :now) AS overdue_count,
      (SELECT COUNT(*) FROM list_shares x WHERE x.list_id = l.id) AS share_count
    FROM lists l
    JOIN users u ON u.id = l.owner_id
    LEFT JOIN list_shares s ON s.list_id = l.id AND s.user_id = :me
    WHERE l.owner_id = :me OR s.user_id IS NOT NULL
    ORDER BY (l.owner_id = :me) DESC, l.title COLLATE NOCASE`).all({ me, now: Date.now() });
}

app.get('/api/lists', requireAuth, (req, res) => res.json(listsFor(req.user.id)));

app.post('/api/lists', requireAuth, (req, res) => {
  const title = cleanText(req.body?.title, 120, 'Title').trim();
  if (!title) throw new HttpError(400, 'Title is required');
  const { lastInsertRowid } = db.prepare('INSERT INTO lists (owner_id, title) VALUES (?, ?)').run(req.user.id, title);
  req.listId = Number(lastInsertRowid);
  res.status(201).json({ id: req.listId, title });
});

// Everything open across all your lists, for the dashboard.
app.get('/api/dashboard', requireAuth, (req, res) => {
  const me = req.user.id;
  const lists = listsFor(me);
  const shareNames = db.prepare(`
    SELECT s.list_id, u.username FROM list_shares s JOIN users u ON u.id = s.user_id
    JOIN lists l ON l.id = s.list_id WHERE l.owner_id = ? ORDER BY u.username COLLATE NOCASE`).all(me);
  for (const l of lists) l.shared_with = shareNames.filter((s) => s.list_id === l.id).map((s) => s.username);
  const items = db.prepare(`${ITEM_SELECT}
    WHERE i.done = 0 AND i.list_id IN (
      SELECT l.id FROM lists l LEFT JOIN list_shares s ON s.list_id = l.id AND s.user_id = :me
      WHERE l.owner_id = :me OR s.user_id IS NOT NULL)
    ORDER BY i.due_at IS NULL, i.due_at, i.id DESC`).all({ me });
  const photoCounts = new Map(db.prepare(`
    SELECT item_id, COUNT(*) AS n FROM photos WHERE item_id IN (
      SELECT i.id FROM items i JOIN lists l ON l.id = i.list_id
      LEFT JOIN list_shares s ON s.list_id = l.id AND s.user_id = :me
      WHERE i.done = 0 AND (l.owner_id = :me OR s.user_id IS NOT NULL))
    GROUP BY item_id`).all({ me }).map((r) => [r.item_id, r.n]));
  const doneThisWeek = db.prepare(`
    SELECT COUNT(*) AS n FROM items i JOIN lists l ON l.id = i.list_id
    LEFT JOIN list_shares s ON s.list_id = l.id AND s.user_id = :me
    WHERE (l.owner_id = :me OR s.user_id IS NOT NULL)
      AND ((i.done = 1 AND i.updated_at >= datetime('now', '-7 days')) OR i.last_done_at >= :weekAgo)`)
    .get({ me, weekAgo: Date.now() - 7 * DAY_MS }).n;
  res.json({
    lists,
    items: items.map((i) => ({ ...i, done: false, photo_count: photoCounts.get(i.id) ?? 0 })),
    done_this_week: doneThisWeek,
  });
});

app.get('/api/lists/:listId', requireAuth, requireListAccess('view'), (req, res) => {
  const list = db.prepare(`
    SELECT l.id, l.title, l.created_at, l.owner_id, u.username AS owner
    FROM lists l JOIN users u ON u.id = l.owner_id WHERE l.id = ?`).get(req.listId);
  // Open items first, soonest deadline first, then newest.
  const items = db.prepare(`${ITEM_SELECT}
    WHERE i.list_id = ? ORDER BY i.done, i.due_at IS NULL, i.due_at, i.id DESC`).all(req.listId);
  const photos = photosFor(items.map((i) => i.id));
  const shares = db.prepare(`
    SELECT u.id AS user_id, u.username, s.can_edit
    FROM list_shares s JOIN users u ON u.id = s.user_id
    WHERE s.list_id = ? ORDER BY u.username COLLATE NOCASE`).all(req.listId)
    .map((s) => ({ ...s, can_edit: !!s.can_edit }));
  res.json({
    ...list,
    role: req.role,
    shares,
    // People who can be assigned to-dos on this list.
    members: [{ id: list.owner_id, username: list.owner }, ...shares.map((s) => ({ id: s.user_id, username: s.username }))],
    items: items.map((i) => ({ ...i, done: !!i.done, photos: photos.get(i.id) })),
  });
});

app.patch('/api/lists/:listId', requireAuth, requireListAccess('owner'), (req, res) => {
  const title = cleanText(req.body?.title, 120, 'Title').trim();
  if (!title) throw new HttpError(400, 'Title is required');
  db.prepare('UPDATE lists SET title = ? WHERE id = ?').run(title, req.listId);
  res.json({ id: req.listId, title });
});

app.delete('/api/lists/:listId', requireAuth, requireListAccess('owner'), (req, res) => {
  const files = db.prepare(`
    SELECT p.filename FROM photos p JOIN items i ON i.id = p.item_id WHERE i.list_id = ?`)
    .all(req.listId).map((r) => r.filename);
  req.notifyUsers = listMembers(req.listId);
  db.prepare('DELETE FROM lists WHERE id = ?').run(req.listId);
  removeFiles(files);
  res.status(204).end();
});

// Replace the full set of people a list is shared with.
// Body: { shares: [{ userId, canEdit }] }
app.put('/api/lists/:listId/shares', requireAuth, requireListAccess('owner'), (req, res) => {
  const shares = req.body?.shares;
  if (!Array.isArray(shares)) throw new HttpError(400, 'shares must be an array');
  const exists = db.prepare('SELECT 1 FROM users WHERE id = ?');
  const clean = new Map();
  for (const s of shares) {
    const userId = Number(s?.userId);
    if (!Number.isInteger(userId) || userId === req.user.id || !exists.get(userId)) {
      throw new HttpError(400, 'Invalid user in share list');
    }
    clean.set(userId, s.canEdit ? 1 : 0);
  }
  const before = listMembers(req.listId);
  tx(() => {
    db.prepare('DELETE FROM list_shares WHERE list_id = ?').run(req.listId);
    const ins = db.prepare('INSERT INTO list_shares (list_id, user_id, can_edit) VALUES (?, ?, ?)');
    for (const [userId, edit] of clean) ins.run(req.listId, userId, edit);
    dropStaleAssignments(req.listId);
  });
  // Tell people who gained *and* lost access.
  req.notifyUsers = [...before, ...listMembers(req.listId)];
  res.status(204).end();
});

// Let a shared user remove a list from their own view.
app.delete('/api/lists/:listId/shares/me', requireAuth, requireListAccess('view'), (req, res) => {
  if (req.role === 'owner') throw new HttpError(400, 'You own this list');
  req.notifyUsers = listMembers(req.listId);
  tx(() => {
    db.prepare('DELETE FROM list_shares WHERE list_id = ? AND user_id = ?').run(req.listId, req.user.id);
    dropStaleAssignments(req.listId);
  });
  res.status(204).end();
});

// ---- items

app.post('/api/lists/:listId/items', requireAuth, requireListAccess('edit'), upload.array('photos', 10), (req, res) => {
  const body = cleanText(req.body?.body ?? '', 20000, 'Text').trim();
  if (!body && !req.files?.length) throw new HttpError(400, 'Add some text or a photo');
  const dueAt = parseTime(req.body?.due_at, 'Deadline') ?? null;
  const remindAt = parseTime(req.body?.remind_at, 'Reminder') ?? null;
  const repeat = parseRepeat(req.body?.repeat) ?? 'none';
  if (repeat !== 'none' && dueAt == null) throw new HttpError(400, 'A repeating to-do needs a deadline');
  const tz = validTimeZone(req.body?.tz) ? req.body.tz : null;
  const assignee = parseAssignee(req.body?.assigned_to, req.listId) ?? null;
  const id = tx(() => {
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO items (list_id, body, due_at, remind_at, repeat, repeat_anchor, tz, assigned_to, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(req.listId, body, dueAt, remindAt, repeat, repeat === 'none' ? null : dueAt, tz, assignee, req.user.id);
    insertPhotos(Number(lastInsertRowid), req.files);
    return Number(lastInsertRowid);
  });
  notifyAssignee(id, assignee, req.user);
  res.status(201).json(itemView(id));
});

app.patch('/api/items/:itemId', requireAuth, requireListAccess('edit'), (req, res) => {
  const { body, done } = req.body ?? {};
  const dueAt = parseTime(req.body?.due_at, 'Deadline');
  const remindAt = parseTime(req.body?.remind_at, 'Reminder');
  const repeat = parseRepeat(req.body?.repeat);
  const assignee = parseAssignee(req.body?.assigned_to, req.listId);
  const current = db.prepare('SELECT * FROM items WHERE id = ?').get(req.item.id);
  const next = {
    due_at: dueAt !== undefined ? dueAt : current.due_at,
    repeat: repeat ?? current.repeat,
  };
  if (next.repeat !== 'none' && next.due_at == null) throw new HttpError(400, 'A repeating to-do needs a deadline');

  let advancedTo = null;
  tx(() => {
    const touch = (sql, ...args) => db.prepare(`UPDATE items SET ${sql}, updated_at = datetime('now') WHERE id = ?`).run(...args, req.item.id);
    if (body !== undefined) touch('body = ?', cleanText(body, 20000, 'Text').trim());
    if (validTimeZone(req.body?.tz)) db.prepare('UPDATE items SET tz = ? WHERE id = ?').run(req.body.tz, req.item.id);
    if (dueAt !== undefined) touch('due_at = ?', dueAt);
    if (remindAt !== undefined) {
      // A new reminder time re-arms the push notification.
      db.prepare('UPDATE items SET remind_at = ?, reminded_at = NULL WHERE id = ?').run(remindAt, req.item.id);
    }
    if (repeat !== undefined || dueAt !== undefined) {
      // Changing the deadline or the pattern starts a fresh series from the new deadline.
      touch('repeat = ?, repeat_anchor = ?', next.repeat, next.repeat === 'none' ? null : next.due_at);
    }
    if (assignee !== undefined) touch('assigned_to = ?', assignee);

    if (done !== undefined) {
      const item = db.prepare('SELECT * FROM items WHERE id = ?').get(req.item.id);
      if (done && item.repeat !== 'none' && item.due_at != null) {
        // Completing a repeating to-do rolls it forward instead of closing it.
        advancedTo = nextOccurrence(item);
        const newRemind = item.remind_at != null ? advancedTo - (item.due_at - item.remind_at) : null;
        touch('due_at = ?, remind_at = ?, reminded_at = NULL, last_done_at = ?, done = 0', advancedTo, newRemind, Date.now());
      } else {
        touch('done = ?', done ? 1 : 0);
      }
    }
  });
  if (assignee !== undefined && assignee !== current.assigned_to) notifyAssignee(req.item.id, assignee, req.user);
  res.json({ ...itemView(req.item.id), advanced_to: advancedTo });
});

app.delete('/api/items/:itemId', requireAuth, requireListAccess('edit'), (req, res) => {
  const files = db.prepare('SELECT filename FROM photos WHERE item_id = ?').all(req.item.id).map((r) => r.filename);
  db.prepare('DELETE FROM items WHERE id = ?').run(req.item.id);
  removeFiles(files);
  res.status(204).end();
});

app.post('/api/items/:itemId/photos', requireAuth, requireListAccess('edit'), upload.array('photos', 10), (req, res) => {
  if (!req.files?.length) throw new HttpError(400, 'No photo uploaded');
  tx(() => {
    insertPhotos(req.item.id, req.files);
    db.prepare("UPDATE items SET updated_at = datetime('now') WHERE id = ?").run(req.item.id);
  });
  res.status(201).json(itemView(req.item.id));
});

// ---- reminders

// Reminders that have come due for the current user and haven't been dismissed.
app.get('/api/reminders', requireAuth, (req, res) => {
  res.json(db.prepare(`
    SELECT i.id, i.body, i.due_at, i.remind_at, l.id AS list_id, l.title AS list_title,
      CASE WHEN l.owner_id = :me OR s.can_edit = 1 THEN 1 ELSE 0 END AS can_edit
    FROM items i
    JOIN lists l ON l.id = i.list_id
    LEFT JOIN list_shares s ON s.list_id = l.id AND s.user_id = :me
    LEFT JOIN reminder_acks a ON a.item_id = i.id AND a.user_id = :me AND a.remind_at = i.remind_at
    WHERE (l.owner_id = :me OR s.user_id IS NOT NULL)
      AND i.done = 0 AND i.remind_at IS NOT NULL AND i.remind_at <= :now AND a.item_id IS NULL
      AND (i.assigned_to IS NULL OR i.assigned_to = :me)
    ORDER BY i.remind_at`).all({ me: req.user.id, now: Date.now() })
    .map((r) => ({ ...r, can_edit: !!r.can_edit })));
});

// Dismiss a reminder for yourself only (other people on the list still see theirs).
app.post('/api/reminders/:itemId/dismiss', requireAuth, requireListAccess('view'), (req, res) => {
  const { remind_at } = db.prepare('SELECT remind_at FROM items WHERE id = ?').get(req.item.id);
  if (remind_at != null) {
    db.prepare(`INSERT INTO reminder_acks (item_id, user_id, remind_at) VALUES (?, ?, ?)
      ON CONFLICT (item_id, user_id) DO UPDATE SET remind_at = excluded.remind_at`)
      .run(req.item.id, req.user.id, remind_at);
  }
  req.notifyUsers = [req.user.id]; // only your own other devices care
  res.status(204).end();
});

// ---- web push (reminders while the app is closed)

const vapidPath = path.join(DATA_DIR, 'vapid.json');
let vapid;
try {
  vapid = JSON.parse(fs.readFileSync(vapidPath, 'utf8'));
} catch {
  vapid = webpush.generateVAPIDKeys();
  fs.writeFileSync(vapidPath, JSON.stringify(vapid));
}
webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@example.com', vapid.publicKey, vapid.privateKey);

// Only accept endpoints on the browsers' real push services, so the server can't be
// pointed at arbitrary URLs.
const PUSH_HOSTS = [/\.googleapis\.com$/, /\.mozilla\.com$/, /\.mozaws\.net$/, /\.push\.apple\.com$/, /\.notify\.windows\.com$/];

app.get('/api/push/key', requireAuth, (req, res) => res.json({ publicKey: vapid.publicKey }));

app.post('/api/push/subscribe', requireAuth, (req, res) => {
  const { endpoint, keys } = req.body?.subscription ?? {};
  let url;
  try { url = new URL(endpoint); } catch { throw new HttpError(400, 'Invalid subscription'); }
  if (url.protocol !== 'https:' || !PUSH_HOSTS.some((re) => re.test(url.hostname))) {
    throw new HttpError(400, 'Unsupported push service');
  }
  if (typeof keys?.p256dh !== 'string' || typeof keys?.auth !== 'string') throw new HttpError(400, 'Invalid subscription');
  db.prepare(`INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth) VALUES (?, ?, ?, ?)
    ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`)
    .run(endpoint, req.user.id, keys.p256dh, keys.auth);
  res.status(204).end();
});

app.post('/api/push/unsubscribe', requireAuth, (req, res) => {
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').run(String(req.body?.endpoint), req.user.id);
  res.status(204).end();
});

function pushToUsers(userIds, message) {
  if (!userIds.length) return Promise.resolve();
  const payload = JSON.stringify(message);
  const subs = db.prepare(
    `SELECT * FROM push_subscriptions WHERE user_id IN (${userIds.map(() => '?').join(',')})`,
  ).all(...userIds);
  return Promise.all(subs.map((sub) =>
    webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload, { TTL: 3600 })
      .catch((err) => {
        if (err.statusCode === 404 || err.statusCode === 410) {
          db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(sub.endpoint);
        } else {
          console.warn('Push failed:', err.statusCode ?? err.message);
        }
      })));
}

async function sendDueReminders() {
  const due = db.prepare(`
    SELECT i.id, i.body, i.list_id, i.assigned_to, l.title
    FROM items i JOIN lists l ON l.id = i.list_id
    WHERE i.reminded_at IS NULL AND i.remind_at IS NOT NULL AND i.remind_at <= ? AND i.done = 0`).all(Date.now());
  for (const item of due) {
    db.prepare('UPDATE items SET reminded_at = ? WHERE id = ?').run(Date.now(), item.id);
    const members = listMembers(item.list_id);
    // An assigned to-do reminds just the assignee; otherwise everyone on the list.
    const audience = item.assigned_to != null && members.includes(item.assigned_to) ? [item.assigned_to] : members;
    emit(members, { type: 'reminder', listId: item.list_id });
    await pushToUsers(audience, {
      title: `🔔 ${item.title}`,
      body: item.body.split('\n')[0].slice(0, 140) || 'Photo to-do',
      tag: `item-${item.id}`,
      url: `/#${item.list_id}`,
    });
  }
}
setInterval(() => sendDueReminders().catch((err) => console.error('Reminder job failed:', err)), 30_000).unref();

// ---- photos

app.get('/api/photos/:photoId', requireAuth, requireListAccess('view'), (req, res) => {
  res.set({
    'Content-Type': req.photo.mime,
    'Cache-Control': 'private, max-age=86400',
    'Content-Security-Policy': "default-src 'none'; sandbox",
  });
  res.sendFile(path.join(UPLOAD_DIR, path.basename(req.photo.filename)));
});

app.delete('/api/photos/:photoId', requireAuth, requireListAccess('edit'), (req, res) => {
  db.prepare('DELETE FROM photos WHERE id = ?').run(req.photo.id);
  removeFiles([req.photo.filename]);
  res.status(204).end();
});

// ---- errors

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

app.use((err, req, res, next) => {
  // Discard any files multer already wrote for a request that failed.
  if (req.files?.length) removeFiles(req.files.map((f) => f.filename));
  if (err instanceof multer.MulterError) {
    const msg = err.code === 'LIMIT_FILE_SIZE' ? `Photos must be under ${MAX_PHOTO_BYTES / 1024 / 1024} MB` : err.message;
    return res.status(400).json({ error: msg });
  }
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong' });
});

const HOST = process.env.HOST || '0.0.0.0';
app.listen(PORT, HOST, (err) => {
  if (err) {
    console.error(err.code === 'EADDRINUSE'
      ? `Port ${PORT} is already in use — is another copy of the app still running? (set PORT to use a different one)`
      : err);
    process.exit(1);
  }
  console.log(`Shared To-Do running at http://localhost:${PORT}`);
  if (HOST === '0.0.0.0') {
    // Show LAN addresses so phones on the same Wi-Fi can connect.
    for (const addrs of Object.values(os.networkInterfaces())) {
      for (const a of addrs ?? []) {
        if (a.family === 'IPv4' && !a.internal) console.log(`  on your network: http://${a.address}:${PORT}`);
      }
    }
  }
});
