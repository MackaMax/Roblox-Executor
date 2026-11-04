/**
 * LuaRuntime — one Lua state (a "realm") plus the runtime guards that make
 * running user-supplied scripts safe inside a Node process.
 *
 * A realm is what Roblox calls the environment a script executes in: the
 * server has one, and every connected player gets one client realm. Each
 * realm owns its own Lua state, its own bindings and its own scheduler, so a
 * client script can never reach server-only objects.
 */

import fengari from 'fengari';
import { luauToLua } from './luau.js';

const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari;

export const LUA_OK = lua.LUA_OK; // 0
export const LUA_YIELD = lua.LUA_YIELD; // 1
export const FENGARI = fengari;

const DEFAULT_BUDGET = 3_000_000; // instructions per resumption

export class LuaRuntime {
  constructor({ instructionBudget = DEFAULT_BUDGET, name = 'realm' } = {}) {
    this.name = name;
    this.instructionBudget = instructionBudget;
    this.L = lauxlib.luaL_newstate();
    lualib.luaL_openlibs(this.L);
    this.closed = false;
    this.fengari = fengari;
    this.instructions = 0;
    this.onBudgetExceeded = null;
    this.onBudget = null;
    this.errorHook = null; // (message, runtime) => void for diagnostics

    this._installSandbox();
    this._installInstructionHook();
  }

  /* -------------------------------------------------------------------- */
  /* sandbox: drop APIs that make no sense in a host sandbox               */
  /* -------------------------------------------------------------------- */

  _installSandbox() {
    const st = this.L;
    const drop = `
      io = nil
      dofile = nil
      loadfile = nil
      if package then
        package.loadlib = nil
        package.searchers = nil
        package.path = ""
        package.cpath = ""
      end
      if os then
        os.execute = nil
        os.exit = nil
        os.remove = nil
        os.rename = nil
        os.tmpname = nil
      end
      if debug then
        debug.debug = nil
        debug.getregistry = nil
        debug.setmetatable = nil
        debug.sethook = nil
      end
      collectgarbage = function() return 0 end
    `;
    const status = lauxlib.luaL_dostring(st, to_luastring(drop));
    if (status !== LUA_OK) {
      const msg = lua.lua_tojsstring(st, -1);
      lua.lua_pop(st, 1);
      throw new Error(`sandbox init failed: ${msg}`);
    }
  }

  /**
   * Count hook guard: `while true do end` never returns to JS, so without this
   * one bad script would freeze the whole server. Every N VM instructions we
   * check a budget; when it is exceeded we raise a normal Lua error, which
   * unwinds the script and leaves the host alive.
   */
  _installInstructionHook() {
    const st = this.L;
    const self = this;
    const hook = (Lstate) => {
      self.instructions += 10_000;
      if (self.instructions > self.instructionBudget) {
        const msg = 'script killed: exceeded its instruction budget (infinite loop?)';
        if (self.errorHook) self.errorHook(msg, self);
        if (self.onBudget) self.onBudget(msg);
        lua.lua_pushstring(Lstate, to_luastring(msg));
        lua.lua_error(Lstate);
      }
    };
    try {
      lua.lua_sethook(st, hook, lua.LUA_MASKCOUNT, 10_000);
    } catch (_) {
      this.onBudget = null;
    }
  }

  resetBudget() {
    this.instructions = 0;
  }

  /* -------------------------------------------------------------------- */
  /* stack helpers                                                         */
  /* -------------------------------------------------------------------- */

  /**
   * Create a coroutine from the Lua function at stack index `index` of `st`.
   * The function stays on the stack (we only push a copy).
   */
  createThreadFromStack(st, index) {
    const base = lua.lua_gettop(st);
    lua.lua_pushvalue(st, index);
    const fnIdx = lua.lua_gettop(st);
    lua.lua_getglobal(st, to_luastring('coroutine'));
    lua.lua_getfield(st, -1, to_luastring('create'));
    lua.lua_remove(st, -2);
    lua.lua_pushvalue(st, fnIdx);
    const status = lua.lua_pcall(st, 1, 1, 0);
    if (status !== LUA_OK) {
      const err = lua.lua_tojsstring(st, -1) || 'could not create coroutine';
      lua.lua_settop(st, base);
      return { ok: false, error: err };
    }
    const thread = lua.lua_tothread(st, -1);
    lua.lua_settop(st, base);
    return { ok: true, thread };
  }

