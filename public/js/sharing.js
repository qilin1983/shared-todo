// "Share…" dialog: pick exactly which people can see a list, and whether they can edit.

import { $, h, fill, api, toast, attempt, state, people, avatar, nameOf, isFinePointer } from './core.js';
import { refreshView } from './nav.js';

let draft = new Map(); // userId -> canEdit

export async function openShareDialog() {
  draft = new Map(state.current.shares.map((s) => [s.user_id, s.can_edit]));
  $('#share-title').textContent = state.current.title;
  $('#share-filter').value = '';
  $('#share-error').textContent = '';
  renderShareUsers();
  $('#share-dialog').showModal();
  if (isFinePointer()) $('#share-filter').focus();
}

function renderShareUsers() {
  const q = $('#share-filter').value.trim().toLowerCase();
  const others = [...people.values()].filter((u) => u.id !== state.me.id);
  const shown = others.filter((u) =>
    u.username.toLowerCase().includes(q) || (u.display_name ?? '').toLowerCase().includes(q));
  // Selected people float to the top so it's easy to review who has access.
  shown.sort((a, b) => Number(draft.has(b.id)) - Number(draft.has(a.id)));

  fill($('#share-users'),
    shown.length
      ? shown.map((u) => {
        const selected = draft.has(u.id);
        return h('li', { class: selected ? 'selected' : '' },
          h('label', { class: 'inline grow share-person' },
            h('input', {
              type: 'checkbox',
              checked: selected,
              onchange: (e) => {
                if (e.target.checked) draft.set(u.id, true);
                else draft.delete(u.id);
                renderShareUsers();
              },
            }),
            avatar(u.id, 'sm'),
            h('span', { class: 'share-names' },
              h('span', {}, nameOf(u.id)),
              u.display_name ? h('span', { class: 'muted small' }, `@${u.username}`) : null)),
          h('select', {
            disabled: !selected,
            'aria-label': `Access for ${nameOf(u.id)}`,
            onchange: (e) => draft.set(u.id, e.target.value === 'edit'),
          },
          h('option', { value: 'edit', selected: draft.get(u.id) !== false }, 'Can edit'),
          h('option', { value: 'view', selected: draft.get(u.id) === false }, 'View only')));
      })
      : h('li', { class: 'muted' }, others.length ? 'No matching users.' : 'No other users have signed up yet.'));
}

$('#share-filter').addEventListener('input', renderShareUsers);
$('#share-cancel').addEventListener('click', () => $('#share-dialog').close());

$('#share-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const shares = [...draft].map(([userId, canEdit]) => ({ userId, canEdit }));
    await api(`/lists/${state.currentId}/shares`, { method: 'PUT', json: { shares } });
    $('#share-dialog').close();
    toast(shares.length ? `Shared with ${shares.length} ${shares.length === 1 ? 'person' : 'people'}` : 'List is now private');
    await attempt(refreshView);
  } catch (err) {
    $('#share-error').textContent = err.message;
  }
});
