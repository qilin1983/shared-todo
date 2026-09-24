// ---------------------------------------------------------------- helpers

const $ = (sel, root = document) => root.querySelector(sel);

/** Tiny element builder. Children that are strings become text nodes (never HTML). */
function h(tag, props = {}, ...children) {
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

// Identifies this tab so live updates caused by our own actions can be skipped.
const CLIENT_ID = Math.random().toString(36).slice(2) + Date.now().toString(36);
const TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** replaceChildren that, like h(), skips null/false and flattens nested arrays. */
function fill(el, ...children) {
  el.replaceChildren(...children.flat(Infinity).filter((c) => c != null && c !== false));
}

async function api(path,{ method = 'GET', json, form } = {}) {
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
    if (res.status === 401 && !['/me', '/login'].includes(path)) showAuth();
    throw new Error(data?.error || `Request failed (${res.status})`);
  }
  return data;
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3500);
}

async function attempt(fn) {
  try {
    return await fn();
  } catch (err) {
    toast(err.message);
  }
}

function formatDate(sqlDate) {
  const d = new Date(sqlDate.replace(' ', 'T') + 'Z');
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** "Today 3:00 PM", "Tomorrow 9:00 AM", "Mon, Sep 29, 3:00 PM" */
function formatWhen(ms) {
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

// <input type="datetime-local"> works in local time, "YYYY-MM-DDTHH:MM".
function toLocalInput(ms) {
  if (ms == null) return '';
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const fromLocalInput = (s) => (s ? new Date(s).getTime() : null);

const MAX_PHOTO_MB = 10;
function acceptImages(fileList) {
  const ok = [];
  for (const f of fileList) {
    if (!f.type.startsWith('image/')) toast(`${f.name || 'File'} is not an image`);
    else if (f.size > MAX_PHOTO_MB * 1024 * 1024) toast(`${f.name} is over ${MAX_PHOTO_MB} MB`);
    else ok.push(f);
  }
  return ok;
}

// ---------------------------------------------------------------- state

const state = {
  me: null,
  lists: [],
  view: 'dashboard', // 'dashboard' | 'list'
  dashboard: null,
  dashScope: 'all',  // all | mine | shared | assigned | created
  dashWhen: 'any',   // any | overdue | today | week
  currentId: null,
  current: null,
  hideDone: false,
  onlyMine: false,
  draftBody: '',     // text typed into the add form, kept across re-renders
  pendingPhotos: [], // File[] waiting to be attached to a new item
  editingItemId: null,
  reminders: [],
};

try {
  state.hideDone = localStorage.getItem('hideDone') === '1';
  state.dashScope = localStorage.getItem('dashScope') || 'all';
} catch {}

const remember = (key, value) => { try { localStorage.setItem(key, value); } catch {} };

// ---------------------------------------------------------------- auth view

function showAuth() {
  state.me = null;
  stopReminderPolling();
  stopLiveUpdates();
  $('#app-view').hidden = true;
  $('#auth-view').hidden = false;
  $('#auth-form [name=username]').focus();
}

$('#auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const mode = e.submitter?.dataset.mode || 'login';
  const form = e.currentTarget;
  const username = form.username.value.trim();
  const password = form.password.value;
  const errEl = $('#auth-error');
  errEl.textContent = '';
  try {
    state.me = await api(mode === 'register' ? '/register' : '/login', { method: 'POST', json: { username, password } });
    form.password.value = '';
    await showApp();
  } catch (err) {
    errEl.textContent = err.message;
  }
});

// ---------------------------------------------------------------- app view

async function showApp() {
  $('#auth-view').hidden = true;
  $('#app-view').hidden = false;
  $('#whoami').textContent = `Signed in as ${state.me.username}`;
  await loadLists();
  const fromHash = Number(location.hash.slice(1));
  if (state.lists.some((l) => l.id === fromHash)) await openList(fromHash);
  else await openDashboard();
  startReminderPolling();
  startLiveUpdates();
  syncPushSubscription();
  renderNotifyBox();
}

$('#logout-btn').addEventListener('click', async () => {
  // Stop this device getting the next person's reminders.
  await disablePush({ quiet: true }).catch(() => {});
  await attempt(() => api('/logout', { method: 'POST' }));
  Object.assign(state, { lists: [], current: null, currentId: null, dashboard: null, reminders: [], draftBody: '', pendingPhotos: [] });
  $('#reminder-bar').replaceChildren();
  history.replaceState(null, '', location.pathname);
  showAuth();
});

// Mobile drawer
function setNav(open) {
  document.body.classList.toggle('nav-open', open);
  $('#menu-btn').setAttribute('aria-expanded', String(open));
}
$('#menu-btn').addEventListener('click', () => setNav(!document.body.classList.contains('nav-open')));
$('#nav-backdrop').addEventListener('click', () => setNav(false));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setNav(false); });

$('#new-list-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = e.currentTarget.title;
  attempt(async () => {
    const list = await api('/lists', { method: 'POST', json: { title: input.value } });
    input.value = '';
    await loadLists();
    await openList(list.id);
  });
});

async function loadLists() {
  state.lists = await api('/lists');
  renderLists();
}

