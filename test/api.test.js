import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, client, newUser, photoForm } from './helpers.js';

let base;
before(async () => { ({ base } = await startServer()); });

// ---------------------------------------------------------------- accounts

test('register, me, logout, login', async () => {
  const c = client(base);
  const username = `alice${process.pid}`;
  let r = await c.post('/api/register', { username, password: 'password123' });
  assert.equal(r.status, 201);
  assert.equal(r.body.username, username);

  r = await c.get('/api/me');
  assert.equal(r.status, 200);
  assert.equal(r.body.username, username);

  r = await c.post('/api/logout');
  assert.equal(r.status, 204);
  assert.equal((await c.get('/api/me')).status, 401);

  r = await c.post('/api/login', { username: username.toUpperCase(), password: 'password123' });
  assert.equal(r.status, 200, 'usernames are case-insensitive');
  assert.equal((await c.get('/api/me')).status, 200);
});

test('register validation', async () => {
  const c = client(base);
  assert.equal((await c.post('/api/register', { username: 'ab', password: 'password123' })).status, 400);
  assert.equal((await c.post('/api/register', { username: 'bad name', password: 'password123' })).status, 400);
  assert.equal((await c.post('/api/register', { username: 'goodname', password: 'short' })).status, 400);
  const u = await newUser(base);
  const r = await client(base).post('/api/register', { username: u.username.toUpperCase(), password: 'password123' });
  assert.equal(r.status, 409);
});

test('login failures are rejected and throttled', async () => {
  const u = await newUser(base);
  const c = client(base);
  assert.equal((await c.post('/api/login', { username: 42, password: 'x' })).status, 400);
  assert.equal((await c.post('/api/login', { username: 'nobody-here', password: 'whatever1' })).status, 401);
  for (let i = 0; i < 10; i++) {
    assert.equal((await c.post('/api/login', { username: u.username, password: 'wrong-password' })).status, 401);
  }
  const r = await c.post('/api/login', { username: u.username, password: 'password123' });
  assert.equal(r.status, 429, 'even the right password is refused while throttled');
});

