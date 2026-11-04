/**
 * Roblox API bindings for one Lua realm.
 *
 * This file is the "environment" a script sees. It mirrors the shape of the
 * real Roblox API surface: Instance userdata with property metatables, the
 * Vector3/CFrame/Color3/Enum value types, RBXScriptSignals, and the global
 * functions (`game`, `workspace`, `task`, `Instance.new`, ...).
 *
 * Design rules:
 *  - everything is built per-realm; no global shared state
 *  - Lua never receives raw JS objects (except opaque userdata)
 *  - property writes funnel through one place so the host can replicate
 */

import { Instance, createInstance, CLASS_DEFAULTS } from '../instance.js';
import * as T from '../math/transform.js';

/* ========================================================================== */
/* enums                                                                      */
/* ========================================================================== */

export const ENUMS = {
  Material: ['Plastic', 'SmoothPlastic', 'Neon', 'Wood', 'WoodPlanks', 'Metal', 'DiamondPlate', 'CorrodedMetal', 'Grass', 'Slate', 'Concrete', 'Brick', 'Granite', 'Marble', 'Sand', 'Fabric', 'Ice', 'Glass', 'ForceField'],
  PartType: ['Ball', 'Block', 'Cylinder', 'Wedge', 'CornerWedge'],
  EasingStyle: ['Linear', 'Sine', 'Back', 'Quad', 'Quart', 'Quint', 'Bounce', 'Elastic', 'Exponential', 'Circular', 'Cubic', 'Heavy', 'Soft'],
  EasingDirection: ['In', 'Out', 'InOut'],
  HumanoidStateType: ['Running', 'Jumping', 'Falling', 'Landed', 'Freefall', 'Climbing', 'Swimming'],
  KeyCode: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z', 'Space', 'Return', 'Escape', 'LeftShift', 'LeftControl', 'Backspace', 'Tab', 'MouseButton1', 'MouseButton2', 'W', 'S', 'D'],
  UserInputType: ['Keyboard', 'MouseButton1', 'MouseButton2', 'MouseMovement', 'Touch', 'Focus'],
  RunContext: ['Legacy', 'Server', 'Client'],
  NormalId: ['Top', 'Bottom', 'Left', 'Right', 'Front', 'Back'],
  SurfaceType: ['Smooth', 'Glue', 'Weld', 'Studs', 'Inlet', 'Universal', 'Hinge', 'Motor'],
  Font: ['Legacy', 'Arial', 'ArialBold', 'SourceSans', 'SourceSansBold', 'SourceSansLight', 'SourceSansItalic', 'SourceSansSemibold', 'Code', 'Gotham', 'GothamMedium', 'GothamBold', 'Cartoon', 'Fantasy', 'Antique', 'SciFi'],
  TextXAlignment: ['Left', 'Center', 'Right'],
  TextYAlignment: ['Top', 'Center', 'Bottom'],
  ScaleType: ['Stretch', 'Slice', 'Tile', 'Fit'],
  CameraType: ['Fixed', 'Attach', 'Watch', 'Track', 'Custom', 'Scriptable'],
  PlaybackState: ['Playing', 'Paused', 'Stopped'],
  AutomaticSize: ['None', 'X', 'Y', 'XY'],
  TextTruncate: ['None', 'AtEnd', 'SplitWord'],
  RaycastFilterType: ['Exclude', 'Include'],
  ContextActionService: [],
};

const ENUM_IDS = {};
for (const [enumName, items] of Object.entries(ENUMS)) {
  items.forEach((item, i) => {
    ENUM_IDS[`${enumName}.${item}`] = i;
  });
}

function fmt(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return String(n);
  if (Number.isInteger(n)) return String(n);
  return String(Math.round(n * 100000) / 100000);
}

/* ========================================================================== */
/* Bindings                                                                   */
/* ========================================================================== */

export class Bindings {
  constructor(opts) {
    this.vm = opts.vm;
    this.f = opts.vm.fengari; // { lua, lauxlib, to_luastring, to_jsstring }
    if (!this.f) throw new Error('Bindings: vm.fengari missing (pass the LuaRuntime)');
    this.realm = opts.realm ?? 'server';
    this.game = opts.game;
    this.services = opts.services ?? {};
    this.scheduler = opts.scheduler;
    this.owner = opts.owner ?? null;
    this.player = opts.player ?? null;
    this.playerGui = opts.playerGui ?? null;
    this.shared = opts.shared ?? null;
    this.onLog = opts.onLog ?? (() => {});
    this.onReplicated = opts.onReplicated ?? (() => {});
    this.host = opts.host ?? {}; // service implementations (remotes, debris, raycast...)
    this.destroyed = false;

    this.instRefs = new Map(); // Instance -> registry int
    this.signalRefs = []; // registry ints we must keep alive
    this.signalCache = new Map();
    this.connectionRefs = new Map();
    this.moduleCache = new Map();
    this.waiterRefs = new Set();
    this._sigSeq = 0;
  }

  get L() {
    return this.vm.L;
  }

  /* ------------------------------------------------------------------ */
  /* small stack helpers                                                */
  /* ------------------------------------------------------------------ */

  top(st = this.L) {
    return this.f.lua.lua_gettop(st);
  }

  ltype(st, i) {
    return this.f.lua.lua_type(st, i);
  }

  isString(st, i) {
    return this.ltype(st, i) === this.f.lua.LUA_TSTRING;
  }

  isNumber(st, i) {
    return this.ltype(st, i) === this.f.lua.LUA_TNUMBER;
  }

  isFunction(st, i) {
    return this.ltype(st, i) === this.f.lua.LUA_TFUNCTION;
  }

  isTable(st, i) {
    return this.ltype(st, i) === this.f.lua.LUA_TTABLE;
  }

  isUserdata(st, i) {
    return this.ltype(st, i) === this.f.lua.LUA_TUSERDATA;
  }

  isNil(st, i) {
    const t = this.ltype(st, i);
    return t === this.f.lua.LUA_TNIL || t === this.f.lua.LUA_TNONE;
  }

  str(st, i, fallback = '') {
    const t = this.ltype(st, i);
    if (t === this.f.lua.LUA_TSTRING || t === this.f.lua.LUA_TNUMBER) {
      return this.f.to_jsstring(this.f.lua.lua_tostring(st, i));
    }
    return fallback;
  }

  num(st, i, fallback = 0) {
    const t = this.ltype(st, i);
    if (t === this.f.lua.LUA_TNUMBER) return this.f.lua.lua_tonumber(st, i);
    if (t === this.f.lua.LUA_TSTRING) {
      const n = Number(this.f.to_jsstring(this.f.lua.lua_tostring(st, i)));
      return Number.isFinite(n) ? n : fallback;
    }
    return fallback;
  }

  bool(st, i, fallback = false) {
    const t = this.ltype(st, i);
    if (t === this.f.lua.LUA_TNIL || t === this.f.lua.LUA_TNONE) return fallback;
    return !!this.f.lua.lua_toboolean(st, i);
  }

  pushStr(st, s) {
    this.f.lua.lua_pushstring(st, this.f.to_luastring(String(s)));
  }

  pushNil(st) {
    this.f.lua.lua_pushnil(st);
  }

  pushBool(st, b) {
    this.f.lua.lua_pushboolean(st, b ? 1 : 0);
  }

  pushNum(st, n) {
    if (Number.isInteger(n)) this.f.lua.lua_pushinteger(st, n);
    else this.f.lua.lua_pushnumber(st, n);
  }

  fail(st, msg) {
    this.pushStr(st, msg);
    return this.f.lua.lua_error(st);
  }

  setGlobal(name, fn) {
    this.f.lua.lua_pushjsfunction(this.L, fn);
    this.f.lua.lua_setglobal(this.L, this.f.to_luastring(name));
  }

  /* ------------------------------------------------------------------ */
  /* userdata construction                                              */
  /* ------------------------------------------------------------------ */

  /** Creates a userdata with a metatable and leaves it on the stack. */
  _newUserdata(st, metaName, init) {
    const { lua, lauxlib, to_luastring } = this.f;
    const ud = lua.lua_newuserdata(st, 0);
    init(ud);
    lauxlib.luaL_getmetatable(st, to_luastring(metaName));
    lua.lua_setmetatable(st, -2);
    return ud;
  }

  pushVector3(st, x = 0, y = 0, z = 0) {
    this._newUserdata(st, 'RBXVector3', (ud) => {
      ud.__t = 'Vector3';
      ud.x = x; ud.y = y; ud.z = z;
    });
    return 1;
  }

  pushCFrame(st, cf) {
    const value = cf && cf.__t === 'CFrame' ? cf : T.cframe();
    this._newUserdata(st, 'RBXCFrame', (ud) => {
      ud.__t = 'CFrame';
      ud.cf = value;
    });
    return 1;
  }

  pushColor3(st, c) {
    this._newUserdata(st, 'RBXColor3', (ud) => {
      ud.__t = 'Color3';
      ud.r = c?.r ?? 0;
      ud.g = c?.g ?? 0;
      ud.b = c?.b ?? 0;
    });
    return 1;
  }

  pushUDim(st, scale = 0, offset = 0) {
    this._newUserdata(st, 'RBXUDim', (ud) => {
      ud.__t = 'UDim';
      ud.scale = scale;
      ud.offset = offset;
    });
    return 1;
  }

  pushUDim2(st, x = 0, y = 0, w = 0, h = 0) {
    this._newUserdata(st, 'RBXUDim2', (ud) => {
      ud.__t = 'UDim2';
      ud.x = x; ud.y = y; ud.w = w; ud.h = h;
    });
    return 1;
  }

  pushEnum(st, enumName, itemName) {
    this._newUserdata(st, 'RBXEnumItem', (ud) => {
      ud.__t = 'EnumItem';
      ud.enum = enumName;
      ud.name = itemName;
    });
    return 1;
  }

  pushRay(st, origin, direction) {
    this._newUserdata(st, 'RBXRay', (ud) => {
      ud.__t = 'Ray';
      ud.origin = origin;
      ud.direction = direction;
    });
    return 1;
  }

  pushInstance(st, inst) {
    const { lua, lauxlib, to_luastring } = this.f;
    if (!inst) {
      lua.lua_pushnil(st);
      return 1;
    }
    const ref = this.instRefs.get(inst);
    if (ref !== undefined) {
      lua.lua_rawgeti(st, lua.LUA_REGISTRYINDEX, ref);
      return 1;
    }
    const ud = lua.lua_newuserdata(st, 0);
    ud.__inst = inst;
    lauxlib.luaL_getmetatable(st, to_luastring('RBXInstance'));
    lua.lua_setmetatable(st, -2);
    // store the userdata itself in the registry so identity is stable
    const newRef = lauxlib.luaL_ref(st, lua.LUA_REGISTRYINDEX);
    this.instRefs.set(inst, newRef);
    inst._luaRefs?.add?.(newRef);
    lua.lua_rawgeti(st, lua.LUA_REGISTRYINDEX, newRef);
    return 1;
  }

  instanceAt(st, i) {
    if (!this.isUserdata(st, i)) return null;
    const ud = this.f.lua.lua_touserdata(st, i);
    return ud && ud.__inst ? ud.__inst : null;
  }

  vecAt(st, i, fallback = { x: 0, y: 0, z: 0 }) {
    if (!this.isUserdata(st, i)) return fallback;
    const ud = this.f.lua.lua_touserdata(st, i);
    if (ud.__t === 'Vector3') return { x: ud.x, y: ud.y, z: ud.z };
    if (ud.__t === 'CFrame') return T.posOf(ud.cf);
    return fallback;
  }

  cfAt(st, i) {
    if (!this.isUserdata(st, i)) return null;
    const ud = this.f.lua.lua_touserdata(st, i);
    return ud.__t === 'CFrame' ? ud.cf : null;
  }

  /* ------------------------------------------------------------------ */
  /* value conversion Lua -> JS                                         */
  /* ------------------------------------------------------------------ */

  readValue(st, i, depth = 0) {
    const lua = this.f.lua;
    const t = this.ltype(st, i);
    switch (t) {
      case lua.LUA_TNIL:
      case lua.LUA_TNONE:
        return null;
      case lua.LUA_TBOOLEAN:
        return !!lua.lua_toboolean(st, i);
      case lua.LUA_TNUMBER:
        return lua.lua_tonumber(st, i);
      case lua.LUA_TSTRING:
        return this.f.to_jsstring(lua.lua_tostring(st, i));
      case lua.LUA_TUSERDATA: {
        const ud = lua.lua_touserdata(st, i);
        if (ud.__inst) return ud.__inst;
        if (ud.__t === 'Vector3') return { __t: 'Vector3', x: ud.x, y: ud.y, z: ud.z };
        if (ud.__t === 'CFrame') return ud.cf;
        if (ud.__t === 'Color3') return { __t: 'Color3', r: ud.r, g: ud.g, b: ud.b };
        if (ud.__t === 'UDim') return { __t: 'UDim', scale: ud.scale, offset: ud.offset };
        if (ud.__t === 'UDim2') return { __t: 'UDim2', x: ud.x, y: ud.y, w: ud.w, h: ud.h };
        if (ud.__t === 'EnumItem') return { __t: 'EnumItem', enum: ud.enum, name: ud.name };
        if (ud.__t === 'Ray') return { __t: 'Ray', origin: ud.origin, direction: ud.direction };
        return null;
      }
      case lua.LUA_TTABLE: {
        if (depth > 6) return null;
        const abs = i < 0 ? this.top(st) + i + 1 : i;
        const out = {};
        lua.lua_pushnil(st);
        while (lua.lua_next(st, abs) !== 0) {
          const key = this.readValue(st, -2, depth + 1);
          const val = this.readValue(st, -1, depth + 1);
          if (typeof key === 'string' || typeof key === 'number') out[key] = val;
          lua.lua_pop(st, 1);
        }
        return out;
      }
      default:
        return null;
    }
  }

