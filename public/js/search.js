// Search across every list you can see: to-do text, labels, sub-tasks and comments.

import { $, h, fill, api, state, highlight } from './core.js';
import { dueBadge, assigneeBadge, priorityBadge, labelChips } from './fields.js';
import { openList, openDashboard, renderLists } from './nav.js';

let previous = null;   // where to go back to when the search is cleared
let timer = null;
let seq = 0;

const input = $('#search-input');

input.addEventListener('input', () => {
  clearTimeout(timer);
  timer = setTimeout(() => runSearch(input.value), 250);
});
input.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') clearSearch();
});
$('#search-clear').addEventListener('click', clearSearch);
$('#search-toggle').addEventListener('click', () => {
  document.body.classList.add('search-open');
  input.focus();
});

function runSearch(value) {
  const q = value.trim();
  if (q.length < 2) {
    if (state.view === 'search') {
      state.searchQuery = q;
      renderSearch();
    }
    return;
  }
  if (state.view !== 'search') {
    previous = state.view === 'list' ? { list: state.currentId } : { dashboard: true };
    state.view = 'search';
    renderLists();
  }
  state.searchQuery = q;
  renderSearch();
}

export function clearSearch() {
  input.value = '';
  state.searchQuery = '';
  document.body.classList.remove('search-open');
  if (state.view !== 'search') return;
  const back = previous;
  previous = null;
  if (back?.list) openList(back.list);
  else openDashboard();
}

export async function renderSearch() {
  const q = state.searchQuery;
  const mySeq = ++seq;
  if (q.length < 2) {
    fill($('#list-pane'), h('p', { class: 'muted empty' }, 'Type at least 2 characters to search.'));
    return;
  }
  let res;
  try {
    res = await api(`/search?q=${encodeURIComponent(q)}`);
  } catch (err) {
    fill($('#list-pane'), h('p', { class: 'error' }, err.message));
    return;
  }
  if (mySeq !== seq) return; // a newer search has started

  const groups = new Map();
  for (const item of res.items) {
    if (!groups.has(item.list_id)) groups.set(item.list_id, { title: item.list_title, items: [] });
    groups.get(item.list_id).items.push(item);
  }

  const openResult = (listId, itemId) => {
    input.value = '';
    state.searchQuery = '';
    document.body.classList.remove('search-open');
    previous = null;
    openList(listId, { focusItemId: itemId });
  };

  fill($('#list-pane'),
    h('div', { class: 'pane-header' },
      h('div', {},
        h('h2', {}, 'Search'),
        h('p', { class: 'muted small' },
          `${res.items.length} to-do${res.items.length === 1 ? '' : 's'}${res.items.length === 100 ? '+' : ''}`,
          res.lists.length ? ` and ${res.lists.length} list${res.lists.length === 1 ? '' : 's'}` : '',
          ` matching “${q}”`)),
      h('button', { class: 'ghost small', onclick: clearSearch }, '✕ Close')),
    res.lists.length
      ? h('section', { class: 'dash-section' },
        h('h3', { class: 'dash-section-title' }, 'Lists'),
        h('div', { class: 'row wrap' }, res.lists.map((l) =>
          h('button', { class: 'chip-button', onclick: () => openResult(l.id) }, '📋 ', highlight(l.title, q)))))
      : null,
    groups.size
      ? [...groups].map(([listId, g]) => h('article', { class: 'card dash-group' },
        h('a', {
          href: `#${listId}`,
          class: 'dash-group-head',
          onclick: (e) => { e.preventDefault(); openResult(listId); },
        }, h('div', { class: 'grow dash-group-title' }, g.title), h('span', { class: 'chev' }, '›')),
        h('ul', { class: 'dash-items' }, g.items.map((i) => {
          const [first, ...rest] = (i.body || 'Photo to-do').split('\n');
          const extra = rest.join(' ').trim();
          const matchedElsewhere = !i.body.toLowerCase().includes(q.toLowerCase());
          return h('li', { class: 'dash-item search-hit' + (i.done ? ' done' : '') },
            h('span', { class: 'status-dot', title: i.done ? 'Done' : 'Open' }, i.done ? '✓' : '○'),
            h('div', { class: 'dash-item-body' },
              h('button', { class: 'dash-item-open', onclick: () => openResult(listId, i.id) },
                h('span', { class: 'dash-item-title' }, highlight(first, q)),
                extra ? h('span', { class: 'dash-item-more muted small' }, highlight(extra, q)) : null,
                matchedElsewhere && i.subtask_match
                  ? h('span', { class: 'small match-note' }, '☑ ', highlight(i.subtask_match, q)) : null,
                matchedElsewhere && !i.subtask_match && i.comment_match
                  ? h('span', { class: 'small match-note' }, '💬 ', highlight(i.comment_match, q)) : null),
              h('span', { class: 'chips' },
                [priorityBadge(i), assigneeBadge(i), i.done ? null : dueBadge(i), labelChips(i)].flat().filter(Boolean))));
        }))))
      : h('p', { class: 'muted empty' }, res.lists.length ? '' : 'No matches.'));
}
