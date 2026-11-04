/**
 * Engine — the "game" process.
 *
 * Owns the DataModel (instance tree), the server realm (one Lua VM that runs
 * Scripts) and one client realm per connected player (Lua VMs that run
 * LocalScripts and represent what that player's machine sees).
 *
 * The educational point: in real Roblox the client VM runs on the player's
 * machine and talks to the server through RemoteEvents. Here both realms run
 * in this Node process, but they are strictly separated — a LocalScript can
 * only reach objects replicated to its realm, and can only communicate
 * through RemoteEvents/BindableEvents, exactly like the real thing.
 */

import { LuaRuntime } from './lua/vm.js';
import { Scheduler } from './scheduler.js';
import { Bindings } from './lua/bindings.js';
import { buildDataModel, buildShowcase } from './world.js';
import { createInstance, Instance } from './instance.js';
import * as T from './math/transform.js';
import { LoopService, TweenService, DebrisService, CollectionService, InputService, raycast } from './services.js';

export class Engine {
  constructor(opts = {}) {
    this.opts = opts;
    this.tickRate = opts.tickRate ?? 60;
    this.time = 0;
    this.frame = 0;
    this.logs = [];
    this.errors = [];
    this.maxLogs = 500;

    this.listeners = {
      snapshot: new Set(),
      log: new Set(),
      scheduler: new Set(),
      status: new Set(),
    };

    // world
    const built = buildDataModel();
    this.dataModel = built.dataModel;
    this.services = built.services;
    this.workspace = this.services.Workspace;
    buildShowcase(this.workspace);

    this.loops = new LoopService();
    this.tweens = new TweenService(this);
    this.debrisSvc = new DebrisService(this);
    this.collectionSvc = new CollectionService(this);
    this.input = new InputService(this);

    this.clients = new Map(); // playerId -> ClientRealm
    this.playerSeq = 0;
    this.dirty = new Set(); // instances changed since last snapshot
    this.dirtyFull = true;

    // server realm
    this.server = this._createServerRealm();
    this.attachTreeHooks(this.dataModel);

    this.running = false;
    this.interval = null;
    this.lastTick = performance.now();
  }

  /* =================================================================== */
  /* realms                                                              */
  /* =================================================================== */

  _createServerRealm() {
    const runtime = new LuaRuntime({ name: 'server' });
    runtime.installRuntimeShim();

    const scheduler = new Scheduler(runtime, {
      onError: (msg, label, script) => this.reportError(msg, label, 'server', script),
      onLog: (entry) => this.pushLog({ ...entry, realm: 'server' }),
    });

    const bindings = new Bindings({
      vm: runtime,
      realm: 'server',
      game: this.dataModel,
      services: this.services,
      scheduler,
      owner: null,
      shared: this._sharedTable(),
      onLog: (entry) => this.pushLog({ ...entry, realm: 'server' }),
      onReplicated: (inst, prop) => this.markDirty(inst, prop),
      host: this._serverHost(),
    });
    bindings.install();
    scheduler.attach(bindings);

    return { runtime, scheduler, bindings, scripts: new Map() };
  }

  _serverHost() {
    return {
      remote: {
        fire: ({ instance, target, args }) => this.routeRemote(instance, target, args, null),
      },
      waitForChild: (parent, name, script) => this.watchForChild(parent, name, script, 'server'),
      tween: {
        create: (target, goals, duration, info) => this.tweens.create(target, goals, duration, info),
        play: (id) => this.tweens.play(id),
        cancel: (id) => this.tweens.cancel(id),
        pause: (id) => this.tweens.pause(id),
      },
      debris: {
        add: (inst, lifetime, realm) => this.debrisSvc.add(inst, lifetime, realm),
      },
      collection: this.collectionSvc,
      input: this.input,
      loops: {
        add: (cb) => this.loops.add(cb),
        remove: (name, bindings) => this.loops.remove(name, bindings),
        list: () => [],
      },
      raycast: (origin, direction, params) => raycast(this.workspace, origin, direction, params),
    };
  }

  _sharedTable() {
    if (!this._shared) this._shared = {};
    return this._shared;
  }

