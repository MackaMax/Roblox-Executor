# Roblox Executor Lab

**Educational Purposes Only.**

An educational, fully self-contained sandbox that shows *how* a Roblox-style script executor works — from the outside in. It reproduces the interesting parts of an executor honestly (a real Lua VM, a real instance tree, real client/server script realms, a real replication boundary) without touching the Roblox client, hooking any process, or bypassing any anti-cheat.

> **This is not an executor and cannot be used as one.**
> It never attaches to Roblox, never injects into another process, and never sends traffic to Roblox. Everything happens inside a local simulation you fully control. The point is to teach the concepts — injection points, execution contexts, the client/server boundary, and why `FilteringEnabled` exists — in a place where learning them is safe and legal.

---

## Why this exists

"Executor" tutorials are usually a black box: a DLL, an injector, and a script hub. The concepts underneath are genuinely interesting and worth understanding:

- **How does a script reach the game?** A real executor finds the Lua state inside the Roblox client and swaps in a new closure. Here, the server ships your code to a realm's Lua runtime over a WebSocket — the same *shape* of problem, with none of the process injection.
- **What is the difference between `Script` and `LocalScript`?** Which globals exist, who can see what, and why `Players.LocalPlayer` is `nil` on the server.
- **Why is the client untrusted?** In this lab you can watch a client script succeed at something it shouldn't, and then watch the server refuse to believe it.

## What it actually does

The app runs a **fake place file** (43 instances: a baseplate, a showcase model, neon pillars, spawn points, `StarterPlayer` script folders) inside an engine that you can inspect and mutate in real time.

```
Browser (CodeMirror editor, three.js viewport)
        │  WebSocket
        ▼
┌─────────────────────────────────────────────┐
│  Node server                                │
│                                             │
│  Server realm            Client realms      │
│  ┌───────────────┐       ┌───────────────┐  │
│  │ Lua 5.3 (VM)  │       │ Lua 5.3 (VM)  │  │
│  │ DataModel     │◄─────►│ filtered copy │  │
│  │ all services  │ remotes│ no SSStorage │  │
│  └───────────────┘       └───────────────┘  │
│         │ instance tree, scheduler, logs    │
└─────────────────────────────────────────────┘
```