function renderLists() {
  const nav = $('#lists-nav');
  const mine = state.lists.filter((l) => l.role === 'owner');
  const shared = state.lists.filter((l) => l.role !== 'owner');
  const link = (l) =>
    h('a', {
      href: `#${l.id}`,
      class: 'list-link' + (state.view === 'list' && l.id === state.currentId ? ' active' : ''),
      onclick: (e) => {
        e.preventDefault();
        openList(l.id);
      },
    },
    h('span', { class: 'list-name' }, l.title),
    l.role !== 'owner' ? h('span', { class: 'muted small' }, `from ${l.owner}`) : null,
    l.role === 'owner' && l.share_count > 0 ? h('span', { class: 'badge', title: `Shared with ${l.share_count}` }, 'shared') : null,
    l.overdue_count > 0 ? h('span', { class: 'badge overdue', title: `${l.overdue_count} overdue` }, `${l.overdue_count} late`) : null,
    h('span', { class: 'count' }, l.open_count));

  const totalOverdue = state.lists.reduce((n, l) => n + l.overdue_count, 0);
  fill(nav, 
    h('a', {
      href: '#dashboard',
      class: 'list-link dash-link' + (state.view === 'dashboard' ? ' active' : ''),
      onclick: (e) => { e.preventDefault(); openDashboard(); },
    },
    h('span', { class: 'list-name' }, '🏠 Dashboard'),
    totalOverdue ? h('span', { class: 'badge overdue' }, `${totalOverdue} late`) : null),
    h('h3', {}, 'My lists'),
    mine.length ? mine.map(link) : h('p', { class: 'muted small' }, 'No lists yet — create one above.'),
    shared.length ? [h('h3', {}, 'Shared with me'), shared.map(link)] : null,
  );
}

async function openList(id) {
  if (id !== state.currentId) {
    state.draftBody = '';
    state.pendingPhotos = [];
  }
  state.view = 'list';
  state.currentId = id;
  state.editingItemId = null;
  history.replaceState(null, '', `#${id}`);
  setNav(false);
  renderLists();
  await refreshCurrent();
}

async function openDashboard() {
  state.view = 'dashboard';
  state.currentId = null;
  state.current = null;
  state.editingItemId = null;
  history.replaceState(null, '', '#dashboard');
  setNav(false);
  renderLists();
  await refreshDashboard();
}

window.addEventListener('hashchange', () => {
  if (!state.me) return;
  if (location.hash === '#dashboard') {
    if (state.view !== 'dashboard') openDashboard();
    return;
  }
  const id = Number(location.hash.slice(1));
  if (id && id !== state.currentId) openList(id);
});

async function refreshCurrent() {
  if (state.view === 'dashboard') return refreshDashboard();
  if (!state.currentId) return;
  try {
    state.current = await api(`/lists/${state.currentId}`);
  } catch (err) {
    // e.g. the owner deleted the list or stopped sharing it with us
    toast(err.message === 'Not found' ? 'That list is no longer available' : err.message);
    await loadLists();
    await openDashboard();
    return;
  }
  renderList();
}

/** Re-render the current view with fresh data (used after actions and live updates). */
async function refreshView() {
  await loadLists();
  await refreshCurrent();
}

// ---------------------------------------------------------------- deadline & reminder fields

const REMIND_PRESETS = [
  ['none', 'No reminder'],
  ['0', 'At the deadline'],
  ['15', '15 minutes before'],
  ['60', '1 hour before'],
  ['1440', '1 day before'],
  ['10080', '1 week before'],
  ['custom', 'At a specific time…'],
];

const REPEAT_LABELS = {
  none: 'Does not repeat',
  daily: 'Every day',
  weekdays: 'Every weekday (Mon–Fri)',
  weekly: 'Every week',
  monthly: 'Every month',
  yearly: 'Every year',
};
const REPEAT_SHORT = { daily: 'Daily', weekdays: 'Weekdays', weekly: 'Weekly', monthly: 'Monthly', yearly: 'Yearly' };

/**
 * Deadline, reminder, repeat and assignee inputs for a to-do.
 * Returns { el, read() }; read() gives { due_at, remind_at, repeat, assigned_to } or throws.
 */
function detailFields({ due_at = null, remind_at = null, repeat = 'none', assigned_to_id = null } = {}, members = []) {
  const due = h('input', { type: 'datetime-local', value: toLocalInput(due_at), 'aria-label': 'Deadline' });
  const custom = h('input', { type: 'datetime-local', value: toLocalInput(remind_at), 'aria-label': 'Reminder time' });

  let preset = 'none';
  if (remind_at != null) {
    preset = 'custom';
    if (due_at != null) {
      const mins = Math.round((due_at - remind_at) / 60000);
      if (REMIND_PRESETS.some(([v]) => v === String(mins))) preset = String(mins);
    }
  }
  const select = h('select', { 'aria-label': 'Reminder' },
    REMIND_PRESETS.map(([v, label]) => h('option', { value: v, selected: v === preset }, label)));

  const repeatSelect = h('select', { 'aria-label': 'Repeat' },
    Object.entries(REPEAT_LABELS).map(([v, label]) => h('option', { value: v, selected: v === repeat }, label)));

  const assignSelect = members.length > 1
    ? h('select', { 'aria-label': 'Assign to' },
      h('option', { value: '' }, 'Nobody (everyone on the list)'),
      members.map((m) => h('option', { value: String(m.id), selected: m.id === assigned_to_id },
        m.id === state.me.id ? `${m.username} (me)` : m.username)))
    : null;

  const sync = () => {
    const hasDue = !!due.value;
    for (const opt of select.options) {
      if (!['none', 'custom'].includes(opt.value)) opt.disabled = !hasDue;
    }
    if (!hasDue && !['none', 'custom'].includes(select.value)) select.value = 'none';
    custom.hidden = select.value !== 'custom';
    // Repeating needs a deadline to repeat from.
    for (const opt of repeatSelect.options) if (opt.value !== 'none') opt.disabled = !hasDue;
    if (!hasDue) repeatSelect.value = 'none';
  };
  due.addEventListener('change', sync);
  select.addEventListener('change', () => {
    sync();
    if (select.value === 'custom' && !custom.value) {
      custom.value = toLocalInput(fromLocalInput(due.value) ?? Date.now() + 3600000);
    }
  });
  sync();

  const clearBtn = h('button', {
    type: 'button', class: 'ghost small', 'aria-label': 'Clear deadline',
    onclick: () => { due.value = ''; sync(); },
  }, 'Clear');

  const el = h('div', { class: 'schedule' },
    h('label', { class: 'field' }, h('span', {}, '📅 Deadline'), h('div', { class: 'row' }, due, clearBtn)),
    h('label', { class: 'field' }, h('span', {}, '🔔 Reminder'), h('div', { class: 'row wrap' }, select, custom)),
    h('label', { class: 'field' }, h('span', {}, '🔁 Repeat'), repeatSelect),
    assignSelect ? h('label', { class: 'field' }, h('span', {}, '👤 Assign to'), assignSelect) : null);

  return {
    el,
    read() {
      const dueAt = fromLocalInput(due.value);
      let remindAt = null;
      if (select.value === 'custom') {
        remindAt = fromLocalInput(custom.value);
        if (remindAt == null) throw new Error('Pick a time for the reminder');
      } else if (select.value !== 'none') {
        remindAt = dueAt - Number(select.value) * 60000;
      }
      return {
        due_at: dueAt,
        remind_at: remindAt,
        repeat: repeatSelect.value,
        assigned_to: assignSelect ? (assignSelect.value ? Number(assignSelect.value) : null) : assigned_to_id,
      };
    },
  };
}

