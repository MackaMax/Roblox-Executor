/**
 * Host-side implementations of Roblox services.
 *
 * The Lua layer calls into these small classes; they own state that lives in
 * Node (tweens in flight, debris timers, per-frame loop callbacks) and are
 * deliberately realm-aware: a client loop only runs when that client's realm is
 * being stepped, and scripts can never reach a loop registered by another realm.
 */

import * as T from './math/transform.js';
import { Instance } from './instance.js';

/* ---------------------------------------------------------------------- */
/* RunService: Heartbeat / RenderStepped / BindToRenderStep               */
/* ---------------------------------------------------------------------- */

export class LoopService {
  constructor() {
    this.callbacks = new Map(); // bindings -> [ { ref, name, kind } ]
  }

  _bucket(bindings) {
    if (!this.callbacks.has(bindings)) this.callbacks.set(bindings, []);
    return this.callbacks.get(bindings);
  }

  add({ ref, name, kind, bindings }) {
    const list = this._bucket(bindings);
    if (list.some((c) => c.name === name && c.kind === kind)) return;
    list.push({ ref, name, kind });
  }

  remove(name, bindings) {
    const list = this._bucket(bindings);
    const i = list.findIndex((c) => c.name === name);
    if (i !== -1) list.splice(i, 1);
  }

  list(kind) {
    return [];
  }

  clearFor(bindings) {
    this.callbacks.delete(bindings);
  }

  /** Steps every callback registered in `bindings`; called once per frame. */
  step(bindings, dt, frame) {
    // RunService.Heartbeat / Stepped / RenderStepped as instance signals
    const services = bindings.services;
    const runService = services.RunService;
    if (runService) {
      for (const signalName of ['Heartbeat', 'Stepped', 'RenderStepped']) {
        const sig = bindings.signalCache.get(`${runService.id}:${signalName}`);
        if (sig && sig.listeners.length > 0) bindings.fire(sig, [dt]);
      }
    }
    const list = this._bucket(bindings);
    if (!list.length) return;
    for (const cb of [...list]) {
      const created = bindings.vm.createThreadFromRef(cb.ref);
      if (!created.ok) {
        bindings.onLog({ level: 'error', text: created.error, source: cb.name });
        continue;
      }
      const entry = bindings.scheduler.addEntry(created.thread, {
        label: cb.name || 'render step',
        kind: 'event',
        script: bindings.scheduler.currentScript,
      });
      if (entry) entry.entryArgs = [dt];
    }
    void frame;
  }
}

/* ---------------------------------------------------------------------- */
/* TweenService                                                           */
/* ---------------------------------------------------------------------- */

const EASING = {
  Linear: (t) => t,
  Sine: (t) => 1 - Math.cos((t * Math.PI) / 2),
  Quad: (t) => t * t,
  Cubic: (t) => t * t * t,
  Quart: (t) => t * t * t * t,
  Quint: (t) => t * t * t * t * t,
  Bounce: (t) => {
    const n1 = 7.5625;
    const d1 = 2.75;
    if (t < 1 / d1) return n1 * t * t;
    if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75;
    if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375;
    return n1 * (t -= 2.625 / d1) * t + 0.984375;
  },
  Elastic: (t) => {
    if (t === 0 || t === 1) return t;
    const c4 = (2 * Math.PI) / 3;
    return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1;
  },
  Back: (t) => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return c3 * t * t * t - c1 * t * t;
  },
  Exponential: (t) => (t === 0 ? 0 : Math.pow(2, 10 * t - 10)),
  Circular: (t) => 1 - Math.sqrt(1 - t * t),
};

export class TweenService {
  constructor(engine) {
    this.engine = engine;
    this.tweens = new Map();
    this.seq = 0;
  }

  create(target, goals, duration, info = {}) {
    const id = `tw${++this.seq}`;
    const easingName = info?.EasingStyle?.name ?? 'Quad';
    const dirName = info?.EasingDirection?.name ?? 'Out';
    const base = EASING[easingName] ?? EASING.Quad;
    const ease =
      dirName === 'In' ? base
      : dirName === 'Out' ? (t) => 1 - base(1 - t)
      : (t) => (t < 0.5 ? base(t * 2) / 2 : 1 - base((1 - t) * 2) / 2);
    const starts = {};
    for (const key of Object.keys(goals ?? {})) starts[key] = target.props[key] ?? null;
    this.tweens.set(id, {
      id,
      target,
      goals: goals ?? {},
      starts,
      duration: Math.max(0.001, duration),
      elapsed: 0,
      ease,
      playing: false,
      finished: false,
      repeatCount: 0,
      onComplete: null,
    });
    return id;
  }

  play(id) {
    const tw = this.tweens.get(id);
    if (tw) {
      tw.playing = true;
      tw.finished = false;
    }
  }

  pause(id) {
    const tw = this.tweens.get(id);
    if (tw) tw.playing = false;
  }

  cancel(id) {
    this.tweens.delete(id);
  }

  step(dt) {
    for (const [id, tw] of [...this.tweens]) {
      if (!tw.playing) continue;
      tw.elapsed += dt;
      const raw = Math.min(1, tw.elapsed / tw.duration);
      const t = tw.ease(raw);
      for (const [key, goal] of Object.entries(tw.goals)) {
        tw.target.props[key] = interpolate(tw.starts[key], goal, t);
      }
      this.engine.markDirty(tw.target, 'Tween');
      if (raw >= 1) {
        // snap to the exact goal
        for (const [key, goal] of Object.entries(tw.goals)) tw.target.props[key] = goal;
        tw.finished = true;
        this.tweens.delete(id);
      }
    }
  }
}

