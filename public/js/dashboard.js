// Home screen: everything open across your own lists and lists shared with you.

import { $, h, fill, attempt, state, remember, nameOf } from './core.js';
import {
  dueBadge, repeatBadge, assigneeBadge, priorityBadge, labelChips, subtaskBadge,
} from './fields.js';
import { openList, refreshDashboard, completeItem } from './nav.js';
import { renderFeed } from './history.js';

const DASH_SCOPES = [
  ['all', 'All'],
  ['mine', 'My lists'],
  ['shared', 'Shared with me'],
  ['assigned', 'Assigned to me'],
  ['created', 'Created by me'],
];
const DASH_GROUP_LIMIT = 6;

export function renderDashboard() {
  const { lists, items, done_this_week, activity } = state.dashboard;
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
  const hasLabel = (i) => !state.dashLabel || i.labels.some((l) => l.toLowerCase() === state.dashLabel.toLowerCase());
  const WHEN = {
    any: () => true,
    overdue: (i) => i.due_at != null && i.due_at < now,
    today: (i) => i.due_at != null && i.due_at >= startOfToday.getTime() && i.due_at < endOfToday,
    week: (i) => i.due_at != null && i.due_at >= now && i.due_at < now + 7 * 86400000,
    high: (i) => i.priority === 3,
  };

  const scoped = items.filter((i) => inScope(i) && hasLabel(i));
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
    tile('high', 'High priority', scoped.filter(WHEN.high).length, 'high'));

  const allLabels = [...new Map(items.flatMap((i) => i.labels).map((l) => [l.toLowerCase(), l])).values()].sort();
  const tabs = h('div', { class: 'tabs-row' },
    h('div', { class: 'tabs', role: 'tablist' },
      DASH_SCOPES.map(([key, label]) => {
        const n = items.filter((i) => inScope(i, key) && hasLabel(i)).length;
        return h('button', {
          role: 'tab',
          class: 'tab' + (state.dashScope === key ? ' active' : ''),
          'aria-selected': String(state.dashScope === key),
          onclick: () => { state.dashScope = key; remember('dashScope', key); renderDashboard(); },
        }, label, h('span', { class: 'tab-count' }, n));
      })),
    allLabels.length || state.dashLabel
      ? h('select', {
        class: 'compact',
        'aria-label': 'Filter by label',
        onchange: (e) => { state.dashLabel = e.target.value; renderDashboard(); },
      },
      h('option', { value: '' }, 'All labels'),
      allLabels.map((l) => h('option', { value: l, selected: l.toLowerCase() === state.dashLabel.toLowerCase() }, `#${l}`)))
      : null);

  // Group the visible to-dos by list.
  const byList = new Map();
  for (const i of shown) {
    if (!byList.has(i.list_id)) byList.set(i.list_id, []);
    byList.get(i.list_id).push(i);
  }
  const filtering = state.dashWhen !== 'any' || !!state.dashLabel || ['assigned', 'created'].includes(state.dashScope);
  // When just browsing lists, also show lists with nothing open so none go missing.
  const groupLists = (pred) => lists.filter((l) => pred(l) && (byList.has(l.id) || !filtering));

  const emptyText = (title) => {
    if (filtering) return 'Nothing matches this filter.';
    return title === 'Shared with me' ? 'Nobody has shared a list with you yet.' : 'You have no lists yet — create one in the menu.';
  };
  const section = (title, subtitle, groupList) => h('section', { class: 'dash-section' },
    h('h3', { class: 'dash-section-title' }, title, subtitle ? h('span', { class: 'muted' }, ` · ${subtitle}`) : null),
    groupList.length
      ? groupList.map((l) => renderDashGroup(l, byList.get(l.id) ?? []))
      : h('p', { class: 'muted small dash-empty' }, emptyText(title)));

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

  const notes = [
    { overdue: 'overdue', today: 'due today', week: 'due in the next 7 days', high: 'high priority' }[state.dashWhen],
    state.dashLabel ? `labelled #${state.dashLabel}` : null,
  ].filter(Boolean);

  fill($('#list-pane'),
    h('div', { class: 'pane-header' },
      h('div', {},
        h('h2', {}, `Hi, ${nameOf(me)}`),
        h('p', { class: 'muted small' },
          `${items.length} open to-do${items.length === 1 ? '' : 's'} across ${lists.length} list${lists.length === 1 ? '' : 's'}`,
          done_this_week ? ` · ${done_this_week} completed this week 🎉` : '')),
      h('button', { class: 'ghost small', onclick: () => attempt(refreshDashboard), title: 'Fetch latest changes' }, '↻ Refresh')),
    tiles,
    tabs,
    notes.length
      ? h('p', { class: 'filter-note small' }, `Showing only to-dos ${notes.join(' and ')}. `,
        h('button', { class: 'linkish', onclick: () => { state.dashWhen = 'any'; state.dashLabel = ''; renderDashboard(); } }, 'Clear filters'))
      : null,
    h('div', { class: 'dash-columns' },
      h('div', { class: 'dash-main' }, body),
      activity?.length
        ? h('aside', { class: 'dash-side' },
          h('h3', { class: 'dash-section-title' }, 'Recent activity'),
          h('div', { class: 'card feed-card' }, renderFeed(activity, { showList: true, compact: true })))
        : null));
}

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
    priorityBadge(item),
    assigneeBadge(item),
    dueBadge(item),
    repeatBadge(item),
    subtaskBadge(item.subtask_total, item.subtask_done),
    item.photo_count ? h('span', { class: 'chip' }, `📷 ${item.photo_count}`) : null,
    item.comment_count ? h('span', { class: 'chip' }, `💬 ${item.comment_count}`) : null,
    labelChips(item, (l) => { state.dashLabel = l; renderDashboard(); }),
    item.created_by_id !== state.me.id && item.created_by_id != null
      ? h('span', { class: 'chip faded' }, `by ${nameOf(item.created_by_id, item.created_by)}`) : null,
  ].flat().filter(Boolean);

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
    h('div', { class: 'dash-item-body' },
      h('button', {
        class: 'dash-item-open',
        onclick: () => openList(list.id, { focusItemId: item.id }),
      },
      h('span', { class: 'dash-item-title' }, first || (item.photo_count ? 'Photo to-do' : 'Untitled')),
      rest.join(' ').trim() ? h('span', { class: 'dash-item-more muted small' }, rest.join(' ').trim()) : null),
      chips.length ? h('span', { class: 'chips' }, chips) : null));
}