function repeatBadge(item) {
  if (!item.repeat || item.repeat === 'none') return null;
  const last = item.last_done_at ? ` · last done ${formatWhen(item.last_done_at)}` : '';
  return h('span', { class: 'chip', title: REPEAT_LABELS[item.repeat] + last }, `🔁 ${REPEAT_SHORT[item.repeat]}`);
}

function assigneeBadge(item) {
  if (item.assigned_to_id == null) return null;
  const mine = item.assigned_to_id === state.me.id;
  return h('span', { class: 'chip' + (mine ? ' mine' : '') }, `👤 ${mine ? 'You' : item.assigned_to}`);
}

/** Tick a to-do. Repeating ones roll forward to the next date instead of closing. */
async function completeItem(itemId, done) {
  const res = await api(`/items/${itemId}`, { method: 'PATCH', json: { done } });
  if (res.advanced_to) toast(`Done! Next one is due ${formatWhen(res.advanced_to)}`);
  await refreshView();
  checkReminders();
}

function dueBadge(item) {
  if (item.due_at == null) return null;
  const left = item.due_at - Date.now();
  let cls = 'chip';
  let prefix = 'Due';
  if (!item.done && left < 0) { cls += ' overdue'; prefix = 'Overdue ·'; }
  else if (!item.done && left < 86400000) cls += ' soon';
  return h('span', { class: cls, title: new Date(item.due_at).toLocaleString() }, `📅 ${prefix} ${formatWhen(item.due_at)}`);
}

function remindBadge(item) {
  if (item.remind_at == null || item.done) return null;
  const past = item.remind_at <= Date.now();
  return h('span', { class: 'chip' + (past ? ' faded' : ''), title: new Date(item.remind_at).toLocaleString() },
    `🔔 ${formatWhen(item.remind_at)}`);
}

// ---------------------------------------------------------------- list pane

function renderList() {
  const list = state.current;
  const editable = list.role === 'owner' || list.role === 'edit';
  const isOwner = list.role === 'owner';

  const sharedLine = isOwner
    ? list.shares.length
      ? `Shared with ${list.shares.map((s) => s.username + (s.can_edit ? '' : ' (view only)')).join(', ')}`
      : 'Private — only you can see this list'
    : `Owned by ${list.owner} · you can ${list.role === 'edit' ? 'edit' : 'view only'}`;

  const header = h('div', { class: 'pane-header' },
    h('div', {},
      h('h2', {}, list.title),
      h('p', { class: 'muted small' }, sharedLine)),
    h('div', { class: 'row wrap' },
      isOwner ? h('button', { class: 'primary', onclick: openShareDialog }, 'Share…') : null,
      isOwner ? h('button', { onclick: renameList }, 'Rename') : null,
      isOwner ? h('button', { class: 'danger', onclick: deleteList }, 'Delete') : null,
      !isOwner ? h('button', { onclick: leaveList }, 'Remove from my lists') : null));

  const items = list.items.filter((i) =>
    !(state.hideDone && i.done) && !(state.onlyMine && i.assigned_to_id !== state.me.id));
  const doneCount = list.items.filter((i) => i.done).length;
  const overdue = list.items.filter((i) => !i.done && i.due_at != null && i.due_at < Date.now()).length;

  const toolbar = h('div', { class: 'row toolbar' },
    h('span', { class: 'muted small' },
      `${list.items.length - doneCount} open · ${doneCount} done`,
      overdue ? h('span', { class: 'overdue-text' }, ` · ${overdue} overdue`) : null),
    h('span', { class: 'spacer' }),
    list.members.length > 1
      ? h('label', { class: 'small inline' },
        h('input', {
          type: 'checkbox',
          checked: state.onlyMine,
          onchange: (e) => { state.onlyMine = e.target.checked; renderList(); },
        }),
        ' Assigned to me')
      : null,
    h('label', { class: 'small inline' },
      h('input', {
        type: 'checkbox',
        checked: state.hideDone,
        onchange: (e) => {
          state.hideDone = e.target.checked;
          remember('hideDone', state.hideDone ? '1' : '0');
          renderList();
        },
      }),
      ' Hide completed'),
    h('button', { class: 'ghost small', onclick: () => attempt(refreshCurrent), title: 'Fetch latest changes' }, '↻ Refresh'));

  fill($('#list-pane'), 
    header,
    editable ? renderAddForm() : null,
    toolbar,
    items.length
      ? h('ul', { class: 'items' }, items.map((i) => renderItem(i, editable)))
      : h('p', { class: 'muted empty' },
        state.onlyMine ? 'Nothing assigned to you here.' : list.items.length ? 'Everything is done 🎉' : 'Nothing here yet.'),
  );
}