  /* ------------------------------------------------------------------ */
  /* value conversion JS -> Lua                                         */
  /* ------------------------------------------------------------------ */

  pushValue(st, value) {
    const lua = this.f.lua;
    if (value === undefined || value === null) {
      lua.lua_pushnil(st);
      return 1;
    }
    if (value instanceof Instance) return this.pushInstance(st, value);
    const t = typeof value;
    if (t === 'number') { this.pushNum(st, value); return 1; }
    if (t === 'boolean') { this.pushBool(st, value); return 1; }
    if (t === 'string') { this.pushStr(st, value); return 1; }
    const tag = value.__t;
    if (tag === 'Vector3') return this.pushVector3(st, value.x, value.y, value.z);
    if (tag === 'CFrame') return this.pushCFrame(st, value);
    if (tag === 'Color3') return this.pushColor3(st, value);
    if (tag === 'UDim') return this.pushUDim(st, value.scale, value.offset);
    if (tag === 'UDim2') return this.pushUDim2(st, value.x, value.y, value.w, value.h);
    if (tag === 'EnumItem') return this.pushEnum(st, value.enum, value.name);
    if (tag === 'Ray') return this.pushRay(st, value.origin, value.direction);
    if (typeof value.pushLua === 'function') return value.pushLua(st, this);
    if (Array.isArray(value)) {
      lua.lua_createtable(st, value.length, 0);
      value.forEach((v, i) => {
        this.pushValue(st, v);
        lua.lua_rawseti(st, -2, i + 1);
      });
      return 1;
    }
    lua.lua_createtable(st, 0, 0);
    for (const [k, v] of Object.entries(value)) {
      if (k === '__t') continue;
      this.pushValue(st, v);
      lua.lua_setfield(st, -2, this.f.to_luastring(k));
    }
    return 1;
  }

  /* ================================================================== */
  /* install                                                            */
  /* ================================================================== */

  install() {
    this.installValueMetas();
    this.installInstanceMeta();
    this.installSignalMeta();
    this.installConnectionMeta();
    this.installGlobals();
  }

  /* --------------------------- value metatables ---------------------- */

  installValueMetas() {
    const { lua, lauxlib, to_luastring } = this.f;
    const st = this.L;

    /* ---- Vector3 ---- */
    lauxlib.luaL_newmetatable(st, to_luastring('RBXVector3'));
    let mt = this.top(st);
    lua.lua_pushjsfunction(st, (L) => {
      const ud = lua.lua_touserdata(L, 1);
      const key = this.str(L, 2);
      switch (key) {
        case 'X': lua.lua_pushnumber(L, ud.x); return 1;
        case 'Y': lua.lua_pushnumber(L, ud.y); return 1;
        case 'Z': lua.lua_pushnumber(L, ud.z); return 1;
        case 'Magnitude': lua.lua_pushnumber(L, Math.hypot(ud.x, ud.y, ud.z)); return 1;
        case 'Unit': {
          const l = Math.hypot(ud.x, ud.y, ud.z) || 1;
          this.pushVector3(L, ud.x / l, ud.y / l, ud.z / l);
          return 1;
        }
        case 'Dot': case 'Cross': case 'Lerp': case 'FuzzyEq': case 'Abs':
        case 'Ceil': case 'Floor': case 'Sign': case 'Min': case 'Max':
          lua.lua_pushvalue(L, 1);
          lua.lua_pushjsclosure(L, (L2) => this.vector3Method(L2, key), 1);
          return 1;
        default:
          lua.lua_pushnil(L);
          return 1;
      }
    });
    lua.lua_setfield(st, mt, to_luastring('__index'));
    lua.lua_pushjsfunction(st, (L) => {
      const a = lua.lua_touserdata(L, 1);
      const b = this.isUserdata(L, 2) ? lua.lua_touserdata(L, 2) : null;
      if (!b) return this.fail(L, 'Vector3 arithmetic expects another Vector3');
      this.pushVector3(L, a.x + b.x, a.y + b.y, a.z + b.z);
      return 1;
    });
    lua.lua_setfield(st, mt, to_luastring('__add'));
    lua.lua_pushjsfunction(st, (L) => {
      const a = lua.lua_touserdata(L, 1);
      const b = this.isUserdata(L, 2) ? lua.lua_touserdata(L, 2) : null;
      if (!b) return this.fail(L, 'Vector3 arithmetic expects another Vector3');
      this.pushVector3(L, a.x - b.x, a.y - b.y, a.z - b.z);
      return 1;
    });
    lua.lua_setfield(st, mt, to_luastring('__sub'));
    lua.lua_pushjsfunction(st, (L) => {
      const a = lua.lua_touserdata(L, 1);
      if (this.isNumber(L, 2)) {
        const s = this.num(L, 2);
        this.pushVector3(L, a.x * s, a.y * s, a.z * s);
        return 1;
      }
      const b = lua.lua_touserdata(L, 2);
      if (b && b.__t === 'Vector3') {
        this.pushVector3(L, a.x * b.x, a.y * b.y, a.z * b.z);
        return 1;
      }
      return this.fail(L, 'Vector3 multiplication expects a number or Vector3');
    });
    lua.lua_setfield(st, mt, to_luastring('__mul'));
    lua.lua_pushjsfunction(st, (L) => {
      const a = lua.lua_touserdata(L, 1);
      const s = this.num(L, 2, 1);
      this.pushVector3(L, a.x / s, a.y / s, a.z / s);
      return 1;
    });
    lua.lua_setfield(st, mt, to_luastring('__div'));
    lua.lua_pushjsfunction(st, (L) => {
      const a = lua.lua_touserdata(L, 1);
      this.pushVector3(L, -a.x, -a.y, -a.z);
      return 1;
    });
    lua.lua_setfield(st, mt, to_luastring('__unm'));
    lua.lua_pushjsfunction(st, (L) => {
      const a = lua.lua_touserdata(L, 1);
      const b = lua.lua_touserdata(L, 2);
      this.pushBool(L, b && a.x === b.x && a.y === b.y && a.z === b.z);
      return 1;
    });
    lua.lua_setfield(st, mt, to_luastring('__eq'));
    lua.lua_pushjsfunction(st, (L) => {
      const a = lua.lua_touserdata(L, 1);
      this.pushStr(L, `${fmt(a.x)}, ${fmt(a.y)}, ${fmt(a.z)}`);
      return 1;
    });
    lua.lua_setfield(st, mt, to_luastring('__tostring'));
    lua.lua_pushjsfunction(st, (L) => {
      const a = lua.lua_touserdata(L, 1);
      lua.lua_pushnumber(L, Math.hypot(a.x, a.y, a.z));
      return 1;
    });
    lua.lua_setfield(st, mt, to_luastring('__len'));
    lua.lua_pushliteral(st, 'Vector3');
    lua.lua_setfield(st, mt, to_luastring('__typeof'));
    lua.lua_pop(st, 1);

    /* ---- CFrame ---- */
    lauxlib.luaL_newmetatable(st, to_luastring('RBXCFrame'));
    mt = this.top(st);
    lua.lua_pushjsfunction(st, (L) => {
      const ud = lua.lua_touserdata(L, 1);
      const cf = ud.cf;
      const key = this.str(L, 2);
      switch (key) {
        case 'X': lua.lua_pushnumber(L, cf.p[0]); return 1;
        case 'Y': lua.lua_pushnumber(L, cf.p[1]); return 1;
        case 'Z': lua.lua_pushnumber(L, cf.p[2]); return 1;
        case 'Position': case 'p': this.pushVector3(L, cf.p[0], cf.p[1], cf.p[2]); return 1;
        case 'LookVector': { const v = T.cfLookVector(cf); this.pushVector3(L, v.x, v.y, v.z); return 1; }
        case 'RightVector': { const v = T.cfRightVector(cf); this.pushVector3(L, v.x, v.y, v.z); return 1; }
        case 'UpVector': { const v = T.cfUpVector(cf); this.pushVector3(L, v.x, v.y, v.z); return 1; }
        case 'Rotation': {
          const e = T.toEulerDegrees(cf);
          this.pushVector3(L, e.x, e.y, e.z);
          return 1;
        }
        case 'Inverse': case 'Lerp': case 'ToWorldSpace': case 'ToObjectSpace':
        case 'PointToWorldSpace': case 'PointToObjectSpace':
        case 'VectorToWorldSpace': case 'VectorToObjectSpace':
        case 'ToEulerAnglesXYZ': case 'ToEulerAnglesYXZ': case 'ToOrientation':
          lua.lua_pushvalue(L, 1);
          lua.lua_pushjsclosure(L, (L2) => this.cframeMethod(L2, key), 1);
          return 1;
        default:
          lua.lua_pushnil(L);
          return 1;
      }
    });
    lua.lua_setfield(st, mt, to_luastring('__index'));
    lua.lua_pushjsfunction(st, (L) => {
      const a = lua.lua_touserdata(L, 1);
      // CFrame * CFrame, or CFrame * Vector3
      const t2 = this.ltype(L, 2);
      if (t2 === lua.LUA_TUSERDATA) {
        const b = lua.lua_touserdata(L, 2);
        if (b.cf) {
          this.pushCFrame(L, T.cfMul(a.cf, b.cf));
          return 1;
        }
        if (b.__t === 'Vector3') {
          const p = T.cfPointToWorld(a.cf, b);
          this.pushVector3(L, p.x, p.y, p.z);
          return 1;
        }
      }
      return this.fail(L, 'CFrame multiplication expects CFrame or Vector3');
    });
    lua.lua_setfield(st, mt, to_luastring('__mul'));
    lua.lua_pushjsfunction(st, (L) => {
      const a = lua.lua_touserdata(L, 1);
      const b = lua.lua_touserdata(L, 2);
      const same = b && a.cf.p.every((v, i) => v === b.cf.p[i]);
      this.pushBool(L, same);
      return 1;
    });
    lua.lua_setfield(st, mt, to_luastring('__eq'));
    lua.lua_pushjsfunction(st, (L) => {
      const a = lua.lua_touserdata(L, 1);
      this.pushStr(L, `${fmt(a.cf.p[0])}, ${fmt(a.cf.p[1])}, ${fmt(a.cf.p[2])}`);
      return 1;
    });
    lua.lua_setfield(st, mt, to_luastring('__tostring'));
    lua.lua_pushliteral(st, 'CFrame');
    lua.lua_setfield(st, mt, to_luastring('__typeof'));
    lua.lua_pop(st, 1);

    /* ---- Color3 ---- */
    lauxlib.luaL_newmetatable(st, to_luastring('RBXColor3'));
    mt = this.top(st);
    lua.lua_pushjsfunction(st, (L) => {
      const ud = lua.lua_touserdata(L, 1);
      const key = this.str(L, 2);
      if (key === 'R') { lua.lua_pushnumber(L, ud.r); return 1; }
      if (key === 'G') { lua.lua_pushnumber(L, ud.g); return 1; }
      if (key === 'B') { lua.lua_pushnumber(L, ud.b); return 1; }
      if (key === 'ToHSV') {
        lua.lua_pushjsclosure(L, (L2) => {
          const c = lua.lua_touserdata(L2, 1);
          const hsv = T.toHSV({ r: c.r, g: c.g, b: c.b });
          lua.lua_pushnumber(L2, hsv.h);
          lua.lua_pushnumber(L2, hsv.s);
          lua.lua_pushnumber(L2, hsv.v);
          return 3;
        }, 0);
        return 1;
      }
      if (key === 'Lerp') {
        lua.lua_pushjsclosure(L, (L2) => {
          const a = lua.lua_touserdata(L2, 1);
          const b = lua.lua_touserdata(L2, 2);
          const t = this.num(L2, 3);
          const c = T.colorLerp({ r: a.r, g: a.g, b: a.b }, { r: b.r, g: b.g, b: b.b }, t);
          this.pushColor3(L2, c);
          return 1;
        }, 0);
        return 1;
      }
      lua.lua_pushnil(L);
      return 1;
    });
    lua.lua_setfield(st, mt, to_luastring('__index'));
    lua.lua_pushjsfunction(st, (L) => {
      const a = lua.lua_touserdata(L, 1);
      const b = lua.lua_touserdata(L, 2);
      this.pushBool(L, b && a.r === b.r && a.g === b.g && a.b === b.b);
      return 1;
    });
    lua.lua_setfield(st, mt, to_luastring('__eq'));
    lua.lua_pushjsfunction(st, (L) => {
      const a = lua.lua_touserdata(L, 1);
      this.pushStr(L, `${fmt(a.r)}, ${fmt(a.g)}, ${fmt(a.b)}`);
      return 1;
    });
    lua.lua_setfield(st, mt, to_luastring('__tostring'));
    lua.lua_pushliteral(st, 'Color3');
    lua.lua_setfield(st, mt, to_luastring('__typeof'));
    lua.lua_pop(st, 1);

    /* ---- UDim ---- */
    lauxlib.luaL_newmetatable(st, to_luastring('RBXUDim'));
    mt = this.top(st);
    lua.lua_pushjsfunction(st, (L) => {
      const ud = lua.lua_touserdata(L, 1);
      const key = this.str(L, 2);
      if (key === 'Scale') lua.lua_pushnumber(L, ud.scale);
      else if (key === 'Offset') lua.lua_pushnumber(L, ud.offset);
      else lua.lua_pushnil(L);
      return 1;
    });
    lua.lua_setfield(st, mt, to_luastring('__index'));
    lua.lua_pushliteral(st, 'UDim');
    lua.lua_setfield(st, mt, to_luastring('__typeof'));
    lua.lua_pop(st, 1);

    /* ---- UDim2 ---- */
    lauxlib.luaL_newmetatable(st, to_luastring('RBXUDim2'));
    mt = this.top(st);
    lua.lua_pushjsfunction(st, (L) => {
      const ud = lua.lua_touserdata(L, 1);
      const key = this.str(L, 2);
      if (key === 'X') { this.pushUDim(L, ud.x, ud.w); return 1; }
      if (key === 'Y') { this.pushUDim(L, ud.y, ud.h); return 1; }
      if (key === 'Width') { this.pushUDim(L, ud.y, ud.h); return 1; }
      if (key === 'Height') { this.pushUDim(L, ud.y, ud.h); return 1; }
      lua.lua_pushnil(L);
      return 1;
    });
    lua.lua_setfield(st, mt, to_luastring('__index'));
    lua.lua_pushjsfunction(st, (L) => {
      const a = lua.lua_touserdata(L, 1);
      this.pushStr(L, `{${fmt(a.x)}, ${fmt(a.y)}}, {${fmt(a.w)}, ${fmt(a.h)}}`);
      return 1;
    });
    lua.lua_setfield(st, mt, to_luastring('__tostring'));
    lua.lua_pushliteral(st, 'UDim2');
    lua.lua_setfield(st, mt, to_luastring('__typeof'));
    lua.lua_pop(st, 1);

    /* ---- EnumItem ---- */
    lauxlib.luaL_newmetatable(st, to_luastring('RBXEnumItem'));
    mt = this.top(st);
    lua.lua_pushjsfunction(st, (L) => {
      const ud = lua.lua_touserdata(L, 1);
      const key = this.str(L, 2);
      if (key === 'Name') { this.pushStr(L, ud.name); return 1; }
      if (key === 'Value') { lua.lua_pushinteger(L, ENUM_IDS[`${ud.enum}.${ud.name}`] ?? 0); return 1; }
      if (key === 'EnumType') {
        this.pushStrToEnumTable(L, ud.enum);
        return 1;
      }
      lua.lua_pushnil(L);
      return 1;
    });
    lua.lua_setfield(st, mt, to_luastring('__index'));
    lua.lua_pushjsfunction(st, (L) => {
      const ud = lua.lua_touserdata(L, 1);
      this.pushStr(L, `Enum.${ud.enum}.${ud.name}`);
      return 1;
    });
    lua.lua_setfield(st, mt, to_luastring('__tostring'));
    lua.lua_pushjsfunction(st, (L) => {
      const a = lua.lua_touserdata(L, 1);
      const b = this.isUserdata(L, 2) ? lua.lua_touserdata(L, 2) : null;
      this.pushBool(L, b && a.enum === b.enum && a.name === b.name);
      return 1;
    });
    lua.lua_setfield(st, mt, to_luastring('__eq'));
    lua.lua_pushliteral(st, 'EnumItem');
    lua.lua_setfield(st, mt, to_luastring('__typeof'));
    lua.lua_pop(st, 1);

    /* ---- Ray ---- */
    lauxlib.luaL_newmetatable(st, to_luastring('RBXRay'));
    mt = this.top(st);
    lua.lua_pushjsfunction(st, (L) => {
      const ud = lua.lua_touserdata(L, 1);
      const key = this.str(L, 2);
      if (key === 'Origin') { this.pushVector3(L, ud.origin.x, ud.origin.y, ud.origin.z); return 1; }
      if (key === 'Direction') { this.pushVector3(L, ud.direction.x, ud.direction.y, ud.direction.z); return 1; }
      if (key === 'Unit') {
        const d = T.vnorm(ud.direction);
        this.pushVector3(L, d.x, d.y, d.z);
        return 1;
      }
      lua.lua_pushnil(L);
      return 1;
    });
    lua.lua_setfield(st, mt, to_luastring('__index'));
    lua.lua_pushliteral(st, 'Ray');
    lua.lua_setfield(st, mt, to_luastring('__typeof'));
    lua.lua_pop(st, 1);
  }

