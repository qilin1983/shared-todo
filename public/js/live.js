// Live updates: the server pushes a small event whenever something you can see changes.

import { attempt, state, loadPeople, CLIENT_ID } from './core.js';
import { refreshView } from './nav.js';
import { isBusyInList } from './list.js';
import { checkReminders } from './reminders.js';
import { renderMeButton } from './profile.js';

let eventSource = null;
let liveTimer = null;
let liveDeferred = false;

export function startLiveUpdates() {
  stopLiveUpdates();
  if (!('EventSource' in window)) return;
  eventSource = new EventSource('/api/events');
  eventSource.onmessage = (e) => {
    let ev;
    try { ev = JSON.parse(e.data); } catch { return; }
    if (ev.type === 'reminder') checkReminders();
    if (ev.type === 'users') {
      // Someone changed their name or picture.
      attempt(async () => { await loadPeople(); renderMeButton(); scheduleRefresh(); });
      return;
    }
    if (ev.source === CLIENT_ID) return; // our own change — already on screen
    scheduleRefresh();
  };
}

export function stopLiveUpdates() {
  eventSource?.close();
  eventSource = null;
  clearTimeout(liveTimer);
}

function scheduleRefresh() {
  clearTimeout(liveTimer);
  liveTimer = setTimeout(runLiveRefresh, 250);
}

/** Refresh for someone else's change, unless that would disrupt what the user is doing. */
async function runLiveRefresh() {
  const busy = document.querySelector('dialog[open]') || (state.view === 'list' && isBusyInList());
  if (busy) {
    liveDeferred = true;
    return;
  }
  liveDeferred = false;
  await attempt(refreshView);
  checkReminders();
}

export function flushDeferredLive() {
  if (liveDeferred) setTimeout(runLiveRefresh, 50);
}

document.addEventListener('focusout', flushDeferredLive);
for (const d of document.querySelectorAll('dialog')) d.addEventListener('close', flushDeferredLive);

// Pick up anything missed while this tab was in the background.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.me) {
    checkReminders();
    runLiveRefresh();
  }
});
