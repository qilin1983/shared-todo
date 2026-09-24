// Printable view of a list (use the browser's "Save as PDF" to export a PDF).

import { h, fill, formatWhen, formatDate } from './core.js';

const doc = document.getElementById('doc');
const listId = Number(new URLSearchParams(location.search).get('list'));
const opts = {
  done: document.getElementById('opt-done'),
  photos: document.getElementById('opt-photos'),
  subtasks: document.getElementById('opt-subtasks'),
};
let list = null;

const PRIORITY = ['', 'Low priority', 'Medium priority', 'High priority'];
const REPEAT = { daily: 'Repeats daily', weekdays: 'Repeats on weekdays', weekly: 'Repeats weekly', monthly: 'Repeats monthly', yearly: 'Repeats yearly' };

function render() {
  const now = Date.now();
  const open = list.items.filter((i) => !i.done)
    .sort((a, b) => (a.due_at ?? Infinity) - (b.due_at ?? Infinity) || b.priority - a.priority);
  const done = list.items.filter((i) => i.done);

  const item = (i) => {
    const [first, ...rest] = (i.body || 'Photo to-do').split('\n');
    const facts = [
      i.priority ? h('span', { class: i.priority === 3 ? 'high' : '' }, PRIORITY[i.priority]) : null,
      i.due_at != null
        ? h('span', { class: !i.done && i.due_at < now ? 'late' : '' }, `${!i.done && i.due_at < now ? 'Overdue — was due' : 'Due'} ${formatWhen(i.due_at)}`)
        : null,
      i.repeat && i.repeat !== 'none' ? h('span', {}, REPEAT[i.repeat]) : null,
      i.assigned_to ? h('span', {}, `Assigned to ${i.assigned_to}`) : null,
      i.labels.length ? h('span', {}, i.labels.map((l) => `#${l}`).join(' ')) : null,
      i.comment_count ? h('span', {}, `${i.comment_count} comment${i.comment_count === 1 ? '' : 's'}`) : null,
    ].filter(Boolean);
    return h('li', { class: 'item' + (i.done ? ' done' : '') },
      h('span', { class: 'box' }, i.done ? '☑' : '☐'),
      h('div', {},
        h('div', { class: 'text' }, h('strong', {}, first), rest.length ? `\n${rest.join('\n')}` : ''),
        facts.length ? h('div', { class: 'facts' }, facts) : null,
        opts.subtasks.checked && i.subtasks.length
          ? h('ul', { class: 'subtasks' }, i.subtasks.map((s) => h('li', { class: s.done ? 'done' : '' }, `${s.done ? '☑' : '☐'} ${s.body}`)))
          : null,
        opts.photos.checked && i.photos.length
          ? h('div', { class: 'photos' }, i.photos.map((p) => h('img', { src: p.url, alt: '' })))
          : null));
  };

  const sharedWith = list.shares.length ? ` · shared with ${list.shares.map((s) => s.name).join(', ')}` : '';
  document.title = list.title;
  fill(doc,
    h('h1', {}, list.title),
    h('p', { class: 'meta' },
      `Owner: ${list.owner}${sharedWith} · ${open.length} open, ${done.length} done · printed ${formatDate(new Date().toISOString().replace('T', ' ').slice(0, 19))}`),
    open.length ? h('ul', { class: 'items' }, open.map(item)) : h('p', {}, 'Nothing open.'),
    opts.done.checked && done.length ? [h('h2', { class: 'section' }, 'Completed'), h('ul', { class: 'items' }, done.map(item))] : null);
}

/** Wait for photos so they appear in the printout. */
async function imagesLoaded() {
  await Promise.all([...doc.querySelectorAll('img')].map((img) =>
    img.complete ? null : new Promise((r) => { img.onload = img.onerror = r; })));
}

async function printNow() {
  await imagesLoaded();
  window.print();
}

for (const o of Object.values(opts)) o.addEventListener('change', render);
document.getElementById('print-btn').addEventListener('click', printNow);

(async () => {
  try {
    const res = await fetch(`/api/lists/${listId}`);
    if (res.status === 401) throw new Error('Please sign in to the app first, then try again.');
    if (!res.ok) throw new Error('That list could not be found.');
    list = await res.json();
    render();
    // On a computer, open the print dialog straight away.
    if (matchMedia('(pointer: fine)').matches) printNow();
  } catch (err) {
    fill(doc, h('p', { class: 'error' }, err.message));
  }
})();
