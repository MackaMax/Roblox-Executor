/**
 * HTTP + WebSocket server.
 *
 * Serves the single-page IDE and bridges it to the Engine over a tiny JSON
 * protocol. Everything the browser does (edit scripts, press Play, join as a
 * client, execute code) is a message; the engine stays authoritative.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Engine } from '../src/engine/engine.js';
import { SAMPLE_PROJECTS } from './samples.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');

const PORT = Number(process.env.PORT ?? 5173);
const HOST = process.env.HOST ?? '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/* ---------------------------------------------------------------------- */
/* static file serving                                                     */
/* ---------------------------------------------------------------------- */

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  if (pathname === '/api/samples') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ samples: SAMPLE_PROJECTS }));
    return;
  }

  const filePath = path.join(PUBLIC, pathname);
  // path traversal guard
  if (!filePath.startsWith(PUBLIC)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      // SPA fallback
      const fallback = path.join(PUBLIC, 'index.html');
      fs.readFile(fallback, (err2, data) => {
        if (err2) {
          res.writeHead(404).end('Not found');
          return;
        }
        res.writeHead(200, { 'content-type': MIME['.html'] });
        res.end(data);
      });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=60',
    });
    fs.createReadStream(filePath).pipe(res);
  });
});

/* ---------------------------------------------------------------------- */
/* engine + realtime bridge                                                */
/* ---------------------------------------------------------------------- */

let engine = new Engine({ tickRate: 60 });
const wss = new WebSocketServer({ server, path: '/ws' });

/** Per-socket session state. A Set of sockets is kept alongside so a world
 *  reset can re-announce the fresh world to everyone connected. */
const sessions = new WeakMap();
const sockets = new Set();

function send(ws, type, payload = {}) {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify({ type, ...payload }));
}

function broadcast(type, payload) {
  for (const client of wss.clients) send(client, type, payload);
}

/** Wire an engine's event streams to every connected browser. */
function bindEngineStreams(target) {
  target.listeners.log.add((entry) => broadcast('log', { entry }));
  target.listeners.snapshot.add((snap) => broadcast('snapshot', { snapshot: snap }));
  target.listeners.scheduler.add((data) => broadcast('scheduler', { scheduler: data }));
  target.listeners.status.add((status) => broadcast('status', { status }));
}
bindEngineStreams(engine);

function statusPayload() {
  return {
    running: engine.running,
    time: +engine.time.toFixed(2),
    clients: [...engine.clients.values()].map((c) => ({ id: c.id, name: c.playerName })),
    scheduler: {
      server: engine.server.scheduler.activeCount,
      clients: [...engine.clients.values()].map((c) => ({ id: c.id, count: c.scheduler.activeCount })),
    },
    scripts: {
      server: engine.server.scripts.size,
      clients: [...engine.clients.values()].map((c) => ({ id: c.id, count: c.scripts.size })),
    },
  };
}

/** Serialise the editable tree (services of interest, with script sources). */
function treePayload() {
  const roots = ['Workspace', 'ReplicatedStorage', 'ServerScriptService', 'ServerStorage', 'StarterGui', 'StarterPlayer', 'Lighting'];
  const services = {};
  for (const name of roots) {
    const svc = engine.services[name];
    if (svc) services[name] = svc.toSnapshot(true);
  }
  return { services, samples: SAMPLE_PROJECTS.map((s) => ({ id: s.id, name: s.name, description: s.description })) };
}

function helloPayload() {
  return {
    status: statusPayload(),
    tree: treePayload(),
    logs: engine.logs.slice(-200),
    snapshot: engine.snapshot(),
  };
}

wss.on('connection', (ws) => {
  sessions.set(ws, { id: `s${Math.random().toString(36).slice(2, 8)}` });
  sockets.add(ws);
  ws.on('close', () => sockets.delete(ws));
  send(ws, 'hello', helloPayload());

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (_) {
      return;
    }
    handle(ws, msg);
  });

  ws.on('close', () => {
    const s = sessions.get(ws);
    if (s?.clientId) engine.removeClient(s.clientId);
  });
});