function renderAddForm() {
  const textarea = h('textarea', {
    name: 'body',
    rows: 3,
    maxlength: 20000,
    placeholder: 'Add a to-do… write as much as you like. Paste or attach photos.',
    oninput: (e) => { state.draftBody = e.target.value; },
    onkeydown: (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) form.requestSubmit();
    },
    onpaste: (e) => {
      const files = [...(e.clipboardData?.files ?? [])];
      if (files.length) {
        e.preventDefault();
        addPending(files);
      }
    },
  }, state.draftBody);

  const previews = h('div', { class: 'thumbs' });
  const drawPreviews = () => {
    previews.replaceChildren(
      ...state.pendingPhotos.map((file, idx) => {
        const url = URL.createObjectURL(file);
        return h('figure', { class: 'thumb' },
          h('img', { src: url, alt: file.name, onload: () => URL.revokeObjectURL(url) }),
          h('button', {
            type: 'button', class: 'thumb-remove', 'aria-label': 'Remove photo',
            onclick: () => { state.pendingPhotos.splice(idx, 1); drawPreviews(); },
          }, '×'));
      }));
  };
  const addPending = (files) => {
    state.pendingPhotos.push(...acceptImages(files));
    state.pendingPhotos = state.pendingPhotos.slice(0, 10);
    drawPreviews();
  };

  // On phones, accept="image/*" lets the user pick "Take photo" or the gallery.
  const fileInput = h('input', {
    type: 'file', accept: 'image/*', multiple: true, hidden: true,
    onchange: (e) => { addPending([...e.target.files]); e.target.value = ''; },
  });

  const schedule = detailFields({}, state.current.members);
  schedule.el.hidden = true;
  const scheduleBtn = h('button', {
    type: 'button',
    title: 'Deadline, reminder, repeat' + (state.current.members.length > 1 ? ', assign' : ''),
    onclick: () => { schedule.el.hidden = !schedule.el.hidden; scheduleBtn.classList.toggle('on', !schedule.el.hidden); },
  }, state.current.members.length > 1 ? '📅 Due / assign' : '📅 Due / repeat');

  const submitBtn = h('button', { type: 'submit', class: 'primary' }, 'Add');

  const form = h('form', {
    class: 'card add-form',
    ondragover: (e) => { e.preventDefault(); form.classList.add('drag'); },
    ondragleave: () => form.classList.remove('drag'),
    ondrop: (e) => {
      e.preventDefault();
      form.classList.remove('drag');
      addPending([...e.dataTransfer.files]);
    },
    onsubmit: async (e) => {
      e.preventDefault();
      if (!textarea.value.trim() && !state.pendingPhotos.length) {
        textarea.focus();
        return;
      }
      let times = { due_at: null, remind_at: null, repeat: 'none', assigned_to: null };
      if (!schedule.el.hidden) {
        try { times = schedule.read(); } catch (err) { return toast(err.message); }
      }
      const fd = new FormData();
      fd.append('body', textarea.value);
      fd.append('tz', TIME_ZONE);
      if (times.due_at != null) fd.append('due_at', String(times.due_at));
      if (times.remind_at != null) fd.append('remind_at', String(times.remind_at));
      if (times.repeat !== 'none') fd.append('repeat', times.repeat);
      if (times.assigned_to != null) fd.append('assigned_to', String(times.assigned_to));
      for (const f of state.pendingPhotos) fd.append('photos', f, f.name || 'photo.jpg');
      submitBtn.disabled = true;
      submitBtn.textContent = 'Adding…';
      try {
        await api(`/lists/${state.currentId}/items`, { method: 'POST', form: fd });
        state.pendingPhotos = [];
        state.draftBody = '';
        await refreshView();
        if (matchMedia('(pointer: fine)').matches) $('.add-form textarea')?.focus();
        if (times.remind_at != null) maybeOfferNotifications();
      } catch (err) {
        toast(err.message);
        submitBtn.disabled = false;
        submitBtn.textContent = 'Add';
      }
    },
  },
  textarea,
  previews,
  schedule.el,
  h('div', { class: 'row wrap' },
    h('button', { type: 'button', onclick: () => fileInput.click() }, '📷 Photo'),
    fileInput,
    scheduleBtn,
    h('span', { class: 'muted small hint' }, 'Ctrl+Enter to add'),
    h('span', { class: 'spacer' }),
    submitBtn));

  queueMicrotask(drawPreviews);
  return form;
}

