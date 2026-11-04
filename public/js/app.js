/**
 * App shell: wires the WebSocket to the explorer, inspector, editor, console,
 * viewport and the run/multiplayer controls.
 */

import { Viewport } from './mirror.js';
import { MirrorInstance } from './mirror.js';
import { Explorer, Inspector, escapeHtml } from './explorer.js';
import { CodeEditor, ConsolePrompt } from './editor.js';
import { GuiLayer } from './gui.js';

/* ---------------------------------------------------------------------- */
/* websocket                                                               */
/* ---------------------------------------------------------------------- */

class Connection {
  constructor(url) {
    this.url = url;
    this.handlers = new Map();
    this.queue = [];
    this.connect();
  }

  connect() {
    this.ws = new WebSocket(this.url);
    this.ws.addEventListener('open', () => {
      this.setStatus('connected');
      for (const msg of this.queue.splice(0)) this.send(msg.type, msg.payload);
      this.emit('open');
    });
    this.ws.addEventListener('close', () => {
      this.setStatus('reconnecting');
      this.emit('close');
      setTimeout(() => this.connect(), 1200);
    });
    this.ws.addEventListener('error', () => this.setStatus('offline'));
    this.ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch (_) {
        return;
      }
      this.emit(msg.type, msg);
    });
  }

  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type).add(fn);
  }

  emit(type, payload) {
    for (const fn of this.handlers.get(type) ?? []) fn(payload);
  }

  send(type, payload = {}) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type, ...payload }));
    } else {
      this.queue.push({ type, payload });
    }
  }

  setStatus(state) {
    const dot = document.getElementById('conn-dot');
    const label = document.getElementById('conn-label');
    if (!dot) return;
    dot.dataset.state = state;
    label.textContent = state === 'connected' ? 'engine online'
      : state === 'reconnecting' ? 'reconnecting…' : 'offline';
  }
}

/* ---------------------------------------------------------------------- */
/* app                                                                     */
/* ---------------------------------------------------------------------- */

const app = {
  services: {},
  mirror: null,
  selectedPath: null,
  selectedNode: null,
  realm: 'server',
  clientId: null,
  running: false,
  activeTab: 'editor',
  showClientGui: true,
};

const conn = new Connection(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);

/* viewport */
const viewport = new Viewport(document.getElementById('viewport-canvas'));
window.__viewport = viewport;

/* PlayerGui overlay — paints the selected client's GUI over the 3D view */
const guiLayer = new GuiLayer(document.getElementById('gui-host'), {
  onActivate: (node) => {
    // fire the click inside the client realm that owns this PlayerGui
    const clientId = activeClientId();
    if (clientId == null) return setStatus('join a client to click its GUI', 'warn');
    fireGuiClick(node, clientId);
  },
});

/* panes */
const explorer = new Explorer(document.getElementById('explorer'), {
  onSelect: (path, node) => selectInstance(path, node),
  onFocus: (path) => focusInstance(path),
  onDelete: (path) => conn.send('deleteInstance', { path }),
  onSetProp: (path, prop, value) => conn.send('setProperty', { path, prop, value }),
});

const inspector = new Inspector(document.getElementById('inspector'), {
  onSetProp: (path, prop, value) => conn.send('setProperty', { path, prop, value }),
  onDelete: (path) => conn.send('deleteInstance', { path }),
  onOpenScript: (path, node) => openScript(path, node),
});

const editor = new CodeEditor(document.getElementById('editor-host'));
editor.onSave = (path, text) => {
  if (!path) return;
  conn.send('setScriptSource', { path, source: text });
  setStatus(`saved ${path}`, 'ok');
};
editor.onRun = (path) => {
  if (path) conn.send('runScript', { path });
};

const consolePrompt = new ConsolePrompt(document.getElementById('console-prompt-host'), (code) => {
  runCode(code);
});

/* ---------------------------------------------------------------------- */
/* tree / mirror                                                           */
/* ---------------------------------------------------------------------- */

function buildMirror(services) {
  const root = new MirrorInstance({ id: 'root', className: 'DataModel', name: 'Game', props: {}, children: [] });
  const map = {};
  for (const [name, snap] of Object.entries(services)) {
    const inst = new MirrorInstance(snap, root);
    root.children.push(inst);
    root.byName.set(name, inst);
    map[name] = inst;
  }
  app.mirror = root;
  app.serviceMirrors = map;
  const wsMirror = map.Workspace;
  if (wsMirror) viewport.syncWorkspace(wsMirror);
  applyCameraFromMirror();
}

function applyCameraFromMirror() {
  const ws = app.serviceMirrors?.Workspace;
  const camera = ws?.findFirstChild('Camera');
  viewport.applyCamera(camera);
}

