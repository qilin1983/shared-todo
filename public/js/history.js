// Activity history: the per-list dialog and the feed used on the dashboard.

import { $, h, fill, api, attempt, state, formatWhen, timeAgo, avatar, nameOf } from './core.js';
import { openList } from './nav.js';

const q = (s) => `“${s}”`;

/** Human sentence for one history entry (without the person's name). */
function describe(a) {
  const s = q(a.summary);
  switch (a.action) {
    case 'list_created': return 'created this list';
    case 'list_renamed': return `renamed the list to ${q(a.detail)}`;
    case 'sharing_changed': return a.detail ? `shared the list with ${a.detail}` : 'made the list private';
    case 'member_left': return 'left the list';
    case 'item_added': return `added ${s}`;
    case 'item_edited': return `edited ${s}`;
    case 'item_completed': return `completed ${s}`;
    case 'item_reopened': return `reopened ${s}`;
    case 'item_repeated': return `completed ${s} — next due ${formatWhen(Number(a.detail))}`;
    case 'item_deleted': return `deleted ${s}`;
    case 'item_assigned': return a.detail ? `assigned ${s} to ${a.detail}` : `unassigned ${s}`;
    case 'photo_added': return `added ${a.detail === '1' ? 'a photo' : `${a.detail} photos`} to ${s}`;
    case 'photo_removed': return `removed a photo from ${s}`;
    case 'subtask_added': return `added sub-task ${q(a.detail)} to ${s}`;
    case 'subtask_done': return `ticked ${q(a.detail)} in ${s}`;
    case 'subtask_undone': return `unticked ${q(a.detail)} in ${s}`;
    case 'subtask_deleted': return `removed sub-task ${q(a.detail)} from ${s}`;
    case 'comment_added': return `commented on ${s}: ${q(a.detail)}`;
    default: return a.action.replace(/_/g, ' ');
  }
}

const ICONS = {
  list_created: '🆕', list_renamed: '✏️', sharing_changed: '👥', member_left: '🚪',
  item_added: '➕', item_edited: '✏️', item_completed: '✅', item_reopened: '↩️', item_repeated: '🔁',
  item_deleted: '🗑', item_assigned: '👤', photo_added: '📷', photo_removed: '📷',
  subtask_added: '☑', subtask_done: '☑', subtask_undone: '☐', subtask_deleted: '☑', comment_added: '💬',
};

export function renderFeed(entries, { showList = false, compact = false } = {}) {
  let lastDay = '';
  const rows = [];
  for (const a of entries) {
    const day = new Date(a.created_at).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
    if (!compact && day !== lastDay) {
      rows.push(h('li', { class: 'feed-day' }, day));
      lastDay = day;
    }
    const who = a.user_id === state.me.id ? 'You' : nameOf(a.user_id, a.user_name ?? 'Former member');
    rows.push(h('li', { class: 'feed-entry' },
      a.user_id != null ? avatar(a.user_id, 'sm') : h('span', { class: 'avatar sm hue-0' }, '?'),
      h('div', { class: 'feed-text' },
        h('div', {}, h('span', { class: 'feed-icon', 'aria-hidden': 'true' }, ICONS[a.action] ?? '•'), ' ',
          h('strong', {}, who), ' ', describe(a)),
        h('div', { class: 'muted small' },
          h('span', { title: new Date(a.created_at).toLocaleString() }, timeAgo(a.created_at)),
          showList
            ? [' · ', h('a', {
              href: `#${a.list_id}`,
              onclick: (e) => { e.preventDefault(); openList(a.list_id, { focusItemId: a.item_id }); },
            }, a.list_title)]
            : null))));
  }
  return h('ul', { class: 'feed' + (compact ? ' compact' : '') }, rows);
}

let historyState = { listId: null, entries: [], done: false };

export async function openHistory(listId, title) {
  historyState = { listId, entries: [], done: false };
  $('#history-title').textContent = title;
  fill($('#history-body'), h('p', { class: 'muted' }, 'Loading…'));
  $('#history-dialog').showModal();
  await loadMore();
}

async function loadMore() {
  const { listId, entries } = historyState;
  const before = entries.length ? `?before=${entries.at(-1).id}` : '';
  const page = await attempt(() => api(`/lists/${listId}/activity${before}`));
  if (!page) return;
  historyState.entries.push(...page);
  historyState.done = page.length < 50;
  fill($('#history-body'),
    historyState.entries.length ? renderFeed(historyState.entries) : h('p', { class: 'muted' }, 'No history yet.'),
    !historyState.done ? h('button', { class: 'small', onclick: loadMore }, 'Show older') : null);
}

$('#history-close').addEventListener('click', () => $('#history-dialog').close());