test('CSRF header is required for state-changing requests', async () => {
  const r = await fetch(`${base}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'csrfuser', password: 'password123' }),
  });
  assert.equal(r.status, 403);
});

test('invalid JSON and unknown API routes', async () => {
  const c = await newUser(base);
  assert.equal((await c.post('/api/lists', '{not json')).status, 400);
  assert.equal((await c.get('/api/nope')).status, 404);
});

test('security headers are set', async () => {
  const r = await fetch(`${base}/`);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
});

test('profile: display name and password change', async () => {
  const c = await newUser(base);
  let r = await c.patch('/api/me', { display_name: '  Ada   Lovelace ' });
  assert.equal(r.status, 200);
  assert.equal(r.body.display_name, 'Ada Lovelace');
  r = await c.patch('/api/me', { display_name: null });
  assert.equal(r.body.display_name, null);
  assert.equal((await c.patch('/api/me', { display_name: 'x'.repeat(41) })).status, 400);

  // A second device gets signed out by a password change; this one stays in.
  const other = client(base);
  await other.post('/api/login', { username: c.username, password: 'password123' });
  assert.equal((await c.post('/api/me/password', { current: 'nope-nope', next: 'newpassword1' })).status, 400);
  assert.equal((await c.post('/api/me/password', { current: 'password123', next: 'short' })).status, 400);
  assert.equal((await c.post('/api/me/password', { current: 'password123', next: 'newpassword1' })).status, 204);
  assert.equal((await c.get('/api/me')).status, 200);
  assert.equal((await other.get('/api/me')).status, 401);
  assert.equal((await client(base).post('/api/login', { username: c.username, password: 'newpassword1' })).status, 200);
});

test('avatar upload, fetch and delete', async () => {
  const c = await newUser(base);
  let r = await c.request('PUT', '/api/me/avatar', { form: photoForm({}, undefined, 'avatar') });
  assert.equal(r.status, 200);
  assert.ok(r.body.avatar_version);
  const img = await c.request('GET', `/api/users/${c.id}/avatar`, { raw: true });
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.equal((await c.del('/api/me/avatar')).status, 204);
  assert.equal((await c.get(`/api/users/${c.id}/avatar`)).status, 404);
  const bad = photoForm({}, [{ name: 'a.txt', type: 'text/plain', data: Buffer.from('hi') }], 'avatar');
  assert.equal((await c.request('PUT', '/api/me/avatar', { form: bad })).status, 400);
});

// ---------------------------------------------------------------- lists & items

test('list lifecycle', async () => {
  const c = await newUser(base);
  assert.equal((await c.post('/api/lists', { title: '   ' })).status, 400);
  let r = await c.post('/api/lists', { title: ' Groceries ' });
  assert.equal(r.status, 201);
  assert.equal(r.body.title, 'Groceries');
  const id = r.body.id;

  r = await c.patch(`/api/lists/${id}`, { title: 'Shopping' });
  assert.equal(r.body.title, 'Shopping');

  r = await c.get('/api/lists');
  assert.deepEqual(r.body.map((l) => [l.title, l.role]), [['Shopping', 'owner']]);

  r = await c.get(`/api/lists/${id}/activity`);
  assert.deepEqual(r.body.map((a) => a.action), ['list_renamed', 'list_created']);

  assert.equal((await c.del(`/api/lists/${id}`)).status, 204);
  assert.equal((await c.get(`/api/lists/${id}`)).status, 404);
});

test('items: create, edit, complete, delete', async () => {
  const c = await newUser(base);
  const { body: list } = await c.post('/api/lists', { title: 'Chores' });
  assert.equal((await c.post(`/api/lists/${list.id}/items`, { body: '  ' })).status, 400);

  let r = await c.post(`/api/lists/${list.id}/items`, {
    body: 'Buy milk\nsemi-skimmed', priority: 2, labels: ['#Home', 'home', 'errands'], subtasks: ['one', ' ', 'two'],
  });
  assert.equal(r.status, 201);
  const item = r.body;
  assert.equal(item.body, 'Buy milk\nsemi-skimmed');
  assert.equal(item.priority, 2);
  assert.deepEqual(item.labels, ['Home', 'errands']);
  assert.deepEqual(item.subtasks.map((s) => s.body), ['one', 'two']);

  r = await c.patch(`/api/items/${item.id}`, { body: 'Buy oat milk', labels: 'a, b', priority: null });
  assert.equal(r.body.body, 'Buy oat milk');
  assert.deepEqual(r.body.labels, ['a', 'b']);
  assert.equal(r.body.priority, 0);

  r = await c.patch(`/api/items/${item.id}`, { done: true });
  assert.equal(r.body.done, true);
  r = await c.patch(`/api/items/${item.id}`, { done: false });
  assert.equal(r.body.done, false);

  assert.equal((await c.patch(`/api/items/${item.id}`, { priority: 7 })).status, 400);
  assert.equal((await c.patch(`/api/items/${item.id}`, { due_at: 'soon' })).status, 400);
  assert.equal((await c.patch(`/api/items/${item.id}`, { repeat: 'hourly' })).status, 400);
  assert.equal((await c.patch(`/api/items/${item.id}`, { repeat: 'daily' })).status, 400, 'repeat needs a deadline');

  const acts = (await c.get(`/api/lists/${list.id}/activity`)).body.map((a) => a.action);
  assert.deepEqual(acts.slice(0, 3), ['item_reopened', 'item_completed', 'item_edited']);

  assert.equal((await c.del(`/api/items/${item.id}`)).status, 204);
  assert.equal((await c.get(`/api/lists/${list.id}`)).body.items.length, 0);
});

test('items with photos', async () => {
  const c = await newUser(base);
  const { body: list } = await c.post('/api/lists', { title: 'Pics' });
  let r = await c.request('POST', `/api/lists/${list.id}/items`, { form: photoForm() });
  assert.equal(r.status, 201);
  assert.equal(r.body.photos.length, 1);
  const item = r.body;

  r = await c.request('POST', `/api/items/${item.id}/photos`, { form: photoForm() });
  assert.equal(r.status, 201);
  assert.equal(r.body.photos.length, 2);

  const img = await c.request('GET', r.body.photos[0].url, { raw: true });
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');

  const bad = photoForm({}, [{ name: 'x.txt', type: 'text/plain', data: Buffer.from('x') }]);
  assert.equal((await c.request('POST', `/api/items/${item.id}/photos`, { form: bad })).status, 400);

  const photoId = r.body.photos[0].id;
  assert.equal((await c.del(`/api/photos/${photoId}`)).status, 204);
  assert.equal((await c.get(`/api/photos/${photoId}`)).status, 404);
});

test('drag-and-drop order', async () => {
  const c = await newUser(base);
  const { body: list } = await c.post('/api/lists', { title: 'Order' });
  const a = (await c.post(`/api/lists/${list.id}/items`, { body: 'a' })).body;
  const b = (await c.post(`/api/lists/${list.id}/items`, { body: 'b' })).body;
  // New items go on top.
  let items = (await c.get(`/api/lists/${list.id}`)).body.items;
  assert.deepEqual(items.map((i) => i.body), ['b', 'a']);

  assert.equal((await c.put(`/api/lists/${list.id}/order`, { ids: [a.id, b.id] })).status, 204);
  items = (await c.get(`/api/lists/${list.id}`)).body.items;
  assert.deepEqual(items.map((i) => i.body), ['a', 'b']);

  assert.equal((await c.put(`/api/lists/${list.id}/order`, { ids: 'nope' })).status, 400);
  assert.equal((await c.put(`/api/lists/${list.id}/order`, { ids: [999999] })).status, 400);
});

// ---------------------------------------------------------------- sharing & access control

test('sharing roles are enforced', async () => {
  const owner = await newUser(base, 'own');
  const editor = await newUser(base, 'edt');
  const viewer = await newUser(base, 'vwr');
  const stranger = await newUser(base, 'str');
  const { body: list } = await owner.post('/api/lists', { title: 'Team' });
  const item = (await owner.post(`/api/lists/${list.id}/items`, { body: 'shared thing' })).body;

  assert.equal((await owner.put(`/api/lists/${list.id}/shares`, { shares: [{ userId: owner.id }] })).status, 400);
  assert.equal((await owner.put(`/api/lists/${list.id}/shares`, { shares: 'x' })).status, 400);
  let r = await owner.put(`/api/lists/${list.id}/shares`, {
    shares: [{ userId: editor.id, canEdit: true }, { userId: viewer.id, canEdit: false }],
  });
  assert.equal(r.status, 204);

  // Strangers can't tell the list exists.
  assert.equal((await stranger.get(`/api/lists/${list.id}`)).status, 404);
  assert.equal((await stranger.patch(`/api/items/${item.id}`, { done: true })).status, 404);

  // Viewers can read and comment, not edit.
  assert.equal((await viewer.get(`/api/lists/${list.id}`)).body.role, 'view');
  assert.equal((await viewer.patch(`/api/items/${item.id}`, { done: true })).status, 403);
  assert.equal((await viewer.post(`/api/items/${item.id}/comments`, { body: 'nice' })).status, 201);

  // Editors can edit items but not manage the list.
  assert.equal((await editor.patch(`/api/items/${item.id}`, { body: 'edited' })).status, 200);
  assert.equal((await editor.patch(`/api/lists/${list.id}`, { title: 'Mine now' })).status, 403);
  assert.equal((await editor.del(`/api/lists/${list.id}`)).status, 403);

  // Assign to a member; assigning to a stranger is refused.
  assert.equal((await owner.patch(`/api/items/${item.id}`, { assigned_to: stranger.id })).status, 400);
  r = await owner.patch(`/api/items/${item.id}`, { assigned_to: editor.id });
  assert.equal(r.body.assigned_to_id, editor.id);

  // Leaving the list drops the assignment.
  assert.equal((await owner.del(`/api/lists/${list.id}/shares/me`)).status, 400);
  assert.equal((await editor.del(`/api/lists/${list.id}/shares/me`)).status, 204);
  assert.equal((await editor.get(`/api/lists/${list.id}`)).status, 404);
  r = await owner.get(`/api/lists/${list.id}`);
  assert.equal(r.body.items[0].assigned_to_id, null);
  assert.deepEqual(r.body.shares.map((s) => s.user_id), [viewer.id]);
});