function findNodeByPath(path) {
  const parts = String(path).split('.');
  let cur = app.serviceMirrors?.[parts[0]];
  for (let i = 1; i < parts.length; i++) {
    if (!cur) return null;
    cur = cur.findFirstChild(parts[i]);
  }
  return cur ?? null;
}

function selectInstance(path, node) {
  app.selectedPath = path;
  app.selectedNode = node;
  inspector.show(path, node);
  explorer.select(path, node);
  viewport.select(node?.id ?? null);
  const isScript = node && (node.className === 'Script' || node.className === 'LocalScript' || node.className === 'ModuleScript');
  if (isScript && !editor.isDirty()) {
    openScript(path, node);
  }
}

function focusInstance(path) {
  const node = findNodeByPath(path);
  if (node) viewport.focusOn(node.id);
}

function openScript(path, node) {
  app.currentScriptPath = path;
  document.getElementById('editor-file-label').textContent = path;
  editor.setReadOnly(false);
  const source = node?.props?.Source ?? '-- empty script\n';
  editor.setText(source, path);
  switchTab('editor');
}

/* ---------------------------------------------------------------------- */
/* tabs                                                                    */
/* ---------------------------------------------------------------------- */

function switchTab(name) {
  app.activeTab = name;
  for (const btn of document.querySelectorAll('.tab')) {
    btn.classList.toggle('active', btn.dataset.tab === name);
  }
  for (const pane of document.querySelectorAll('.tab-pane')) {
    pane.classList.toggle('active', pane.dataset.pane === name);
  }
}

for (const btn of document.querySelectorAll('.tab')) {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
}

/* ---------------------------------------------------------------------- */
/* execution                                                               */
/* ---------------------------------------------------------------------- */

function runCode(code) {
  if (!code.trim()) return;
  conn.send('execute', { code, realm: app.realm });
  switchTab('console');
}

function setStatus(text, kind = 'info') {
  const el = document.getElementById('status-flash');
  if (!el) return;
  el.textContent = text;
  el.dataset.kind = kind;
  el.classList.add('show');
  clearTimeout(setStatus._t);
  setStatus._t = setTimeout(() => el.classList.remove('show'), 2400);
}

/* GUI overlay toggle */
document.getElementById('btn-gui-layer')?.addEventListener('click', (e) => {
  ui.showClientGui = !ui.showClientGui;
  guiLayer.setVisible(ui.showClientGui);
  e.currentTarget.textContent = `GUI: ${ui.showClientGui ? 'on' : 'off'}`;
  if (!ui.showClientGui) guiLayer.render(null);
  else renderClientGui(app.lastSnapshot ?? {});
});

/* toolbar buttons */
document.getElementById('btn-run').addEventListener('click', () => {
  if (editor.currentPath) {
    conn.send('setScriptSource', { path: editor.currentPath, source: editor.getText() });
    conn.send('runScript', { path: editor.currentPath });
  } else {
    conn.send('execute', { code: editor.getText(), realm: app.realm });
  }
});

document.getElementById('btn-play').addEventListener('click', () => {
  conn.send(app.running ? 'stop' : 'play');
});
document.getElementById('btn-reset').addEventListener('click', () => {
  if (confirm('Reset the place to the starter project? All edits will be lost.')) {
    conn.send('reset');
  }
});

document.getElementById('btn-join-client').addEventListener('click', () => {
  if (app.clientId) {
    conn.send('leaveClient');
    app.clientId = null;
  } else {
    conn.send('joinClient', { name: null });
  }
});

document.getElementById('btn-new-script').addEventListener('click', () => {
  const target = app.selectedNode?.className === 'Script'
    ? app.selectedPath.split('.').slice(0, -1).join('.')
    : null;
  showNewScriptDialog(target ?? 'ServerScriptService');
});

document.getElementById('realm-select').addEventListener('change', (e) => {
  app.realm = e.target.value;
});

/* ---------------------------------------------------------------------- */
/* console                                                                */
/* ---------------------------------------------------------------------- */

const logView = document.getElementById('log-view');
const MAX_LOG_ROWS = 700;

function appendLog(entry) {
  const row = document.createElement('div');
  row.className = `log-row level-${entry.level}`;
  const realm = entry.realm ?? 'server';
  const realmClass = realm.startsWith('client') ? 'client' : 'server';
  row.innerHTML = `
    <span class="log-time">${formatTime(entry.t)}</span>
    <span class="log-realm ${realmClass}">${escapeHtml(realm.replace('client:', 'client '))}</span>
    <span class="log-text">${escapeHtml(entry.text)}</span>
  `;
  logView.appendChild(row);
  while (logView.childElementCount > MAX_LOG_ROWS) logView.firstElementChild.remove();
  logView.scrollTop = logView.scrollHeight;
}

