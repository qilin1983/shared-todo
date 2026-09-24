// A single list: add form, to-dos with sub-tasks and comments, sorting, drag-to-reorder.

import {
  $, h, fill, api, toast, attempt, state, remember, TIME_ZONE, isFinePointer,
  formatDate, timeAgo, acceptImages, viewPhoto, person, avatar, nameOf,
} from './core.js';
import {
  detailFields, dueBadge, remindBadge, repeatBadge, assigneeBadge, priorityBadge, labelChips,
  subtaskBadge, sortItems, knownLabels,
} from './fields.js';
import { refreshView, refreshCurrent, loadLists, openDashboard, completeItem } from './nav.js';
import { checkReminders, maybeOfferNotifications } from './reminders.js';
import { openShareDialog } from './sharing.js';
import { openHistory } from './history.js';
import { flushDeferredLive } from './live.js';

const canEditList = (list) => list.role === 'owner' || list.role === 'edit';

export function renderList() {
  const list = state.current;
  const editable = canEditList(list);
  const isOwner = list.role === 'owner';

  const sharedLine = isOwner
    ? list.shares.length
      ? `Shared with ${list.shares.map((s) => s.name + (s.can_edit ? '' : ' (view only)')).join(', ')}`
      : 'Private — only you can see this list'
    : `Owned by ${list.owner} · you can ${list.role === 'edit' ? 'edit' : 'view and comment'}`;

  const header = h('div', { class: 'pane-header' },
    h('div', {},
      h('h2', {}, list.title),
      h('p', { class: 'muted small member-line' },
        h('span', { class: 'avatar-stack' }, list.members.slice(0, 5).map((m) => avatar(m.id, 'xs'))),
        ' ', sharedLine)),
    h('div', { class: 'row wrap header-actions' },
      isOwner ? h('button', { class: 'primary', onclick: openShareDialog }, 'Share…') : null,
      h('button', { onclick: () => openHistory(list.id, list.title) }, '🕘 History'),
      exportMenu(list),
      isOwner ? h('button', { onclick: renameList }, 'Rename') : null,
      isOwner ? h('button', { class: 'danger', onclick: deleteList }, 'Delete') : null,
      !isOwner ? h('button', { onclick: leaveList }, 'Leave') : null));

  const visible = sortItems(list.items, state.sort).filter((i) =>
    !(state.hideDone && i.done)
    && !(state.onlyMine && i.assigned_to_id !== state.me.id)
    && !(state.labelFilter && !i.labels.some((l) => l.toLowerCase() === state.labelFilter.toLowerCase())));
  const doneCount = list.items.filter((i) => i.done).length;
  const overdue = list.items.filter((i) => !i.done && i.due_at != null && i.due_at < Date.now()).length;
  const labels = knownLabels();
  const dragMode = state.sort === 'custom' && editable;

  const toolbar = h('div', { class: 'toolbar' },
    h('span', { class: 'muted small' },
      `${list.items.length - doneCount} open · ${doneCount} done`,
      overdue ? h('span', { class: 'overdue-text' }, ` · ${overdue} overdue`) : null),
    h('span', { class: 'spacer' }),
    h('label', { class: 'small inline' }, 'Sort ',
      h('select', {
        class: 'compact',
        onchange: (e) => { state.sort = e.target.value; remember('sort', state.sort); renderList(); },
      },
      h('option', { value: 'smart', selected: state.sort === 'smart' }, 'Deadline'),
      h('option', { value: 'priority', selected: state.sort === 'priority' }, 'Priority'),
      h('option', { value: 'custom', selected: state.sort === 'custom' }, 'My order (drag)'))),
    labels.length || state.labelFilter
      ? h('select', {
        class: 'compact',
        'aria-label': 'Filter by label',
        onchange: (e) => { state.labelFilter = e.target.value; renderList(); },
      },
      h('option', { value: '' }, 'All labels'),
      labels.map((l) => h('option', { value: l, selected: l.toLowerCase() === state.labelFilter.toLowerCase() }, `#${l}`)))
      : null,
    list.members.length > 1
      ? h('label', { class: 'small inline' },
        h('input', { type: 'checkbox', checked: state.onlyMine, onchange: (e) => { state.onlyMine = e.target.checked; renderList(); } }),
        ' Mine')
      : null,
    h('label', { class: 'small inline' },
      h('input', {
        type: 'checkbox',
        checked: state.hideDone,
        onchange: (e) => { state.hideDone = e.target.checked; remember('hideDone', state.hideDone ? '1' : '0'); renderList(); },
      }),
      ' Hide done'));

  const filtered = state.onlyMine || state.labelFilter;
  const ul = h('ul', { class: 'items' + (dragMode ? ' drag-mode' : '') }, visible.map((i) => renderItem(i, editable, dragMode)));
  if (dragMode) enableDragReorder(ul);

  fill($('#list-pane'),
    header,
    editable ? renderAddForm() : null,
    toolbar,
    dragMode && visible.some((i) => !i.done) ? h('p', { class: 'muted small hint-line' }, 'Drag ⠿ to reorder.') : null,
    visible.length
      ? ul
      : h('p', { class: 'muted empty' },
        filtered ? 'Nothing matches these filters.' : list.items.length ? 'Everything is done 🎉' : 'Nothing here yet.'));
}

