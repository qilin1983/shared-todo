// Entry point: sign-in, start-up, and the pieces of the page that are always there.

import { $, api, attempt, state, hooks, loadPeople, people } from './core.js';
import { setNav, loadLists, openList, openDashboard } from './nav.js';
import {
  startReminderPolling, stopReminderPolling, syncPushSubscription, renderNotifyBox, disablePush,
} from './reminders.js';
import { startLiveUpdates, stopLiveUpdates } from './live.js';
import { renderMeButton } from './profile.js';
import { clearSearch } from './search.js';

// ---------------------------------------------------------------- auth

function showAuth() {
  state.me = null;
  stopReminderPolling();
  stopLiveUpdates();
  $('#app-view').hidden = true;
  $('#auth-view').hidden = false;
  $('#auth-form [name=username]').focus();
}
hooks.onSignedOut = showAuth;

$('#auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const mode = e.submitter?.dataset.mode || 'login';
  const form = e.currentTarget;
  const errEl = $('#auth-error');
  errEl.textContent = '';
  try {
    state.me = await api(mode === 'register' ? '/register' : '/login', {
      method: 'POST',
      json: { username: form.username.value.trim(), password: form.password.value },
    });
    form.password.value = '';
    await showApp();
  } catch (err) {
    errEl.textContent = err.message;
  }
});

async function showApp() {
  $('#auth-view').hidden = true;
  $('#app-view').hidden = false;
  await loadPeople();
  state.me = { ...state.me, ...people.get(state.me.id) };
  renderMeButton();
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
  clearSearch();
  Object.assign(state, {
    lists: [], current: null, currentId: null, dashboard: null, reminders: [], draftBody: '', pendingPhotos: [],
  });
  state.openThreads.clear();
  state.comments.clear();
  $('#reminder-bar').replaceChildren();
  history.replaceState(null, '', location.pathname);
  showAuth();
});

// ---------------------------------------------------------------- always-present UI

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

$('#photo-dialog').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) e.currentTarget.close();
});

// Close export menus when clicking elsewhere.
document.addEventListener('click', (e) => {
  for (const d of document.querySelectorAll('details.menu[open]')) {
    if (!d.contains(e.target)) d.open = false;
  }
});

window.addEventListener('hashchange', () => {
  if (!state.me) return;
  if (location.hash === '#dashboard') {
    if (state.view !== 'dashboard') openDashboard();
    return;
  }
  const id = Number(location.hash.slice(1));
  if (id && id !== state.currentId) openList(id);
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