  pushStrToEnumTable(L, enumName) {
    const lua = this.f.lua;
    lua.lua_getglobal(L, this.f.to_luastring('Enum'));
    if (lua.lua_type(L, -1) === lua.LUA_TTABLE) {
      lua.lua_getfield(L, -1, this.f.to_luastring(enumName));
      lua.lua_remove(L, -2);
      return 1;
    }
    lua.lua_pop(L, 1);
    lua.lua_pushnil(L);
    return 1;
  }

  vector3Method(L, name) {
    const lua = this.f.lua;
    const a = lua.lua_touserdata(L, lua.lua_upvalueindex(1));
    const b = this.isUserdata(L, 2) ? lua.lua_touserdata(L, 2) : null;
    switch (name) {
      case 'Dot':
        if (!b || b.__t !== 'Vector3') return this.fail(L, 'Dot expects a Vector3');
        lua.lua_pushnumber(L, a.x * b.x + a.y * b.y + a.z * b.z);
        return 1;
      case 'Cross':
        if (!b || b.__t !== 'Vector3') return this.fail(L, 'Cross expects a Vector3');
        this.pushVector3(L, a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
        return 1;
      case 'Lerp': {
        if (!b || b.__t !== 'Vector3') return this.fail(L, 'Lerp expects a Vector3');
        const t = this.num(L, 3);
        this.pushVector3(L, a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);
        return 1;
      }
      case 'FuzzyEq': {
        if (!b) return this.fail(L, 'FuzzyEq expects a Vector3');
        const eps = 1e-5;
        this.pushBool(L, Math.abs(a.x - b.x) < eps && Math.abs(a.y - b.y) < eps && Math.abs(a.z - b.z) < eps);
        return 1;
      }
      case 'Abs': this.pushVector3(L, Math.abs(a.x), Math.abs(a.y), Math.abs(a.z)); return 1;
      case 'Ceil': this.pushVector3(L, Math.ceil(a.x), Math.ceil(a.y), Math.ceil(a.z)); return 1;
      case 'Floor': this.pushVector3(L, Math.floor(a.x), Math.floor(a.y), Math.floor(a.z)); return 1;
      case 'Sign': this.pushVector3(L, Math.sign(a.x), Math.sign(a.y), Math.sign(a.z)); return 1;
      case 'Min':
        if (!b) return this.fail(L, 'Min expects a Vector3');
        this.pushVector3(L, Math.min(a.x, b.x), Math.min(a.y, b.y), Math.min(a.z, b.z));
        return 1;
      case 'Max':
        if (!b) return this.fail(L, 'Max expects a Vector3');
        this.pushVector3(L, Math.max(a.x, b.x), Math.max(a.y, b.y), Math.max(a.z, b.z));
        return 1;
      default:
        lua.lua_pushnil(L);
        return 1;
    }
  }

  cframeMethod(L, name) {
    const lua = this.f.lua;
    const a = lua.lua_touserdata(L, lua.lua_upvalueindex(1)).cf;
    switch (name) {
      case 'Inverse': this.pushCFrame(L, T.cfInverse(a)); return 1;
      case 'Lerp': {
        const b = this.cfAt(L, 2);
        if (!b) return this.fail(L, 'Lerp expects a CFrame');
        this.pushCFrame(L, T.cfLerp(a, b, this.num(L, 3)));
        return 1;
      }
      case 'ToWorldSpace': {
        const b = this.cfAt(L, 2);
        if (!b) return this.fail(L, 'ToWorldSpace expects a CFrame');
        this.pushCFrame(L, T.cfMul(a, b));
        return 1;
      }
      case 'ToObjectSpace': {
        const b = this.cfAt(L, 2);
        if (!b) return this.fail(L, 'ToObjectSpace expects a CFrame');
        this.pushCFrame(L, T.cfMul(T.cfInverse(a), b));
        return 1;
      }
      case 'PointToWorldSpace': {
        const v = this.vecAt(L, 2);
        const w = T.cfPointToWorld(a, v);
        this.pushVector3(L, w.x, w.y, w.z);
        return 1;
      }
      case 'PointToObjectSpace': {
        const v = this.vecAt(L, 2);
        const w = T.cfPointToObject(a, v);
        this.pushVector3(L, w.x, w.y, w.z);
        return 1;
      }
      case 'VectorToWorldSpace': {
        const v = this.vecAt(L, 2);
        const w = T.cfVectorToWorld(a, v);
        this.pushVector3(L, w.x, w.y, w.z);
        return 1;
      }
      case 'VectorToObjectSpace': {
        const v = this.vecAt(L, 2);
        const w = T.cfVectorToObject(a, v);
        this.pushVector3(L, w.x, w.y, w.z);
        return 1;
      }
      case 'ToEulerAnglesXYZ': {
        const [x, y, z] = T.toEulerXYZ(a.r);
        lua.lua_pushnumber(L, x);
        lua.lua_pushnumber(L, y);
        lua.lua_pushnumber(L, z);
        return 3;
      }
      case 'ToEulerAnglesYXZ': {
        const [x, y, z] = T.toEulerXYZ(a.r);
        lua.lua_pushnumber(L, y);
        lua.lua_pushnumber(L, x);
        lua.lua_pushnumber(L, z);
        return 3;
      }
      case 'ToOrientation': {
        const e = T.toEulerDegrees(a);
        lua.lua_pushnumber(L, e.x);
        lua.lua_pushnumber(L, e.y);
        lua.lua_pushnumber(L, e.z);
        return 3;
      }
      default:
        lua.lua_pushnil(L);
        return 1;
    }
  }

  /* --------------------------- instance metatable -------------------- */

  installInstanceMeta() {
    const { lua, lauxlib, to_luastring } = this.f;
    const st = this.L;
    lauxlib.luaL_newmetatable(st, to_luastring('RBXInstance'));
    const mt = this.top(st);

    lua.lua_pushjsfunction(st, (L) => this.instanceIndex(L));
    lua.lua_setfield(st, mt, to_luastring('__index'));

    lua.lua_pushjsfunction(st, (L) => {
      const inst = this.instanceAt(L, 1);
      if (!inst) return this.fail(L, 'attempt to index a non-instance value');
      const key = this.str(L, 2);
      try {
        this.writeProperty(L, inst, key);
      } catch (err) {
        return this.fail(L, `${inst.className}.${key}: ${err.message}`);
      }
      return 0;
    });
    lua.lua_setfield(st, mt, to_luastring('__newindex'));

    lua.lua_pushjsfunction(st, (L) => {
      const inst = this.instanceAt(L, 1);
      this.pushStr(L, inst ? inst.fullName : 'nil');
      return 1;
    });
    lua.lua_setfield(st, mt, to_luastring('__tostring'));

    lua.lua_pushjsfunction(st, (L) => {
      const a = this.instanceAt(L, 1);
      const b = this.instanceAt(L, 2);
      this.pushBool(L, !!a && a === b);
      return 1;
    });
    lua.lua_setfield(st, mt, to_luastring('__eq'));

    lua.lua_pushliteral(st, 'Instance');
    lua.lua_setfield(st, mt, to_luastring('__typeof'));

    // pairs(instance) iterates children (handy and true to intent)
    lua.lua_pushjsfunction(st, (L) => {
      const inst = this.instanceAt(L, 1);
      if (!inst) {
        lua.lua_pushnil(L);
        return 1;
      }
      const cur = this.num(L, 2, 0);
      const next = cur + 1;
      if (next <= inst.children.length) {
        lua.lua_pushinteger(L, next);
        this.pushInstance(L, inst.children[next - 1]);
        return 2;
      }
      lua.lua_pushnil(L);
      return 1;
    });
    lua.lua_setfield(st, mt, to_luastring('__pairs'));

    lua.lua_pop(st, 1);
  }

  /** Instance property/method lookup. */
  instanceIndex(L) {
    try {
      return this._instanceIndex(L);
    } catch (err) {
      return this.fail(L, `internal error reading instance property: ${err.message}`);
    }
  }

  _instanceIndex(L) {
    const lua = this.f.lua;
    const inst = this.instanceAt(L, 1);
    if (!inst) {
      lua.lua_pushnil(L);
      return 1;
    }
    const key = this.str(L, 2);

    // 1. methods (curried with the receiver)
    if (INSTANCE_METHOD_NAMES.has(key)) {
      lua.lua_pushvalue(L, 1);
      lua.lua_pushjsclosure(L, (L2) => {
        const ud = lua.lua_touserdata(L2, lua.lua_upvalueindex(1));
        const target = ud && ud.__inst ? ud.__inst : inst;
        return this.callInstanceMethod(L2, target, key);
      }, 1);
      return 1;
    }

    // 2. special per-class virtual properties (e.g. PlayerGui, Character)
    const special = this.getSpecial(inst, key);
    if (special !== undefined) {
      if (special instanceof Instance) return this.pushInstance(L, special);
      return this.pushValue(L, special);
    }

    // 3. signals exposed as properties (e.g. Players.PlayerAdded)
    const sig = this.instanceSignal(inst, key);
    if (sig) return this.pushSignal(L, sig);

    // 4. children (Roblox allows workspace.PartName)
    const child = inst.findFirstChild(key);
    if (child) return this.pushInstance(L, child);

    // 5. plain properties with class defaults
    if (key === 'ClassName') { this.pushStr(L, inst.className); return 1; }
    if (key === 'Name') { this.pushStr(L, inst.name); return 1; }
    if (key === 'Parent') return this.pushInstance(L, inst.parent);
    if (Object.prototype.hasOwnProperty.call(inst.props, key)) {
      return this.pushValue(L, inst.props[key]);
    }
    const defaults = CLASS_DEFAULTS[inst.className];
    if (defaults && Object.prototype.hasOwnProperty.call(defaults, key)) {
      return this.pushValue(L, defaults[key]);
    }
    lua.lua_pushnil(L);
    return 1;
  }

  /** Handles naming/precedence for known virtual properties. */
  getSpecial(inst, key) {
    // Players.LocalPlayer exists on the client only — nil on the server, which
    // is why server scripts must use PlayerAdded instead.
    if (inst.className === 'Players' && key === 'LocalPlayer') {
      return this.player ?? null;
    }
    if (inst.className === 'Players' && key === 'NumPlayers') {
      return inst.children.filter((c) => c.className === 'Player').length;
    }
    if (inst.className === 'Players' && key === 'MaxPlayers') {
      return inst.props.MaxPlayers ?? 12;
    }
    if (inst.className === 'Player') {
      if (key === 'Character') return inst._meta.character ?? null;
      if (key === 'PlayerGui') return inst._meta.playerGui ?? null;
      if (key === 'Backpack') return inst._meta.backpack ?? null;
    }
    if (inst.className === 'Workspace') {
      if (key === 'CurrentCamera') return inst._meta.camera ?? null;
      if (key === 'Gravity') return inst.props.Gravity ?? 196.2;
    }
    if (inst.className === 'BasePart' || inst.className === 'Part') {
      if (key === 'Position') {
        const cf = inst.props.CFrame;
        if (cf) {
          const p = T.posOf(cf);
          return { __t: 'Vector3', x: p.x, y: p.y, z: p.z };
        }
        const p = inst.props.Position ?? { x: 0, y: 0, z: 0 };
        return { __t: 'Vector3', x: p.x, y: p.y, z: p.z };
      }
      if (key === 'Orientation' || key === 'Rotation') {
        const cf = inst.props.CFrame;
        if (cf) return { __t: 'Vector3', ...T.toEulerDegrees(cf) };
        return inst.props.Orientation ?? { __t: 'Vector3', x: 0, y: 0, z: 0 };
      }
      if (key === 'CFrame') {
        if (inst.props.CFrame) return inst.props.CFrame;
        const p = inst.props.Position ?? { x: 0, y: 0, z: 0 };
        const o = inst.props.Orientation ?? { x: 0, y: 0, z: 0 };
        return {
          __t: 'CFrame',
          p: [p.x, p.y, p.z],
          r: T.fromEulerDegrees(o.x, o.y, o.z).r,
        };
      }
    }
    return undefined;
  }

  writeProperty(L, inst, key) {
    const lua = this.f.lua;
    if (key === 'Parent') {
      const parent = this.instanceAt(L, 3);
      try {
        if (parent) parent.addChild(inst);
        else if (inst.parent) inst.parent.removeChild(inst);
      } catch (err) {
        throw new Error(err.message);
      }
      this.onReplicated(inst, 'Parent');
      return;
    }
    if (key === 'Name') {
      const v = this.str(L, 3, inst.name);
      inst.name = v;
      inst.props.Name = v;
      this.onReplicated(inst, 'Name');
      return;
    }
    // geometry conveniences: setting Position/Orientation/CFrame keeps all in sync
    if (inst.isA('BasePart')) {
      if (key === 'Position') {
        const v = this.vecAt(L, 3);
        const o = inst.props.CFrame ? T.toEulerDegrees(inst.props.CFrame) : (inst.props.Orientation ?? { x: 0, y: 0, z: 0 });
        inst.props.Position = { __t: 'Vector3', x: v.x, y: v.y, z: v.z };
        inst.props.Orientation = { __t: 'Vector3', x: o.x, y: o.y, z: o.z };
        inst.props.CFrame = { __t: 'CFrame', p: [v.x, v.y, v.z], r: T.fromEulerDegrees(o.x, o.y, o.z).r };
        this.onReplicated(inst, 'Position');
        this.changedProp(inst, 'Position');
        this.changedProp(inst, 'CFrame');
        return;
      }
      if (key === 'Orientation' || key === 'Rotation') {
        const v = this.vecAt(L, 3);
        const cf = inst.props.CFrame ?? T.cframeFromPosition(inst.props.Position ?? { x: 0, y: 0, z: 0 });
        inst.props.Orientation = { __t: 'Vector3', x: v.x, y: v.y, z: v.z };
        inst.props.CFrame = { __t: 'CFrame', p: [...cf.p], r: T.fromEulerDegrees(v.x, v.y, v.z).r };
        this.onReplicated(inst, 'Orientation');
        this.changedProp(inst, 'Orientation');
        this.changedProp(inst, 'CFrame');
        return;
      }
      if (key === 'CFrame') {
        const cf = this.cfAt(L, 3);
        if (!cf) throw new Error('CFrame expects a CFrame');
        inst.props.CFrame = cf;
        inst.props.Position = T.posOf(cf);
        inst.props.Orientation = T.toEulerDegrees(cf);
        this.onReplicated(inst, 'CFrame');
        this.changedProp(inst, 'CFrame');
        this.changedProp(inst, 'Position');
        this.changedProp(inst, 'Orientation');
        return;
      }
    }
    if (key === 'Size' || key === 'Color' || key === 'Transparency') {
      const value = this.readValue(L, 3);
      inst.props[key] = value;
      this.onReplicated(inst, key);
      this.changedProp(inst, key);
      return;
    }
    const value = this.readValue(L, 3);
    const old = inst.props[key];
    inst.props[key] = value;
    this.onReplicated(inst, key);
    this.changedProp(inst, key, old, value);
    void lua;
  }

  /** Fire `:GetPropertyChangedSignal(prop)` listeners after a write. */
  changedProp(inst, key, oldValue, newValue) {
    const cacheKey = `${inst.id}:prop:${key}`;
    const sig = this.signalCache.get(cacheKey);
    if (!sig || sig.listeners.length === 0) return;
    this.fire(sig, []);
    void oldValue; void newValue;
  }

  /** RemoteEvent / BindableEvent dispatch, routed through the host. */
  fireRemote(L, self, target) {
    if (!this.host.remote) return this.fail(L, 'remote events are not available in this realm');
    const args = [];
    const n = this.top(L);
    for (let i = 2; i <= n; i++) args.push(this.readValue(L, i));
    try {
      this.host.remote.fire({ instance: self, target, args, realm: this.realm, player: this.player });
    } catch (err) {
      return this.fail(L, err.message);
    }
    return 0;
  }

  /* --------------------------- instance methods ---------------------- */

  callInstanceMethod(L, inst, name) {
    const fn = INSTANCE_METHODS[name];
    if (!fn) return this.fail(L, `unknown method ${name}`);
    try {
      return fn.call(this, L, inst);
    } catch (err) {
      // A Lua error raised by this.fail() inside the method is a longjmp: it
      // must be rethrown untouched, or the original message is lost.
      if (isLongjmp(err)) throw err;
      return this.fail(L, `${name}: ${err.message}`);
    }
  }

  /* ----------------------------- signals ----------------------------- */

  installSignalMeta() {
    const { lua, lauxlib, to_luastring } = this.f;
    const st = this.L;
    lauxlib.luaL_newmetatable(st, to_luastring('RBXSignal'));
    const mt = this.top(st);
    lua.lua_pushjsfunction(st, (L) => {
      const ud = lua.lua_touserdata(L, 1);
      const sig = ud.__signal;
      const key = this.str(L, 2);
      // Return a *bound* method: the signal is captured as an upvalue so the
      // Lua call `sig:Connect(fn)` arrives as (bound_self, fn) where self is
      // the receiver we pushed. Using an upvalue avoids argument-shifting bugs.
      if (key === 'Connect' || key === 'connect' || key === 'Once' || key === 'once') {
        const once = key === 'Once' || key === 'once';
        lua.lua_pushvalue(L, 1); // upvalue = signal userdata
        lua.lua_pushjsclosure(L, (L2) => {
          const selfUd = lua.lua_touserdata(L2, lua.lua_upvalueindex(1));
          return this.signalConnectMethod(L2, selfUd.__signal, once);
        }, 1);
        return 1;
      }
      if (key === 'Wait' || key === 'wait') {
        lua.lua_pushvalue(L, 1);
        lua.lua_pushjsclosure(L, (L2) => {
          const selfUd = lua.lua_touserdata(L2, lua.lua_upvalueindex(1));
          return this.signalWaitMethod(L2, selfUd.__signal);
        }, 1);
        return 1;
      }
      lua.lua_pushnil(L);
      return 1;
    });
    lua.lua_setfield(st, mt, to_luastring('__index'));
    lua.lua_pushjsfunction(st, (L) => {
      const ud = lua.lua_touserdata(L, 1);
      this.pushStr(L, `Signal(${ud.__signal?.name ?? '?'})`);
      return 1;
    });
    lua.lua_setfield(st, mt, to_luastring('__tostring'));
    lua.lua_pushliteral(st, 'RBXScriptSignal');
    lua.lua_setfield(st, mt, to_luastring('__typeof'));
    lua.lua_pop(st, 1);
  }

  installConnectionMeta() {
    const { lua, lauxlib, to_luastring } = this.f;
    const st = this.L;
    lauxlib.luaL_newmetatable(st, to_luastring('RBXConnection'));
    const mt = this.top(st);
    lua.lua_pushjsfunction(st, (L) => {
      const ud = lua.lua_touserdata(L, 1);
      const conn = ud.__conn;
      const key = this.str(L, 2);
      if (key === 'Disconnect' || key === 'disconnect') {
        lua.lua_pushjsfunction(L, () => {
          this.disconnect(conn);
          return 0;
        });
        return 1;
      }
      if (key === 'Connected') {
        this.pushBool(L, conn.connected);
        return 1;
      }
      lua.lua_pushnil(L);
      return 1;
    });
    lua.lua_setfield(st, mt, to_luastring('__index'));
    lua.lua_pushliteral(st, 'RBXScriptConnection');
    lua.lua_setfield(st, mt, to_luastring('__typeof'));
    lua.lua_pop(st, 1);
  }

  pushSignal(st, signal) {
    this._newUserdata(st, 'RBXSignal', (ud) => {
      ud.__signal = signal;
    });
    return 1;
  }

  /** Signals that exist as properties on services/instances. */
  instanceSignal(inst, key) {
    if (SERVICE_SIGNALS[inst.className]?.includes(key)) return this.getSignal(inst, key);
    if (SIGNAL_PROPS[inst.className]?.includes(key)) return this.getSignal(inst, key);
    // BasePart parts: every Part is a BasePart for signal purposes
    if (inst.isA('BasePart') && SIGNAL_PROPS.BasePart.includes(key)) return this.getSignal(inst, key);
    if (inst.isA('GuiButton') && SIGNAL_PROPS.TextButton?.includes(key)) return this.getSignal(inst, key);
    if (SIGNAL_PROPS.Instance.includes(key)) return this.getSignal(inst, key);
    return null;
  }

  getSignal(inst, name) {
    const cacheKey = `${inst.id}:${name}`;
    let sig = this.signalCache.get(cacheKey);
    if (!sig) {
      sig = { name, owner: inst, listeners: [], waiters: [], id: `s${++this._sigSeq}` };
      this.signalCache.set(cacheKey, sig);
    }
    return sig;
  }

  /** `sig:Connect(fn)` — stack is (self, fn) because a colon call passes self. */
  signalConnectMethod(L, signal, once) {
    const lua = this.f.lua;
    // self may be at 1 and fn at 2; tolerate either (some code does sig.Connect(fn))
    let fnIndex = this.isFunction(L, 2) ? 2 : this.isFunction(L, 1) ? 1 : 0;
    if (!fnIndex) return this.fail(L, 'Connect expects a function');
    lua.lua_pushvalue(L, fnIndex);
    const ref = this.f.lauxlib.luaL_ref(L, lua.LUA_REGISTRYINDEX);
    this.signalRefs.push(ref);
    const listener = { ref, once, script: this.scheduler?.currentScript ?? null };
    signal.listeners.push(listener);
    const conn = { signal, listener, connected: true };
    this._newUserdata(L, 'RBXConnection', (ud) => {
      ud.__conn = conn;
    });
    return 1;
  }

  disconnect(conn) {
    if (!conn || !conn.connected) return;
    conn.connected = false;
    const lua = this.f.lua;
    const i = conn.signal.listeners.indexOf(conn.listener);
    if (i !== -1) conn.signal.listeners.splice(i, 1);
    try {
      this.f.lauxlib.luaL_unref(this.L, lua.LUA_REGISTRYINDEX, conn.listener.ref);
    } catch (_) { /* ignore */ }
  }

  signalWaitMethod(L, signal) {
    const lua = this.f.lua;
    lua.lua_pushthread(L);
    const thread = lua.lua_tothread(L, -1);
    lua.lua_pop(L, 1);
    signal.waiters.push({ thread, bindings: this });
    // tell the host we parked this thread on a signal
    lua.lua_newtable(L);
    this.pushStr(L, 'signal');
    lua.lua_setfield(L, -2, this.f.to_luastring('kind'));
    lua.lua_setglobal(L, this.f.to_luastring('__yieldRequest'));
    return lua.lua_yield(L, 0);
  }

  /**
   * Register a function to be called every frame (RunService:Heartbeat /
   * :BindToRenderStep). Implemented by the scheduler as a self-rescheduling
   * task so scripts keep their normal yield semantics.
   */
  bindLoopCallback(L, fnIndex, name, kind) {
    const lua = this.f.lua;
    lua.lua_pushvalue(L, fnIndex);
    const fnRef = this.f.lauxlib.luaL_ref(L, lua.LUA_REGISTRYINDEX);
    this.signalRefs.push(fnRef);
    this.host.loops?.add({ ref: fnRef, name, kind, bindings: this });
    void name;
  }

  unbindLoopCallback(name) {
    this.host.loops?.remove(name, this);
  }

  /** Called by the host each frame for every registered loop callback. */
  runLoopCallbacks(kind, dt) {
    const list = this.host.loops?.list(kind) ?? [];
    for (const cb of list) {
      const created = this.vm.createThreadFromRef(cb.ref);
      if (!created.ok) continue;
      const entry = this.scheduler.addEntry(created.thread, {
        label: `${kind} callback`,
        kind: 'event',
      });
      if (entry) entry.entryArgs = [dt];
    }
  }

  /** Public helper: fire a RemoteEvent from this realm (used by the host). */
  fireRemoteCall(inst, target, args) {
    return this.host.remote.fire({ instance: inst, target, args, realm: this.realm, player: this.player });
  }

  /** Fire a signal from JS. Schedules listeners; resumes :Wait()ers. */
  fire(signal, args = []) {
    if (!signal) return;
    const lua = this.f.lua;

    for (const listener of [...signal.listeners]) {
      if (listener.once) {
        // remove from the list, but keep the Lua reference until we have
        // copied the function onto the stack
        const i = signal.listeners.indexOf(listener);
        if (i !== -1) signal.listeners.splice(i, 1);
      }
      lua.lua_rawgeti(this.L, lua.LUA_REGISTRYINDEX, listener.ref);
      const fnIdx = this.top();
      const created = this.vm.createThreadFromStack(this.L, fnIdx);
      this.f.lua.lua_pop(this.L, 1);
      if (!created.ok) {
        this.onLog({ level: 'error', text: created.error, source: signal.name });
        continue;
      }
      const entry = this.scheduler.addEntry(created.thread, {
        label: `${signal.name} callback`,
        kind: 'event',
        script: listener.script,
      });
      if (entry) entry.entryArgs = args;
    }

    const waiters = signal.waiters.splice(0, signal.waiters.length);
    for (const waiter of waiters) {
      const lua2 = this.f.lua;
      // push args for the parked thread, then wake it
      this.scheduler.wakeForSignal(waiter.thread, args);
      void lua2;
    }
  }

  /* ================================================================== */
  /* globals                                                            */
  /* ================================================================== */

  installGlobals() {
    const lua = this.f.lua;
    const st = this.L;

    // core instances
    this.setGlobalValue('game', this.game);
    this.setGlobalValue('Game', this.game);
    this.setGlobalValue('workspace', this.services.Workspace);
    this.setGlobalValue('Workspace', this.services.Workspace);
    this.setGlobalValue('script', this.owner);
    if (this.player) this.setGlobalValue('Player', this.player);
    for (const [name, svc] of Object.entries(this.services)) {
      if (name === 'Workspace') continue;
      this.setGlobalValue(name, svc);
    }
    this.setGlobalValue('shared', this.shared ?? {});

    this.installConstructors();
    this.installTask();
    this.installMathAndString();
    this.installMisc();
    void lua; void st;
  }

  setGlobalValue(name, value) {
    const lua = this.f.lua;
    if (value instanceof Instance) {
      this.pushInstance(this.L, value);
    } else if (value === null) {
      lua.lua_pushnil(this.L);
    } else {
      this.pushValue(this.L, value);
    }
    lua.lua_setglobal(this.L, this.f.to_luastring(name));
  }

  installConstructors() {
    const { lua, to_luastring } = this.f;
    const st = this.L;

    /* Vector3 */
    lua.lua_newtable(st);
    let t = this.top(st);
    lua.lua_pushjsfunction(st, (L) => {
      const n = this.top(L);
      const x = this.num(L, 1);
      const y = n >= 2 ? this.num(L, 2) : x;
      const z = n >= 3 ? this.num(L, 3) : y;
      this.pushVector3(L, x, y, z);
      return 1;
    });
    lua.lua_setfield(st, t, to_luastring('new'));
    this.pushVector3(st, 0, 0, 0);
    lua.lua_setfield(st, t, to_luastring('zero'));
    this.pushVector3(st, 1, 1, 1);
    lua.lua_setfield(st, t, to_luastring('one'));
    lua.lua_setglobal(st, to_luastring('Vector3'));

    /* CFrame */
    lua.lua_newtable(st);
    t = this.top(st);
    lua.lua_pushjsfunction(st, (L) => this.cframeNew(L));
    lua.lua_setfield(st, t, to_luastring('new'));
    lua.lua_pushjsfunction(st, (L) => {
      this.pushCFrame(L, T.anglesXYZ(this.num(L, 1), this.num(L, 2), this.num(L, 3)));
      return 1;
    });
    lua.lua_setfield(st, t, to_luastring('Angles'));
    lua.lua_pushjsfunction(st, (L) => {
      this.pushCFrame(L, T.anglesXYZ(this.num(L, 1), this.num(L, 2), this.num(L, 3)));
      return 1;
    });
    lua.lua_setfield(st, t, to_luastring('fromEulerAnglesXYZ'));
    lua.lua_pushjsfunction(st, (L) => {
      this.pushCFrame(L, T.anglesYXZ(this.num(L, 1), this.num(L, 2), this.num(L, 3)));
      return 1;
    });
    lua.lua_setfield(st, t, to_luastring('fromEulerAnglesYXZ'));
    lua.lua_pushjsfunction(st, (L) => {
      const p = this.vecAt(L, 1);
      const target = this.vecAt(L, 2);
      const up = this.isUserdata(L, 3) ? this.vecAt(L, 3) : null;
      this.pushCFrame(L, T.cframeLookAt(
        [p.x, p.y, p.z],
        [target.x, target.y, target.z],
        up ? [up.x, up.y, up.z] : undefined
      ));
      return 1;
    });
    lua.lua_setfield(st, t, to_luastring('lookAt'));
    this.pushCFrame(st, T.cframe());
    lua.lua_setfield(st, t, to_luastring('identity'));
    lua.lua_setglobal(st, to_luastring('CFrame'));

    /* Color3 */
    lua.lua_newtable(st);
    t = this.top(st);
    lua.lua_pushjsfunction(st, (L) => {
      this.pushColor3(L, { r: this.num(L, 1), g: this.num(L, 2), b: this.num(L, 3) });
      return 1;
    });
    lua.lua_setfield(st, t, to_luastring('new'));
    lua.lua_pushjsfunction(st, (L) => {
      const rgb = this.num(L, 1) | 0;
      this.pushColor3(L, {
        r: ((rgb >> 16) & 255) / 255,
        g: ((rgb >> 8) & 255) / 255,
        b: (rgb & 255) / 255,
      });
      return 1;
    });
    lua.lua_setfield(st, t, to_luastring('fromRGB'));
    lua.lua_pushjsfunction(st, (L) => {
      this.pushColor3(L, T.fromHSV(this.num(L, 1), this.num(L, 2), this.num(L, 3)));
      return 1;
    });
    lua.lua_setfield(st, t, to_luastring('fromHSV'));
    lua.lua_pushjsfunction(st, (L) => {
      const hex = this.str(L, 1).replace('#', '');
      const n = parseInt(hex, 16) || 0;
      this.pushColor3(L, {
        r: ((n >> 16) & 255) / 255,
        g: ((n >> 8) & 255) / 255,
        b: (n & 255) / 255,
      });
      return 1;
    });
    lua.lua_setfield(st, t, to_luastring('fromHex'));
    lua.lua_setglobal(st, to_luastring('Color3'));

    /* UDim / UDim2 */
    lua.lua_newtable(st);
    lua.lua_pushjsfunction(st, (L) => {
      this.pushUDim(L, this.num(L, 1), this.num(L, 2));
      return 1;
    });
    lua.lua_setfield(st, -2, to_luastring('new'));
    lua.lua_setglobal(st, to_luastring('UDim'));

    lua.lua_newtable(st);
    t = this.top(st);
    lua.lua_pushjsfunction(st, (L) => {
      this.pushUDim2(L, this.num(L, 1), this.num(L, 2), this.num(L, 3), this.num(L, 4));
      return 1;
    });
    lua.lua_setfield(st, t, to_luastring('new'));
    lua.lua_pushjsfunction(st, (L) => {
      this.pushUDim2(L, 0, 0, this.num(L, 1), this.num(L, 2));
      return 1;
    });
    lua.lua_setfield(st, t, to_luastring('fromScale'));
    lua.lua_pushjsfunction(st, (L) => {
      this.pushUDim2(L, 0, 0, this.num(L, 1), this.num(L, 2));
      return 1;
    });
    lua.lua_setfield(st, t, to_luastring('fromOffset'));
    lua.lua_setglobal(st, to_luastring('UDim2'));

    /* Ray */
    lua.lua_newtable(st);
    lua.lua_pushjsfunction(st, (L) => {
      const o = this.vecAt(L, 1);
      const d = this.vecAt(L, 2);
      this.pushRay(L, o, d);
      return 1;
    });
    lua.lua_setfield(st, -2, to_luastring('new'));
    lua.lua_setglobal(st, to_luastring('Ray'));

    /* Enum */
    lua.lua_newtable(st);
    const enumTable = this.top(st);
    for (const [enumName, items] of Object.entries(ENUMS)) {
      lua.lua_newtable(st);
      const et = this.top(st);
      for (const itemName of items) {
        this.pushEnum(st, enumName, itemName);
        lua.lua_setfield(st, et, to_luastring(itemName));
      }
      lua.lua_pushjsfunction(st, (L) => {
        lua.lua_createtable(L, items.length, 0);
        items.forEach((n, i) => {
          this.pushEnum(L, enumName, n);
          lua.lua_rawseti(L, -2, i + 1);
        });
        return 1;
      });
      lua.lua_setfield(st, et, to_luastring('GetEnumItems'));
      lua.lua_setfield(st, enumTable, to_luastring(enumName));
    }
    lua.lua_setglobal(st, to_luastring('Enum'));

    /* Random */
    lua.lua_newtable(st);
    t = this.top(st);
    lua.lua_pushjsfunction(st, (L) => {
      lua.lua_newtable(L);
      const obj = this.top(L);
      lua.lua_pushjsclosure(L, (L2) => {
        const lo = this.num(L2, 2, 0);
        const hi = this.num(L2, 3, 1);
        lua.lua_pushnumber(L2, lo + Math.random() * (hi - lo));
        return 1;
      }, 0);
      lua.lua_setfield(L, obj, to_luastring('NextNumber'));
      lua.lua_pushjsclosure(L, (L2) => {
        const lo = Math.ceil(this.num(L2, 2, 1));
        const hi = Math.floor(this.num(L2, 3, 1));
        lua.lua_pushinteger(L2, lo + Math.floor(Math.random() * (hi - lo + 1)));
        return 1;
      }, 0);
      lua.lua_setfield(L, obj, to_luastring('NextInteger'));
      lua.lua_pushjsclosure(L, (L2) => {
        const u = Math.random() * 2 - 1;
        const a = Math.random() * Math.PI * 2;
        const r = Math.sqrt(Math.max(0, 1 - u * u));
        this.pushVector3(L2, r * Math.cos(a), u, r * Math.sin(a));
        return 1;
      }, 0);
      lua.lua_setfield(L, obj, to_luastring('NextUnitVector'));
      return 1;
    });
    lua.lua_setfield(st, t, to_luastring('new'));
    lua.lua_setglobal(st, to_luastring('Random'));

    /* Instance */
    lua.lua_newtable(st);
    t = this.top(st);
    lua.lua_pushjsfunction(st, (L) => this.instanceNew(L));
    lua.lua_setfield(st, t, to_luastring('new'));
    lua.lua_setglobal(st, to_luastring('Instance'));

    /* typeof */
    this.setGlobal('typeof', (L) => {
      const t2 = this.ltype(L, 1);
      if (t2 === lua.LUA_TUSERDATA) {
        const ud = lua.lua_touserdata(L, 1);
        if (ud.__inst) { this.pushStr(L, 'Instance'); return 1; }
        if (ud.__signal) { this.pushStr(L, 'RBXScriptSignal'); return 1; }
        if (ud.__conn) { this.pushStr(L, 'RBXScriptConnection'); return 1; }
        if (ud.__t) { this.pushStr(L, ud.__t); return 1; }
        this.pushStr(L, 'userdata');
        return 1;
      }
      this.pushStr(L, lua.lua_typename(L, t2));
      return 1;
    });

    /* NumberRange */
    lua.lua_newtable(st);
    lua.lua_pushjsfunction(st, (L) => {
      lua.lua_newtable(L);
      lua.lua_pushnumber(L, this.num(L, 1));
      lua.lua_setfield(L, -2, to_luastring('Min'));
      lua.lua_pushnumber(L, this.num(L, 2));
      lua.lua_setfield(L, -2, to_luastring('Max'));
      return 1;
    });
    lua.lua_setfield(st, -2, to_luastring('new'));
    lua.lua_setglobal(st, to_luastring('NumberRange'));

    /* Vector2 */
    lua.lua_newtable(st);
    lua.lua_pushjsfunction(st, (L) => {
      lua.lua_newtable(L);
      lua.lua_pushnumber(L, this.num(L, 1));
      lua.lua_setfield(L, -2, to_luastring('X'));
      lua.lua_pushnumber(L, this.num(L, 2));
      lua.lua_setfield(L, -2, to_luastring('Y'));
      return 1;
    });
    lua.lua_setfield(st, -2, to_luastring('new'));
    lua.lua_setglobal(st, to_luastring('Vector2'));
  }

  cframeNew(L) {
    const lua = this.f.lua;
    const n = this.top(L);
    if (n >= 12) {
      const p = [this.num(L, 1), this.num(L, 2), this.num(L, 3)];
      const r = [];
      for (let i = 4; i <= 12; i++) r.push(this.num(L, i));
      this.pushCFrame(L, { __t: 'CFrame', p, r });
      return 1;
    }
    if (n === 1 && this.isUserdata(L, 1)) {
      const ud = lua.lua_touserdata(L, 1);
      if (ud.__t === 'Vector3') {
        this.pushCFrame(L, T.cframe(ud.x, ud.y, ud.z));
        return 1;
      }
      if (ud.cf) {
        this.pushCFrame(L, ud.cf);
        return 1;
      }
    }
    if (n >= 2 && this.isUserdata(L, 1) && this.isUserdata(L, 2)
        && lua.lua_touserdata(L, 1).__t === 'Vector3'
        && lua.lua_touserdata(L, 2).__t === 'Vector3') {
      const p = this.vecAt(L, 1);
      const target = this.vecAt(L, 2);
      this.pushCFrame(L, T.cframeLookAt([p.x, p.y, p.z], [target.x, target.y, target.z]));
      return 1;
    }
    this.pushCFrame(L, T.cframe(this.num(L, 1), this.num(L, 2), this.num(L, 3)));
    return 1;
  }

  /* -------------------------------- task ------------------------------ */

  installTask() {
    const { lua, to_luastring } = this.f;
    const st = this.L;
    lua.lua_newtable(st);
    const t = this.top(st);

    const fn = (f) => {
      lua.lua_pushjsfunction(st, f);
      lua.lua_setfield(st, t, to_luastring(f.name ?? ''));
    };
    void fn;

    lua.lua_pushjsfunction(st, (L) => this.yieldWait(L, Math.max(0, this.num(L, 1, 0))));
    lua.lua_setfield(st, t, to_luastring('wait'));

    lua.lua_pushjsfunction(st, (L) => {
      if (!this.isFunction(L, 1)) return this.fail(L, 'task.spawn expects a function');
      this.scheduler.spawnFromLua(L, { label: 'task.spawn' });
      return 0;
    });
    lua.lua_setfield(st, t, to_luastring('spawn'));

    lua.lua_pushjsfunction(st, (L) => {
      if (!this.isFunction(L, 1)) return this.fail(L, 'task.defer expects a function');
      this.scheduler.spawnFromLua(L, { label: 'task.defer', delay: 0.001 });
      return 0;
    });
    lua.lua_setfield(st, t, to_luastring('defer'));

    lua.lua_pushjsfunction(st, (L) => {
      // task.delay(seconds, fn, ...args)
      if (!this.isFunction(L, 2)) return this.fail(L, 'task.delay expects (seconds, function)');
      const delay = Math.max(0, this.num(L, 1, 0));
      const n = this.top(L);
      // reorder: put fn first so the scheduler finds it at index 1
      const fnRef = this.f.lauxlib;
      lua.lua_pushvalue(L, 2);
      const tmpFn = lua.lua_gettop(L);
      // build [fn, args...] at the top of the stack, then call spawn with fnIndex
      const built = tmpFn;
      lua.lua_pushvalue(L, built);
      lua.lua_remove(L, built);
      for (let i = 3; i <= n; i++) lua.lua_pushvalue(L, i);
      this.scheduler.spawnFromLua(L, { label: 'task.delay', delay, fnIndex: built });
      lua.lua_settop(L, n);
      void fnRef;
      return 0;
    });
    lua.lua_setfield(st, t, to_luastring('delay'));

    lua.lua_pushjsfunction(st, (L) => {
      const luaT = this.f.lua;
      if (luaT.lua_type(L, 1) === luaT.LUA_TTHREAD) {
        const entry = this.scheduler.byThread.get(luaT.lua_tothread(L, 1));
        if (entry) this.scheduler.removeEntry(entry);
      }
      return 0;
    });
    lua.lua_setfield(st, t, to_luastring('cancel'));

    lua.lua_pushjsfunction(st, () => 0);
    lua.lua_setfield(st, t, to_luastring('synchronize'));

    lua.lua_setglobal(st, to_luastring('task'));

    // classic aliases
    this.setGlobal('wait', (L) => this.yieldWait(L, Math.max(0, this.num(L, 1, 0))));
    this.setGlobal('spawn', (L) => {
      this.scheduler.spawnFromLua(L, { label: 'spawn' });
      return 0;
    });
    this.setGlobal('delay', (L) => {
      // legacy Roblox signature: delay(seconds, fn, ...)
      if (!this.isFunction(L, 2)) return this.fail(L, 'delay expects (seconds, function)');
      const delay = Math.max(0, this.num(L, 1, 0));
      const n = this.top(L);
      lua.lua_pushvalue(L, 2);
      for (let i = 3; i <= n; i++) lua.lua_pushvalue(L, i);
      this.scheduler.spawnFromLua(L, { label: 'delay', delay, fnIndex: 1 });
      lua.lua_settop(L, n - 1);
      return 0;
    });
  }

  /** `task.wait(seconds)`: yield and be resumed with (elapsed, deltaMs). */
  yieldWait(L, seconds) {
    const lua = this.f.lua;
    lua.lua_newtable(L);
    this.pushStr(L, 'wait');
    lua.lua_setfield(L, -2, this.f.to_luastring('kind'));
    lua.lua_pushnumber(L, seconds);
    lua.lua_setfield(L, -2, this.f.to_luastring('seconds'));
    lua.lua_setglobal(L, this.f.to_luastring('__yieldRequest'));
    return lua.lua_yield(L, 0);
  }

  /* ------------------------ math / string helpers --------------------- */

  installMathAndString() {
    const { lua, to_luastring } = this.f;
    const st = this.L;
    lua.lua_getglobal(st, to_luastring('math'));
    if (lua.lua_type(st, -1) === lua.LUA_TTABLE) {
      const mt = this.top(st);
      const extra = {
        clamp: (L) => { lua.lua_pushnumber(L, Math.min(Math.max(this.num(L, 1), this.num(L, 2)), this.num(L, 3))); return 1; },
        round: (L) => { lua.lua_pushnumber(L, Math.round(this.num(L, 1))); return 1; },
        sign: (L) => { lua.lua_pushinteger(L, Math.sign(this.num(L, 1))); return 1; },
        lerp: (L) => {
          const a = this.num(L, 1); const b = this.num(L, 2); const t = this.num(L, 3);
          lua.lua_pushnumber(L, a + (b - a) * t); return 1;
        },
        map: (L) => {
          const v = this.num(L, 1); const a = this.num(L, 2); const b = this.num(L, 3);
          const c = this.num(L, 4); const d = this.num(L, 5);
          lua.lua_pushnumber(L, c + ((v - a) / (b - a || 1)) * (d - c)); return 1;
        },
        noise: (L) => {
          lua.lua_pushnumber(L, pseudoNoise(this.num(L, 1), this.num(L, 2), this.num(L, 3)));
          return 1;
        },
      };
      for (const [name, f] of Object.entries(extra)) {
        lua.lua_pushjsfunction(st, f);
        lua.lua_setfield(st, mt, to_luastring(name));
      }
    }
    lua.lua_pop(st, 1);

    lua.lua_getglobal(st, to_luastring('string'));
    if (lua.lua_type(st, -1) === lua.LUA_TTABLE) {
      lua.lua_pushjsfunction(st, (L) => {
        const s = this.str(L, 1);
        const sep = this.str(L, 2, ',');
        lua.lua_createtable(L, 0, 0);
        s.split(sep).forEach((part, i) => {
          this.pushStr(L, part.trim());
          lua.lua_rawseti(L, -2, i + 1);
        });
        return 1;
      });
      lua.lua_setfield(st, -2, to_luastring('split'));
    }
    lua.lua_pop(st, 1);

    lua.lua_getglobal(st, to_luastring('table'));
    if (lua.lua_type(st, -1) === lua.LUA_TTABLE) {
      lua.lua_pushjsfunction(st, (L) => {
        if (!this.isTable(L, 1)) return this.fail(L, 'table.clone expects a table');
        lua.lua_newtable(L);
        const dst = this.top(L);
        lua.lua_pushnil(L);
        while (lua.lua_next(L, 1) !== 0) {
          lua.lua_pushvalue(L, -2);
          lua.lua_pushvalue(L, -2);
          lua.lua_settable(L, dst);
          lua.lua_pop(L, 1);
        }
        return 1;
      });
      lua.lua_setfield(st, -2, to_luastring('clone'));
      lua.lua_pushjsfunction(st, (L) => {
        const n = Math.max(0, Math.floor(this.num(L, 1)));
        lua.lua_createtable(L, n, 0);
        if (this.top(L) >= 2) {
          for (let i = 1; i <= n; i++) {
            lua.lua_pushvalue(L, 2);
            lua.lua_rawseti(L, -2, i);
          }
        }
        return 1;
      });
      lua.lua_setfield(st, -2, to_luastring('create'));
      lua.lua_pushjsfunction(st, (L) => {
        if (!this.isTable(L, 1)) { lua.lua_pushnil(L); return 1; }
        const n = lua.lua_rawlen(L, 1);
        for (let i = 1; i <= n; i++) {
          lua.lua_rawgeti(L, 1, i);
          if (lua.lua_rawequal(L, -1, 2)) { lua.lua_pushinteger(L, i); return 1; }
          lua.lua_pop(L, 1);
        }
        lua.lua_pushnil(L);
        return 1;
      });
      lua.lua_setfield(st, -2, to_luastring('find'));
    }
    lua.lua_pop(st, 1);

    // bit32 (Lua 5.3 has native ops, but lots of game code uses bit32)
    lua.lua_newtable(st);
    const bt = this.top(st);
    const bitop = (name, fn) => {
      lua.lua_pushjsfunction(st, (L) => {
        lua.lua_pushinteger(L, fn(this.num(L, 1) >>> 0, this.num(L, 2) >>> 0) >>> 0);
        return 1;
      });
      lua.lua_setfield(st, bt, to_luastring(name));
    };
    bitop('band', (a, b) => a & b);
    bitop('bor', (a, b) => a | b);
    bitop('bxor', (a, b) => a ^ b);
    bitop('lshift', (a, b) => a << b);
    bitop('rshift', (a, b) => a >>> b);
    lua.lua_pushjsfunction(st, (L) => {
      lua.lua_pushinteger(L, ~(this.num(L, 1) >>> 0) >>> 0);
      return 1;
    });
    lua.lua_setfield(st, bt, to_luastring('bnot'));
    lua.lua_setglobal(st, to_luastring('bit32'));
  }

  /* ---------------------------- misc globals -------------------------- */

  installMisc() {
    const { lua, to_luastring, lauxlib } = this.f;

    this.setGlobal('print', (L) => {
      this.onLog({ level: 'print', text: this.readArgs(L).join('\t'), source: 'print' });
      return 0;
    });
    this.setGlobal('warn', (L) => {
      this.onLog({ level: 'warn', text: this.readArgs(L).join('\t'), source: 'warn' });
      return 0;
    });
    this.setGlobal('tick', (L) => { lua.lua_pushnumber(L, this.scheduler.clock()); return 1; });
    this.setGlobal('time', (L) => { lua.lua_pushnumber(L, this.scheduler.clock()); return 1; });
    this.setGlobal('elapsedTime', (L) => { lua.lua_pushnumber(L, this.scheduler.clock()); return 1; });

    this.setGlobal('loadstring', (L) => this.loadString(L));
    this.setGlobal('load', (L) => this.loadString(L));
    this.setGlobal('require', (L) => this.requireModule(L));

    this.setGlobal('getgenv', (L) => { lua.lua_pushglobaltable(L); return 1; });
    this.setGlobal('getrenv', (L) => { lua.lua_pushglobaltable(L); return 1; });
    this.setGlobal('gethui', (L) => {
      this.pushInstance(L, this.playerGui ?? this.services.StarterGui ?? null);
      return 1;
    });
    this.setGlobal('getgc', (L) => { lua.lua_newtable(L); return 1; });
    this.setGlobal('getconnections', (L) => { lua.lua_newtable(L); return 1; });
    this.setGlobal('setclipboard', () => {
      this.onLog({ level: 'info', text: 'setclipboard() is disabled in this educational sandbox', source: 'executor' });
      return 0;
    });
    this.setGlobal('toclipboard', () => {
      this.onLog({ level: 'info', text: 'toclipboard() is disabled in this educational sandbox', source: 'executor' });
      return 0;
    });
    void lauxlib;
    void to_luastring;
  }

  readArgs(L) {
    const n = this.top(L);
    const out = [];
    for (let i = 1; i <= n; i++) {
      const t = this.ltype(L, i);
      if (t === this.f.lua.LUA_TUSERDATA) {
        const ud = this.f.lua.lua_touserdata(L, i);
        if (ud.__inst) { out.push(ud.__inst.fullName); continue; }
        if (ud.cf) { out.push(`CFrame(${ud.cf.p.map(fmt).join(', ')})`); continue; }
        if (ud.__t === 'Vector3') { out.push(`${fmt(ud.x)}, ${fmt(ud.y)}, ${fmt(ud.z)}`); continue; }
        if (ud.__t === 'Color3') { out.push(`Color3(${fmt(ud.r)}, ${fmt(ud.g)}, ${fmt(ud.b)})`); continue; }
        if (ud.__t === 'EnumItem') { out.push(`Enum.${ud.enum}.${ud.name}`); continue; }
        out.push('[userdata]');
        continue;
      }
      if (t === this.f.lua.LUA_TTABLE) {
        out.push(this.tableToString(L, i));
        continue;
      }
      if (t === this.f.lua.LUA_TNIL) { out.push('nil'); continue; }
      if (t === this.f.lua.LUA_TBOOLEAN) { out.push(String(!!this.f.lua.lua_toboolean(L, i))); continue; }
      if (t === this.f.lua.LUA_TNUMBER) {
        const v = this.num(L, i);
        out.push(String(v));
        continue;
      }
      out.push(this.str(L, i));
    }
    return out;
  }

  tableToString(L, idx) {
    const lua = this.f.lua;
    const abs = idx < 0 ? this.top(L) + idx + 1 : idx;
    const parts = [];
    lua.lua_pushnil(L);
    let guard = 0;
    while (lua.lua_next(L, abs) !== 0 && guard++ < 32) {
      const k = this.str(L, -2);
      const vt = this.ltype(L, -1);
      let v;
      if (vt === lua.LUA_TSTRING || vt === lua.LUA_TNUMBER) v = this.str(L, -1);
      else if (vt === lua.LUA_TBOOLEAN) v = String(!!lua.lua_toboolean(L, -1));
      else if (vt === lua.LUA_TTABLE) v = '{table}';
      else v = '[value]';
      parts.push(`${k} = ${v}`);
      lua.lua_pop(L, 1);
    }
    return `{ ${parts.join(', ')} }`;
  }

  loadString(L) {
    const { lauxlib, lua, to_luastring } = this.f;
    const src = this.vm.transpile(this.str(L, 1));
    const chunkName = this.str(L, 2, '=loadstring');
    const status = lauxlib.luaL_loadbuffer(L, to_luastring(src, true), null, to_luastring(chunkName));
    if (status !== lua.LUA_OK) {
      const err = this.str(L, -1);
      lua.lua_pop(L, 1);
      lua.lua_pushnil(L);
      this.pushStr(L, err);
      return 2;
    }
    return 1;
  }

  requireModule(L) {
    const { lauxlib, lua, to_luastring } = this.f;
    let target = this.instanceAt(L, 1);
    if (!target) {
      const name = this.str(L, 1);
      const rs = this.services.ReplicatedStorage;
      target = rs ? rs.findFirstChild(name, true) : null;
      if (!target) return this.fail(L, `require: module '${name}' not found`);
    }
    if (target.className !== 'ModuleScript') {
      return this.fail(L, `require: ${target.fullName} is not a ModuleScript`);
    }
    if (this.moduleCache.has(target)) {
      lua.lua_rawgeti(L, lua.LUA_REGISTRYINDEX, this.moduleCache.get(target));
      return 1;
    }
    const status = lauxlib.luaL_loadbuffer(
      L,
      to_luastring(this.vm.transpile(target.props.Source ?? ''), true),
      null,
      to_luastring('=' + target.fullName)
    );
    if (status !== lua.LUA_OK) {
      const err = this.str(L, -1);
      lua.lua_pop(L, 1);
      return this.fail(L, `require: ${err}`);
    }
    if (lua.lua_pcall(L, 0, 1, 0) !== lua.LUA_OK) {
      const err = this.str(L, -1);
      lua.lua_pop(L, 1);
      return this.fail(L, `require: ${err}`);
    }
    const ref = lauxlib.luaL_ref(L, lua.LUA_REGISTRYINDEX);
    this.moduleCache.set(target, ref);
    lua.lua_rawgeti(L, lua.LUA_REGISTRYINDEX, ref);
    return 1;
  }

  instanceNew(L) {
    const className = this.str(L, 1);
    if (!className) return this.fail(L, 'Instance.new: class name expected');
    let inst;
    try {
      inst = createInstance(className);
    } catch (err) {
      return this.fail(L, `Instance.new: ${err.message}`);
    }
    inst.name = className;
    inst.props.Name = className;
    this.onReplicated(inst, 'Created');
    const parent = this.instanceAt(L, 2);
    if (parent) {
      try {
        parent.addChild(inst);
        this.onReplicated(inst, 'Parent');
      } catch (err) {
        return this.fail(L, err.message);
      }
    }
    this.pushInstance(L, inst);
    return 1;
  }

  /** Called by the scheduler right before a script's first resume. */
  bindScriptEnvironment(thread, scriptInstance) {
    void thread;
    this.ownerFor(scriptInstance);
  }

  ownerFor(scriptInstance) {
    this.owner = scriptInstance;
    this.setGlobalValue('script', scriptInstance);
  }
}

/* ========================================================================== */
/* instance methods                                                           */
/* ========================================================================== */

/**
 * Fengari signals Lua errors by longjmp, which it implements as a thrown value
 * carrying `lua_syntaxerror`/`status`. Distinguishing those from real JS errors
 * keeps messages like "Instance.new: bad class" intact.
 */
export function isLongjmp(err) {
  return !!err && typeof err === 'object' && ('lua_syntaxerror' in err || 'status' in err || err.error != null);
}

/** Services that exist only in the server DataModel. */
const SERVER_ONLY_SERVICES = new Set(['ServerScriptService', 'ServerStorage']);

const INSTANCE_METHODS = {
  IsA(L, self) {
    this.pushBool(L, self.isA(this.str(L, 2)));
    return 1;
  },
  FindFirstChild(L, self) {
    return this.pushInstance(L, self.findFirstChild(this.str(L, 2), this.bool(L, 3)));
  },
  FindFirstChildOfClass(L, self) {
    return this.pushInstance(L, self.findFirstChildOfClass(this.str(L, 2)));
  },
  FindFirstChildWhichIsA(L, self) {
    return this.pushInstance(L, self.findFirstChildWhichIsA(this.str(L, 2), this.bool(L, 3)));
  },
  FindFirstAncestor(L, self) {
    return this.pushInstance(L, self.findFirstAncestor(this.str(L, 2)));
  },
  FindFirstAncestorOfClass(L, self) {
    return this.pushInstance(L, self.findFirstAncestorOfClass(this.str(L, 2)));
  },
  FindFirstAncestorWhichIsA(L, self) {
    return this.pushInstance(L, self.findFirstAncestorWhichIsA(this.str(L, 2)));
  },
  /**
   * Players:GetPlayers() / :GetPlayerByUserId() / :GetPlayerFromCharacter()
   *
   * In this sandbox a Player instance is a child of the Players service, so the
   * list is just the filtered children. Server-side this returns every joined
   * client; client-side it returns only the local player.
   */
  GetPlayers(L, self) {
    const lua = this.f.lua;
    const players = self.children.filter((c) => c.className === 'Player' || c.isA?.('Player'));
    lua.lua_createtable(L, players.length, 0);
    players.forEach((p, i) => {
      this.pushInstance(L, p);
      lua.lua_rawseti(L, -2, i + 1);
    });
    return 1;
  },
  GetPlayerByUserId(L, self) {
    const userId = this.num(L, 2);
    const found = self.children.find((c) => c.className === 'Player' && Number(c.props.UserId) === userId) ?? null;
    return this.pushInstance(L, found);
  },
  GetPlayerFromCharacter(L, self) {
    const character = this.instanceAt(L, 2);
    if (!character) return this.pushInstance(L, null);
    // walk the character's ancestors looking for a Player (Roblox semantics)
    let cur = character;
    while (cur && cur.className !== 'Player') cur = cur.parent;
    return this.pushInstance(L, cur ?? null);
  },
  GetUserIdFromNameAsync(L, self) {
    void self;
    // No web API in the sandbox — derive a stable fake id and say so in the log.
    const name = this.str(L, 2) ?? '';
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
    this.f.lua.lua_pushinteger(L, 1000 + (hash % 90000));
    return 1;
  },
  GetNameFromUserIdAsync(L, self) {
    void self;
    const userId = this.num(L, 2);
    const found = this.game
      ?.findFirstChildOfClass?.('Players')
      ?.children.find((c) => Number(c.props.UserId) === userId);
    if (found) {
      this.pushStr(L, found.name);
      return 1;
    }
    return this.fail(L, 'GetNameFromUserIdAsync: no such user in this sandbox');
  },
  GetChildren(L, self) {
    const lua = this.f.lua;
    lua.lua_createtable(L, self.children.length, 0);
    self.children.forEach((c, i) => {
      this.pushInstance(L, c);
      lua.lua_rawseti(L, -2, i + 1);
    });
    return 1;
  },
  GetDescendants(L, self) {
    const lua = this.f.lua;
    const list = self.getDescendants();
    lua.lua_createtable(L, list.length, 0);
    list.forEach((c, i) => {
      this.pushInstance(L, c);
      lua.lua_rawseti(L, -2, i + 1);
    });
    return 1;
  },
  Destroy(L, self) {
    self.destroy();
    this.onReplicated(self, 'Destroyed');
    return 0;
  },
  Remove(L, self) {
    self.destroy();
    this.onReplicated(self, 'Destroyed');
    return 0;
  },
  ClearAllChildren(L, self) {
    self.clearAllChildren();
    this.onReplicated(self, 'Children');
    return 0;
  },
  Clone(L, self) {
    return this.pushInstance(L, cloneInstance(self));
  },
  GetFullName(L, self) {
    this.pushStr(L, self.fullName);
    return 1;
  },
  GetAttribute(L, self) {
    return this.pushValue(L, self.getAttribute(this.str(L, 2)) ?? null);
  },
  GetAttributes(L, self) {
    return this.pushValue(L, self.getAttributes());
  },
  SetAttribute(L, self) {
    self.setAttribute(this.str(L, 2), this.readValue(L, 3));
    return 0;
  },
  GetAttributeChangedSignal(L, self) {
    return this.pushSignal(L, this.getSignal(self, `attr:${this.str(L, 2)}`));
  },
  // AddTag / RemoveTag / HasTag are defined further down: the CollectionService
  // entry points and the instance methods share one implementation.
  GetPropertyChangedSignal(L, self) {
    return this.pushSignal(L, this.getSignal(self, `prop:${this.str(L, 2)}`));
  },
  IsDescendantOf(L, self) {
    const other = this.instanceAt(L, 2);
    this.pushBool(L, !!other && self.isDescendantOf(other));
    return 1;
  },
  IsAncestorOf(L, self) {
    const other = this.instanceAt(L, 2);
    this.pushBool(L, !!other && self.isAncestorOf(other));
    return 1;
  },
  GetPivot(L, self) {
    const cf = self.props.CFrame ?? T.cframeFromPosition(self.props.Position ?? { x: 0, y: 0, z: 0 });
    this.pushCFrame(L, cf);
    return 1;
  },
  GetPivotPosition(L, self) {
    const cf = self.props.CFrame ?? T.cframeFromPosition(self.props.Position ?? { x: 0, y: 0, z: 0 });
    const p = T.posOf(cf);
    this.pushVector3(L, p.x, p.y, p.z);
    return 1;
  },
  PivotTo(L, self) {
    const cf = this.cfAt(L, 2);
    if (!cf) return this.fail(L, 'PivotTo expects a CFrame');
    self.props.CFrame = cf;
    self.props.Position = T.posOf(cf);
    self.props.Orientation = T.toEulerDegrees(cf);
    this.onReplicated(self, 'CFrame');
    return 0;
  },
  /* ---- Workspace raycasting ---- */
  Raycast(L, self) {
    void self;
    const origin = this.vecAt(L, 2);
    const direction = this.vecAt(L, 3);
    const params = this.readValue(L, 4) ?? {};
    const hit = this.host.raycast?.(origin, direction, params) ?? null;
    if (!hit) {
      const lua = this.f.lua;
      lua.lua_pushnil(L);
      return 1;
    }
    const lua = this.f.lua;
    lua.lua_newtable(L);
    const t = this.top(L);
    this.pushInstance(L, hit.instance);
    lua.lua_setfield(L, t, this.f.to_luastring('Instance'));
    this.pushVector3(L, hit.position.x, hit.position.y, hit.position.z);
    lua.lua_setfield(L, t, this.f.to_luastring('Position'));
    this.pushVector3(L, hit.normal.x, hit.normal.y, hit.normal.z);
    lua.lua_setfield(L, t, this.f.to_luastring('Normal'));
    lua.lua_pushnumber(L, hit.distance);
    lua.lua_setfield(L, t, this.f.to_luastring('Distance'));
    lua.lua_pushnumber(L, hit.distance);
    lua.lua_setfield(L, t, this.f.to_luastring('Distance1'));
    return 1;
  },
  FindPartOnRay(L, self) {
    void self;
    const origin = this.vecAt(L, 2);
    const direction = this.vecAt(L, 3);
    const hit = this.host.raycast?.(origin, direction, {}) ?? null;
    if (!hit) {
      const lua = this.f.lua;
      lua.lua_pushnil(L);
      lua.lua_pushnil(L);
      return 2;
    }
    this.pushInstance(L, hit.instance);
    this.pushVector3(L, hit.position.x, hit.position.y, hit.position.z);
    return 2;
  },

  /* ---- RunService ---- */
  IsClient(L, self) {
    void self;
    this.pushBool(L, this.realm === 'client');
    return 1;
  },
  IsServer(L, self) {
    void self;
    this.pushBool(L, this.realm === 'server');
    return 1;
  },
  IsStudio(L) {
    this.pushBool(L, false);
    return 1;
  },
  BindToRenderStep(L, self) {
    void self;
    const name = this.str(L, 2);
    const fnIdx = this.isFunction(L, 3) ? 3 : 4;
    if (this.isFunction(L, fnIdx)) {
      this.bindLoopCallback(L, fnIdx, name, 'render');
      return 0;
    }
    return this.fail(L, 'BindToRenderStep expects (name, priority, function)');
  },
  UnbindFromRenderStep(L) {
    const name = this.str(L, 2);
    this.unbindLoopCallback(name);
    return 0;
  },

  /* ---- TweenService ---- */
  Create(L, self) {
    void self;
    const target = this.instanceAt(L, 2);
    if (!target) return this.fail(L, 'TweenService:Create expects an instance');
    const info = this.readValue(L, 3) ?? {};
    const goals = this.readValue(L, 4) ?? {};
    const duration = typeof info.Time === 'number' ? info.Time : 1;
    const tweenId = this.host.tween?.create(target, goals, duration, info) ?? null;
    // return an object with :Play() / :Cancel()
    const lua = this.f.lua;
    lua.lua_newtable(L);
    const t = this.top(L);
    const bind = (name, fn) => {
      lua.lua_pushjsclosure(L, (L2) => fn.call(this, L2), 0);
      lua.lua_setfield(L, t, this.f.to_luastring(name));
    };
    bind('Play', (L2) => { this.host.tween?.play(tweenId); return 0; });
    bind('Cancel', (L2) => { this.host.tween?.cancel(tweenId); return 0; });
    bind('Pause', (L2) => { this.host.tween?.pause(tweenId); return 0; });
    return 1;
  },

  /* ---- Debris ---- */
  AddItem(L, self) {
    void self;
    const inst = this.instanceAt(L, 2);
    const lifetime = this.num(L, 3, 10);
    if (inst) this.host.debris?.add(inst, lifetime, this.realm);
    return 0;
  },

  /* ---- CollectionService ---- */
  GetTagged(L, self) {
    void self;
    const tag = this.str(L, 2);
    const list = this.host.collection?.getTagged(tag) ?? [];
    const lua = this.f.lua;
    lua.lua_createtable(L, list.length, 0);
    list.forEach((inst, i) => {
      this.pushInstance(L, inst);
      lua.lua_rawseti(L, -2, i + 1);
    });
    return 1;
  },
  AddTag(L, self) {
    // CollectionService:AddTag(instance, tag)  /  instance:AddTag(tag)
    const target = this.instanceAt(L, 2);
    if (target) {
      const tag = this.str(L, 3);
      target.tags.add(tag);
      this.host.collection?.changed?.(target, tag);
      return 0;
    }
    self.tags.add(this.str(L, 2));
    return 0;
  },
  RemoveTag(L, self) {
    const target = this.instanceAt(L, 2);
    if (target) {
      const tag = this.str(L, 3);
      target.tags.delete(tag);
      this.host.collection?.changed?.(target, tag);
      return 0;
    }
    self.tags.delete(this.str(L, 2));
    return 0;
  },
  HasTag(L, self) {
    const target = this.instanceAt(L, 2);
    if (target) {
      this.pushBool(L, target.tags.has(this.str(L, 3)));
      return 1;
    }
    this.pushBool(L, self.tags.has(this.str(L, 2)));
    return 1;
  },
  GetTags(L, self) {
    const target = this.instanceAt(L, 2);
    if (target) {
      this.pushValue(L, [...target.tags]);
      return 1;
    }
    this.pushValue(L, [...self.tags]);
    return 1;
  },
  GetInstanceAddedSignal(L, self) {
    void self;
    return this.pushSignal(L, this.getSignal(self, `tagAdded:${this.str(L, 2)}`));
  },
  GetInstanceRemovedSignal(L, self) {
    void self;
    return this.pushSignal(L, this.getSignal(self, `tagRemoved:${this.str(L, 2)}`));
  },

  /* ---- HttpService (sandboxed) ---- */
  JSONEncode(L, self) {
    void self;
    const value = this.readValue(L, 2);
    let json;
    try {
      json = JSON.stringify(value ?? null);
    } catch (_) {
      json = 'null';
    }
    this.pushStr(L, json);
    return 1;
  },
  JSONDecode(L, self) {
    void self;
    const text = this.str(L, 2);
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      return this.fail(L, `JSONDecode: ${err.message}`);
    }
    this.pushValue(L, parsed);
    return 1;
  },
  GenerateGUID(L, self) {
    void self;
    const guid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
    this.pushStr(L, guid);
    return 1;
  },
  GetAsync(L, self) {
    void self;
    // Deliberately inert: this lab never talks to the internet.
    return this.fail(L, 'HttpService:GetAsync is disabled in this educational sandbox');
  },
  PostAsync(L, self) {
    void self;
    return this.fail(L, 'HttpService:PostAsync is disabled in this educational sandbox');
  },