  /**
   * Create a client realm ("what player X sees").
   * The client data model is a filtered copy: server-only services are not
   * present, Handles are not present, and LocalScripts are collected from the
   * replicated tree.
   */
  createClient(playerName = null) {
    const id = ++this.playerSeq;
    const name = playerName ?? `Player${id}`;
    const player = createInstance('Player', name);
    player.props.UserId = 1000 + id;
    player.props.DisplayName = name;
    // Players:GetPlayers() reads the service's children, exactly like Roblox
    this.services.Players?.addChild(player);

    // The *server* has its own PlayerGui for this player, seeded from StarterGui.
    // It is a different object from the client's: GUIs a LocalScript builds live
    // only in the client's copy, so the server never sees them.
    createPlayerGui(this.services.StarterGui, player);

    const clientDataModel = this.buildClientView(player);

    const runtime = new LuaRuntime({ name: `client:${name}` });
    runtime.installRuntimeShim();
    const scheduler = new Scheduler(runtime, {
      onError: (msg, label, script) => this.reportError(msg, label, `client:${name}`, script),
      onLog: (entry) => this.pushLog({ ...entry, realm: `client:${name}` }),
    });

    const clientServices = clientDataModel.services;
    // The client talks to its *own* Player object, not the server's record, and
    // owns a *separate* PlayerGui. Sharing one object would leak every GUI a
    // LocalScript builds straight into the server realm.
    const localPlayer = clientServices.LocalPlayer ?? player;
    const playerGui = createPlayerGui(clientServices.StarterGui, localPlayer);
    localPlayer._meta.character = player._meta.character ?? null;

    const bindings = new Bindings({
      vm: runtime,
      realm: 'client',
      game: clientDataModel.dataModel,
      services: clientServices,
      scheduler,
      owner: null,
      player: localPlayer,
      playerGui,
      shared: this._sharedTable(),
      onLog: (entry) => this.pushLog({ ...entry, realm: `client:${name}` }),
      onReplicated: () => {},
      host: {
        remote: {
          fire: ({ instance, target, args }) => this.routeRemote(instance, target, args, id),
        },
        waitForChild: (parent, name, script) => this.watchForChild(parent, name, script, `client:${name}`),
        tween: {
          create: (target, goals, duration, info) => this.tweens.create(target, goals, duration, info),
          play: (id) => this.tweens.play(id),
          cancel: (id) => this.tweens.cancel(id),
          pause: (id) => this.tweens.pause(id),
        },
        debris: {
          add: (inst, lifetime, realm) => this.debrisSvc.add(inst, lifetime, realm),
        },
        collection: this.collectionSvc,
        input: this.input,
        loops: {
          add: (cb) => this.loops.add(cb),
          remove: (name, bindings) => this.loops.remove(name, bindings),
          list: () => [],
        },
      },
    });
    bindings.install();
    scheduler.attach(bindings);

    const client = {
      id,
      playerName: name,
      player,
      dataModel: clientDataModel.dataModel,
      services: clientServices,
      runtime,
      scheduler,
      bindings,
      playerGui,
      scripts: new Map(),
      connectedAt: this.time,
    };

    this.clients.set(id, client);

    // Players service (server side) sees the join
    this.fireInstanceSignal(this.services.Players, 'PlayerAdded', [player]);
    this.pushLog({ level: 'info', realm: 'server', text: `${name} joined the game`, source: 'Players' });

    this.startClientScripts(client);
    this.notifyStatus();
    this.markFullDirty();
    return client;
  }

  removeClient(id) {
    const client = this.clients.get(id);
    if (!client) return;
    if (client.player?.parent) client.player.destroy();
    client.scheduler.stopAll();
    this.loops.clearFor(client.bindings);
    client.runtime.close();
    this.clients.delete(id);
    this.fireInstanceSignal(this.services.Players, 'PlayerRemoving', [client.player]);
    this.pushLog({ level: 'info', realm: 'server', text: `${client.playerName} left the game`, source: 'Players' });
    this.notifyStatus();
    this.markFullDirty();
  }