function exportMenu(list) {
  const csvHref = `/api/lists/${list.id}/export.csv?tz=${encodeURIComponent(TIME_ZONE)}`;
  return h('details', { class: 'menu' },
    h('summary', { class: 'button-like' }, '⬇ Export'),
    h('div', { class: 'menu-panel card' },
      h('a', { href: csvHref, download: '', class: 'menu-item' }, '📊 Spreadsheet (CSV)'),
      h('a', { href: `/print.html?list=${list.id}`, target: '_blank', rel: 'noopener', class: 'menu-item' }, '🖨 PDF / Print')));
}

// ---------------------------------------------------------------- add form

function renderAddForm() {
  const members = state.current.members;
  const textarea = h('textarea', {
    name: 'body',
    rows: 3,
    maxlength: 20000,
    placeholder: 'Add a to-do… write as much as you like. Paste or attach photos.',
    oninput: (e) => { state.draftBody = e.target.value; },
    onkeydown: (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) form.requestSubmit(); },
    onpaste: (e) => {
      const files = [...(e.clipboardData?.files ?? [])];
      if (files.length) { e.preventDefault(); addPending(files); }
    },
  }, state.draftBody);

  const previews = h('div', { class: 'thumbs' });
  const drawPreviews = () => {
    fill(previews, state.pendingPhotos.map((file, idx) => {
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

  const details = detailFields({}, members, { withSubtasks: true });
  details.el.hidden = true;
  const detailsBtn = h('button', {
    type: 'button',
    'aria-expanded': 'false',
    onclick: () => {
      details.el.hidden = !details.el.hidden;
      detailsBtn.classList.toggle('on', !details.el.hidden);
      detailsBtn.setAttribute('aria-expanded', String(!details.el.hidden));
    },
  }, '⚙ Details');

  const submitBtn = h('button', { type: 'submit', class: 'primary' }, 'Add');

  const form = h('form', {
    class: 'card add-form',
    ondragover: (e) => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); form.classList.add('drag'); } },
    ondragleave: () => form.classList.remove('drag'),
    ondrop: (e) => {
      if (!e.dataTransfer?.files.length) return;
      e.preventDefault();
      form.classList.remove('drag');
      addPending([...e.dataTransfer.files]);
    },
    onsubmit: async (e) => {
      e.preventDefault();
      if (!textarea.value.trim() && !state.pendingPhotos.length) return textarea.focus();
      let d = { due_at: null, remind_at: null, repeat: 'none', priority: 0, labels: [], assigned_to: null, subtasks: [] };
      if (!details.el.hidden) {
        try { d = details.read(); } catch (err) { return toast(err.message); }
      }
      const fd = new FormData();
      fd.append('body', textarea.value);
      fd.append('tz', TIME_ZONE);
      if (d.due_at != null) fd.append('due_at', String(d.due_at));
      if (d.remind_at != null) fd.append('remind_at', String(d.remind_at));
      if (d.repeat !== 'none') fd.append('repeat', d.repeat);
      if (d.priority) fd.append('priority', String(d.priority));
      if (d.labels.length) fd.append('labels', JSON.stringify(d.labels));
      if (d.assigned_to != null) fd.append('assigned_to', String(d.assigned_to));
      if (d.subtasks.length) fd.append('subtasks', JSON.stringify(d.subtasks));
      for (const f of state.pendingPhotos) fd.append('photos', f, f.name || 'photo.jpg');
      submitBtn.disabled = true;
      submitBtn.textContent = 'Adding…';
      try {
        await api(`/lists/${state.currentId}/items`, { method: 'POST', form: fd });
        state.pendingPhotos = [];
        state.draftBody = '';
        await refreshView();
        if (isFinePointer()) $('.add-form textarea')?.focus();
        if (d.remind_at != null) maybeOfferNotifications();
      } catch (err) {
        toast(err.message);
        submitBtn.disabled = false;
        submitBtn.textContent = 'Add';
      }
    },
  },
  textarea,
  previews,
  details.el,
  h('div', { class: 'row wrap' },
    h('button', { type: 'button', onclick: () => fileInput.click() }, '📷 Photo'),
    fileInput,
    detailsBtn,
    h('span', { class: 'muted small hint' }, 'Ctrl+Enter to add'),
    h('span', { class: 'spacer' }),
    submitBtn));

  queueMicrotask(drawPreviews);
  return form;
}