  /* ---- UserInputService ---- */
  IsKeyDown(L, self) {
    void self;
    const key = this.str(L, 2);
    this.pushBool(L, !!this.host.input?.isKeyDown(key));
    return 1;
  },
  GetMouseLocation(L, self) {
    void self;
    const pos = this.host.input?.mousePosition() ?? { x: 0, y: 0 };
    this.pushVector3(L, pos.x, pos.y, 0);
    return 1;
  },
  GetFocusedTextBox(L) {
    this.pushInstance(L, null);
    return 1;
  },

  /* ---- TeleportService (no-op) ---- */
  Teleport(L) {
    this.onLog({ level: 'info', text: '[sandbox] TeleportService is disabled', source: 'TeleportService' });
    return 0;
  },

  /* services */
  GetService(L, self) {
    const name = this.str(L, 2);
    const svc = self.findFirstChild(name);
    if (svc) return this.pushInstance(L, svc);
    if (this.services[name]) return this.pushInstance(L, this.services[name]);

    // Server-only services must not be conjurable from a client realm: that is
    // exactly what FilteringEnabled prevents, and it is what this sandbox is
    // teaching. `FindService` returns nil; `GetService` raises like Roblox.
    if (this.realm !== 'server' && SERVER_ONLY_SERVICES.has(name)) {
      return this.fail(L, `${name} is not replicated to clients (FilteringEnabled)`);
    }
    return this.pushInstance(L, createServiceLazy(this, name));
  },
  FindService(L, self) {
    const name = this.str(L, 2);
    return this.pushInstance(L, self.findFirstChild(name) ?? this.services[name] ?? null);
  },
  /* remotes */
  FireServer(L, self) {
    return this.fireRemote(L, self, 'server');
  },
  FireClient(L, self) {
    return this.fireRemote(L, self, 'client');
  },
  FireAllClients(L, self) {
    return this.fireRemote(L, self, 'all');
  },
  InvokeServer(L, self) {
    return this.fireRemote(L, self, 'server');
  },
  /* gui */
  TweenPosition(L, self) {
    const v = this.readValue(L, 2);
    if (v && v.__t === 'UDim2') self.props.Position = v;
    return 0;
  },
  TweenSize(L, self) {
    const v = this.readValue(L, 2);
    if (v && v.__t === 'UDim2') self.props.Size = v;
    return 0;
  },
  /* sound */
  Play(L, self) {
    this.onReplicated(self, 'Play');
    return 0;
  },
  Stop(L, self) {
    this.onReplicated(self, 'Stop');
    return 0;
  },
  Pause(L) { return 0; },
  Resume(L) { return 0; },
  WaitForChild(L, self) {
    const name = this.str(L, 2);
    const timeout = this.num(L, 3, 5);
    const existing = self.findFirstChild(name);
    if (existing) return this.pushInstance(L, existing);
    // Yield this coroutine until the child appears (scheduler resumes it).
    this.host.waitForChild?.(self, name, this.scheduler?.currentScript);
    const lua = this.f.lua;
    lua.lua_newtable(L);
    this.pushStr(L, 'waitForChild');
    lua.lua_setfield(L, -2, this.f.to_luastring('kind'));
    this.pushStr(L, name);
    lua.lua_setfield(L, -2, this.f.to_luastring('name'));
    lua.lua_pushnumber(L, timeout);
    lua.lua_setfield(L, -2, this.f.to_luastring('timeout'));
    lua.lua_setglobal(L, this.f.to_luastring('__yieldRequest'));
    return lua.lua_yield(L, 0);
  },
  WaitForChildOfClass(L, self) {
    return this.pushInstance(L, self.findFirstChildOfClass(this.str(L, 2)));
  },
};