  /**
   * The client's copy of the world: Workspace + replicated services only.
   * Server-only containers (ServerScriptService, ServerStorage) never cross
   * the boundary — that is the whole point of FilteringEnabled.
   */
  buildClientView(player) {
    const copy = createInstance('DataModel', 'Game');
    const services = {};

    const replicated = ['Workspace', 'Lighting', 'Players', 'ReplicatedStorage', 'StarterGui', 'StarterPlayer', 'Teams', 'SoundService'];
    for (const name of replicated) {
      const src = this.services[name];
      if (!src) continue;
      const clone = cloneForClient(src);
      copy.addChild(clone);
      services[name] = clone;
    }

    // LocalScripts from StarterPlayer, cloned to the client. This folder is the
    // root of client scripts, so it must live in the client's tree (StarterPlayer)
    const starterPlayerScripts = this.services.StarterPlayer?.findFirstChild('StarterPlayerScripts');
    if (starterPlayerScripts) {
      // The cloned StarterPlayer already contains a clone of StarterPlayerScripts
      // (cloneForClient copies the whole subtree), so reference that one instead
      // of parenting a second copy and breaking the path.
      const clientStarterPlayer = copy.findFirstChild('StarterPlayer');
      const existing = clientStarterPlayer?.findFirstChild('StarterPlayerScripts');
      if (existing) {
        services.StarterPlayerScripts = existing;
      } else {
        const clone = cloneForClient(starterPlayerScripts);
        clone.name = 'StarterPlayerScripts';
        if (clientStarterPlayer) clientStarterPlayer.addChild(clone);
        services.StarterPlayerScripts = clone;
      }
    }

    // Mirror the Players service: this client also has a Players list with itself
    const playersService = services.Players;
    if (playersService) {
      playersService.clearAllChildren();
      const playerClone = cloneForClient(player);
      playersService.addChild(playerClone);
      // keep local player object identity aligned with our record
      playerClone.props.UserId = player.props.UserId;
      playerClone.name = player.name;
      services.LocalPlayer = playerClone;
    }

    return { dataModel: copy, services };
  }

  /**
   * Start all Scripts (server) / LocalScripts (client) found in a tree.
   * Mirrors Roblox's RunContext rules in a simplified way.
   */
  startServerScripts() {
    const roots = [
      this.services.ServerScriptService,
      this.workspace,
    ].filter(Boolean);
    for (const root of roots) {
      for (const script of root.getDescendants()) {
        if (script.className !== 'Script') continue;
        if (script.props.Enabled === false) continue;
        this.runServerScript(script);
      }
      if (root.className === 'Script') this.runServerScript(root);
    }
  }

  runServerScript(script, sourceOverride = null) {
    if (this.server.scripts.has(script)) this.server.scheduler.stopScript(script);
    const source = sourceOverride ?? script.props.Source ?? '';
    if (!source.trim()) return;
    const entry = this.server.scheduler.runScript(script, source);
    if (entry) this.server.scripts.set(script, entry);
  }

  startClientScripts(client) {
    const roots = [
      client.services.StarterPlayerScripts,
      client.services.Workspace,
      client.services.StarterGui,
    ].filter(Boolean);
    const started = new Set();
    for (const root of roots) {
      for (const script of root.getDescendants()) {
        if (script.className !== 'LocalScript') continue;
        if (script.props.Enabled === false) continue;
        if (started.has(script)) continue;
        started.add(script);
        this.runClientScript(client, script);
      }
    }
  }

  /**
   * A LocalScript was added to a client-visible root after players joined.
   * Roblox replicates new LocalScripts into existing clients, so mirror that:
   * start a copy of the script in every client whose tree contains it.
   */
  startLocalScriptForClients(serverScript) {
    if (serverScript.className !== 'LocalScript') return;
    if (serverScript.props.Enabled === false) return;
    for (const client of this.clients.values()) {
      const mirror = findMatchingInstance(client.dataModel, serverScript);
      if (!mirror) continue;
      if (client.scripts.has(mirror)) continue;
      this.runClientScript(client, mirror, serverScript.props.Source ?? mirror.props.Source ?? '');
    }
  }