function renderItem(item, editable) {
  const editing = state.editingItemId === item.id;

  const checkbox = h('input', {
    type: 'checkbox',
    class: 'done-box',
    checked: item.done,
    disabled: !editable,
    'aria-label': item.done ? 'Mark as not done' : 'Mark as done',
    onchange: (e) => attempt(() => completeItem(item.id, e.target.checked)),
  });

  let content;
  if (editing) {
    const ta = h('textarea', { rows: Math.min(12, Math.max(3, item.body.split('\n').length + 1)), maxlength: 20000 }, item.body);
    const schedule = detailFields(item, state.current.members);
    const save = () => attempt(async () => {
      const times = schedule.read();
      const patch = { body: ta.value, tz: TIME_ZONE };
      if (times.due_at !== item.due_at) patch.due_at = times.due_at;
      if (times.remind_at !== item.remind_at) patch.remind_at = times.remind_at;
      if (times.repeat !== item.repeat) patch.repeat = times.repeat;
      if (times.assigned_to !== item.assigned_to_id) patch.assigned_to = times.assigned_to;
      await api(`/items/${item.id}`, { method: 'PATCH', json: patch });
      state.editingItemId = null;
      await refreshView();
      checkReminders();
      if (patch.remind_at != null) maybeOfferNotifications();
    });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save();
      if (e.key === 'Escape') stopEditing();
    });
    queueMicrotask(() => ta.focus());
    content = h('div', { class: 'edit-box' },
      ta,
      schedule.el,
      h('div', { class: 'row end' },
        h('button', { onclick: stopEditing }, 'Cancel'),
        h('button', { class: 'primary', onclick: save }, 'Save')));
  } else {
    content = item.body ? h('div', { class: 'body' }, item.body) : null;
  }

  const photoInput = h('input', {
    type: 'file', accept: 'image/*', multiple: true, hidden: true,
    onchange: (e) => attempt(async () => {
      const files = acceptImages([...e.target.files]);
      e.target.value = '';
      if (!files.length) return;
      const fd = new FormData();
      for (const f of files) fd.append('photos', f, f.name || 'photo.jpg');
      await api(`/items/${item.id}/photos`, { method: 'POST', form: fd });
      await refreshCurrent();
    }),
  });

  const photos = item.photos.length
    ? h('div', { class: 'thumbs' }, item.photos.map((p) =>
      h('figure', { class: 'thumb' },
        h('img', { src: p.url, alt: 'Attached photo', loading: 'lazy', onclick: () => viewPhoto(p.url) }),
        editable && editing
          ? h('button', {
            class: 'thumb-remove', 'aria-label': 'Delete photo',
            onclick: () => attempt(async () => {
              if (!confirm('Delete this photo?')) return;
              await api(`/photos/${p.id}`, { method: 'DELETE' });
              await refreshCurrent();
            }),
          }, '×')
          : null)))
    : null;

  const chipEls = editing ? [] : [assigneeBadge(item), dueBadge(item), remindBadge(item), repeatBadge(item)].filter(Boolean);
  const chips = chipEls.length ? h('div', { class: 'chips' }, chipEls) : null;

  const edited = item.updated_at !== item.created_at ? ' · edited' : '';
  const meta = h('div', { class: 'meta muted small' },
    `${item.created_by ?? 'someone'} · ${formatDate(item.created_at)}${edited}`);

  const actions = editable && !editing
    ? h('div', { class: 'item-actions' },
      h('button', { class: 'ghost small', onclick: () => { state.editingItemId = item.id; renderList(); } }, 'Edit'),
      h('button', { class: 'ghost small', onclick: () => photoInput.click(), 'aria-label': 'Add photo' }, '📷'),
      photoInput,
      h('button', {
        class: 'ghost small danger',
        onclick: () => attempt(async () => {
          if (!confirm('Delete this to-do and its photos?')) return;
          await api(`/items/${item.id}`, { method: 'DELETE' });
          await refreshView();
        }),
      }, 'Delete'))
    : null;

  const overdue = !item.done && item.due_at != null && item.due_at < Date.now();
  return h('li', { class: 'item card' + (item.done ? ' done' : '') + (overdue ? ' is-overdue' : ''), id: `item-${item.id}` },
    checkbox,
    h('div', { class: 'item-main' }, content, chips, photos, meta),
    actions);
}

function viewPhoto(url) {
  $('#photo-full').src = url;
  $('#photo-dialog').showModal();
}
$('#photo-dialog').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) e.currentTarget.close();
});

// ---------------------------------------------------------------- dashboard

const DASH_SCOPES = [
  ['all', 'All'],
  ['mine', 'My lists'],
  ['shared', 'Shared with me'],
  ['assigned', 'Assigned to me'],
  ['created', 'Created by me'],
];

async function refreshDashboard() {
  try {
    state.dashboard = await api('/dashboard');
  } catch (err) {
    return toast(err.message);
  }
  renderDashboard();
}

