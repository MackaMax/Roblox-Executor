/**
 * Scheduler — runs Lua coroutines on simulated time.
 *
 * A Roblox script's natural shape is:
 *
 *     while true do
 *       task.wait(1)
 *       -- work
 *     end
 *
 * Lua scripts pause by yielding. This scheduler owns the queue of suspended
 * coroutines, each with a wake-up time, and resumes the ones that are due on
 * every simulation tick. `task.wait`, `task.delay`, `task.spawn`, remote event
 * handlers, `:Wait()` on signals and `:WaitForChild()` are all built on it.
 */

export class Scheduler {
  constructor(runtime, opts = {}) {
    this.runtime = runtime;
    this.time = 0; // simulated seconds
    this.entries = [];
    this.byThread = new Map();
    this.onError = opts.onError ?? (() => {});
    this.onLog = opts.onLog ?? (() => {});
    this.bindings = null;
    this.currentScript = null;
    this.maxCoroutines = opts.maxCoroutines ?? 1024;
    this.scriptEntries = [];
    this._seq = 0;
    this._drainGuard = 8000;
  }

  attach(bindings) {
    this.bindings = bindings;
  }

  clock() {
    return this.time;
  }

  /** For the UI: what is currently scheduled in this realm. */
  snapshot() {
    return this.entries.map((e) => ({
      id: e.id,
      label: e.label,
      kind: e.kind,
      wait: Math.max(0, +(e.wakeAt - this.time).toFixed(3)),
      age: +(this.time - e.startedAt).toFixed(1),
      script: e.script ? e.script.fullName : null,
      status: e.busy ? 'running' : e.wakeAt > this.time ? 'waiting' : 'ready',
    }));
  }

  /* ------------------------------------------------------------------- */
  /* entries                                                             */
  /* ------------------------------------------------------------------- */

  addEntry(thread, { label, kind = 'script', script = null, wakeAt = this.time } = {}) {
    if (this.entries.length >= this.maxCoroutines) {
      this.onError(
        `coroutine limit reached (${this.maxCoroutines}); new task dropped`,
        label,
        script
      );
      return null;
    }
    const entry = {
      id: `t${++this._seq}`,
      thread,
      label: label ?? 'task',
      kind,
      script,
      wakeAt,
      startedAt: this.time,
      waitStartedAt: this.time,
      dead: false,
      busy: false,
      entryArgs: null,
      expectElapsed: false,
    };
    this.entries.push(entry);
    this.byThread.set(thread, entry);
    if (kind === 'script') this.scriptEntries.push(entry);
    return entry;
  }

  removeEntry(entry) {
    if (!entry || entry.dead) return;
    entry.dead = true;
    const i = this.entries.indexOf(entry);
    if (i !== -1) this.entries.splice(i, 1);
    this.byThread.delete(entry.thread);
  }

  /* ------------------------------------------------------------------- */
  /* script lifecycle                                                    */
  /* ------------------------------------------------------------------- */

  /** Compile & schedule a script instance. Returns the entry or null. */
  runScript(scriptInstance, source) {
    const rt = this.runtime;
    const chunkName = `=${scriptInstance.fullName}`;
    const compiled = rt.compileScript(source, chunkName);
    if (!compiled.ok) {
      this.onError(compiled.error, chunkName, scriptInstance);
      return null;
    }
    this.bindings?.ownerFor(scriptInstance);
    const entry = this.addEntry(compiled.thread, {
      label: scriptInstance.name,
      kind: 'script',
      script: scriptInstance,
    });
    return entry;
  }

  stopScript(scriptInstance) {
    for (const entry of [...this.entries]) {
      if (entry.script === scriptInstance) this.removeEntry(entry);
    }
    this.scriptEntries = this.scriptEntries.filter((e) => !e.dead);
  }

  /**
   * Schedule a canned Lua function (registry ref) as a new coroutine.
   * Used for remote handlers, GUI callbacks and console "Execute".
   */
  spawnFunction(fnRef, args = [], { label = 'event', script = null } = {}) {
    const rt = this.runtime;
    const created = rt.createThreadFromRef(fnRef);
    if (!created.ok) {
      this.onError(created.error, label, script);
      return null;
    }
    const entry = this.addEntry(created.thread, { label, kind: 'event', script });
    if (entry) entry.entryArgs = args;
    return entry;
  }

  /* ------------------------------------------------------------------- */
  /* task.* API                                                          */
  /* ------------------------------------------------------------------- */