  runClientScript(client, script, sourceOverride = null) {
    if (client.scripts.has(script)) client.scheduler.stopScript(script);
    const source = sourceOverride ?? script.props.Source ?? '';
    if (!source.trim()) return null;
    const entry = client.scheduler.runScript(script, source);
    if (entry) client.scripts.set(script, entry);
    return entry;
  }

  /* =================================================================== */
  /* remote events                                                       */
  /* =================================================================== */

  /**
   * Route a RemoteEvent fire.
   *  target 'server'  : client -> server (OnServerEvent(player, ...))
   *  target 'client'  : server -> one client (OnClientEvent(...))
   *  target 'all'     : server -> every client
   * The server realm's OnServerEvent and the client realm's OnClientEvent are
   * fired on the *same-named* instance in each realm.
   */
  routeRemote(instance, target, args, fromClientId) {
    if (instance.className !== 'RemoteEvent') {
      this.pushLog({ level: 'warn', realm: 'server', text: `Fire on non-RemoteEvent ${instance.fullName}`, source: 'remote' });
      return;
    }
    // BindableEvent-ish local use is not supported through this path.

    if (target === 'server') {
      const serverInst = this.findServerCounterpart(instance);
      if (!serverInst) {
        this.pushLog({ level: 'warn', realm: 'server', text: `RemoteEvent ${instance.name} does not exist on the server`, source: 'remote' });
        return;
      }
      const player = fromClientId ? this.clients.get(fromClientId)?.player : null;
      this.fireInstanceSignal(serverInst, 'OnServerEvent', [player, ...args]);
      this.pushLog({
        level: 'remote',
        realm: 'server',
        text: `→ OnServerEvent(${player?.name ?? 'nil'}${args.length ? ', ' + args.map(fmtArg).join(', ') : ''})`,
        source: instance.name,
      });
      return;
    }

    const targets = target === 'all' ? [...this.clients.values()] : null;
    if (target === 'client') {
      // in our single-client-per-player model the server fires all clients
      for (const client of this.clients.values()) {
        this.fireRemoteOnClient(client, instance, args);
      }
      return;
    }
    void targets;
  }

  fireRemoteOnClient(client, serverInstance, args) {
    const clientInst = findMatchingInstance(client.dataModel, serverInstance);
    if (!clientInst) return;
    this.fireInstanceSignal(clientInst, 'OnClientEvent', args, client);
    this.pushLog({
      level: 'remote',
      realm: `client:${client.playerName}`,
      text: `← OnClientEvent(${args.map(fmtArg).join(', ')})`,
      source: serverInstance.name,
    });
  }

  /** Fire a RemoteEvent from the server to every client. */
  fireClient(instance, ...args) {
    // target '' => server side uses :FireAllClients()
    for (const client of this.clients.values()) {
      this.fireRemoteOnClient(client, instance, args);
    }
  }

  findServerCounterpart(instance) {
    // Same name somewhere in the server's ReplicatedStorage / Workspace
    const roots = [this.services.ReplicatedStorage, this.services.Workspace, this.services.ServerScriptService];
    for (const root of roots) {
      if (!root) continue;
      const hit = root.getDescendants().find((d) => d.name === instance.name && d.className === instance.className);
      if (hit) return hit;
    }
    // fallback: the instance handed to us may already be the server copy
    return instance;
  }

  fireInstanceSignal(inst, signalName, args, client = null) {
    if (client) {
      // fire inside a client realm
      const bindings = client.bindings;
      const sig = bindings.getSignal(inst, signalName);
      bindings.fire(sig, args);
      return;
    }
    const sig = this.server.bindings.getSignal(inst, signalName);
    this.server.bindings.fire(sig, args);
  }

  /* =================================================================== */
  /* instance tree hooks                                                 */
  /* =================================================================== */

