// Navigation between the dashboard, a list and search results, plus the sidebar.

import { $, h, fill, api, toast, state, formatWhen } from './core.js';
import { renderList } from './list.js';
import { renderDashboard } from './dashboard.js';
import { renderSearch } from './search.js';
import { checkReminders } from './reminders.js';

export function setNav(open) {
  document.body.classList.toggle('nav-open', open);
  $('#menu-btn').setAttribute('aria-expanded', String(open));
}

export async function loadLists() {
  state.lists = await api('/lists');
  renderLists();
}

export function renderLists() {
  const mine = state.lists.filter((l) => l.role === 'owner');
  const shared = state.lists.filter((l) => l.role !== 'owner');
  const link = (l) =>
    h('a', {
      href: `#${l.id}`,
      class: 'list-link' + (state.view === 'list' && l.id === state.currentId ? ' active' : ''),
      onclick: (e) => { e.preventDefault(); openList(l.id); },
    },
    h('span', { class: 'list-name' },
      h('span', { class: 'list-title' }, l.title),
      l.role !== 'owner' ? h('span', { class: 'muted small list-owner' }, `from ${l.owner}`) : null),
    l.role === 'owner' && l.share_count > 0 ? h('span', { class: 'badge', title: `Shared with ${l.share_count}` }, 'shared') : null,
    l.overdue_count > 0 ? h('span', { class: 'badge overdue', title: `${l.overdue_count} overdue` }, `${l.overdue_count} late`) : null,
    h('span', { class: 'count' }, l.open_count));

  const totalOverdue = state.lists.reduce((n, l) => n + l.overdue_count, 0);
  fill($('#lists-nav'),
    h('a', {
      href: '#dashboard',
      class: 'list-link dash-link' + (state.view === 'dashboard' ? ' active' : ''),
      onclick: (e) => { e.preventDefault(); openDashboard(); },
    },
    h('span', { class: 'list-name' }, '🏠 Dashboard'),
    totalOverdue ? h('span', { class: 'badge overdue' }, `${totalOverdue} late`) : null),
    h('h3', {}, 'My lists'),
    mine.length ? mine.map(link) : h('p', { class: 'muted small' }, 'No lists yet — create one above.'),
    shared.length ? [h('h3', {}, 'Shared with me'), shared.map(link)] : null);
}

export async function openList(id, { focusItemId } = {}) {
  if (id !== state.currentId) {
    state.draftBody = '';
    state.pendingPhotos = [];
    state.labelFilter = '';
    state.openThreads.clear();
    state.addingSubtaskTo = null;
  }
  state.view = 'list';
  state.currentId = id;
  state.editingItemId = null;
  history.replaceState(null, '', `#${id}`);
  setNav(false);
  renderLists();
  await refreshCurrent();
  if (focusItemId) focusItem(focusItemId);
}

export async function openDashboard() {
  state.view = 'dashboard';
  state.currentId = null;
  state.current = null;
  state.editingItemId = null;
  history.replaceState(null, '', '#dashboard');
  setNav(false);
  renderLists();
  await refreshDashboard();
}

export async function refreshDashboard() {
  let data;
  try {
    data = await api('/dashboard');
  } catch (err) {
    return toast(err.message);
  }
  // The user may have moved on (e.g. started a search) while this was loading.
  if (state.view !== 'dashboard') return;
  state.dashboard = data;
  renderDashboard();
}

/** Re-fetch and redraw whatever is on screen. */
export async function refreshCurrent() {
  if (state.view === 'dashboard') return refreshDashboard();
  if (state.view === 'search') return renderSearch();
  if (!state.currentId) return;
  const listId = state.currentId;
  let data;
  try {
    data = await api(`/lists/${listId}`);
  } catch (err) {
    if (state.view !== 'list' || state.currentId !== listId) return;
    // e.g. the owner deleted the list or stopped sharing it with us
    toast(err.message === 'Not found' ? 'That list is no longer available' : err.message);
    await loadLists();
    await openDashboard();
    return;
  }
  if (state.view !== 'list' || state.currentId !== listId) return; // navigated away meanwhile
  state.current = data;
  // Refresh any comment threads that are open.
  await Promise.all([...state.openThreads].map(async (itemId) => {
    if (!state.current.items.some((i) => i.id === itemId)) return state.openThreads.delete(itemId);
    state.comments.set(itemId, await api(`/items/${itemId}/comments`).catch(() => []));
  }));
  if (state.view === 'list' && state.currentId === listId) renderList();
}

/** Re-render the current view with fresh data (used after actions and live updates). */
export async function refreshView() {
  await loadLists();
  await refreshCurrent();
}

/** Scroll a to-do into view and briefly highlight it. */
export function focusItem(itemId) {
  const el = document.getElementById(`item-${itemId}`);
  if (!el) return;
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1600);
}

/** Tick a to-do. Repeating ones roll forward to the next date instead of closing. */
export async function completeItem(itemId, done) {
  const res = await api(`/items/${itemId}`, { method: 'PATCH', json: { done } });
  if (res.advanced_to) toast(`Done! Next one is due ${formatWhen(res.advanced_to)}`);
  await refreshView();
  checkReminders();
}
