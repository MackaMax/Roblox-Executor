/**
 * Instance tree — an educational re-implementation of the Roblox DataModel.
 *
 * Every object in the world (Workspace, parts, GUI frames, scripts) is an
 * `Instance`. Instances have a ClassName, a Name, properties, children and, in
 * some cases, magic behavior (parts move, GUIs render, lights emit light).
 *
 * Property storage lives here (the authoritative copy). The browser mirror in
 * public/js/mirror.js re-creates a lightweight copy for rendering, and the Lua
 * scripting layer in src/engine/lua/bindings.js exposes these objects as
 * userdata with metatables so script code can read/write them naturally.
 */

let idCounter = 0;

/** Convert degrees (Roblox style) to radians (three.js style). */
export const rad = (d) => (d * Math.PI) / 180;

const COLOR3 = (r, g, b) => ({ __t: 'Color3', r, g, b });

export class Instance {
  constructor(className = 'Instance', name = null) {
    this.id = `i${++idCounter}`;
    this.className = className;
    this.name = name ?? className;
    this.parent = null;
    this.children = [];
    this.props = {};
    this.attributes = new Map();
    this.tags = new Set();
    this.destroyed = false;
    this._refs = new Set(); // Lua references (registry ids) pointing at this instance
    this._meta = {}; // class-specific runtime handling / subclass storage
    this._hooks = {}; // per-property change hooks: { prop: fn(newValue, oldValue) }
  }

  get fullName() {
    if (!this.parent) return this.name;
    return `${this.parent.fullName}.${this.name}`;
  }

  /** Add a child, detaching it from any previous parent. */
  addChild(child) {
    if (child === this) throw new Error('An instance cannot be its own parent');
    if (this.destroyed) throw new Error('Attempt to parent to a destroyed instance');
    if (child.destroyed) throw new Error('Attempt to parent a destroyed instance');
    if (child.contains(this)) throw new Error('Attempt to parent an instance to one of its descendants');
    if (child.parent === this) return child;
    if (child.parent) child.parent.removeChild(child);
    child.parent = this;
    this.children.push(child);
    if (this._onChildAdded) this._onChildAdded(child);
    return child;
  }

  removeChild(child) {
    const i = this.children.indexOf(child);
    if (i === -1) return;
    this.children.splice(i, 1);
    child.parent = null;
    if (this._onChildRemoved) this._onChildRemoved(child);
  }

  setParent(parent) {
    if (parent === null) {
      if (this.parent) this.parent.removeChild(this);
      return;
    }
    parent.addChild(this);
  }

  destroy() {
    for (const c of [...this.children]) c.destroy();
    if (this.parent) this.parent.removeChild(this);
    this.destroyed = true;
    if (this._onDestroy) this._onDestroy();
  }

  clearAllChildren() {
    for (const c of [...this.children]) c.destroy();
  }

  /** Is `other` an ancestor of this instance? */
  contains(other) {
    for (let p = this; p; p = p.parent) if (p === other) return true;
    return false;
  }

  isAncestorOf(other) {
    return other.contains(this) && other !== this;
  }

  isDescendantOf(other) {
    for (let p = this.parent; p; p = p.parent) if (p === other) return true;
    return false;
  }

  findFirstChild(name, recursive = false) {
    for (const c of this.children) if (c.name === name) return c;
    if (recursive) {
      for (const c of this.children) {
        const found = c.findFirstChild(name, true);
        if (found) return found;
      }
    }
    return null;
  }

  findFirstChildOfClass(className) {
    for (const c of this.children) if (c.className === className) return c;
    return null;
  }

  findFirstChildWhichIsA(className) {
    for (const c of this.children) {
      if (c.className === className || c.isA(className)) return c;
    }
    return null;
  }

  findFirstAncestor(name) {
    for (let p = this.parent; p; p = p.parent) if (p.name === name) return p;
    return null;
  }

  findFirstAncestorOfClass(className) {
    for (let p = this.parent; p; p = p.parent) if (p.className === className) return p;
    return null;
  }