  /**
   * `task.spawn(fn, ...)` / `task.delay(n, fn, ...)`.
   * `fnIndex` says where the function sits; its args follow it.
   */
  spawnFromLua(L, { delay = 0, label = 'task', fnIndex = 1 } = {}) {
    const rt = this.runtime;
    const args = [];
    const n = rt.top(L);
    for (let i = fnIndex + 1; i <= n; i++) args.push(rt.readScalar(L, i));
    // When fnIndex is 1 we already reordered the stack, so index 1 is correct.
    const created = rt.createThreadFromStack(L, fnIndex);
    if (!created.ok) {
      rt.pushScalar(L, created.error);
      return this.runtime.fengari.lua.lua_error(L);
    }
    const entry = this.addEntry(created.thread, {
      label,
      kind: 'task',
      script: this.currentScript,
      wakeAt: this.time + Math.max(0, delay),
    });
    if (entry) entry.entryArgs = args;
    return 0;
  }

  /**
   * Re-queue a thread that was parked on `Signal:Wait()`.
   * Called by the bindings when a signal fires.
   */
  wakeForSignal(thread, args = []) {
    const entry = this.byThread.get(thread);
    if (!entry || entry.dead) return;
    entry.entryArgs = args;
    entry.waitStartedAt = this.time;
    entry.wakeAt = this.time;
  }

  /* ------------------------------------------------------------------- */
  /* the loop                                                            */
  /* ------------------------------------------------------------------- */

  tick(dtSeconds) {
    this.time += Math.max(0, Number.isFinite(dtSeconds) ? dtSeconds : 0);
    this._drain();
  }

  /** Resume every coroutine whose wake-up time has passed. */
  _drain() {
    let guard = 0;
    for (;;) {
      if (guard++ > this._drainGuard) {
        this.onError(
          'scheduler guard tripped: too many coroutine wake-ups in one tick',
          'scheduler'
        );
        break;
      }
      const due = this.entries.filter((e) => !e.dead && !e.busy && e.wakeAt <= this.time);
      if (due.length === 0) break;
      for (const entry of due) {
        if (entry.dead) continue;
        this._resumeEntry(entry);
      }
    }
  }

  _resumeEntry(entry) {
    const rt = this.runtime;
    const bindings = this.bindings;
    entry.busy = true;
    const prevScript = this.currentScript;
    this.currentScript = entry.script;
    if (bindings && entry.script && bindings.owner !== entry.script) {
      bindings.ownerFor(entry.script);
    }

    let resumeArgs = entry.entryArgs ?? [];
    entry.entryArgs = null;
    if (entry.expectElapsed) {
      const elapsed = Math.max(0, this.time - entry.waitStartedAt);
      resumeArgs = [elapsed, Math.floor(elapsed * 1000)];
      entry.expectElapsed = false;
    }

    let result;
    try {
      result = rt.resumeThread(entry.thread, resumeArgs, bindings);
    } catch (err) {
      entry.busy = false;
      this.currentScript = prevScript;
      this.removeEntry(entry);
      this.onError(`host exception: ${err?.stack ?? err}`, entry.label, entry.script);
      return;
    }

    if (result.status === 'ok') {
      this.removeEntry(entry);
      entry.busy = false;
      this.currentScript = prevScript;
      return;
    }

    if (result.status === 'yield') {
      this._handleYield(entry, result.request ?? {});
      entry.busy = false;
      this.currentScript = prevScript;
      return;
    }

    this.removeEntry(entry);
    entry.busy = false;
    this.currentScript = prevScript;
    this.onError(result.error, entry.label, entry.script);
  }

  _handleYield(entry, request) {
    const kind = request.kind;
    if (kind === 'wait' || kind === 'sleep') {
      const seconds = typeof request.seconds === 'number' ? request.seconds : 0;
      entry.waitStartedAt = this.time;
      entry.wakeAt = this.time + Math.max(0, seconds);
      entry.expectElapsed = true;
      return;
    }
    if (kind === 'signal') {
      // parked on Signal:Wait(); an eventual fire() re-queues us
      entry.waitStartedAt = this.time;
      entry.wakeAt = Infinity;
      return;
    }
    if (kind === 'waitForChild') {
      entry.waitStartedAt = this.time;
      entry.waitAtMost = this.time + (typeof request.timeout === 'number' ? request.timeout : 5);
      entry.waitForName = request.name;
      entry.wakeAt = entry.waitAtMost; // timeout fallback; host may wake us sooner
      return;
    }
    // bare coroutine.yield: resume next tick
    entry.waitStartedAt = this.time;
    entry.wakeAt = this.time + 0.016;
  }

  stopAll() {
    for (const entry of [...this.entries]) this.removeEntry(entry);
    this.scriptEntries = [];
  }

  get activeCount() {
    return this.entries.length;
  }
}