  attachTreeHooks(root) {
    const visit = (inst) => {
      inst._onChildAdded = (child) => {
        this.markDirty(inst, 'ChildAdded');
        this.fireInstanceSignal(inst, 'ChildAdded', [child]);
        visit(child);
        this.onTreeChanged(child, 'added');
      };
      inst._onChildRemoved = (child) => {
        this.markDirty(inst, 'ChildRemoved');
        this.fireInstanceSignal(inst, 'ChildRemoved', [child]);
        this.onTreeChanged(child, 'removed');
      };
      inst._onDestroy = () => {
        this.markDirty(inst, 'Destroyed');
      };
      inst._onPropChanged = (prop, value, old) => {
        this.markDirty(inst, prop);
        if (prop === 'Source') this.onSourceChanged(inst);
      };
      for (const child of inst.children) visit(child);
    };
    visit(root);
  }

  /**
   * Mirror a server instance into every client tree that should see it.
   * Called for new instances so scripts can add parts at runtime and have them
   * show up on clients, the way real replication works.
   */
  replicateToClients(inst, change) {
    if (this._replicating) return;
    if (inst.className === 'Script') return;          // server code never replicates
    if (inst.className === 'PlayerGui') return;        // per-client, built by buildClientView
    if (inst.className === 'Player') return;           // players are mirrored on join
    if (inst.isDescendantOf?.(this.services.ServerScriptService)) return;
    if (inst.isDescendantOf?.(this.services.ServerStorage)) return;
    const serverParent = inst.parent;
    if (!serverParent) return;
    // only containers that exist in the client view
    const clientVisible = new Set(['Workspace', 'Lighting', 'Players', 'ReplicatedStorage', 'StarterGui', 'StarterPlayer', 'Teams', 'SoundService']);
    const top = this.topLevelServiceOf(inst);
    if (!top || !clientVisible.has(top.name)) return;

    this._replicating = true;
    try {
      for (const client of this.clients.values()) {
        const clientParent = findMatchingInstance(client.dataModel, serverParent);
        if (!clientParent) continue;
        if (clientParent.findFirstChild(inst.name)) continue;
        const copy = cloneForClient(inst);
        copy.props = { ...inst.props };
        clientParent.addChild(copy);
        if (inst.className === 'LocalScript') this.runClientScript(client, copy, inst.props.Source ?? '');
        if (change === 'added') this.attachTreeHooks(copy);
      }
    } finally {
      this._replicating = false;
    }
  }

  topLevelServiceOf(inst) {
    let cur = inst;
    while (cur && cur.parent && cur.parent !== this.dataModel) cur = cur.parent;
    return cur;
  }

  /** A script was added/edited: (re)start or stop it as appropriate. */
  onTreeChanged(inst, change) {
    if (change === 'added') this.replicateToClients(inst, change);
    if (change === 'removed') {
      this.server.scheduler.stopScript(inst);
      for (const client of this.clients.values()) client.scheduler.stopScript(inst);
      return;
    }
    if (inst.className === 'Script' && inst.isDescendantOf(this.services.ServerScriptService)) {
      this.runServerScript(inst);
    }
    if (inst.className === 'LocalScript') {
      for (const client of this.clients.values()) {
        const mirror = findMatchingInstance(client.dataModel, inst);
        if (mirror) this.runClientScript(client, mirror);
      }
    }
    this.attachTreeHooks(inst);
  }

  onSourceChanged(inst) {
    if (inst.className === 'Script') {
      this.runServerScript(inst);
    } else if (inst.className === 'LocalScript') {
      for (const client of this.clients.values()) {
        const mirror = findMatchingInstance(client.dataModel, inst);
        if (mirror) {
          mirror.props.Source = inst.props.Source;
          this.runClientScript(client, mirror);
        }
      }
    }
  }

  /** Push an edit made on the client to the server copy (RemoteEvent style). */
  syncInstanceToServer(instance) {
    const serverInst = this.findServerCounterpart(instance);
    if (!serverInst) return false;
    // Clients may only change visual properties in this model.
    const allowed = new Set(['Color', 'Transparency', 'Material', 'Size', 'Reflectance', 'Name', 'Text', 'TextColor3', 'BackgroundTransparency', 'BackgroundColor3']);
    let changed = false;
    for (const key of Object.keys(instance.props)) {
      if (!allowed.has(key)) continue;
      const next = instance.props[key];
      if (JSON.stringify(serverInst.props[key]) !== JSON.stringify(next)) {
        serverInst.props[key] = next;
        this.markDirty(serverInst, key);
        changed = true;
      }
    }
    return changed;
  }