  findFirstAncestorWhichIsA(className) {
    for (let p = this.parent; p; p = p.parent) if (p.className === className || p.isA(className)) return p;
    return null;
  }

  getChildren() {
    return [...this.children];
  }

  getDescendants() {
    const out = [];
    const walk = (inst) => {
      for (const c of inst.children) {
        out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }

  isA(className) {
    if (className === this.className) return true;
    const chain = CLASS_HIERARCHY[this.className] ?? [];
    return chain.includes(className);
  }

  /** Property lookup for the Lua layer (handles special/computed values). */
  getProp(name) {
    const special = SPECIAL_GETTERS[this.className];
    if (special && special[name]) return special[name](this);
    if (name in this.props) return this.props[name];
    const inherited = CLASS_DEFAULTS[this.className];
    if (inherited && name in inherited) return inherited[name];
    return undefined;
  }

  /** Property assignment for the Lua layer. */
  setProp(name, value) {
    const special = SPECIAL_SETTERS[this.className];
    if (special && special[name]) {
      special[name](this, value);
      return;
    }
    const old = this.props[name];
    this.props[name] = value;
    if (this._hooks[name]) this._hooks[name](value, old);
    if (this._onPropChanged) this._onPropChanged(name, value, old);
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : undefined;
  }

  setAttribute(name, value) {
    if (value === undefined) this.attributes.delete(name);
    else this.attributes.set(name, value);
  }

  getAttributes() {
    return Object.fromEntries(this.attributes);
  }

  /** Deep, structured snapshot used by the browser mirror and the explorer. */
  toSnapshot(includeScripts = true) {
    if (this.destroyed) return null;
    const out = {
      id: this.id,
      className: this.className,
      name: this.name,
      props: {},
      children: [],
      tags: [...this.tags],
    };
    // Only send serialisable props, plus a few virtual ones the viewport needs.
    for (const [k, v] of Object.entries(this.props)) {
      if (k === 'Source') continue; // script source stays on the server
      if (v === undefined || typeof v === 'function') continue;
      out.props[k] = v;
    }
    for (const [k, getter] of Object.entries(SPECIAL_SNAPSHOT[this.className] ?? {})) {
      out.props[k] = getter(this);
    }
    if (includeScripts && this.className === 'Script') out.props.Source = this.props.Source ?? '';
    for (const c of this.children) {
      const snap = c.toSnapshot(includeScripts);
      if (snap) out.children.push(snap);
    }
    return out;
  }
}

/**
 * Inheritance map (child -> ancestors). Modelled after the real Roblox class
 * tree so `part:IsA("BasePart")` behaves the way scripts expect.
 */
export const CLASS_HIERARCHY = {
  // Data model
  DataModel: ['ServiceProvider', 'Model', 'Instance'],
  Workspace: ['Model', 'Instance'],
  Model: ['PVInstance', 'Instance'],
  BasePart: ['PVInstance', 'Instance'],
  Part: ['BasePart', 'PVInstance', 'Instance'],
  MeshPart: ['BasePart', 'PVInstance', 'Instance'],
  SpawnLocation: ['BasePart', 'PVInstance', 'Instance'],
  PVInstance: ['Instance'],
  Folder: ['Instance'],
  Script: ['BaseScript', 'LuaSourceContainer', 'Instance'],
  LocalScript: ['BaseScript', 'LuaSourceContainer', 'Instance'],
  ModuleScript: ['LuaSourceContainer', 'Instance'],
  RemoteEvent: ['Instance'],
  BindableEvent: ['Instance'],
  Team: ['Instance'],
  Player: ['Instance'],
  Players: ['Instance'],
  Lighting: ['Instance'],
  PointLight: ['Light', 'Instance'],
  SpotLight: ['Light', 'Instance'],
  Camera: ['Instance'],
  Humanoid: ['Instance'],
  TextLabel: ['GuiLabel', 'GuiObject', 'GuiBase2d', 'Instance'],
  TextButton: ['GuiButton', 'GuiObject', 'GuiBase2d', 'Instance'],
  ScreenGui: ['LayerCollector', 'Instance'],
  Frame: ['GuiObject', 'GuiBase2d', 'Instance'],
  BillboardGui: ['LayerCollector', 'Instance'],
  Sky: ['Instance'],
  Atmosphere: ['Instance'],
  Sound: ['Instance'],
  UICorner: ['Instance'],
  UIPadding: ['Instance'],
  UIListLayout: ['Instance'],
  UIGridLayout: ['Instance'],
};

/** Default property values per class (used when a script reads an unset prop). */
export const CLASS_DEFAULTS = {
  BasePart: {
    Anchored: true,
    CanCollide: true,
    Transparency: 0,
    Color: COLOR3(0.64, 0.64, 0.64),
    Material: 'Plastic',
    Reflectance: 0,
    Size: { __t: 'Vector3', x: 4, y: 1.2, z: 2 },
    Position: { __t: 'Vector3', x: 0, y: 2, z: 0 },
    Orientation: { __t: 'Vector3', x: 0, y: 0, z: 0 },
  },
  PointLight: { Brightness: 1, Range: 8, Color: COLOR3(1, 1, 1), Enabled: true, Shadows: false },
  Player: { Team: null, UserId: 0, DisplayName: '' },
  Humanoid: { Health: 100, MaxHealth: 100, WalkSpeed: 16 },
  TextLabel: {
    Text: 'Label',
    TextColor3: COLOR3(0, 0, 0),
    TextScaled: false,
    TextSize: 14,
    BackgroundTransparency: 1,
    Size: { __t: 'UDim2', x: 0, y: 0, w: 0.2, h: 0.1 },
    Position: { __t: 'UDim2', x: 0, y: 0, w: 0, h: 0 },
  },
  TextButton: {
    Text: 'Button',
    TextColor3: COLOR3(1, 1, 1),
    TextScaled: false,
    TextSize: 14,
    BackgroundTransparency: 0,
    BackgroundColor3: COLOR3(0.2, 0.2, 0.25),
    Size: { __t: 'UDim2', x: 0, y: 0, w: 0.2, h: 0.08 },
    Position: { __t: 'UDim2', x: 0, y: 0, w: 0.4, h: 0.45 },
  },
  Frame: {
    BackgroundTransparency: 0,
    BackgroundColor3: COLOR3(0.1, 0.1, 0.12),
    Size: { __t: 'UDim2', x: 0, y: 0, w: 0.3, h: 0.3 },
    Position: { __t: 'UDim2', x: 0, y: 0, w: 0.35, h: 0.35 },
  },
  ScreenGui: { Enabled: true, ResetOnSpawn: true, DisplayOrder: 0 },
};

/** Virtual (computed) properties readable from Lua but never stored directly. */
export const SPECIAL_GETTERS = {
  Instance: {
    ClassName: (i) => i.className,
    Parent: (i) => i.parent,
    Name: (i) => i.name,
    Archivable: () => true,
  },
  BasePart: {
    Position: (i) => {
      const p = i.props.Position;
      return p ? { __t: 'Vector3', x: p.x, y: p.y, z: p.z } : { __t: 'Vector3', x: 0, y: 0, z: 0 };
    },
    Orientation: (i) => i.props.Orientation ?? { __t: 'Vector3', x: 0, y: 0, z: 0 },
    Rotation: (i) => i.props.Orientation ?? { __t: 'Vector3', x: 0, y: 0, z: 0 },
  },
  Player: {
    Character: (i) => i._meta.character ?? null,
    PlayerGui: (i) => i._meta.playerGui ?? null,
    Backpack: (i) => i._meta.backpack ?? null,
  },
  Workspace: {
    Gravity: (i) => i.props.Gravity ?? 196.2,
    CurrentCamera: (i) => i._meta.camera ?? null,
    Terrain: (i) => i._meta.terrain ?? null,
  },
  Script: { Enabled: (i) => i.props.Enabled ?? true },
  LocalScript: { Enabled: (i) => i.props.Enabled ?? true },
  ScreenGui: { Enabled: (i) => i.props.Enabled ?? true },
};

/** Virtual properties that write through to a real property. */
export const SPECIAL_SETTERS = {
  Instance: {
    Parent: (i, v) => {
      if (v === null || v === undefined) i.setParent(null);
      else if (v instanceof Instance) v.addChild(i);
      else throw new Error('Parent must be an Instance or nil');
    },
    Name: (i, v) => i.setProp('Name', String(v)),
  },
  BasePart: {
    Position: (i, v) => {
      const cur = i.props.Position ?? { x: 0, y: 0, z: 0 };
      i.setProp('Position', { x: num(v?.x, cur.x), y: num(v?.y, cur.y), z: num(v?.z, cur.z) });
    },
    Orientation: (i, v) => {
      const cur = i.props.Orientation ?? { x: 0, y: 0, z: 0 };
      i.setProp('Orientation', { x: num(v?.x, cur.x), y: num(v?.y, cur.y), z: num(v?.z, cur.z) });
    },
  },
};

/** Extra read-only values included in snapshots (e.g. resolved light/camera data). */
export const SPECIAL_SNAPSHOT = {
  BasePart: {},
  Player: {},
  Workspace: {},
};

function num(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/* ------------------------------------------------------------------------- */
/* Constructors used by the world builder and by the Lua `Instance.new` API  */
/* ------------------------------------------------------------------------- */

const PART_DEFAULTS = () => ({
  Position: { x: 0, y: 2, z: 0 },
  Orientation: { x: 0, y: 0, z: 0 },
  Size: { x: 4, y: 1.2, z: 2 },
  Color: COLOR3(0.64, 0.64, 0.64),
  Transparency: 0,
  Anchored: true,
  CanCollide: true,
  Material: 'Plastic',
  Shape: 'Block',
  Reflectance: 0,
});

export function createInstance(className, name) {
  const inst = new Instance(className, name);

  if (className === 'Part' || className === 'MeshPart' || className === 'SpawnLocation') {
    Object.assign(inst.props, PART_DEFAULTS());
    inst.props.Size = { __t: 'Vector3', x: 4, y: 1.2, z: 2 };
    inst.props.Position = { __t: 'Vector3', x: 0, y: 2, z: 0 };
    inst.props.Orientation = { __t: 'Vector3', x: 0, y: 0, z: 0 };
    if (className === 'SpawnLocation') {
      inst.props.Color = COLOR3(0.05, 0.75, 0.15);
      inst.props.Size = { x: 6, y: 0.2, z: 6 };
      inst.props.Transparency = 0.4;
      inst.props.CanCollide = true;
    }
  }

  if (className === 'Model') {
    inst.props.PrimaryPart = null;
  }

  if (className === 'Script' || className === 'LocalScript') {
    inst.props.Source = '';
    inst.props.Enabled = true;
    inst.props.RunContext = className === 'Script' ? 'Server' : 'Client';
  }

  if (className === 'ModuleScript') {
    inst.props.Source = '';
  }

  if (className === 'RemoteEvent') {
    inst.props.RemoteId = `re${inst.id}`;
  }

  if (className === 'PointLight') {
    inst.props.Brightness = 1;
    inst.props.Range = 8;
    inst.props.Color = COLOR3(1, 1, 1);
    inst.props.Enabled = true;
    inst.props.Name = name ?? 'PointLight';
  }

  if (className === 'ScreenGui' || className === 'BillboardGui') {
    inst.props.Enabled = true;
    inst.props.ResetOnSpawn = true;
  }

  if (className === 'Camera') {
    inst.props.FieldOfView = 70;
    inst.props.CFrame = null;
  }

  if (className === 'Sky') {
    inst.props.SkyboxUp = null;
  }

  inst.props.Name = inst.name;
  return inst;
}

export { COLOR3 };
