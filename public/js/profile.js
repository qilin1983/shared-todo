// Profile dialog: display name, profile picture and password.

import { $, h, fill, api, toast, state, people, loadPeople, avatar, nameOf } from './core.js';
import { refreshCurrent, renderLists } from './nav.js';

export function renderMeButton() {
  fill($('#me-btn'), avatar(state.me.id, 'sm'), h('span', { class: 'me-name' }, nameOf(state.me.id)));
}

export function openProfile() {
  const me = people.get(state.me.id) ?? state.me;
  $('#profile-name').value = me.display_name ?? '';
  $('#profile-username').textContent = `@${me.username}`;
  $('#pw-form').reset();
  $('#profile-error').textContent = '';
  $('#pw-error').textContent = '';
  drawAvatar();
  $('#profile-dialog').showModal();
}

function drawAvatar() {
  const me = people.get(state.me.id) ?? state.me;
  fill($('#profile-avatar'), avatar(state.me.id, 'xl'));
  $('#avatar-remove').hidden = !me.avatar_version;
}

/** Everything showing names/avatars needs redrawing after a change. */
async function afterProfileChange() {
  await loadPeople();
  renderMeButton();
  drawAvatar();
  renderLists();
  await refreshCurrent();
}

$('#me-btn').addEventListener('click', openProfile);
$('#profile-close').addEventListener('click', () => $('#profile-dialog').close());

$('#profile-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#profile-error').textContent = '';
  try {
    await api('/me', { method: 'PATCH', json: { display_name: $('#profile-name').value } });
    toast('Name saved');
    await afterProfileChange();
  } catch (err) {
    $('#profile-error').textContent = err.message;
  }
});

/** Square-crop and shrink a photo to 256px JPEG before uploading. */
async function resizeAvatar(file) {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  canvas.getContext('2d').drawImage(
    bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, 256, 256);
  bitmap.close?.();
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not process that picture'))), 'image/jpeg', 0.88));
}

$('#avatar-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  $('#profile-error').textContent = '';
  try {
    let blob;
    try {
      blob = await resizeAvatar(file);
    } catch {
      throw new Error('That picture format isn’t supported here — try a JPEG or PNG.');
    }
    const fd = new FormData();
    fd.append('avatar', blob, 'avatar.jpg');
    await api('/me/avatar', { method: 'PUT', form: fd });
    toast('Picture updated');
    await afterProfileChange();
  } catch (err) {
    $('#profile-error').textContent = err.message;
  }
});
$('#avatar-change').addEventListener('click', () => $('#avatar-input').click());

$('#avatar-remove').addEventListener('click', async () => {
  try {
    await api('/me/avatar', { method: 'DELETE' });
    await afterProfileChange();
  } catch (err) {
    $('#profile-error').textContent = err.message;
  }
});

$('#pw-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const errEl = $('#pw-error');
  errEl.textContent = '';
  if (form.next.value !== form.confirm.value) {
    errEl.textContent = 'The new passwords don’t match';
    return;
  }
  try {
    await api('/me/password', { method: 'POST', json: { current: form.current.value, next: form.next.value } });
    form.reset();
    toast('Password changed — other devices have been signed out');
  } catch (err) {
    errEl.textContent = err.message;
  }
});