- **Lua.** Scripts run on [fengari](https://github.com/fengari-lua/fengari) — a real Lua 5.3 VM in JavaScript. Coroutines, `pcall`, metatables and closures behave like Lua because they *are* Lua.
- **Luau.** Roblox scripts are written in Luau, not Lua 5.3. A small transpiler (`src/engine/lua/luau.js`) translates before compiling: compound assignment (`+=`, `..=`), backtick string interpolation, `continue`, and type annotations.
- **Two realms.** The server realm sees every service. Each client realm gets a *filtered copy*: no `ServerScriptService`, no `ServerStorage`, and `Players.LocalPlayer` points only at itself.
- **Remote events.** `FireServer` / `FireClient` / `FireAllClients` cross the boundary for real, with argument passing and per-player targeting.
- **A scheduler.** `task.wait`, `task.spawn`, `task.delay`, `RunService.Heartbeat` / `RenderStepped`, and `TweenService` all yield and resume on a fixed timestep, so you can watch the scheduler list drain.

## Quick start

### The Windows executable

Download **`RobloxExecutorLab-win-x64.exe`** and double-click it.

That is the whole install. There is no Node.js requirement, no `npm install`, no
folder to keep next to it — the server, the Lua engine and the entire UI are
inside the single file. It prints a banner, starts on <http://localhost:5173>,
and opens your default browser. Close the console window to stop it.

- If port 5173 is already taken it automatically walks up to the next free port
  and prints the URL it settled on.
- Windows SmartScreen will warn you ("Windows protected your PC") because the exe
  is not code-signed. Choose **More info → Run anyway**. Signing certificates cost
  money and this is a free educational project.

### From source

```bash
npm install
npm start          # http://localhost:5173
```

No build step is needed to run it — a prebuilt `public/js/bundle.js` is served directly. After editing browser code:

```bash
npm run build      # rebuild the bundle
npm test           # 56 engine regression tests
```

### Building the executable yourself

```bash
npm run exe:win    # fetch node.exe, bundle everything, emit dist/*.exe
npm run exe:linux  # same thing as a Linux binary, handy for testing
```

The build inlines `public/` into the binary, bundles the server to a single
CommonJS file, and injects both into a genuine `node.exe` via Node's
[Single Executable Application](https://nodejs.org/api/single-executable-applications.html)
support. Output is **~84 MB** — that is a full Node runtime plus the app, which
is the price of shipping one file that needs nothing installed.

## Using it

| Control | What it does |
| --- | --- |
| **Play** | Starts the simulation clock. Scripts resume, tweens animate. |
| **Run** (or `Ctrl`/`Cmd` + `Enter`) | Executes the editor contents in the selected realm. |
| **Join client** | Creates a new client realm — a simulated player with its own Lua state and filtered tree. |
| **Realm selector** | Switch between `server` and any joined client. Executing as a client runs inside *that* client's sandbox. |
| **Explorer** (left) | Click any instance to inspect its class, properties, and children. Click a `Script` to open its source. |
| **Viewport** (center) | Click parts to select them. Client-built `ScreenGui`s render on top and are clickable. |
| **GUI: on/off** | Toggles the PlayerGui overlay. |
| **Dock** | Script editor, output log, scheduler inspector, sample projects, and the players list. |
| **Reset** | Rebuilds the world from scratch. |

The executable and `npm start` behave identically; the exe simply serves the UI
from memory instead of from `public/`.

### Try this

1. Hit **Play**, then load **Neon Pulse** from the Samples tab. The pillars breathe — a server script changing `Color` every frame.
2. Click **Join client**, select the client realm, and run:
   ```lua
   print(`I am {game:GetService("Players").LocalPlayer.Name}`)
   ```
3. Still on the client, try to reach the server's storage:
   ```lua
   game:GetService("ServerStorage")
   -- error: ServerStorage is not replicated to clients (FilteringEnabled)
   ```
4. Load **Client GUI Button**. The button appears over the 3D viewport — click it a few times and watch the label count up. It is a `ScreenGui` that exists only inside the client's `PlayerGui`; open it in the Explorer to see the tree.
5. Select the client realm and click the same button from the server perspective:
   ```lua
   -- run in the *server* realm: the GUI does not exist here
   print(game:GetService("Players"):GetPlayers()[1].PlayerGui)
   -- error: nil — PlayerGui lives on the client
   ```
6. Load **Server-Side Authority** to see the server reject a client's claim.

## Sample projects

| Sample | Realm | Demonstrates |
| --- | --- | --- |
| Neon Pulse | server | per-frame property animation |
| Spinning Parts | server | CFrame math, `RunService.Heartbeat` |
| Client GUI Button | client | PlayerGui, `MouseButton1Click`, remotes |
| Remote Demo | server | `RemoteEvent` round trip |
| Tower Defense Wave | server | state machines, `task.wait` |
| Orbit Camera | server | `Workspace.CurrentCamera` |
| Player Stats | server | `PlayerAdded`, leaderstats |
| Server-Side Authority | server | validating client input |

## Layout

```
src/engine/            the simulation
  engine.js            realms, replication, remote routing, snapshots
  world.js             the starter place (services + scene)
  instance.js          instance tree, class hierarchy, defaults
  scheduler.js         coroutine scheduler for Lua threads
  services.js          LoopService, TweenService, Debris, Collection, Input
  math/transform.js    Vector3 / CFrame / Color3 / ray-AABB
  lua/vm.js            fengari runtime, chunk loading, coroutine control
  lua/bindings.js      the API surface scripts see (~2.4k lines)
  lua/luau.js          Luau → Lua 5.3 transpiler
src/standalone/
  launcher.js          embedded-asset handler, port fallback, browser launch
server/
  index.js             HTTP static server + WebSocket protocol
  samples.js           the sample projects
scripts/
  build.js             esbuild bundle for the browser app
  build-exe.js         packages everything into a standalone executable
  fetch-node-win.js    downloads the node.exe used as the exe's body
public/
  index.html           app shell
  styles.css           dark UI theme
  js/app.js            UI controller + WebSocket client
  js/editor.js         CodeMirror setup + completions
  js/explorer.js       explorer tree + inspector
  js/mirror.js         three.js viewport
  js/gui.js            renders PlayerGui as DOM, fires clicks into the client realm
test/run-tests.js      56 regression tests
```

## The API surface

Implemented and tested: `Instance.new` / `:Clone` / `:Destroy` / `:GetChildren` / `:FindFirstChild` / `:WaitForChild` / `:IsA`, attributes and tags, `game:GetService`, `Players:GetPlayers` / `:GetPlayerByUserId` / `:GetPlayerFromCharacter`, `RunService` signals, `TweenService`, `Debris`, `CollectionService`, `HttpService` JSON, `UserInputService`, raycasting, `CFrame` / `Vector3` / `Color3` / `UDim2` math, `task.*`, `require` on `ModuleScript`s, and `loadstring`.

Deliberately absent: `HttpGet` to the real internet, `TeleportService`, asset loading from Roblox, and anything that would leave the sandbox.

## Why not build the real thing

A genuine executor hooks the Roblox client, patches its Lua state, and defeats Byfron/Hyperion to do it. That is a violation of Roblox's Terms of Use, it is used overwhelmingly for cheating, and it is illegal in a growing number of jurisdictions. Building one here would also mean shipping a malware-shaped artifact.

The educational value is in the *architecture* — realms, replication, sandboxing, injection surfaces — and that is what this lab reproduces faithfully.

## License

MIT.