  /* =================================================================== */
  /* console / editor                                                    */
  /* =================================================================== */

  /**
   * Execute user code in a realm ("the executor window").
   * realm = 'server' (game scripts) or 'client' (local player's scripts).
   */
  execute(code, realm = 'server', clientId = null) {
    if (realm === 'client') {
      const client = this.clients.get(clientId) ?? [...this.clients.values()][0];
      if (!client) {
        this.pushLog({ level: 'error', realm: 'client', text: 'No client is connected. Join a player first.', source: 'executor' });
        return { ok: false, error: 'no client' };
      }
      return this.executeInRealm(client, code);
    }
    return this.executeInRealm(this.server, code);
  }

  executeInRealm(host, code) {
    const rt = host.runtime;
    const chunkName = '=executor';
    const compiled = rt.compileScript(code, chunkName);
    if (!compiled.ok) {
      this.reportError(compiled.error, 'executor', host === this.server ? 'server' : 'client');
      return { ok: false, error: compiled.error };
    }
    const entry = host.scheduler.addEntry(compiled.thread, {
      label: 'executor',
      kind: 'executor',
    });
    if (entry) entry.entryArgs = [];
    return { ok: true };
  }

  /* =================================================================== */
  /* simulation loop                                                     */
  /* =================================================================== */

  start() {
    if (this.running) return;
    this.running = true;
    if (this.opts.autostartScripts !== false) this.startServerScripts();
    const stepMs = 1000 / this.tickRate;
    this.lastTick = performance.now();
    this.interval = setInterval(() => this.step(), stepMs);
  }

  /** Release every Lua state and timer; used when the world is rebuilt. */
  dispose() {
    this.stop();
    try { this.server?.runtime.close(); } catch (_) { /* already closed */ }
    for (const client of this.clients?.values() ?? []) {
      try { client.runtime.close(); } catch (_) { /* already closed */ }
    }
    this.clients?.clear();
    this.listeners = { log: new Set(), snapshot: new Set(), scheduler: new Set(), status: new Set() };
  }

  stop() {
    this.running = false;
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
  }

  /**
   * Advance the simulation one frame.
   * `fixedDt` (seconds) is used by tests/headless runs to step deterministically;
   * otherwise wall-clock time between calls drives the sim.
   */
  step(fixedDt = null) {
    let dt;
    if (fixedDt !== null) {
      dt = fixedDt * (this.opts.timeScale ?? 1);
      this.lastTick = performance.now();
    } else {
      const now = performance.now();
      const elapsed = now - (this.lastTick ?? now);
      const realDt = Math.min(0.1, Math.max(0, elapsed) / 1000);
      this.lastTick = now;
      dt = realDt * (this.opts.timeScale ?? 1);
    }
    this.time += dt;
    this.frame++;

    this.server.scheduler.tick(dt);
    for (const client of this.clients.values()) client.scheduler.tick(dt);
    this.simulate(dt);
    this.resolveWaitForChild();

    if (this.frame % 2 === 0) this.emitSnapshot();
    if (this.frame % 15 === 0) this.emitScheduler();
  }

  /** Per-frame service work: tweens, debris, RunService callbacks. */
  simulate(dt) {
    this.tweens.step(dt);
    this.debrisSvc.step();
    // RunService:Heartbeat and friends, per realm
    this.loops.step(this.server.bindings, dt, this.frame);
    for (const client of this.clients.values()) {
      this.loops.step(client.bindings, dt, this.frame);
    }
  }

  /** All bindings objects (server + every client) — used by services. */
  allBindings() {
    return [this.server.bindings, ...[...this.clients.values()].map((c) => c.bindings)];
  }

  /* ------------------------------------------------------------------ */
  /* changed-instance tracking                                          */
  /* ------------------------------------------------------------------ */