function formatTime(t) {
  const s = typeof t === 'number' ? t : 0;
  return `${s.toFixed(2)}s`;
}

document.getElementById('btn-clear-log').addEventListener('click', () => {
  logView.replaceChildren();
});

/* ---------------------------------------------------------------------- */
/* status / scheduler                                                      */
/* ---------------------------------------------------------------------- */

function applyStatus(status) {
  app.running = status.running;
  const playBtn = document.getElementById('btn-play');
  playBtn.textContent = status.running ? 'Stop' : 'Play';
  playBtn.classList.toggle('running', status.running);

  const clientBtn = document.getElementById('btn-join-client');
  const me = status.clients?.find((c) => c.id === app.clientId);
  clientBtn.textContent = me ? `Leave (${me.name})` : 'Join as player';
  clientBtn.classList.toggle('active', !!me);

  document.getElementById('stat-time').textContent = `${status.time.toFixed(1)}s`;
  document.getElementById('stat-tasks').textContent = String(
    (status.scheduler?.server ?? 0) +
      (status.scheduler?.clients ?? []).reduce((a, c) => a + c.count, 0)
  );
  document.getElementById('stat-players').textContent = String(status.clients?.length ?? 0);
}

function renderScheduler(data) {
  const host = document.getElementById('scheduler-list');
  const rows = [];
  rows.push(`<div class="sched-group">Server realm <span>${data.server.length}</span></div>`);
  for (const t of data.server.slice(0, 30)) {
    rows.push(schedRow(t, 'server'));
  }
  for (const client of data.clients) {
    rows.push(`<div class="sched-group">client · ${escapeHtml(client.name)} <span>${client.tasks.length}</span></div>`);
    for (const t of client.tasks.slice(0, 30)) rows.push(schedRow(t, 'client'));
  }
  if (rows.length === 1) rows.push('<div class="empty-hint small">no coroutines running</div>');
  host.innerHTML = rows.join('');
}

function schedRow(task, kind) {
  const wait = task.wait > 0.05 ? `${task.wait.toFixed(2)}s` : 'ready';
  return `<div class="sched-row ${kind}">
    <span class="sched-dot ${task.status}"></span>
    <span class="sched-label">${escapeHtml(task.label)}</span>
    <span class="sched-wait">${wait}</span>
  </div>`;
}

/* ---------------------------------------------------------------------- */
/* samples + new script dialog                                             */
/* ---------------------------------------------------------------------- */

let sampleCache = [];

function renderSamples(samples) {
  sampleCache = samples;
  const host = document.getElementById('samples-list');
  host.innerHTML = '';
  for (const sample of samples) {
    const card = document.createElement('div');
    card.className = 'sample-card';
    card.innerHTML = `
      <div class="sample-title">${escapeHtml(sample.name)}</div>
      <div class="sample-desc">${escapeHtml(sample.description)}</div>
      <button class="btn small">Insert</button>
    `;
    card.querySelector('button').addEventListener('click', () => {
      conn.send('loadSample', { id: sample.id });
      setStatus(`inserted “${sample.name}”`, 'ok');
    });
    host.appendChild(card);
  }
}

function showNewScriptDialog(parentPath) {
  const names = {
    ServerScriptService: 'Script',
    StarterPlayerScripts: 'LocalScript',
  };
  const cls = names[parentPath] ?? 'Script';
  const name = prompt(`Name for the new ${cls}:`, cls === 'Script' ? 'NewScript' : 'NewLocalScript');
  if (!name) return;
  conn.send('createScript', { parentPath, className: cls, name });
  setStatus(`created ${name}`, 'ok');
}

/* ---------------------------------------------------------------------- */
/* multiplayer panel                                                       */
/* ---------------------------------------------------------------------- */

function renderClients(clients) {
  const host = document.getElementById('clients-list');
  if (!clients.length) {
    host.innerHTML = '<div class="empty-hint small">No players connected.<br>Press “Join as player” to spin up a client realm.</div>';
    return;
  }
  host.innerHTML = '';
  for (const c of clients) {
    const row = document.createElement('div');
    row.className = 'client-row';
    row.innerHTML = `
      <span class="client-avatar">${escapeHtml(c.name.slice(0, 1))}</span>
      <div class="client-meta">
        <div class="client-name">${escapeHtml(c.name)}</div>
        <div class="client-sub">client realm #${c.id}</div>
      </div>
      ${app.clientId === c.id ? '<span class="badge">you</span>' : ''}
    `;
    host.appendChild(row);
  }
}

/* ---------------------------------------------------------------------- */
/* socket wiring                                                           */
/* ---------------------------------------------------------------------- */