  /** Same as above, but from a registry reference to a function. */
  createThreadFromRef(fnRef) {
    const st = this.L;
    const base = lua.lua_gettop(st);
    lua.lua_rawgeti(st, lua.LUA_REGISTRYINDEX, fnRef);
    const res = this.createThreadFromStack(st, -1);
    lua.lua_settop(st, base);
    return res;
  }

  /** Push a plain JS scalar (strings/numbers/bools/nil) onto a stack. */
  pushScalar(st, v) {
    if (v === undefined || v === null) lua.lua_pushnil(st);
    else if (typeof v === 'boolean') lua.lua_pushboolean(st, v ? 1 : 0);
    else if (typeof v === 'number') {
      if (Number.isInteger(v)) lua.lua_pushinteger(st, v);
      else lua.lua_pushnumber(st, v);
    } else lua.lua_pushstring(st, to_luastring(String(v)));
  }

  top(st = this.L) {
    return lua.lua_gettop(st);
  }

  pop(n, st = this.L) {
    lua.lua_pop(st, n);
  }

  /** Read a plain value from a stack index. */
  readScalar(st, index) {
    const t = lua.lua_type(st, index);
    switch (t) {
      case lua.LUA_TNIL:
      case lua.LUA_TNONE:
        return null;
      case lua.LUA_TBOOLEAN:
        return !!lua.lua_toboolean(st, index);
      case lua.LUA_TNUMBER:
        return lua.lua_tonumber(st, index);
      case lua.LUA_TSTRING:
        return lua.lua_tojsstring(st, index);
      default:
        return { __luaType: lua.lua_typename(st, t) };
    }
  }

  /** Read everything currently on a stack as JS values. */
  readStack(st = this.L) {
    const n = lua.lua_gettop(st);
    const out = [];
    for (let i = 1; i <= n; i++) out.push(this.readScalar(st, i));
    return out;
  }

  pushThreadRef(L) {
    // push the currently running thread as a usable object on its own stack
    lua.lua_pushthread(L);
    const th = lua.lua_tothread(L, -1);
    lua.lua_pop(L, 1);
    return th;
  }

  /* -------------------------------------------------------------------- */
  /* chunk loading                                                         */
  /* -------------------------------------------------------------------- */

  /** Roblox scripts are Luau; translate the extra syntax before compiling. */
  transpile(source) {
    if (this.transpileEnabled === false) return source;
    try {
      return luauToLua(source);
    } catch (_) {
      return source;
    }
  }

  /**
   * Compile `source` and wrap it into a coroutine we can resume.
   * Returns { ok, thread } or { ok: false, error }.
   */
  compileScript(source, chunkName = '=script') {
    const st = this.L;
    const base = lua.lua_gettop(st);
    // Luau (Roblox) dialect -> Lua 5.3
    const code = this.transpile(source);
    const status = lauxlib.luaL_loadbuffer(
      st,
      to_luastring(code, true),
      null,
      to_luastring(chunkName)
    );
    if (status !== LUA_OK) {
      const err = lua.lua_tojsstring(st, -1) || 'compile error';
      lua.lua_settop(st, base);
      if (this.errorHook) this.errorHook(err, this);
      return { ok: false, error: err };
    }

    // Wrap the chunk in a coroutine so the scheduler can suspend/resume it.
    // Stack: [chunkFn] -> [chunkFn, coCreate] -> [chunkFn, coroutine]
    const fnIdx = lua.lua_gettop(st);
    lua.lua_getglobal(st, to_luastring('coroutine'));
    lua.lua_getfield(st, -1, to_luastring('create'));
    lua.lua_remove(st, -2);
    lua.lua_pushvalue(st, fnIdx);
    const cs = lua.lua_pcall(st, 1, 1, 0);
    if (cs !== LUA_OK) {
      const err = lua.lua_tojsstring(st, -1) || 'create error';
      lua.lua_settop(st, base);
      return { ok: false, error: err };
    }
    const thread = lua.lua_tothread(st, -1);
    lua.lua_settop(st, base);
    return { ok: true, thread };
  }

  /* -------------------------------------------------------------------- */
  /* resumption                                                            */
  /* -------------------------------------------------------------------- */