  markDirty(inst, prop) {
    if (!inst || inst.destroyed) {
      this.dirtyFull = true;
      return;
    }
    const root = this.dirtyRoot(inst);
    if (root) this.dirty.add(root);
    if (prop) this.lastChanged = { inst, prop };
  }

  dirtyRoot(inst) {
    // send the outermost Model or service, not every single part
    let cur = inst;
    while (cur.parent) {
      if (cur.className === 'Model' || cur.parent === this.dataModel || cur.parent === this.services.Workspace) break;
      cur = cur.parent;
    }
    return cur;
  }

  markFullDirty() {
    this.dirtyFull = true;
  }

  emitSnapshot() {
    if (!this.listeners.snapshot.size) return;
    const payload = this.snapshot();
    for (const fn of this.listeners.snapshot) fn(payload);
  }

  snapshot() {
    const view = {
      time: +this.time.toFixed(2),
      frame: this.frame,
      workspace: this.workspace.toSnapshot(),
      lighting: this.services.Lighting.toSnapshot(),
      clients: [...this.clients.values()].map((c) => ({
        id: c.id,
        name: c.playerName,
        playerGui: c.services.LocalPlayer?._meta?.playerGui?.toSnapshot() ?? null,
        localPlayer: c.services.LocalPlayer?.id ?? null,
      })),
      scheduler: {
        server: this.server.scheduler.snapshot(),
        clients: [...this.clients.values()].map((c) => ({
          id: c.id,
          name: c.playerName,
          tasks: c.scheduler.snapshot(),
        })),
      },
    };
    return view;
  }

  emitScheduler() {
    if (!this.listeners.scheduler.size) return;
    const data = {
      server: this.server.scheduler.snapshot(),
      clients: [...this.clients.values()].map((c) => ({ id: c.id, name: c.playerName, tasks: c.scheduler.snapshot() })),
    };
    for (const fn of this.listeners.scheduler) fn(data);
  }

  /* ------------------------------------------------------------------ */
  /* logging / errors                                                   */
  /* ------------------------------------------------------------------ */

  pushLog(entry) {
    const record = {
      id: `l${this.logs.length + 1}`,
      t: +this.time.toFixed(3),
      ...entry,
    };
    this.logs.push(record);
    if (this.logs.length > this.maxLogs) this.logs.shift();
    for (const fn of this.listeners.log) fn(record);
  }

  reportError(message, label = 'script', realm = 'server', script = null) {
    const entry = {
      level: 'error',
      realm,
      text: `${label}: ${message}`,
      source: label,
      script: script ? script.fullName : null,
    };
    this.errors.push(entry);
    this.pushLog(entry);
    if (script) {
      this.pushLog({
        level: 'info',
        realm,
        text: `[${label}] script stopped`,
        source: 'engine',
      });
    }
  }

  notifyStatus() {
    const status = {
      running: this.running,
      time: +this.time.toFixed(2),
      clients: [...this.clients.values()].map((c) => ({ id: c.id, name: c.playerName })),
      scheduler: {
        server: this.server.scheduler.activeCount,
        clients: [...this.clients.values()].map((c) => ({ id: c.id, count: c.scheduler.activeCount })),
      },
    };
    for (const fn of this.listeners.status) fn(status);
  }

  /** Watch for a child appearing (WaitForChild support). */
  watchForChild(parent, name, script, realmTag) {
    this._childWatchers ??= [];
    this._childWatchers.push({ parent, name, addedAt: this.time, realmTag });
  }

  resolveWaitForChild() {
    if (!this._childWatchers?.length) return;
    this._childWatchers = this._childWatchers.filter((w) => {
      const found = w.parent.findFirstChild(w.name);
      if (!found) return true;
      // wake whoever is waiting in that realm
      const realm = w.realmTag === 'server' ? this.server : this.clients.get(Number(w.realmTag.split(':')[1]));
      if (realm) {
        for (const entry of [...realm.scheduler.entries]) {
          if (entry.waitForName === w.name && entry.waitAtMost !== undefined) {
            entry.entryArgs = [];
            entry.wakeAt = this.time;
            entry.waitForName = null;
          }
        }
      }
      return false;
    });
  }