const INSTANCE_METHOD_NAMES = new Set([...Object.keys(INSTANCE_METHODS), 'WaitForChild', 'WaitForChildOfClass', 'GetDescendants']);

const SERVICE_SIGNALS = {
  RunService: ['Heartbeat', 'Stepped', 'RenderStepped', 'PreSimulation', 'PostSimulation'],
  UserInputService: ['InputBegan', 'InputEnded', 'InputChanged'],
};

/* property-style signals per class */
const SIGNAL_PROPS = {
  Players: ['PlayerAdded', 'PlayerRemoving'],
  Player: ['CharacterAdded', 'CharacterRemoving', 'Chatted'],
  RemoteEvent: ['OnServerEvent', 'OnClientEvent'],
  BindableEvent: ['Event'],
  RunService: ['Heartbeat', 'Stepped', 'RenderStepped'],
  UserInputService: ['InputBegan', 'InputEnded', 'InputChanged'],
  BasePart: ['Touched', 'TouchEnded'],
  Humanoid: ['Died', 'HealthChanged', 'StateChanged'],
  Workspace: ['ChildAdded', 'ChildRemoved', 'DescendantAdded', 'DescendantRemoving'],
  Instance: ['ChildAdded', 'ChildRemoved', 'DescendantAdded', 'DescendantRemoving', 'AncestryChanged'],
  Script: ['Changed'],
  Sound: ['Ended', 'Loaded'],
  TextButton: ['Activated', 'MouseButton1Click', 'MouseEnter', 'MouseLeave'],
  TextLabel: [],
  ScreenGui: [],
  Tool: ['Activated', 'Equipped', 'Unequipped'],
};

/* methods that need to exist but are implemented in the Lua prelude */
INSTANCE_METHODS.__iterate = null;

function cloneInstance(inst) {
  const copy = createInstance(inst.className);
  copy.name = inst.name;
  copy.props = JSON.parse(JSON.stringify(inst.props ?? {}));
  copy.attributes = new Map(inst.attributes);
  copy.tags = new Set(inst.tags);
  for (const child of inst.children) copy.addChild(cloneInstance(child));
  return copy;
}

function createServiceLazy(bindings, name) {
  const inst = createInstance(name, name);
  inst.props.ServiceName = name;
  bindings.game.addChild(inst);
  bindings.services[name] = inst;
  return inst;
}

function pseudoNoise(x = 0, y = 0, z = 0) {
  const n = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453;
  const f = n - Math.floor(n);
  return (f + (Math.sin(x * 0.5 + y * 0.7 + z * 0.9) + 1) * 0.5) * 0.5;
}

export { INSTANCE_METHODS, SIGNAL_PROPS, ENUM_IDS };
