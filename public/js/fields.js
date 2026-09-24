// Form fields and "chips" shared by the list view, dashboard and search results.

import { h, fill, $, state, formatWhen, toLocalInput, fromLocalInput, person } from './core.js';

const REMIND_PRESETS = [
  ['none', 'No reminder'],
  ['0', 'At the deadline'],
  ['15', '15 minutes before'],
  ['60', '1 hour before'],
  ['1440', '1 day before'],
  ['10080', '1 week before'],
  ['custom', 'At a specific time…'],
];

export const REPEAT_LABELS = {
  none: 'Does not repeat',
  daily: 'Every day',
  weekdays: 'Every weekday (Mon–Fri)',
  weekly: 'Every week',
  monthly: 'Every month',
  yearly: 'Every year',
};
const REPEAT_SHORT = { daily: 'Daily', weekdays: 'Weekdays', weekly: 'Weekly', monthly: 'Monthly', yearly: 'Yearly' };

export const PRIORITY_LABELS = ['None', 'Low', 'Medium', 'High'];

// ---------------------------------------------------------------- labels

/** Every label currently in use on screen, for autocomplete. */
export function knownLabels() {
  const set = new Map();
  const add = (items) => items?.forEach((i) => i.labels?.forEach((l) => set.set(l.toLowerCase(), l)));
  add(state.current?.items);
  add(state.dashboard?.items);
  return [...set.values()].sort((a, b) => a.localeCompare(b));
}

function refreshLabelSuggestions() {
  fill($('#label-suggestions'), knownLabels().map((l) => h('option', { value: l })));
}

/** Chip-style label editor. Type and press Enter or comma to add. */
function labelInput(initial = []) {
  const labels = [...initial];
  const input = h('input', {
    type: 'text',
    list: 'label-suggestions',
    placeholder: labels.length ? 'Add…' : 'e.g. work, home',
    maxlength: 24,
    'aria-label': 'Add a label',
    autocapitalize: 'none',
  });
  const wrap = h('div', { class: 'label-input', onclick: (e) => { if (e.target === wrap) input.focus(); } });

  const draw = (focus) => {
    fill(wrap,
      labels.map((l, i) => h('span', { class: 'chip label' }, `#${l}`,
        h('button', {
          type: 'button', class: 'chip-x', 'aria-label': `Remove label ${l}`,
          onclick: () => { labels.splice(i, 1); draw(true); },
        }, '×'))),
      input);
    input.placeholder = labels.length ? 'Add…' : 'e.g. work, home';
    if (focus) input.focus();
  };
  const commit = () => {
    const v = input.value.trim().replace(/^#/, '').replace(/,+$/, '').trim();
    input.value = '';
    if (v && labels.length < 10 && !labels.some((x) => x.toLowerCase() === v.toLowerCase())) labels.push(v.slice(0, 24));
    draw(true);
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Backspace' && !input.value && labels.length) {
      labels.pop();
      draw(true);
    }
  });
  // Picking a suggestion from the datalist.
  input.addEventListener('input', () => {
    if (knownLabels().some((l) => l === input.value)) commit();
  });
  input.addEventListener('focus', refreshLabelSuggestions);
  draw(false);
  return {
    el: wrap,
    read() {
      if (input.value.trim()) commit();
      return [...labels];
    },
  };
}

// ---------------------------------------------------------------- the details panel

/**
 * Deadline, reminder, repeat, priority, labels, assignee (and sub-tasks for new to-dos).
 * Returns { el, read() }; read() throws with a friendly message on invalid input.
 */