conn.on('hello', (msg) => {
  buildMirror(msg.tree.services);
  explorer.setTree(msg.tree.services);
  renderSamples(msg.tree.samples ?? []);
  for (const entry of msg.logs ?? []) appendLog(entry);
  applyStatus(msg.status);
});

conn.on('snapshot', (msg) => {
  const snap = msg.snapshot;
  app.lastSnapshot = snap;
  if (snap.workspace) {
    const wsMirror = app.serviceMirrors?.Workspace;
    if (wsMirror) {
      wsMirror.update(snap.workspace);
      viewport.syncWorkspace(wsMirror);
      applyCameraFromMirror();
    }
  }
  if (snap.scheduler) renderScheduler(snap.scheduler);
  renderClientGui(snap);
});

/**
 * Pick which client's PlayerGui the overlay shows: the selected client realm
 * when one is active, otherwise the first joined client.
 */
function activeClientId() {
  // `app.realm` is either 'server' or a concrete 'client:<id>' chosen from the
  // players list; the bare 'client' option means "whichever client I joined".
  const realm = String(app.realm ?? 'server');
  if (realm.startsWith('client:')) return Number(realm.split(':')[1]);
  if (realm === 'client' && app.clientId != null) return Number(app.clientId);
  return null;
}

function renderClientGui(snap) {
  if (!ui.showClientGui) {
    guiLayer.render(null);
    return;
  }
  const id = activeClientId();
  const client = (snap.clients ?? []).find((c) => c.id === id) ?? snap.clients?.[0];
  guiLayer.render(client?.playerGui ?? null, client?.name ?? '');
}

/**
 * Ask the server to fire MouseButton1Click for this GUI node. Snapshots carry
 * no path, so rebuild it down from Players.<name>.PlayerGui.
 */
function fireGuiClick(node, clientId) {
  const client = (app.lastSnapshot?.clients ?? []).find((c) => c.id === clientId);
  const path = guiPath(node);
  if (!path || !client) return;
  conn.send('guiClick', { path: `${client.name}.PlayerGui.${path}`, clientId });
}

/** Build a dotted path below PlayerGui by searching the GUI snapshot. */
function guiPath(target, node = app.lastSnapshot?.clients?.find((c) => c.id === activeClientId())?.playerGui, trail = []) {
  if (!node) return null;
  const here = [...trail, node.name];
  if (node === target) return here.slice(1).join('.');
  for (const child of node.children ?? []) {
    const found = guiPath(target, child, here);
    if (found !== null) return found;
  }
  return null;
}

conn.on('log', (msg) => appendLog(msg.entry));

conn.on('scheduler', (msg) => renderScheduler(msg.scheduler));

conn.on('status', (msg) => {
  applyStatus(msg.status);
  renderClients(msg.status.clients ?? []);
});

conn.on('tree', (msg) => {
  buildMirror(msg.tree.services);
  explorer.setTree(msg.tree.services);
  if (app.selectedPath) {
    const node = findNodeByPath(app.selectedPath);
    if (node) inspector.show(app.selectedPath, node);
  }
});

conn.on('clientJoined', (msg) => {
  app.clientId = msg.client.id;
  setStatus(`${msg.client.name} joined`, 'ok');
});

conn.on('saved', (msg) => {
  void msg;
});

/* viewport picking */
viewport.canvas.addEventListener('pointerdown', (ev) => {
  if (ev.button !== 0) return;
  const id = viewport.pick(ev.clientX, ev.clientY);
  if (!id) {
    viewport.select(null);
    return;
  }
  const node = findById(id);
  if (node) {
    const path = pathOf(node);
    selectInstance(path, node);
  }
});

function findById(id) {
  const ws = app.serviceMirrors?.Workspace;
  if (!ws) return null;
  return ws.getDescendants().find((n) => n.id === id) ?? null;
}

function pathOf(node) {
  const parts = [];
  let cur = node;
  while (cur && cur.className !== 'DataModel') {
    parts.unshift(cur.name);
    cur = cur.parent;
  }
  return parts.join('.');
}

/* search */
document.getElementById('explorer-search').addEventListener('input', (e) => {
  explorer.setSearch(e.target.value);
});

/* keyboard shortcuts */
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    consolePrompt.submit();
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    if (app.activeTab === 'editor') editor.triggerSave();
  }
});

/* initial status */
document.getElementById('stat-time').textContent = '0.0s';

/* connect the editor to a script only when it has been saved at least once */
editor.onChange(() => {
  const dot = document.getElementById('editor-dirty');
  if (dot) dot.style.display = editor.isDirty() ? 'inline-block' : 'none';
});

renderClients([]);
applyStatus({ running: false, time: 0, clients: [], scheduler: { server: 0, clients: [] } });