function renderDashboard() {
  const { lists, items, done_this_week } = state.dashboard;
  const me = state.me.id;
  const listById = new Map(lists.map((l) => [l.id, l]));
  const now = Date.now();
  const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
  const endOfToday = startOfToday.getTime() + 86400000;

  const inScope = (item, scope = state.dashScope) => {
    const list = listById.get(item.list_id);
    switch (scope) {
      case 'mine': return list.role === 'owner';
      case 'shared': return list.role !== 'owner';
      case 'assigned': return item.assigned_to_id === me;
      case 'created': return item.created_by_id === me;
      default: return true;
    }
  };
  const WHEN = {
    any: () => true,
    overdue: (i) => i.due_at != null && i.due_at < now,
    today: (i) => i.due_at != null && i.due_at >= startOfToday.getTime() && i.due_at < endOfToday,
    week: (i) => i.due_at != null && i.due_at >= now && i.due_at < now + 7 * 86400000,
  };

  const scoped = items.filter((i) => inScope(i));
  const shown = scoped.filter(WHEN[state.dashWhen]);

  const tile = (key, label, count, cls = '') =>
    h('button', {
      class: `tile ${cls}${state.dashWhen === key ? ' active' : ''}`,
      'aria-pressed': String(state.dashWhen === key),
      onclick: () => { state.dashWhen = state.dashWhen === key ? 'any' : key; renderDashboard(); },
    },
    h('span', { class: 'tile-num' }, count),
    h('span', { class: 'tile-label' }, label));

  const tiles = h('div', { class: 'tiles' },
    tile('overdue', 'Overdue', scoped.filter(WHEN.overdue).length, 'danger'),
    tile('today', 'Due today', scoped.filter(WHEN.today).length, 'warn'),
    tile('week', 'Next 7 days', scoped.filter(WHEN.week).length),
    tile('any', 'Open to-dos', scoped.length));

  const tabs = h('div', { class: 'tabs', role: 'tablist' },
    DASH_SCOPES.map(([key, label]) => {
      const n = items.filter((i) => inScope(i, key)).length;
      return h('button', {
        role: 'tab',
        class: 'tab' + (state.dashScope === key ? ' active' : ''),
        'aria-selected': String(state.dashScope === key),
        onclick: () => { state.dashScope = key; remember('dashScope', key); renderDashboard(); },
      }, label, h('span', { class: 'tab-count' }, n));
    }));

  // Group the visible to-dos by list.
  const byList = new Map();
  for (const i of shown) {
    if (!byList.has(i.list_id)) byList.set(i.list_id, []);
    byList.get(i.list_id).push(i);
  }
  const filtering = state.dashWhen !== 'any' || ['assigned', 'created'].includes(state.dashScope);
  // When just browsing lists, also show lists with nothing open so none go missing.
  const groupLists = (pred) => lists.filter((l) => pred(l) && (byList.has(l.id) || !filtering));

  const section = (title, subtitle, groupList) => h('section', { class: 'dash-section' },
    h('h3', { class: 'dash-section-title' }, title, subtitle ? h('span', { class: 'muted' }, ` · ${subtitle}`) : null),
    groupList.length
      ? groupList.map((l) => renderDashGroup(l, byList.get(l.id) ?? []))
      : h('p', { class: 'muted small dash-empty' }, emptyText(title)));

  const emptyText = (title) => {
    if (filtering) return 'Nothing matches this filter.';
    return title === 'Shared with me' ? 'Nobody has shared a list with you yet.' : 'You have no lists yet — create one in the menu.';
  };

  let body;
  if (state.dashScope === 'all') {
    body = [
      section('My lists', 'created by you', groupLists((l) => l.role === 'owner')),
      section('Shared with me', 'from other people', groupLists((l) => l.role !== 'owner')),
    ];
  } else if (state.dashScope === 'mine') {
    body = section('My lists', 'created by you', groupLists((l) => l.role === 'owner'));
  } else if (state.dashScope === 'shared') {
    body = section('Shared with me', 'from other people', groupLists((l) => l.role !== 'owner'));
  } else {
    const title = state.dashScope === 'assigned' ? 'Assigned to me' : 'To-dos I created';
    body = section(title, null, lists.filter((l) => byList.has(l.id)));
  }

  const whenLabel = { overdue: 'overdue', today: 'due today', week: 'due in the next 7 days' }[state.dashWhen];

  fill($('#list-pane'), 
    h('div', { class: 'pane-header' },
      h('div', {},
        h('h2', {}, `Hi, ${state.me.username}`),
        h('p', { class: 'muted small' },
          `${items.length} open to-do${items.length === 1 ? '' : 's'} across ${lists.length} list${lists.length === 1 ? '' : 's'}`,
          done_this_week ? ` · ${done_this_week} completed this week 🎉` : '')),
      h('button', { class: 'ghost small', onclick: () => attempt(refreshDashboard), title: 'Fetch latest changes' }, '↻ Refresh')),
    tiles,
    tabs,
    whenLabel
      ? h('p', { class: 'filter-note small' }, `Showing only to-dos ${whenLabel}. `,
        h('button', { class: 'linkish', onclick: () => { state.dashWhen = 'any'; renderDashboard(); } }, 'Show all'))
      : null,
    body,
  );
}

const DASH_GROUP_LIMIT = 6;

function renderDashGroup(list, groupItems) {
  const editable = list.role === 'owner' || list.role === 'edit';
  const meta = list.role === 'owner'
    ? list.shared_with.length ? `Shared with ${list.shared_with.join(', ')}` : 'Private'
    : `From ${list.owner} · ${list.role === 'edit' ? 'can edit' : 'view only'}`;
  const visible = groupItems.slice(0, DASH_GROUP_LIMIT);
  const hidden = groupItems.length - visible.length;

  return h('article', { class: 'card dash-group' },
    h('a', {
      href: `#${list.id}`,
      class: 'dash-group-head',
      onclick: (e) => { e.preventDefault(); openList(list.id); },
    },
    h('div', { class: 'grow' },
      h('div', { class: 'dash-group-title' }, list.title),
      h('div', { class: 'muted small' }, meta)),
    list.overdue_count ? h('span', { class: 'badge overdue' }, `${list.overdue_count} late`) : null,
    h('span', { class: 'count' }, `${list.open_count} open`),
    h('span', { class: 'chev', 'aria-hidden': 'true' }, '›')),
    groupItems.length
      ? h('ul', { class: 'dash-items' }, visible.map((i) => renderDashItem(i, list, editable)))
      : h('p', { class: 'muted small dash-empty' }, list.open_count ? '' : 'All done ✓'),
    hidden > 0
      ? h('button', { class: 'linkish small more-link', onclick: () => openList(list.id) }, `+ ${hidden} more — open list`)
      : null);
}

function renderDashItem(item, list, editable) {
  const [first, ...rest] = (item.body || '').split('\n');
  const chips = [
    assigneeBadge(item),
    dueBadge(item),
    repeatBadge(item),
    item.photo_count ? h('span', { class: 'chip' }, `📷 ${item.photo_count}`) : null,
    item.created_by_id !== state.me.id && item.created_by ? h('span', { class: 'chip faded' }, `by ${item.created_by}`) : null,
  ].filter(Boolean);

  const overdue = item.due_at != null && item.due_at < Date.now();
  return h('li', { class: 'dash-item' + (overdue ? ' is-overdue' : '') },
    h('input', {
      type: 'checkbox',
      class: 'done-box',
      disabled: !editable,
      'aria-label': 'Mark as done',
      title: editable ? (item.repeat !== 'none' ? 'Done — repeats' : 'Mark as done') : 'View only',
      onchange: (e) => attempt(() => completeItem(item.id, e.target.checked)),
    }),
    h('button', {
      class: 'dash-item-body',
      onclick: () => openList(list.id).then(() => $(`#item-${item.id}`)?.scrollIntoView({ block: 'center' })),
    },
    h('span', { class: 'dash-item-title' }, first || (item.photo_count ? 'Photo to-do' : 'Untitled')),
    rest.join(' ').trim() ? h('span', { class: 'dash-item-more muted small' }, rest.join(' ').trim()) : null,
    chips.length ? h('span', { class: 'chips' }, chips) : null));
}