export function detailFields(item = {}, members = [], { withSubtasks = false } = {}) {
  const {
    due_at = null, remind_at = null, repeat = 'none', assigned_to_id = null, priority = 0, labels = [],
  } = item;

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
  const remindSelect = h('select', { 'aria-label': 'Reminder' },
    REMIND_PRESETS.map(([v, label]) => h('option', { value: v, selected: v === preset }, label)));

  const repeatSelect = h('select', { 'aria-label': 'Repeat' },
    Object.entries(REPEAT_LABELS).map(([v, label]) => h('option', { value: v, selected: v === repeat }, label)));

  const prioritySelect = h('select', { 'aria-label': 'Priority' },
    PRIORITY_LABELS.map((label, v) => h('option', { value: String(v), selected: v === priority }, label)));

  const labelsField = labelInput(labels);

  const assignSelect = members.length > 1
    ? h('select', { 'aria-label': 'Assign to' },
      h('option', { value: '' }, 'Nobody (everyone on the list)'),
      members.map((m) => h('option', { value: String(m.id), selected: m.id === assigned_to_id },
        m.id === state.me.id ? `${m.name} (me)` : m.name)))
    : null;

  const subtasksArea = withSubtasks
    ? h('textarea', { rows: 3, placeholder: 'One per line', 'aria-label': 'Sub-tasks, one per line' })
    : null;

  const sync = () => {
    const hasDue = !!due.value;
    for (const opt of remindSelect.options) {
      if (!['none', 'custom'].includes(opt.value)) opt.disabled = !hasDue;
    }
    if (!hasDue && !['none', 'custom'].includes(remindSelect.value)) remindSelect.value = 'none';
    custom.hidden = remindSelect.value !== 'custom';
    // Repeating needs a deadline to repeat from.
    for (const opt of repeatSelect.options) if (opt.value !== 'none') opt.disabled = !hasDue;
    if (!hasDue) repeatSelect.value = 'none';
  };
  due.addEventListener('change', sync);
  remindSelect.addEventListener('change', () => {
    sync();
    if (remindSelect.value === 'custom' && !custom.value) {
      custom.value = toLocalInput(fromLocalInput(due.value) ?? Date.now() + 3600000);
    }
  });
  sync();

  const clearBtn = h('button', {
    type: 'button', class: 'ghost small', 'aria-label': 'Clear deadline',
    onclick: () => { due.value = ''; sync(); },
  }, 'Clear');

  const field = (label, ...control) => h('label', { class: 'field' }, h('span', {}, label), ...control);

  const el = h('div', { class: 'schedule' },
    h('div', { class: 'field-grid' },
      field('📅 Deadline', h('div', { class: 'row' }, due, clearBtn)),
      field('🔔 Reminder', h('div', { class: 'row wrap' }, remindSelect, custom)),
      field('🔁 Repeat', repeatSelect),
      field('⚑ Priority', prioritySelect),
      assignSelect ? field('👤 Assign to', assignSelect) : null),
    h('div', { class: 'field' }, h('span', {}, '🏷 Labels'), labelsField.el),
    subtasksArea ? field('☑ Sub-tasks', subtasksArea) : null);

  return {
    el,
    read() {
      const dueAt = fromLocalInput(due.value);
      let remindAt = null;
      if (remindSelect.value === 'custom') {
        remindAt = fromLocalInput(custom.value);
        if (remindAt == null) throw new Error('Pick a time for the reminder');
      } else if (remindSelect.value !== 'none') {
        remindAt = dueAt - Number(remindSelect.value) * 60000;
      }
      return {
        due_at: dueAt,
        remind_at: remindAt,
        repeat: repeatSelect.value,
        priority: Number(prioritySelect.value),
        labels: labelsField.read(),
        assigned_to: assignSelect ? (assignSelect.value ? Number(assignSelect.value) : null) : assigned_to_id,
        subtasks: subtasksArea ? subtasksArea.value.split('\n').map((s) => s.trim()).filter(Boolean) : [],
      };
    },
  };
}

// ---------------------------------------------------------------- chips

export function dueBadge(item) {
  if (item.due_at == null) return null;
  const left = item.due_at - Date.now();
  let cls = 'chip';
  let prefix = 'Due';
  if (!item.done && left < 0) { cls += ' overdue'; prefix = 'Overdue ·'; }
  else if (!item.done && left < 86400000) cls += ' soon';
  return h('span', { class: cls, title: new Date(item.due_at).toLocaleString() }, `📅 ${prefix} ${formatWhen(item.due_at)}`);
}

export function remindBadge(item) {
  if (item.remind_at == null || item.done) return null;
  const past = item.remind_at <= Date.now();
  return h('span', { class: 'chip' + (past ? ' faded' : ''), title: `Reminder: ${new Date(item.remind_at).toLocaleString()}` },
    `🔔 ${formatWhen(item.remind_at)}`);
}

export function repeatBadge(item) {
  if (!item.repeat || item.repeat === 'none') return null;
  const last = item.last_done_at ? ` · last done ${formatWhen(item.last_done_at)}` : '';
  return h('span', { class: 'chip', title: REPEAT_LABELS[item.repeat] + last }, `🔁 ${REPEAT_SHORT[item.repeat]}`);
}

export function assigneeBadge(item) {
  if (item.assigned_to_id == null) return null;
  const mine = item.assigned_to_id === state.me.id;
  return h('span', { class: 'chip person-chip' + (mine ? ' mine' : ''), title: 'Assigned to' },
    person(item.assigned_to_id, { size: 'xs', fallback: item.assigned_to }));
}

export function priorityBadge(item) {
  if (!item.priority) return null;
  const text = ['', '↓ Low', '! Medium', '‼ High'][item.priority];
  return h('span', { class: `chip prio-${item.priority}`, title: `${PRIORITY_LABELS[item.priority]} priority` }, text);
}

/** Label chips; clicking one calls onPick(label) (e.g. to filter by it). */
export function labelChips(item, onPick) {
  return (item.labels ?? []).map((l) =>
    onPick
      ? h('button', { type: 'button', class: 'chip label', title: `Show only #${l}`, onclick: (e) => { e.stopPropagation(); onPick(l); } }, `#${l}`)
      : h('span', { class: 'chip label' }, `#${l}`));
}

export function subtaskBadge(total, done) {
  if (!total) return null;
  return h('span', { class: 'chip' + (done === total ? ' complete' : ''), title: `${done} of ${total} sub-tasks done` }, `☑ ${done}/${total}`);
}

// ---------------------------------------------------------------- sorting

const PRIORITY_THEN_DUE = (a, b) => b.priority - a.priority || dueCompare(a, b);
function dueCompare(a, b) {
  if (a.due_at == null && b.due_at == null) return 0;
  if (a.due_at == null) return 1;
  if (b.due_at == null) return -1;
  return a.due_at - b.due_at;
}

/** Orders a list's to-dos: open before done, then by the chosen sort. */
export function sortItems(items, mode) {
  const byPosition = (a, b) => (a.position ?? 0) - (b.position ?? 0) || b.id - a.id;
  const cmp = {
    smart: (a, b) => dueCompare(a, b) || b.priority - a.priority || byPosition(a, b),
    priority: (a, b) => PRIORITY_THEN_DUE(a, b) || byPosition(a, b),
    custom: byPosition,
  }[mode] ?? byPosition;
  return [...items].sort((a, b) => Number(a.done) - Number(b.done) || cmp(a, b));
}
