// Reminders: the in-app banner, system notifications, and Web Push (for when the app is closed).

import { $, h, fill, api, toast, attempt, state, formatWhen } from './core.js';
import { openList, refreshView, completeItem } from './nav.js';

// ---------------------------------------------------------------- in-app

let reminderTimer = null;
const notifiedThisSession = new Set();

export function startReminderPolling() {
  stopReminderPolling();
  checkReminders();
  reminderTimer = setInterval(checkReminders, 30000);
}
export function stopReminderPolling() {
  clearInterval(reminderTimer);
  reminderTimer = null;
}

export async function checkReminders() {
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

export function renderReminderBar() {
  const bar = $('#reminder-bar');
  if (!state.reminders.length) return fill(bar);
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
            h('button', { class: 'small', onclick: () => openList(r.list_id, { focusItemId: r.id }) }, 'Open'),
            r.can_edit ? h('button', { class: 'small', onclick: () => snooze(r, 60) }, 'Snooze 1h') : null,
            r.can_edit ? h('button', { class: 'small', onclick: () => attempt(() => completeItem(r.id, true)) }, '✓ Done') : null,
            h('button', { class: 'small ghost', onclick: () => dismiss(r) }, 'Dismiss')))))));
}

const afterReminderChange = async () => {
  await checkReminders();
  await refreshView();
};
const snooze = (r, mins) => attempt(async () => {
  await api(`/items/${r.id}`, { method: 'PATCH', json: { remind_at: Date.now() + mins * 60000 } });
  toast(`Snoozed until ${formatWhen(Date.now() + mins * 60000)}`);
  await afterReminderChange();
});
const dismiss = (r) => attempt(async () => {
  await api(`/reminders/${r.id}/dismiss`, { method: 'POST' });
  await afterReminderChange();
});

// ---------------------------------------------------------------- push (app closed)

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

export async function disablePush({ quiet = false } = {}) {
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
export async function syncPushSubscription() {
  try {
    const sub = await currentPushSubscription();
    if (sub && Notification.permission === 'granted') {
      await api('/push/subscribe', { method: 'POST', json: { subscription: sub.toJSON() } });
    }
  } catch {}
}

let offeredNotifications = false;
export function maybeOfferNotifications() {
  if (offeredNotifications || !pushSupported() || Notification.permission !== 'default') return;
  offeredNotifications = true;
  toast('Tip: turn on notifications in the menu to get reminders when the app is closed');
}

export async function renderNotifyBox() {
  const box = $('#notify-box');
  if (!pushSupported()) {
    fill(box, h('p', { class: 'muted small' },
      window.isSecureContext
        ? 'This browser can’t show notifications. Reminders will still appear in the app. (On iPhone, add this app to your Home Screen first.)'
        : 'Reminders show in the app. For phone/desktop notifications, open the app over HTTPS.'));
    return;
  }
  const sub = await currentPushSubscription().catch(() => null);
  if (Notification.permission === 'denied') {
    fill(box, h('p', { class: 'muted small' }, 'Notifications are blocked for this site in your browser settings.'));
  } else if (sub && Notification.permission === 'granted') {
    fill(box,
      h('p', { class: 'small' }, '🔔 Notifications on for this device'),
      h('button', { class: 'ghost small', onclick: () => attempt(() => disablePush()) }, 'Turn off'));
  } else {
    fill(box, h('button', { onclick: () => attempt(enablePush) }, '🔔 Turn on reminder notifications'));
  }
}