function interpolate(a, b, t) {
  if (typeof b === 'number') {
    const from = typeof a === 'number' ? a : 0;
    return from + (b - from) * t;
  }
  if (b && b.__t === 'Vector3') {
    const from = a && a.__t === 'Vector3' ? a : { x: 0, y: 0, z: 0 };
    return { __t: 'Vector3', x: from.x + (b.x - from.x) * t, y: from.y + (b.y - from.y) * t, z: from.z + (b.z - from.z) * t };
  }
  if (b && b.__t === 'Color3') {
    const from = a && a.__t === 'Color3' ? a : { r: 0, g: 0, b: 0 };
    return T.colorLerp(from, b, t);
  }
  if (b && b.__t === 'UDim2') {
    const from = a && a.__t === 'UDim2' ? a : { x: 0, y: 0, w: 0, h: 0 };
    return {
      __t: 'UDim2',
      x: from.x + (b.x - from.x) * t,
      y: from.y + (b.y - from.y) * t,
      w: from.w + (b.w - from.w) * t,
      h: from.h + (b.h - from.h) * t,
    };
  }
  return t >= 1 ? b : a;
}

/* ---------------------------------------------------------------------- */
/* Debris                                                                 */
/* ---------------------------------------------------------------------- */

export class DebrisService {
  constructor(engine) {
    this.engine = engine;
    this.items = []; // { instance, at }
  }

  add(instance, lifetime, realm) {
    if (!instance) return;
    this.items.push({ instance, at: this.engine.time + Math.max(0, lifetime), realm });
  }

  step() {
    const due = this.items.filter((i) => i.at <= this.engine.time);
    if (!due.length) return;
    this.items = this.items.filter((i) => i.at > this.engine.time);
    for (const item of due) {
      if (!item.instance.destroyed) {
        item.instance.destroy();
        this.engine.markDirty(item.instance.parent ?? this.engine.workspace, 'Destroyed');
      }
    }
  }
}

/* ---------------------------------------------------------------------- */
/* CollectionService                                                      */
/* ---------------------------------------------------------------------- */

export class CollectionService {
  constructor(engine) {
    this.engine = engine;
  }

  getTagged(tag) {
    return this.engine.getAllInstances().filter((i) => i.tags.has(tag));
  }

  changed(instance, tag) {
    const service = this.engine.services.CollectionService;
    if (!service) return;
    for (const bindings of this.engine.allBindings()) {
      const sig = bindings.signalCache.get(`${service.id}:tagAdded:${tag}`);
      if (sig) bindings.fire(sig, [instance]);
    }
  }
}

/* ---------------------------------------------------------------------- */
/* UserInputService                                                       */
/* ---------------------------------------------------------------------- */

export class InputService {
  constructor(engine) {
    this.engine = engine;
    this.keysDown = new Set();
    this.mouse = { x: 0, y: 0 };
  }

  isKeyDown(key) {
    return this.keysDown.has(String(key));
  }

  setKey(key, down) {
    const name = String(key);
    if (down) this.keysDown.add(name);
    else this.keysDown.delete(name);
  }

  mousePosition() {
    return this.mouse;
  }
}

/* ---------------------------------------------------------------------- */
/* Raycasting (Workspace:Raycast / FindPartOnRay)                          */
/* ---------------------------------------------------------------------- */

export function raycast(workspace, origin, direction, params = {}) {
  const dir = T.vnorm(direction);
  const maxDist = params.maxDistance ?? 5000;
  const ignore = new Set(params.ignore ?? []);
  let best = null;

  for (const inst of workspace.getDescendants()) {
    if (!inst.isA('BasePart')) continue;
    if (ignore.has(inst)) continue;
    if (inst.props.Transparency >= 1) continue;
    if (inst.props.CanCollide === false && params.respectCanCollide === true) continue;
    const { min, max } = T.partBounds(inst);
    const t = T.rayAABB(origin, dir, min, max);
    if (t !== null && t <= maxDist && (!best || t < best.distance)) {
      const hitPos = {
        x: origin.x + dir.x * t,
        y: origin.y + dir.y * t,
        z: origin.z + dir.z * t,
      };
      best = {
        instance: inst,
        distance: t,
        position: hitPos,
        normal: estimateNormal(hitPos, min, max),
      };
    }
  }
  return best;
}

function estimateNormal(p, min, max) {
  const eps = 0.01;
  if (Math.abs(p.y - max.y) < eps) return { x: 0, y: 1, z: 0 };
  if (Math.abs(p.y - min.y) < eps) return { x: 0, y: -1, z: 0 };
  if (Math.abs(p.x - max.x) < eps) return { x: 1, y: 0, z: 0 };
  if (Math.abs(p.x - min.x) < eps) return { x: -1, y: 0, z: 0 };
  if (Math.abs(p.z - max.z) < eps) return { x: 0, y: 0, z: 1 };
  if (Math.abs(p.z - min.z) < eps) return { x: 0, y: 0, z: -1 };
  return { x: 0, y: 1, z: 0 };
}

export { EASING, interpolate };
void Instance;