  /**
   * Resume a coroutine.
   * Returns:
   *   { status: 'ok' }                     finished normally
   *   { status: 'yield', request }         yielded (request = JS object)
   *   { status: 'error', error }           raised an error
   */
  /**
   * @param {*} thread
   * @param {Array} args values returned into the suspended `coroutine.yield()`
   * @param {object|null} bindings when present, values are pushed with the
   *        full Roblox value converter (instances, Vector3, ...)
   */
  resumeThread(thread, args = [], bindings = null) {
    this.resetBudget();
    for (const a of args) {
      if (bindings) bindings.pushValue(thread, a);
      else this.pushScalar(thread, a);
    }
    const status = lua.lua_resume(thread, this.L, args.length);
    if (status === LUA_OK) {
      lua.lua_settop(thread, 0);
      return { status: 'ok' };
    }
    if (status === LUA_YIELD) {
      return { status: 'yield', request: this._yieldRequest(thread) };
    }
    const err = lua.lua_tojsstring(thread, -1) || 'unknown Lua error';
    if (this.errorHook) this.errorHook(err, this, thread);
    const trace = this._traceback(thread, err);
    lua.lua_settop(thread, 0);
    return { status: 'error', error: trace };
  }

  _yieldRequest(thread) {
    // The Lua shim stores the request in a per-thread global before yielding.
    lua.lua_getglobal(thread, to_luastring('__yieldRequest'));
    if (lua.lua_type(thread, -1) !== lua.LUA_TTABLE) {
      lua.lua_pop(thread, 1);
      return { kind: 'yield' };
    }
    const req = {};
    lua.lua_pushnil(thread);
    while (lua.lua_next(thread, -2) !== 0) {
      const k = lua.lua_tojsstring(thread, -2);
      const t = lua.lua_type(thread, -1);
      req[k] = t === lua.LUA_TNUMBER ? lua.lua_tonumber(thread, -1) : lua.lua_tojsstring(thread, -1);
      lua.lua_pop(thread, 1);
    }
    lua.lua_pop(thread, 1);
    lua.lua_pushnil(thread);
    lua.lua_setglobal(thread, to_luastring('__yieldRequest'));
    return req;
  }

  _traceback(thread, message) {
    try {
      lauxlib.luaL_traceback(this.L, thread, to_luastring(message), 1);
      const text = lua.lua_tojsstring(this.L, -1);
      lua.lua_pop(this.L, 1);
      return text || message;
    } catch (_) {
      return message;
    }
  }

  /**
   * Install the yield helpers. Scripts never see these directly; the bindings
   * use them so the scheduler can tell *why* a script yielded and how long it
   * wants to sleep.
   */
  installRuntimeShim() {
    // NOTE: everything here must be pure Lua so it cannot capture host state.
    // The binding layer (bindings.js) injects the actual gameplay APIs.
    const code = `
      __yieldRequest = nil
      function __yieldWith(tbl)
        __yieldRequest = tbl
        return coroutine.yield()
      end
      -- task.wait(seconds): yield and get real elapsed values back from the host
      function __taskWait(seconds)
        local before = os.clock()
        __yieldRequest = { kind = "wait", seconds = seconds }
        local elapsed, deltaMs = coroutine.yield()
        return elapsed or 0, deltaMs or 0
      end
      function __coCreate(fn, ...)
        return coroutine.create(fn)
      end
      function __newEnv(scriptObj)
        -- look globals up dynamically in the real global table
        local env = setmetatable({ script = scriptObj }, { __index = function(_, k)
          return _G[k]
        end })
        return env
      end
    `;
    const status = lauxlib.luaL_dostring(this.L, to_luastring(code));
    if (status !== LUA_OK) {
      const err = lua.lua_tojsstring(this.L, -1);
      lua.lua_pop(this.L, 1);
      throw new Error(`runtime shim failed: ${err}`);
    }
  }

  /** Evaluate a chunk on the main thread (engine introspection/testing). */
  doString(code) {
    const st = this.L;
    const status = lauxlib.luaL_dostring(st, to_luastring(code));
    if (status !== LUA_OK) {
      const err = lua.lua_tojsstring(st, -1);
      lua.lua_pop(st, 1);
      return { ok: false, error: err };
    }
    return { ok: true, results: this.readStack(st) };
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      lua.lua_close(this.L);
    } catch (_) {
      /* ignore */
    }
  }
}

export { lua, lauxlib, lualib, to_luastring, to_jsstring, fengari };
