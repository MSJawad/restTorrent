// Progress page for the restTorrent REST API. Live updates come from the
// /api/events server-sent event stream; actions call the REST endpoints.

const list = document.getElementById('torrents');
const empty = document.getElementById('empty');
const notice = document.getElementById('notice');
const drop = document.getElementById('drop');
const fileInput = document.getElementById('file');
const connection = document.getElementById('connection');
const template = document.getElementById('torrent-template');

document.getElementById('api-base').textContent = location.origin;

const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
function formatBytes(bytes) {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return unit === 0 ? `${value} B` : `${value.toFixed(1)} ${UNITS[unit]}`;
}

function formatDuration(seconds) {
  if (seconds === null || !Number.isFinite(seconds)) return 'unknown';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.round(seconds % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

let noticeTimer = null;
function showNotice(message) {
  notice.textContent = message;
  notice.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => (notice.hidden = true), 6000);
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    ...(body ? { body, headers: { 'content-type': 'application/x-bittorrent' } } : {}),
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      message = (await res.json()).error ?? message;
    } catch {
      // not JSON
    }
    throw new Error(message);
  }
  return res.status === 204 ? null : res.json();
}

async function addFiles(files) {
  for (const file of files) {
    try {
      await api('POST', '/api/torrents', file);
    } catch (err) {
      showNotice(`Could not add ${file.name}: ${err.message}`);
    }
  }
  refresh();
}

const cards = new Map();

function card(torrent) {
  let el = cards.get(torrent.id);
  if (el) return el;
  el = template.content.firstElementChild.cloneNode(true);
  el.dataset.id = torrent.id;
  const confirm = el.querySelector('.confirm');
  el.querySelector('.toggle').addEventListener('click', async (event) => {
    const action = event.currentTarget.dataset.action;
    try {
      render(await api('POST', `/api/torrents/${torrent.id}/${action}`));
    } catch (err) {
      showNotice(err.message);
    }
  });
  el.querySelector('.remove').addEventListener('click', () => (confirm.hidden = false));
  el.querySelector('.cancel').addEventListener('click', () => (confirm.hidden = true));
  const remove = async (deleteFiles) => {
    try {
      await api('DELETE', `/api/torrents/${torrent.id}${deleteFiles ? '?deleteFiles=true' : ''}`);
      el.remove();
      cards.delete(torrent.id);
      updateEmpty();
    } catch (err) {
      showNotice(err.message);
    }
  };
  el.querySelector('.keep').addEventListener('click', () => remove(false));
  el.querySelector('.delete').addEventListener('click', () => remove(true));
  // Load the file list only when it is opened; the event stream omits it.
  el.querySelector('.files').addEventListener('toggle', (event) => {
    if (event.currentTarget.open) loadFiles(torrent.id);
  });
  cards.set(torrent.id, el);
  list.append(el);
  return el;
}

async function loadFiles(id) {
  const el = cards.get(id);
  if (!el) return;
  try {
    const torrent = await api('GET', `/api/torrents/${id}`);
    const ul = el.querySelector('.files ul');
    ul.replaceChildren(
      ...torrent.files.map((file) => {
        const li = document.createElement('li');
        const path = document.createElement('span');
        path.className = 'path';
        path.textContent = file.path;
        path.title = file.path;
        const pct = document.createElement('span');
        pct.className = 'pct';
        const done = file.size === 0 ? 100 : (file.downloaded / file.size) * 100;
        pct.textContent = `${formatBytes(file.size)} · ${Math.floor(done)}%`;
        li.append(path, pct);
        return li;
      }),
    );
  } catch (err) {
    showNotice(err.message);
  }
}

function render(torrent) {
  const el = card(torrent);
  el.className = `torrent ${torrent.state}`;
  el.querySelector('.name').textContent = torrent.name;
  el.querySelector('.name').title = torrent.name;
  const state = el.querySelector('.state');
  state.textContent = torrent.state;
  state.className = `state ${torrent.state}`;

  const checking = torrent.state === 'checking';
  const pct = checking
    ? (torrent.pieces.checked / torrent.pieces.total) * 100
    : torrent.progress * 100;
  el.querySelector('.fill').style.width = `${pct}%`;
  el.querySelector('.bar').setAttribute('aria-valuenow', pct.toFixed(0));

  el.querySelector('.amount').textContent = checking
    ? `Checking ${torrent.pieces.checked} of ${torrent.pieces.total} pieces`
    : `${formatBytes(torrent.downloaded)} of ${formatBytes(torrent.size)} (${(torrent.progress * 100).toFixed(1)}%)`;
  const active = torrent.state === 'downloading';
  el.querySelector('.speed').textContent = active ? `${formatBytes(torrent.downloadSpeed)}/s` : '';
  el.querySelector('.peers').textContent = active
    ? `${torrent.peers.connected} peer${torrent.peers.connected === 1 ? '' : 's'} (${torrent.peers.known} known)`
    : '';
  el.querySelector('.eta').textContent = active ? `ETA ${formatDuration(torrent.eta)}` : '';

  const error = el.querySelector('.error');
  const problem =
    torrent.error ?? (active && torrent.peers.connected === 0 ? torrent.tracker.lastError : null);
  error.hidden = !problem;
  error.textContent = problem ? (torrent.error ? problem : `Tracker: ${problem}`) : '';

  el.querySelector('.files summary').textContent =
    `${torrent.fileCount} file${torrent.fileCount === 1 ? '' : 's'} · ${torrent.pieces.total} pieces`;
  if (el.querySelector('.files').open) loadFiles(torrent.id);

  const toggle = el.querySelector('.toggle');
  const canResume = torrent.state === 'paused' || torrent.state === 'error';
  toggle.dataset.action = canResume ? 'resume' : 'pause';
  toggle.textContent = torrent.state === 'error' ? 'Retry' : canResume ? 'Resume' : 'Pause';
  toggle.hidden = torrent.state === 'completed';
}

function updateEmpty() {
  empty.hidden = cards.size > 0;
}

function renderAll(torrents) {
  const seen = new Set();
  for (const torrent of torrents) {
    seen.add(torrent.id);
    render(torrent);
  }
  for (const [id, el] of cards) {
    if (!seen.has(id)) {
      el.remove();
      cards.delete(id);
    }
  }
  updateEmpty();
}

async function refresh() {
  try {
    renderAll((await api('GET', '/api/torrents')).torrents);
  } catch (err) {
    showNotice(err.message);
  }
}

function connect() {
  const events = new EventSource('/api/events');
  events.addEventListener('torrents', (event) => {
    connection.textContent = 'Live';
    connection.classList.add('live');
    renderAll(JSON.parse(event.data).torrents);
  });
  events.addEventListener('error', () => {
    connection.textContent = 'Reconnecting...';
    connection.classList.remove('live');
  });
}

fileInput.addEventListener('change', () => {
  addFiles([...fileInput.files]);
  fileInput.value = '';
});

let dragDepth = 0;
window.addEventListener('dragenter', (event) => {
  if (!event.dataTransfer?.types.includes('Files')) return;
  dragDepth++;
  drop.hidden = false;
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) drop.hidden = true;
});
window.addEventListener('dragover', (event) => event.preventDefault());
window.addEventListener('drop', (event) => {
  event.preventDefault();
  dragDepth = 0;
  drop.hidden = true;
  const files = [...(event.dataTransfer?.files ?? [])].filter((f) => f.name.endsWith('.torrent'));
  if (files.length > 0) addFiles(files);
});

refresh();
connect();