// ---------------------------------------------------------------- live updates

let eventSource = null;
let liveTimer = null;
let liveDeferred = false;

function startLiveUpdates() {
  stopLiveUpdates();
  if (!('EventSource' in window)) return;
  eventSource = new EventSource('/api/events');
  eventSource.onmessage = (e) => {
    let ev;
    try { ev = JSON.parse(e.data); } catch { return; }
    if (ev.type === 'reminder') checkReminders();
    if (ev.source === CLIENT_ID) return; // our own change — already on screen
    clearTimeout(liveTimer);
    liveTimer = setTimeout(runLiveRefresh, 250);
  };
}

function stopLiveUpdates() {
  eventSource?.close();
  eventSource = null;
  clearTimeout(liveTimer);
}

/** Refresh for someone else's change, unless that would disrupt what the user is doing. */
async function runLiveRefresh() {
  const busy = state.editingItemId != null
    || document.querySelector('dialog[open]')
    || document.activeElement?.closest?.('.add-form');
  if (busy) {
    liveDeferred = true;
    return;
  }
  liveDeferred = false;
  await attempt(refreshView);
  checkReminders();
}

function flushDeferredLive() {
  if (liveDeferred) setTimeout(runLiveRefresh, 50);
}
document.addEventListener('focusout', flushDeferredLive);
for (const d of document.querySelectorAll('dialog')) d.addEventListener('close', flushDeferredLive);

function stopEditing() {
  state.editingItemId = null;
  if (liveDeferred) runLiveRefresh();
  else renderList();
}

// ---------------------------------------------------------------- list actions

async function renameList() {
  const title = prompt('Rename list', state.current.title);
  if (!title || title.trim() === state.current.title) return;
  await attempt(async () => {
    await api(`/lists/${state.currentId}`, { method: 'PATCH', json: { title } });
    await loadLists();
    await refreshCurrent();
  });
}

async function deleteList() {
  if (!confirm(`Delete “${state.current.title}” and everything in it? This can't be undone.`)) return;
  await attempt(async () => {
    await api(`/lists/${state.currentId}`, { method: 'DELETE' });
    await loadLists();
    await openDashboard();
  });
}

async function leaveList() {
  if (!confirm(`Remove “${state.current.title}” from your lists? The owner can share it again later.`)) return;
  await attempt(async () => {
    await api(`/lists/${state.currentId}/shares/me`, { method: 'DELETE' });
    await loadLists();
    await openDashboard();
  });
}

// ---------------------------------------------------------------- sharing

let shareDraft = new Map(); // userId -> canEdit
let allUsers = [];

async function openShareDialog() {
  const users = await attempt(() => api('/users'));
  if (!users) return;
  allUsers = users;
  shareDraft = new Map(state.current.shares.map((s) => [s.user_id, s.can_edit]));
  $('#share-title').textContent = state.current.title;
  $('#share-filter').value = '';
  $('#share-error').textContent = '';
  renderShareUsers();
  $('#share-dialog').showModal();
  if (matchMedia('(pointer: fine)').matches) $('#share-filter').focus();
}

function renderShareUsers() {
  const q = $('#share-filter').value.trim().toLowerCase();
  const shown = allUsers.filter((u) => u.username.toLowerCase().includes(q));
  // Selected people float to the top so it's easy to review who has access.
  shown.sort((a, b) => Number(shareDraft.has(b.id)) - Number(shareDraft.has(a.id)));

  fill($('#share-users'), 
    ...(shown.length
      ? shown.map((u) => {
        const selected = shareDraft.has(u.id);
        return h('li', { class: selected ? 'selected' : '' },
          h('label', { class: 'inline grow' },
            h('input', {
              type: 'checkbox',
              checked: selected,
              onchange: (e) => {
                if (e.target.checked) shareDraft.set(u.id, true);
                else shareDraft.delete(u.id);
                renderShareUsers();
              },
            }),
            ' ', u.username),
          h('select', {
            disabled: !selected,
            'aria-label': `Access for ${u.username}`,
            onchange: (e) => shareDraft.set(u.id, e.target.value === 'edit'),
          },
          h('option', { value: 'edit', selected: shareDraft.get(u.id) !== false }, 'Can edit'),
          h('option', { value: 'view', selected: shareDraft.get(u.id) === false }, 'View only')));
      })
      : [h('li', { class: 'muted' }, allUsers.length ? 'No matching users.' : 'No other users have signed up yet.')]),
  );
}

$('#share-filter').addEventListener('input', renderShareUsers);
$('#share-cancel').addEventListener('click', () => $('#share-dialog').close());

$('#share-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const shares = [...shareDraft].map(([userId, canEdit]) => ({ userId, canEdit }));
    await api(`/lists/${state.currentId}/shares`, { method: 'PUT', json: { shares } });
    $('#share-dialog').close();
    toast(shares.length ? `Shared with ${shares.length} ${shares.length === 1 ? 'person' : 'people'}` : 'List is now private');
    await loadLists();
    await refreshCurrent();
  } catch (err) {
    $('#share-error').textContent = err.message;
  }
});

// ---------------------------------------------------------------- reminders (in-app)

let reminderTimer = null;
const notifiedThisSession = new Set();

function startReminderPolling() {
  stopReminderPolling();
  checkReminders();
  reminderTimer = setInterval(checkReminders, 30000);
}
function stopReminderPolling() {
  clearInterval(reminderTimer);
  reminderTimer = null;
}