  /* ------------------------------------------------------------------ */
  /* helpers                                                            */
  /* ------------------------------------------------------------------ */

  findInstanceByPath(path) {
    // "Workspace.Showcase.Part" style lookup
    const parts = String(path).split('.');
    let cur = this.dataModel;
    for (const part of parts) {
      if (!cur) return null;
      cur = cur.findFirstChild(part);
    }
    return cur ?? null;
  }

  getAllInstances() {
    return [this.dataModel, ...this.dataModel.getDescendants()];
  }

  /* ------------------------------------------------------------------ */
  /* editor operations                                                  */
  /* ------------------------------------------------------------------ */

  createInstanceReq({ className, parentPath, name, props }) {
    const parent = parentPath ? this.findInstanceByPath(parentPath) : this.workspace;
    if (!parent) return { ok: false, error: 'parent not found' };
    const inst = createInstance(className, name);
    if (name) {
      inst.name = name;
      inst.props.Name = name;
    }
    for (const [k, v] of Object.entries(props ?? {})) inst.props[k] = v;
    parent.addChild(inst);
    this.markDirty(parent, 'ChildAdded');
    return { ok: true, id: inst.id };
  }

  updateInstanceReq({ path, prop, value }) {
    const inst = this.findInstanceByPath(path);
    if (!inst) return { ok: false, error: 'instance not found' };
    if (prop === 'Name') {
      inst.name = String(value);
      inst.props.Name = inst.name;
    } else {
      inst.props[prop] = value;
    }
    this.markDirty(inst, prop);
    if (inst.className === 'Script' && prop === 'Source') this.runServerScript(inst);
    return { ok: true };
  }

  deleteInstanceReq({ path }) {
    const inst = this.findInstanceByPath(path);
    if (!inst) return { ok: false, error: 'instance not found' };
    const parent = inst.parent;
    inst.destroy();
    if (parent) this.markDirty(parent, 'ChildRemoved');
    return { ok: true };
  }
}

/* ===================================================================== */
/* helpers                                                                */
/* ===================================================================== */

function cloneForClient(root) {
  const copy = createInstance(root.className);
  copy.name = root.name;
  copy.props = { ...root.props };
  copy.attributes = new Map(root.attributes);
  copy.tags = new Set(root.tags);
  copy._serverId = root.id;
  for (const child of root.children) {
    if (child.className === 'Script') continue; // server Scripts never replicate as code
    if (child.className === 'PlayerGui') continue; // PlayerGui is per-client
    copy.addChild(cloneForClient(child));
  }
  return copy;
}

/**
 * Build a fresh PlayerGui under `player`, seeded with the ScreenGuis from
 * `starterGui`. Called once for the server's player record and once for each
 * client's own Player clone — never shared between them.
 */
function createPlayerGui(starterGui, player) {
  const existing = player.findFirstChild('PlayerGui');
  if (existing) return existing;
  const playerGui = createInstance('PlayerGui', 'PlayerGui');
  if (starterGui) {
    for (const child of starterGui.children) {
      if (child.className === 'ScreenGui' || child.className === 'BillboardGui') {
        playerGui.addChild(cloneForClient(child));
      }
    }
  }
  player._meta.playerGui = playerGui;
  player.addChild(playerGui);
  return playerGui;
}

/** Find the client mirror of a server instance, by id/name path. */
export function findMatchingInstance(clientRoot, serverInst) {
  if (!serverInst) return null;
  // Walk down from the DataModel copying the server path segment by segment.
  // The old version skipped a segment whenever the *current* node already had
  // that name, which broke as soon as a path started with a root service.
  const path = serverInst.fullName.split('.').slice(1); // drop the DataModel name
  let cur = clientRoot;
  for (const part of path) {
    if (!cur) return null;
    cur = cur.findFirstChild(part);
  }
  return cur ?? null;
}

function fmtArg(v) {
  if (v === null || v === undefined) return 'nil';
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof Instance) return v.fullName;
  if (v.__t === 'Vector3') return `Vector3(${v.x}, ${v.y}, ${v.z})`;
  return JSON.stringify(v);
}

export { Instance, T as Transform };