function handle(ws, msg) {
  const session = sessions.get(ws) ?? {};
  switch (msg.type) {
    case 'ping':
      send(ws, 'pong', { t: msg.t });
      break;

    case 'play':
      engine.start();
      broadcast('status', { status: statusPayload() });
      break;

    case 'stop':
      engine.stop();
      engine.server.scheduler.stopAll();
      for (const c of engine.clients.values()) c.scheduler.stopAll();
      broadcast('status', { status: statusPayload() });
      break;

    case 'reset':
      // rebuild the world from scratch (fresh instance ids, fresh realms)
      resetEngine();
      broadcast('tree', { tree: treePayload() });
      broadcast('status', { status: statusPayload() });
      break;

    case 'execute': {
      const realm = msg.realm === 'client' ? 'client' : 'server';
      const result = engine.execute(msg.code ?? '', realm, session.clientId ?? null);
      if (!result.ok) {
        send(ws, 'log', {
          entry: { level: 'error', realm, text: result.error, source: 'executor', t: engine.time },
        });
      }
      break;
    }

    case 'joinClient': {
      const client = engine.createClient(msg.name ?? null);
      session.clientId = client.id;
      sessions.set(ws, session);
      send(ws, 'clientJoined', { client: { id: client.id, name: client.playerName } });
      broadcast('status', { status: statusPayload() });
      break;
    }

    case 'leaveClient': {
      if (session.clientId) {
        engine.removeClient(session.clientId);
        session.clientId = null;
        sessions.set(ws, session);
      }
      broadcast('status', { status: statusPayload() });
      break;
    }

    case 'tree':
      send(ws, 'tree', { tree: treePayload() });
      break;

    case 'getScript':
      send(ws, 'scriptSource', { path: msg.path, source: readScriptSource(msg.path) });
      break;

    case 'setScriptSource': {
      const inst = resolvePath(msg.path);
      if (inst) {
        inst.props.Source = msg.source ?? '';
        engine.markDirty(inst, 'Source');
        if (inst.className === 'Script') engine.runServerScript(inst);
        if (inst.className === 'LocalScript') engine.onSourceChanged(inst);
        send(ws, 'saved', { path: msg.path });
      }
      break;
    }

    case 'runScript': {
      const inst = resolvePath(msg.path);
      if (inst) {
        if (inst.className === 'Script') engine.runServerScript(inst);
        else if (inst.className === 'LocalScript') engine.onSourceChanged(inst);
        send(ws, 'log', {
          entry: { level: 'info', realm: 'server', text: `ran ${inst.fullName}`, source: 'editor', t: engine.time },
        });
      }
      break;
    }

    case 'createInstance': {
      const result = engine.createInstanceReq({
        className: msg.className,
        parentPath: msg.parentPath,
        name: msg.name,
      });
      if (result.ok) broadcast('tree', { tree: treePayload() });
      break;
    }

    case 'deleteInstance': {
      const result = engine.deleteInstanceReq({ path: msg.path });
      if (result.ok) broadcast('tree', { tree: treePayload() });
      break;
    }

    case 'setProperty': {
      const result = engine.updateInstanceReq({ path: msg.path, prop: msg.prop, value: msg.value });
      if (result.ok) broadcast('tree', { tree: treePayload() });
      break;
    }

    case 'createScript': {
      const parent = resolvePath(msg.parentPath) ?? engine.services.ServerScriptService;
      const { createInstance } = awaitInstanceModule();
      const inst = createInstance(msg.className ?? 'Script', msg.name ?? 'Script');
      inst.props.Source = msg.source ?? '-- new script\n';
      parent.addChild(inst);
      broadcast('tree', { tree: treePayload() });
      break;
    }

    case 'loadSample': {
      const sample = SAMPLE_PROJECTS.find((s) => s.id === msg.id);
      if (!sample) return;
      const parent = resolvePath(sample.parent) ?? engine.services.ServerScriptService;
      const { createInstance } = awaitInstanceModule();
      const inst = createInstance(sample.className ?? 'Script', sample.name);
      inst.props.Source = sample.code;
      parent.addChild(inst);
      if (sample.className === 'Script') engine.runServerScript(inst);
      if (sample.className === 'LocalScript') engine.startLocalScriptForClients(inst);
      broadcast('tree', { tree: treePayload() });
      break;
    }

    case 'guiClick': {
      // A click on the browser's PlayerGui overlay. Resolve the instance inside
      // the owning client realm and fire MouseButton1Click there.
      const client = engine.clients.get(Number(msg.clientId));
      if (!client) break;
      const target = resolveInClient(client, msg.path);
      if (!target) break;
      engine.fireInstanceSignal(target, 'MouseButton1Click', [], client);
      break;
    }

    case 'input': {
      // keyboard / mouse events from the browser go to UserInputService
      if (msg.event === 'key') engine.input.setKey(msg.key, msg.down);
      if (msg.event === 'mouse') {
        engine.input.mouse.x = msg.x;
        engine.input.mouse.y = msg.y;
      }
      break;
    }

    default:
      break;
  }
}

function awaitInstanceModule() {
  return instanceModule;
}

/* lazy import of the instance factory (kept out of the hot path above) */
import { createInstance as _createInstance } from '../src/engine/instance.js';
const instanceModule = { createInstance: _createInstance };

/** Resolve `Players.<name>.PlayerGui.…` inside one client's mirrored tree. */
function resolveInClient(client, pathStr) {
  if (!pathStr) return null;
  const parts = String(pathStr).split('.');
  // the client's Players service only contains itself, so start there
  let cur = client.dataModel.findFirstChild('Players');
  for (const part of parts) {
    if (!cur) return null;
    cur = cur.findFirstChild(part);
  }
  return cur ?? null;
}

function resolvePath(pathStr) {
  if (!pathStr) return null;
  const parts = String(pathStr).split('.');
  let cur = engine.dataModel;
  for (const part of parts) {
    if (!cur) return null;
    cur = cur.findFirstChild(part);
  }
  return cur ?? null;
}

function readScriptSource(pathStr) {
  const inst = resolvePath(pathStr);
  return inst ? inst.props.Source ?? '' : '';
}

/**
 * Rebuild the whole world. Swapping fields on the old Engine left its Lua
 * bindings pointing at the discarded DataModel, so instead we construct a new
 * Engine, re-wire its event streams, and let the old one go.
 */
function resetEngine() {
  engine.stop();
  engine.dispose?.();
  const fresh = new Engine({ tickRate: 60 });
  bindEngineStreams(fresh);
  engine = fresh;
  for (const ws of sockets) {
    const session = sessions.get(ws);
    if (session) session.clientId = null;
    send(ws, 'hello', helloPayload());
  }
}

/* ---------------------------------------------------------------------- */

server.listen(PORT, HOST, () => {
  console.log(`\n  Roblox Executor Lab`);
  console.log(`  ───────────────────────────────────────────`);
  console.log(`  IDE:      http://localhost:${PORT}`);
  console.log(`  WebSocket: ws://localhost:${PORT}/ws`);
  console.log(`  ${engine.workspace.getDescendants().length} instances in the starter place\n`);
});

process.on('SIGINT', () => {
  console.log('\nshutting down');
  engine.stop();
  server.close(() => process.exit(0));
});