async function checkReminders() {
  if (!state.me) return;
  let due;
  try {
    due = await api('/reminders');
  } catch {
    return;
  }
  state.reminders = due;
  renderReminderBar();
  for (const r of due) {
    const key = `${r.id}:${r.remind_at}`;
    if (notifiedThisSession.has(key)) continue;
    notifiedThisSession.add(key);
    showSystemNotification(r);
  }
}

async function showSystemNotification(r) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const title = `🔔 ${r.list_title}`;
  const opts = { body: r.body.split('\n')[0].slice(0, 140) || 'Photo to-do', tag: `item-${r.id}`, icon: '/icon.svg', data: { url: `/#${r.list_id}` } };
  try {
    // Going through the service worker uses the same tag as push, so it isn't shown twice.
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) return await reg.showNotification(title, opts);
    new Notification(title, opts);
  } catch {}
}

function renderReminderBar() {
  const bar = $('#reminder-bar');
  if (!state.reminders.length) return bar.replaceChildren();
  fill(bar, 
    h('div', { class: 'card reminders' },
      h('div', { class: 'reminders-head' }, `🔔 ${state.reminders.length === 1 ? 'Reminder' : `${state.reminders.length} reminders`}`),
      h('ul', {}, state.reminders.map((r) =>
        h('li', {},
          h('div', { class: 'grow' },
            h('div', { class: 'reminder-text' }, r.body.split('\n')[0] || 'Photo to-do'),
            h('div', { class: 'muted small' },
              r.list_title,
              r.due_at != null ? ` · due ${formatWhen(r.due_at)}` : '')),
          h('div', { class: 'row wrap reminder-actions' },
            h('button', { class: 'small', onclick: () => openList(r.list_id).then(() => $(`#item-${r.id}`)?.scrollIntoView({ block: 'center' })) }, 'Open'),
            r.can_edit ? h('button', { class: 'small', onclick: () => snooze(r, 60) }, 'Snooze 1h') : null,
            r.can_edit ? h('button', { class: 'small', onclick: () => markDone(r) }, '✓ Done') : null,
            h('button', { class: 'small ghost', onclick: () => dismiss(r) }, 'Dismiss')))))));
}

const afterReminderChange = async () => {
  await checkReminders();
  await refreshView();
};
const snooze = (r, mins) => attempt(async () => {
  await api(`/items/${r.id}`, { method: 'PATCH', json: { remind_at: Date.now() + mins * 60000 } });
  toast(`Snoozed until ${formatWhen(Date.now() + mins * 60000)}`);
  await afterReminderChange(r);
});
const markDone = (r) => attempt(() => completeItem(r.id, true));
const dismiss = (r) => attempt(async () => {
  await api(`/reminders/${r.id}/dismiss`, { method: 'POST' });
  await afterReminderChange(r);
});

// ---------------------------------------------------------------- push notifications (app closed)

const pushSupported = () =>
  window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'open') {
      const id = Number(new URL(e.data.url, location.origin).hash.slice(1));
      if (id) openList(id);
    }
  });
}

function urlBase64ToUint8Array(base64) {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

async function currentPushSubscription() {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}

async function enablePush() {
  if (!pushSupported()) return;
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') {
    toast('Notifications were not allowed');
    return renderNotifyBox();
  }
  const reg = await navigator.serviceWorker.ready;
  const { publicKey } = await api('/push/key');
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
  }
  await api('/push/subscribe', { method: 'POST', json: { subscription: sub.toJSON() } });
  toast('Reminders will notify this device');
  renderNotifyBox();
}

async function disablePush({ quiet = false } = {}) {
  const sub = await currentPushSubscription();
  if (sub) {
    await api('/push/unsubscribe', { method: 'POST', json: { endpoint: sub.endpoint } }).catch(() => {});
    await sub.unsubscribe().catch(() => {});
  }
  if (!quiet) {
    toast('Notifications turned off for this device');
    renderNotifyBox();
  }
}

// Re-link an existing subscription to whoever just signed in on this device.
async function syncPushSubscription() {
  try {
    const sub = await currentPushSubscription();
    if (sub && Notification.permission === 'granted') {
      await api('/push/subscribe', { method: 'POST', json: { subscription: sub.toJSON() } });
    }
  } catch {}
}

let offeredNotifications = false;
function maybeOfferNotifications() {
  if (offeredNotifications || !pushSupported() || Notification.permission !== 'default') return;
  offeredNotifications = true;
  toast('Tip: turn on notifications in the menu to get reminders when the app is closed');
}

async function renderNotifyBox() {
  const box = $('#notify-box');
  if (!pushSupported()) {
    box.replaceChildren(h('p', { class: 'muted small' },
      window.isSecureContext
        ? 'This browser can’t show notifications. Reminders will still appear in the app. (On iPhone, add this app to your Home Screen first.)'
        : 'Reminders show in the app. For phone/desktop notifications, open the app over HTTPS.'));
    return;
  }
  const sub = await currentPushSubscription().catch(() => null);
  if (Notification.permission === 'denied') {
    box.replaceChildren(h('p', { class: 'muted small' }, 'Notifications are blocked for this site in your browser settings.'));
  } else if (sub && Notification.permission === 'granted') {
    box.replaceChildren(
      h('p', { class: 'small' }, '🔔 Notifications on for this device'),
      h('button', { class: 'ghost small', onclick: () => attempt(() => disablePush()) }, 'Turn off'));
  } else {
    box.replaceChildren(h('button', { onclick: () => attempt(enablePush) }, '🔔 Turn on reminder notifications'));
  }
}

// ---------------------------------------------------------------- live-ish updates

// Pick up changes collaborators made while this tab was in the background.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.me) {
    checkReminders();
    if (state.editingItemId == null) {
      attempt(async () => {
        await loadLists();
        await refreshCurrent();
      });
    }
  }
});

// ---------------------------------------------------------------- boot

(async () => {
  try {
    state.me = await api('/me');
    await showApp();
  } catch {
    showAuth();
  }
})();