// ---------------------------------------------------------------- a to-do

function stopEditing() {
  state.editingItemId = null;
  flushDeferredLive();
  renderList();
}

function renderItem(item, editable, dragMode) {
  const editing = state.editingItemId === item.id;
  const threadOpen = state.openThreads.has(item.id);

  const checkbox = h('input', {
    type: 'checkbox',
    class: 'done-box',
    checked: item.done,
    disabled: !editable,
    'aria-label': item.done ? 'Mark as not done' : 'Mark as done',
    onchange: (e) => attempt(() => completeItem(item.id, e.target.checked)),
  });

  const handle = dragMode && !item.done
    ? h('span', { class: 'drag-handle', title: 'Drag to reorder', 'aria-label': 'Drag to reorder', role: 'button' }, '⠿')
    : null;

  let content;
  if (editing) {
    const ta = h('textarea', { rows: Math.min(12, Math.max(3, item.body.split('\n').length + 1)), maxlength: 20000 }, item.body);
    const details = detailFields(item, state.current.members);
    const save = () => attempt(async () => {
      const d = details.read();
      const patch = { body: ta.value, tz: TIME_ZONE };
      if (d.due_at !== item.due_at) patch.due_at = d.due_at;
      if (d.remind_at !== item.remind_at) patch.remind_at = d.remind_at;
      if (d.repeat !== item.repeat) patch.repeat = d.repeat;
      if (d.priority !== item.priority) patch.priority = d.priority;
      if (JSON.stringify(d.labels) !== JSON.stringify(item.labels)) patch.labels = d.labels;
      if (d.assigned_to !== item.assigned_to_id) patch.assigned_to = d.assigned_to;
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
      details.el,
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

  const doneSubs = item.subtasks.filter((s) => s.done).length;
  const chipEls = editing ? [] : [
    priorityBadge(item),
    assigneeBadge(item),
    dueBadge(item),
    remindBadge(item),
    repeatBadge(item),
    subtaskBadge(item.subtasks.length, doneSubs),
    labelChips(item, (l) => { state.labelFilter = l; renderList(); }),
  ].flat().filter(Boolean);
  const chips = chipEls.length ? h('div', { class: 'chips' }, chipEls) : null;

  const edited = item.updated_at !== item.created_at ? ' · edited' : '';
  const meta = h('div', { class: 'meta muted small' },
    item.created_by_id != null ? avatar(item.created_by_id, 'xs') : null,
    ` ${item.created_by_id != null ? nameOf(item.created_by_id, item.created_by) : 'someone'} · ${formatDate(item.created_at)}${edited}`);

  const commentBtn = h('button', {
    class: 'ghost small' + (threadOpen ? ' on' : ''),
    'aria-expanded': String(threadOpen),
    onclick: () => toggleThread(item.id),
  }, `💬 ${item.comment_count || ''}`.trim());

  const actions = !editing
    ? h('div', { class: 'item-actions' },
      commentBtn,
      editable ? h('button', {
        class: 'ghost small',
        title: 'Add a sub-task',
        onclick: () => { state.addingSubtaskTo = item.id; renderList(); },
      }, '☑+') : null,
      editable ? h('button', { class: 'ghost small', onclick: () => photoInput.click(), 'aria-label': 'Add photo' }, '📷') : null,
      photoInput,
      editable ? h('button', { class: 'ghost small', onclick: () => { state.editingItemId = item.id; renderList(); } }, 'Edit') : null,
      editable ? h('button', {
        class: 'ghost small danger',
        onclick: () => attempt(async () => {
          if (!confirm('Delete this to-do and its photos?')) return;
          await api(`/items/${item.id}`, { method: 'DELETE' });
          await refreshView();
        }),
      }, 'Delete') : null)
    : null;

  const overdue = !item.done && item.due_at != null && item.due_at < Date.now();
  const li = h('li', {
    class: 'item card' + (item.done ? ' done' : '') + (overdue ? ' is-overdue' : '') + (item.priority === 3 && !item.done ? ' is-high' : ''),
    id: `item-${item.id}`,
  },
  handle,
  checkbox,
  h('div', { class: 'item-main' },
    content,
    chips,
    renderSubtasks(item, editable, editing),
    photos,
    meta,
    threadOpen ? renderThread(item) : null),
  actions);
  li.dataset.id = item.id;
  li.dataset.done = item.done ? '1' : '';
  return li;
}

// ---------------------------------------------------------------- sub-tasks

function renderSubtasks(item, editable, editing) {
  const adding = state.addingSubtaskTo === item.id;
  if (!item.subtasks.length && !adding) return null;

  const rows = item.subtasks.map((st) => h('li', { class: 'subtask' + (st.done ? ' done' : '') },
    h('label', { class: 'inline grow' },
      h('input', {
        type: 'checkbox',
        checked: st.done,
        disabled: !editable,
        onchange: (e) => attempt(async () => {
          await api(`/subtasks/${st.id}`, { method: 'PATCH', json: { done: e.target.checked } });
          await refreshCurrent();
        }),
      }),
      h('span', { class: 'subtask-text' }, st.body)),
    editable && (editing || adding)
      ? h('button', {
        class: 'ghost small subtask-x', 'aria-label': `Remove sub-task ${st.body}`,
        onclick: () => attempt(async () => {
          await api(`/subtasks/${st.id}`, { method: 'DELETE' });
          await refreshCurrent();
        }),
      }, '×')
      : null));

  let adder = null;
  if (adding && editable) {
    const input = h('input', { type: 'text', maxlength: 500, placeholder: 'New sub-task', 'aria-label': 'New sub-task' });
    const add = () => attempt(async () => {
      const text = input.value.trim();
      if (!text) return;
      await api(`/items/${item.id}/subtasks`, { method: 'POST', json: { body: text } });
      await refreshCurrent();
      $(`#item-${item.id} .subtask-add input`)?.focus(); // keep adding
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); add(); }
      if (e.key === 'Escape') { state.addingSubtaskTo = null; renderList(); }
    });
    queueMicrotask(() => input.focus());
    adder = h('div', { class: 'row subtask-add' },
      input,
      h('button', { class: 'small primary', onclick: add }, 'Add'),
      h('button', { class: 'small ghost', onclick: () => { state.addingSubtaskTo = null; flushDeferredLive(); renderList(); } }, 'Done'));
  }

  return h('div', { class: 'subtasks' }, h('ul', {}, rows), adder);
}

// ---------------------------------------------------------------- comments

async function toggleThread(itemId) {
  if (state.openThreads.has(itemId)) {
    state.openThreads.delete(itemId);
    return renderList();
  }
  state.openThreads.add(itemId);
  await attempt(async () => state.comments.set(itemId, await api(`/items/${itemId}/comments`)));
  renderList();
  $(`#item-${itemId} .comment-box textarea`)?.focus({ preventScroll: true });
}

function renderThread(item) {
  const comments = state.comments.get(item.id) ?? [];
  const isOwner = state.current.role === 'owner';
  const ta = h('textarea', {
    rows: 2,
    maxlength: 5000,
    placeholder: 'Write a comment…',
    'aria-label': 'Write a comment',
    onkeydown: (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send(); },
  });
  const sendBtn = h('button', { class: 'small primary', onclick: () => send() }, 'Send');
  const send = () => attempt(async () => {
    const body = ta.value.trim();
    if (!body) return ta.focus();
    sendBtn.disabled = true;
    try {
      await api(`/items/${item.id}/comments`, { method: 'POST', json: { body } });
      ta.value = '';
      await refreshCurrent();
      $(`#item-${item.id} .comment-box textarea`)?.focus({ preventScroll: true });
    } finally {
      sendBtn.disabled = false;
    }
  });

  return h('div', { class: 'thread' },
    comments.length
      ? h('ul', { class: 'comments' }, comments.map((c) => h('li', { class: 'comment' },
        avatar(c.user_id, 'sm'),
        h('div', { class: 'comment-main' },
          h('div', { class: 'comment-head' },
            h('strong', {}, c.user_id === state.me.id ? 'You' : nameOf(c.user_id, c.user_name ?? 'Former member')),
            h('span', { class: 'muted small', title: new Date(c.created_at).toLocaleString() }, ` · ${timeAgo(c.created_at)}`),
            c.user_id === state.me.id || isOwner
              ? h('button', {
                class: 'ghost small comment-x', 'aria-label': 'Delete comment',
                onclick: () => attempt(async () => {
                  if (!confirm('Delete this comment?')) return;
                  await api(`/comments/${c.id}`, { method: 'DELETE' });
                  await refreshCurrent();
                }),
              }, '×')
              : null),
          h('div', { class: 'comment-body' }, c.body)))))
      : h('p', { class: 'muted small' }, 'No comments yet — start the conversation.'),
    h('div', { class: 'comment-box' }, avatar(state.me.id, 'sm'), ta, sendBtn));
}

// ---------------------------------------------------------------- drag to reorder

/**
 * Pointer-based drag (works with mouse and touch, unlike HTML5 drag-and-drop on phones).
 * Only open to-dos move; completed ones stay at the bottom.
 */
function enableDragReorder(ul) {
  ul.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('.drag-handle');
    if (!handle) return;
    e.preventDefault();
    const li = handle.closest('li');
    const pane = document.querySelector('.pane');
    handle.setPointerCapture(e.pointerId);
    li.classList.add('dragging');
    const startOrder = orderOf(ul);
    let lastY = e.clientY;
    let scrollTimer = null;

    const reposition = (y) => {
      const open = [...ul.children].filter((el) => !el.dataset.done && el !== li);
      for (const other of open) {
        const r = other.getBoundingClientRect();
        const mid = r.top + r.height / 2;
        const isAbove = li.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_PRECEDING;
        if (isAbove && y < mid) { ul.insertBefore(li, other); return; }
        if (!isAbove && y > mid) { ul.insertBefore(li, other.nextSibling); }
      }
    };
    const autoScroll = () => {
      const r = pane.getBoundingClientRect();
      const edge = 60;
      if (lastY < r.top + edge) pane.scrollBy(0, -12);
      else if (lastY > r.bottom - edge) pane.scrollBy(0, 12);
      else return;
      reposition(lastY);
    };
    const move = (ev) => {
      lastY = ev.clientY;
      reposition(lastY);
      if (!scrollTimer) scrollTimer = setInterval(autoScroll, 16);
    };
    const end = () => {
      clearInterval(scrollTimer);
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      li.classList.remove('dragging');
      const order = orderOf(ul);
      if (order.join() === startOrder.join()) return;
      // Include hidden (filtered-out) to-dos so their places are kept.
      const shown = new Set(order);
      const rest = sortItems(state.current.items, 'custom').map((i) => i.id).filter((id) => !shown.has(id));
      const ids = [...order, ...rest];
      attempt(async () => {
        await api(`/lists/${state.currentId}/order`, { method: 'PUT', json: { ids } });
        await refreshCurrent();
      });
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  });
}

const orderOf = (ul) => [...ul.children].map((el) => Number(el.dataset.id));

// ---------------------------------------------------------------- list actions

async function renameList() {
  const title = prompt('Rename list', state.current.title);
  if (!title || title.trim() === state.current.title) return;
  await attempt(async () => {
    await api(`/lists/${state.currentId}`, { method: 'PATCH', json: { title } });
    await refreshView();
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
  if (!confirm(`Leave “${state.current.title}”? It will disappear from your lists until the owner shares it again.`)) return;
  await attempt(async () => {
    await api(`/lists/${state.currentId}/shares/me`, { method: 'DELETE' });
    await loadLists();
    await openDashboard();
  });
}

// Used by live updates to know whether re-rendering would interrupt the user.
export const isBusyInList = () =>
  state.editingItemId != null
  || state.addingSubtaskTo != null
  || !!document.activeElement?.closest?.('.add-form, .comment-box');
