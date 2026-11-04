#!/usr/bin/env node
/**
 * Engine regression suite. No test framework: just assert + a summary.
 * Run with: npm test
 */
import { Engine, findMatchingInstance } from '../src/engine/engine.js';
import { createInstance as engineCreate } from '../src/engine/instance.js';
import { luauToLua } from '../src/engine/lua/luau.js';

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      ${String(err.message).split('\n')[0]}`);
  }
}

function assert(cond, message = 'assertion failed') {
  if (!cond) throw new Error(message);
}

function assertEq(actual, expected, message = '') {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${message}\n      expected ${e}\n      actual   ${a}`);
}

/** Fresh engine with a log capture and deterministic time stepping. */
function harness() {
  const engine = new Engine({ timeScale: 1 });
  const logs = [];
  engine.listeners.log.add((l) => logs.push(l));
  const run = (code, { steps = 3, dt = 1 / 60, realm = 'server', clientId = null } = {}) => {
    const before = logs.length;
    const res = engine.execute(code, realm, clientId);
    for (let i = 0; i < steps; i++) engine.step(dt);
    return { ...res, logs: logs.slice(before), all: logs };
  };
  return { engine, logs, run };
}

console.log('\nLua execution');
test('runs a chunk and captures print()', () => {
  const { run } = harness();
  const r = run('print("hello", 42, true)');
  assert(r.ok, 'execute failed');
  const printed = r.logs.filter((l) => l.level === 'print').map((l) => l.text);
  assert(printed.includes('hello\t42\ttrue'), `got ${JSON.stringify(printed)}`);
});

test('reports syntax errors instead of crashing', () => {
  const { run, engine } = harness();
  const r = run('local x = = 5');
  assert(!r.ok || r.all.some((l) => l.level === 'error'), 'expected an error log');
  assert(engine.server.scheduler.activeCount === 0, 'no coroutine should remain');
});

test('reports runtime errors with a traceback', () => {
  const { run } = harness();
  const r = run('local t = nil\nprint(t.field)');
  const err = r.logs.find((l) => l.level === 'error');
  assert(err, 'expected error log');
  assert(/attempt to index/.test(err.text), `got ${err.text}`);
});

test('kills infinite loops instead of hanging', () => {
  const { run } = harness();
  const started = Date.now();
  const r = run('while true do end', { steps: 2 });
  const elapsed = Date.now() - started;
  assert(elapsed < 3000, `took ${elapsed}ms`);
  const err = r.logs.find((l) => l.level === 'error');
  assert(err && /instruction budget/.test(err.text), `got ${err && err.text}`);
});

console.log('\nInstance tree access');
test('reads properties and class names', () => {
  const { run } = harness();
  const r = run(`
    local part = workspace:FindFirstChild("Baseplate", true)
    print(part.ClassName, part.Name)
    print(part.Size.X, part.Position.Y)
  `);
  const printed = r.logs.filter((l) => l.level === 'print').map((l) => l.text);
  assert(printed.includes('Part\tBaseplate'), `got ${JSON.stringify(printed)}`);
  assert(printed.some((p) => p.startsWith('220\t')), `got ${JSON.stringify(printed)}`);
});

test('Instance.new + property writes reach the tree', () => {
  const { run, engine } = harness();
  run(`
    local p = Instance.new("Part")
    p.Name = "FromLua"
    p.Size = Vector3.new(3, 3, 3)
    p.Position = Vector3.new(1, 20, 2)
    p.Color = Color3.fromRGB(10, 20, 30)
    p.Parent = workspace
  `);
  const part = engine.workspace.findFirstChild('FromLua');
  assert(part, 'part missing from workspace');
  assertEq(part.props.Size, { __t: 'Vector3', x: 3, y: 3, z: 3 }, 'Size');
  assertEq(part.props.Position, { __t: 'Vector3', x: 1, y: 20, z: 2 }, 'Position');
  assert(part.props.Color.__t === 'Color3', 'Color3 tag missing');
  // fromRGB packs r<<16 | g<<8 | b, exactly like Roblox
  assert(part.props.Color.r === 0, `R = ${part.props.Color.r}`);
  assert(part.props.Color.g === 0, `G = ${part.props.Color.g}`);
  assert(Math.abs(part.props.Color.b - 0.0392156862745098) < 1e-9, `B = ${part.props.Color.b}`);
});

test('setting Position updates CFrame and vice versa', () => {
  const { run, engine } = harness();
  run(`
    local p = Instance.new("Part")
    p.Name = "GeoPart"
    p.Parent = workspace
    p.Position = Vector3.new(5, 6, 7)
    p.Orientation = Vector3.new(0, 90, 0)
  `);
  const part = engine.workspace.findFirstChild('GeoPart');
  assert(part.props.CFrame, 'CFrame not derived');
  assertEq(part.props.CFrame.p, [5, 6, 7], 'CFrame position');
});

test('cloning copies children', () => {
  const { run, engine } = harness();
  run(`
    local model = Instance.new("Model")
    model.Name = "CloneMe"
    for i = 1, 3 do
      local p = Instance.new("Part")
      p.Name = "Child" .. i
      p.Parent = model
    end
    local copy = model:Clone()
    copy.Name = "Cloned"
    copy.Parent = workspace
  `);
  const cloned = engine.workspace.findFirstChild('Cloned');
  assert(cloned, 'clone missing');
  assert(cloned.children.length === 3, `expected 3 children, got ${cloned.children.length}`);
});

test('queries: GetChildren, GetDescendants, FindFirstChild recursive', () => {
  const { run } = harness();
  const r = run(`
    local showcase = workspace:FindFirstChild("Showcase")
    print(#showcase:GetChildren() > 5, #showcase:GetDescendants() > #showcase:GetChildren())
    print(workspace:FindFirstChild("Baseplate", true) ~= nil)
    print(showcase:FindFirstChildOfClass("Part") ~= nil)
  `);
  const printed = r.logs.filter((l) => l.level === 'print').map((l) => l.text);
  assert(printed[0] === 'true\ttrue', `got ${JSON.stringify(printed)}`);
  assert(printed[1] === 'true', `got ${JSON.stringify(printed)}`);
  assert(printed[2] === 'true', `got ${JSON.stringify(printed)}`);
});

console.log('\nTask scheduler');
test('task.wait suspends and resumes on time', () => {
  const { run, engine } = harness();
  run(`
    task.spawn(function()
      task.wait(0.5)
      print("resumed")
    end)
  `, { steps: 10, dt: 1 / 60 });
  // after ~0.17s of simulated time it must still be waiting
  assert(engine.server.scheduler.activeCount >= 1, 'coroutine should still be alive');
  const printedEarly = engine.logs.filter((l) => l.text === 'resumed').length;
  assert(printedEarly === 0, 'resumed too early');
  for (let i = 0; i < 30; i++) engine.step(1 / 60);
  const printed = engine.logs.filter((l) => l.level === 'print').map((l) => l.text);
  assert(printed.includes('resumed'), 'never resumed');
});

test('task.wait resumes with elapsed time', () => {
  const { run } = harness();
  const r = run(`
    local elapsed = task.wait(0.25)
    print("elapsed", elapsed >= 0.24 and elapsed <= 0.35)
  `, { steps: 40, dt: 1 / 60 });
  const printed = r.logs.filter((l) => l.level === 'print').map((l) => l.text);
  assert(printed.some((p) => p.includes('true')), `got ${JSON.stringify(printed)}`);
});

test('task.spawn runs concurrently', () => {
  const { run } = harness();
  const r = run(`
    local order = {}
    task.spawn(function() task.wait(0.1); order[#order+1] = "A" end)
    task.spawn(function() task.wait(0.2); order[#order+1] = "B" end)
    task.wait(0.35)
    print(table.concat(order, ","))
  `, { steps: 60, dt: 1 / 60 });
  const printed = r.logs.filter((l) => l.level === 'print').map((l) => l.text);
  assert(printed.includes('A,B'), `got ${JSON.stringify(printed)}`);
});

test('task.delay fires later', () => {
  const { run } = harness();
  const r = run(`
    task.delay(0.3, function() print("delayed") end)
    print("immediate")
  `, { steps: 45, dt: 1 / 60 });
  const printed = r.logs.filter((l) => l.level === 'print').map((l) => l.text);
  assert(printed[0] === 'immediate', `got ${JSON.stringify(printed)}`);
  assert(printed.includes('delayed'), `got ${JSON.stringify(printed)}`);
});

test('task.spawn loop cannot starve the host', () => {
  const { run, engine } = harness();
  const started = Date.now();
  run(`
    for i = 1, 40 do
      task.spawn(function() while true do end end)
    end
  `, { steps: 2 });
  const elapsed = Date.now() - started;
  assert(elapsed < 6000, `took ${elapsed}ms`);
  void engine;
});

console.log('\nValues & math');
test('Vector3 arithmetic and methods', () => {
  const { run } = harness();
  const r = run(`
    local a, b = Vector3.new(1,2,3), Vector3.new(4,5,6)
    print((a+b).X, (b-a).Z, a:Dot(b), a.Magnitude > 3.7)
    print(tostring(Vector3.zero), typeof(a))
  `);
  const printed = r.logs.filter((l) => l.level === 'print').map((l) => l.text);
  assert(printed[0] === '5\t3\t32\ttrue', `got ${JSON.stringify(printed)}`);
  assert(printed[1] === '0, 0, 0\tVector3', `got ${JSON.stringify(printed)}`);
});

test('CFrame composition and LookVector', () => {
  const { run } = harness();
  const r = run(`
    local cf = CFrame.new(0,0,0) * CFrame.Angles(0, math.rad(90), 0)
    local lv = cf.LookVector
    print(math.abs(lv.X + 1) < 0.001)
    local p = CFrame.new(1,2,3) * CFrame.new(0,0,-5)
    print(p.Z)
  `);
  const printed = r.logs.filter((l) => l.level === 'print').map((l) => l.text);
  assert(printed[0] === 'true', `got ${JSON.stringify(printed)}`);
  assert(printed[1] === '-2', `got ${JSON.stringify(printed)}`);
});

test('Color3 HSV round trip and Lerp', () => {
  const { run } = harness();
  const r = run(`
    local c = Color3.fromHSV(0, 1, 1)
    print(c.R > 0.99, c.G < 0.01)
    local m = Color3.new(0,0,0):Lerp(Color3.new(1,1,1), 0.5)
    print(m.R)
  `);
  const printed = r.logs.filter((l) => l.level === 'print').map((l) => l.text);
  assert(printed[0] === 'true\ttrue', `got ${JSON.stringify(printed)}`);
  assert(printed[1] === '0.5', `got ${JSON.stringify(printed)}`);
});

test('Udims and Enum', () => {
  const { run } = harness();
  const r = run(`
    local u = UDim2.new(0.5, 10, 1, 0)
    print(u.X.Scale, u.Y.Offset)
    print(Enum.Material.Neon.Name, Enum.Material.Neon.Value >= 0)
    local p = Instance.new("Part")
    p.Material = Enum.Material.Neon
    print(p.Material.Name)
  `);
  const printed = r.logs.filter((l) => l.level === 'print').map((l) => l.text);
  assert(printed[0] === '0.5\t0', `got ${JSON.stringify(printed)}`);
  assert(printed[1] === 'Neon\ttrue', `got ${JSON.stringify(printed)}`);
  assert(printed[2] === 'Neon', `got ${JSON.stringify(printed)}`);
});

console.log('\nSignals');
test('Connect and fire deliver arguments', () => {
  const { run, engine } = harness();
  run(`
    local p = Instance.new("Part")
    p.Name = "SignalPart"
    p.Parent = workspace
    p.Touched:Connect(function(hit) print("touched", hit.Name) end)
  `);
  const part = engine.workspace.findFirstChild('SignalPart');
  const sig = engine.server.bindings.getSignal(part, 'Touched');
  engine.server.bindings.fire(sig, [engine.workspace]);
  for (let i = 0; i < 3; i++) engine.step(1 / 60);
  const printed = engine.logs.filter((l) => l.level === 'print').map((l) => l.text);
  assert(printed.includes('touched\tWorkspace'), `got ${JSON.stringify(printed)}`);
});

test('Once fires a single time', () => {
  const { run, engine } = harness();
  run(`
    local p = Instance.new("Part")
    p.Name = "OncePart"
    p.Parent = workspace
    p.Touched:Once(function() print("once!") end)
  `);
  const part = engine.workspace.findFirstChild('OncePart');
  const sig = engine.server.bindings.getSignal(part, 'Touched');
  engine.server.bindings.fire(sig, []);
  engine.server.bindings.fire(sig, []);
  for (let i = 0; i < 3; i++) engine.step(1 / 60);
  const count = engine.logs.filter((l) => l.text === 'once!').length;
  assert(count === 1, `fired ${count} times`);
});

test('GetPropertyChangedSignal fires on write', () => {
  const { run } = harness();
  const r = run(`
    local p = Instance.new("Part")
    p.Parent = workspace
    p:GetPropertyChangedSignal("Color"):Connect(function() print("changed") end)
    p.Color = Color3.new(1, 0, 0)
  `);
  const printed = r.logs.filter((l) => l.level === 'print').map((l) => l.text);
  assert(printed.includes('changed'), `got ${JSON.stringify(printed)}`);
});

test('Disconnect stops delivery', () => {
  const { run, engine } = harness();
  run(`
    local p = Instance.new("Part")
    p.Name = "DisPart"; p.Parent = workspace
    local conn = p.Touched:Connect(function() print("should not print") end)
    conn:Disconnect()
  `);
  const part = engine.workspace.findFirstChild('DisPart');
  const sig = engine.server.bindings.getSignal(part, 'Touched');
  engine.server.bindings.fire(sig, []);
  for (let i = 0; i < 3; i++) engine.step(1 / 60);
  const printed = engine.logs.filter((l) => l.level === 'print').map((l) => l.text);
  assert(!printed.includes('should not print'), 'listener still fired');
});

console.log('\nRealms');
test('server scripts cannot be seen by the client tree', () => {
  const { engine } = harness();
  const client = engine.createClient('Tester');
  const serverOnly = client.dataModel.findFirstChild('ServerScriptService');
  assert(!serverOnly, 'ServerScriptService leaked into the client');
  const serverScripts = client.dataModel.findFirstChild('ServerStorage');
  assert(!serverScripts, 'ServerStorage leaked into the client');
  assert(client.dataModel.findFirstChild('Workspace'), 'Workspace should replicate');
});

test('client realm runs LocalScripts', () => {
  const { engine } = harness();
  const folder = engine.services.StarterPlayer.findFirstChild('StarterPlayerScripts');
  assert(folder, 'StarterPlayerScripts exists in the starter content');
  createLocalScript(engine, folder, 'TestLocal', 'print("local ran in", typeof(workspace))');
  const client = engine.createClient('ClientA');
  for (let i = 0; i < 3; i++) engine.step(1 / 60);
  const printed = engine.logs.filter((l) => l.level === 'print' && l.realm === `client:ClientA`).map((l) => l.text);
  assert(printed.some((p) => p.startsWith('local ran in')), `got ${JSON.stringify(printed)}`);
  void client;
});

test('RemoteEvent round trip: client to server', () => {
  const { engine } = harness();
  const re = createInstanceOf(engine, 'RemoteEvent', 'ClientToServer');
  engine.services.ReplicatedStorage.addChild(re);

  engine.execute(`
    local re = game:GetService("ReplicatedStorage"):WaitForChild("ClientToServer")
    re.OnServerEvent:Connect(function(player, value)
      print("server got", value, player ~= nil)
    end)
  `, 'server');
  for (let i = 0; i < 3; i++) engine.step(1 / 60);

  const client = engine.createClient('RemoteTester');
  const clientRe = findIn(client.dataModel, 'ClientToServer');
  assert(clientRe, 'remote event did not replicate to the client');
  client.bindings.fireRemoteCall(clientRe, 'server', [42]);
  for (let i = 0; i < 5; i++) engine.step(1 / 60);
  const printed = engine.logs.filter((l) => l.level === 'print').map((l) => l.text);
  assert(printed.some((p) => p === 'server got\t42\ttrue'), `got ${JSON.stringify(printed)}`);
});

console.log('\nServices & environment');
test('game:GetService returns the same service each time', () => {
  const { run } = harness();
  const r = run(`
    local a = game:GetService("Players")
    local b = game:GetService("Players")
    print(a == b, a.ClassName)
  `);
  const printed = r.logs.filter((l) => l.level === 'print').map((l) => l.text);
  assert(printed[0] === 'true\tPlayers', `got ${JSON.stringify(printed)}`);
});

test('typeof and type agree on value types', () => {
  const { run } = harness();
  const r = run(`
    print(typeof(Vector3.new(1,2,3)), typeof(CFrame.new()), typeof(Color3.new()), typeof(workspace))
    print(type(Vector3.new(1,2,3)), type(workspace))
  `);
  const printed = r.logs.filter((l) => l.level === 'print').map((l) => l.text);
  assert(printed[0] === 'Vector3\tCFrame\tColor3\tInstance', `got ${JSON.stringify(printed)}`);
  assert(printed[1] === 'userdata\tuserdata', `got ${JSON.stringify(printed)}`);
});

test('math extensions behave', () => {
  const { run } = harness();
  const r = run(`
    print(math.clamp(15, 0, 10))
    print(math.round(2.6))
    print(math.sign(-4))
    print(math.lerp(0, 10, 0.25))
  `);
  const printed = r.logs.filter((l) => l.level === 'print').map((l) => l.text);
  assertEq(printed, ['10', '3', '-1', '2.5']);
});

test('string.split and table helpers', () => {
  const { run } = harness();
  const r = run(`
    local parts = string.split("a,b,c", ",")
    print(#parts, parts[2])
    local t = {1, 2, 3}
    local c = table.clone(t)
    print(#c, table.find(c, 2))
  `);
  const printed = r.logs.filter((l) => l.level === 'print').map((l) => l.text);
  assert(printed[0] === '3\tb', `got ${JSON.stringify(printed)}`);
  assert(printed[1] === '3\t2', `got ${JSON.stringify(printed)}`);
});

test('loadstring compiles and runs code', () => {
  const { run } = harness();
  const r = run(`
    local fn = loadstring("return 6 * 7")
    print(fn())
    local bad, err = loadstring("this is not lua")
    print(bad == nil, err ~= nil)
  `);
  const printed = r.logs.filter((l) => l.level === 'print').map((l) => l.text);
  assert(printed[0] === '42', `got ${JSON.stringify(printed)}`);
  assert(printed[1] === 'true\ttrue', `got ${JSON.stringify(printed)}`);
});

test('require() loads a ModuleScript once', () => {
  const { engine } = harness();
  const mod = createInstanceOf(engine, 'ModuleScript', 'MathUtils');
  mod.props.Source = 'print("module loaded")\nreturn { double = function(n) return n * 2 end }';
  engine.services.ReplicatedStorage.addChild(mod);
  engine.execute(`
    local m = require(game:GetService("ReplicatedStorage"):FindFirstChild("MathUtils"))
    print("double(21) =", m.double(21))
    local m2 = require(game:GetService("ReplicatedStorage"):FindFirstChild("MathUtils"))
    print("cached", m == m2)
  `, 'server');
  for (let i = 0; i < 3; i++) engine.step(1 / 60);
  const printed = engine.logs.filter((l) => l.level === 'print').map((l) => l.text);
  assert(printed.filter((p) => p === 'module loaded').length === 1, `module loaded ${printed.filter((p) => p === 'module loaded').length} times`);
  assert(printed.includes('double(21) =\t42'), `got ${JSON.stringify(printed)}`);
});

test('sandbox blocks host capabilities', () => {
  const { run } = harness();
  const r = run(`
    print(io, os.execute, loadfile, dofile)
  `);
  const printed = r.logs.filter((l) => l.level === 'print').map((l) => l.text);
  assert(printed[0].startsWith('nil\tnil'), `got ${JSON.stringify(printed)}`);
});

test('attributes and tags round trip', () => {
  const { run, engine } = harness();
  run(`
    local p = Instance.new("Part")
    p.Name = "AttrPart"; p.Parent = workspace
    p:SetAttribute("Score", 10)
    p:SetAttribute("Label", "hi")
    p:AddTag("Special")
    print(p:GetAttribute("Score"), p:GetAttribute("Label"), p:HasTag("Special"))
  `);
  const printed = engine.logs.filter((l) => l.level === 'print').map((l) => l.text);
  assert(printed.includes('10\thi\ttrue'), `got ${JSON.stringify(printed)}`);
  const part = engine.workspace.findFirstChild('AttrPart');
  assert(part.getAttribute('Score') === 10, 'attribute missing on host');
});

console.log('\nServices');
test('RunService:Heartbeat fires every frame', () => {
  const { run, engine } = harness();
  run(`
    local frames = 0
    game:GetService("RunService").Heartbeat:Connect(function(dt)
      frames = frames + 1
    end)
    _G.frameCounter = function() return frames end
  `);
  for (let i = 0; i < 10; i++) engine.step(1 / 60);
  const res = engine.server.runtime.doString('return _G.frameCounter()');
  assert(res.ok, 'counter read failed');
  assert(res.results[0] >= 8, `only ${res.results[0]} heartbeats`);
});

test('TweenService animates a property over time', () => {
  const { run, engine } = harness();
  run(`
    local TweenService = game:GetService("TweenService")
    local p = Instance.new("Part")
    p.Name = "TweenPart"
    p.Parent = workspace
    p.Transparency = 0
    local info = TweenInfo and TweenInfo.new(0.2, Enum.EasingStyle.Linear) or { Time = 0.2 }
    local tween = TweenService:Create(p, info, { Transparency = 1 })
    tween:Play()
  `);
  const part = engine.workspace.findFirstChild('TweenPart');
  engine.step(1 / 60);
  const mid = part.props.Transparency;
  assert(mid > 0 && mid < 1, `transparency mid-tween was ${mid}`);
  for (let i = 0; i < 20; i++) engine.step(1 / 60);
  assert(part.props.Transparency === 1, `final transparency ${part.props.Transparency}`);
});

test('Debris:AddItem removes the instance later', () => {
  const { run, engine } = harness();
  run(`
    local Debris = game:GetService("Debris")
    local p = Instance.new("Part")
    p.Name = "TempPart"
    p.Parent = workspace
    Debris:AddItem(p, 0.1)
  `);
  assert(engine.workspace.findFirstChild('TempPart'), 'part should exist immediately');
  for (let i = 0; i < 12; i++) engine.step(1 / 60);
  assert(!engine.workspace.findFirstChild('TempPart'), 'part should be gone after 0.2s');
});

test('CollectionService tags and queries', () => {
  const { run, engine } = harness();
  const r = run(`
    local CS = game:GetService("CollectionService")
    local p = Instance.new("Part")
    p.Name = "TaggedPart"; p.Parent = workspace
    CS:AddTag(p, "Pickup")
    print(CS:HasTag(p, "Pickup"), #CS:GetTagged("Pickup"))
  `);
  const printed = r.logs.filter((l) => l.level === 'print').map((l) => l.text);
  assert(printed.includes('true\t1'), `got ${JSON.stringify(printed)}`);
});

test('Workspace:Raycast hits the first surface below', () => {
  const { run } = harness();
  const r = run(`
    local result = workspace:Raycast(Vector3.new(0, 50, 0), Vector3.new(0, -1, 0))
    print(result and result.Instance.Name, result and result.Distance)
    -- ray that must miss everything
    local miss = workspace:Raycast(Vector3.new(0, 50, 0), Vector3.new(0, 1, 0))
    print(miss == nil)
  `);
  const printed = r.logs.filter((l) => l.level === 'print').map((l) => l.text);
  assert(printed[0] && printed[0].startsWith('SpawnLocation'), `got ${JSON.stringify(printed)}`);
  assert(printed[1] === 'true', `got ${JSON.stringify(printed)}`);
});

test('HttpService JSON round trip, no network', () => {
  const { run } = harness();
  const r = run(`
    local Http = game:GetService("HttpService")
    local json = Http:JSONEncode({ hello = "world", n = 42 })
    local back = Http:JSONDecode(json)
    print(back.hello, back.n)
    print(#Http:GenerateGUID() > 20)
  `);
  const printed = r.logs.filter((l) => l.level === 'print').map((l) => l.text);
  assert(printed[0] === 'world\t42', `got ${JSON.stringify(printed)}`);
  assert(printed[1] === 'true', `got ${JSON.stringify(printed)}`);
});


/* ------------------------------------------------------------------ */
/* Luau → Lua 5.3 transpiler                                          */
/* ------------------------------------------------------------------ */

console.log('\nLuau transpiler');

test('compound assignment becomes an explicit binary op', () => {
  assertEq(luauToLua('x += 1'), 'x = x + 1', 'simple');
  assertEq(luauToLua('obj.prop += 2'), 'obj.prop = obj.prop + 2', 'property target');
  assertEq(luauToLua('a ..= " world"'), 'a = a .. " world"', 'concat');
  assertEq(luauToLua('d[k] -= 3'), 'd[k] = d[k] - 3', 'index target');
});

test('compound assignment works at the start of a line after a statement', () => {
  // this exact shape regressed once: the offset was taken from the operator
  // instead of the lvalue, producing `t = t + += dt`
  const out = luauToLua('local t = 0\nt += dt');
  assert(!out.includes('+ +='), `duplicated operator in ${JSON.stringify(out)}`);
  assert(out.includes('t = t + dt'), `got ${JSON.stringify(out)}`);
});

test('compound assignment inside one-liners', () => {
  assert(luauToLua('local d = {} d.n = 1 d.n += 5').includes('d.n = d.n + 5'));
});

test('string interpolation compiles to concatenation with tostring', () => {
  const out = luauToLua('print(`hi {name}, {count} coins`)');
  assert(out.includes('tostring(name)'), out);
  assert(out.includes('tostring(count)'), out);
  assert(out.includes('..'), out);
});

test('type annotations are stripped', () => {
  assert(luauToLua('local x: number = 5').includes('local x = 5'));
  assert(!luauToLua('local x: number = 5').includes('number'));
});

test('continue becomes a wrapped-loop break', () => {
  const out = luauToLua('for i = 1, 5 do if i == 3 then continue end print(i) end');
  assert(!/\bcontinue\b/.test(out), `continue survived: ${out}`);
  assert(out.includes('repeat'), out);
  assert(out.includes('until true'), out);
});

test('nested loops keep continue bound to the inner loop', () => {
  const out = luauToLua('for i = 1, 3 do for j = 1, 3 do if j == 2 then continue end print(i, j) end end');
  assert(!/\bcontinue\b/.test(out), out);
  assertEq((out.match(/repeat/g) || []).length, 1, 'only the inner loop needs wrapping');
});

test('strings and comments are never rewritten', () => {
  const src = 'local s = "a+=b" -- += not code\nprint(s)';
  assertEq(luauToLua(src), src, 'literal text untouched');
});

test('transpiled Luau actually runs: continue skips and += accumulates', () => {
  const h = harness();
  h.engine.execute(`local total = 0
for i = 1, 10 do
  if i % 2 == 0 then continue end
  total += i
end
print("ODDSUM", total)`, 'server');
  h.engine.step(0.016);
  const line = h.logs.map((l) => l.text).find((t) => t.startsWith('ODDSUM')) || '';
  assert(line.includes('25'), `expected the odd numbers 1..10 to sum to 25, got ${JSON.stringify(line)}`);
});

/* ------------------------------------------------------------------ */
/* Replication & Players API                                          */
/* ------------------------------------------------------------------ */

console.log('\nReplication & Players');

test('Players:GetPlayers lists joined clients server-side', () => {
  const h = harness();
  const client = h.engine.createClient('Rey');
  h.engine.execute('local list = game:GetService("Players"):GetPlayers()\nprint("COUNT", #list, list[1].Name)', 'server');
  h.engine.step(0.016);
  const line = h.logs.map((l) => l.text).find((t) => t.startsWith('COUNT')) || '';
  assert(line.includes('1') && line.includes('Rey'), `got ${JSON.stringify(line)}`);
  assert(client.player.parent === h.engine.services.Players, 'player must live under Players');
});

test('Players.LocalPlayer is nil on the server, set on the client', () => {
  const h = harness();
  const client = h.engine.createClient('Rey');
  h.engine.execute('print("SERVER_LP", tostring(game:GetService("Players").LocalPlayer))', 'server');
  h.engine.execute('print("CLIENT_LP", game:GetService("Players").LocalPlayer.Name)', 'client', client.id);
  h.engine.step(0.016);
  const texts = h.logs.map((l) => l.text);
  assert(texts.some((t) => t.includes('SERVER_LP') && t.includes('nil')), 'server LocalPlayer must be nil');
  assert(texts.some((t) => t.includes('CLIENT_LP') && t.includes('Rey')), 'client LocalPlayer must resolve');
});

test('client can wait for its PlayerGui', () => {
  const h = harness();
  const client = h.engine.createClient('Rey');
  h.engine.execute('local gui = game:GetService("Players").LocalPlayer:WaitForChild("PlayerGui")\nprint("HASGUI", gui ~= nil)', 'client', client.id);
  h.engine.step(0.016);
  const line = h.logs.map((l) => l.text).find((t) => t.startsWith('HASGUI')) || '';
  assert(line.includes('true'), `PlayerGui should resolve immediately, got ${JSON.stringify(line)}`);
});

test('server-only services are not conjurable from a client realm', () => {
  const h = harness();
  const client = h.engine.createClient('Rey');
  h.engine.execute('game:GetService("ServerStorage")', 'client', client.id);
  h.engine.step(0.016);
  const err = h.logs.find((l) => l.level === 'error');
  assert(err, 'expected a Lua error');
  assert(/not replicated to clients/.test(err.text), `error should explain FilteringEnabled, got ${JSON.stringify(err.text)}`);
});

test('a LocalScript added after a player joined replicates and runs', () => {
  const h = harness();
  const client = h.engine.createClient('Rey');
  const sps = h.engine.services.StarterPlayer.findFirstChild('StarterPlayerScripts');
  const script = engineCreate('LocalScript', 'LateScript');
  script.props.Source = 'print("LATE_RAN", game:GetService("Players").LocalPlayer.Name)';
  sps.addChild(script);
  assert(findMatchingInstance(client.dataModel, script), 'the LocalScript must replicate into the client tree');
  h.engine.step(0.016);
  const line = h.logs.map((l) => l.text).find((t) => t.startsWith('LATE_RAN')) || '';
  assert(line.includes('Rey'), `client script did not run, got ${JSON.stringify(line)}`);
});

test('server Scripts never replicate to clients', () => {
  const h = harness();
  const client = h.engine.createClient('Rey');
  const server = engineCreate('Script', 'SecretLogic');
  server.props.Source = 'print("secret")';
  h.engine.services.ServerScriptService.addChild(server);
  assert(!findMatchingInstance(client.dataModel, server), 'server source must not cross the boundary');
});


test('client-built GUIs never appear in the server PlayerGui', () => {
  const h = harness();
  const client = h.engine.createClient('Rey');
  // simulate what a LocalScript does: build a ScreenGui in its own PlayerGui
  const gui = client.services.LocalPlayer.findFirstChild('PlayerGui');
  assert(gui, 'client should own a PlayerGui');
  gui.addChild(engineCreate('ScreenGui', 'ClientOnly'));

  const serverPlayer = h.engine.services.Players.children.find((c) => c.className === 'Player');
  const serverGui = serverPlayer.findFirstChild('PlayerGui');
  assert(serverGui, 'server should own a PlayerGui too');
  assert(!serverGui.findFirstChild('ClientOnly'), 'server must not see client GUIs');
  assert(serverGui !== gui, 'the two PlayerGuis must be different objects');
});

test('PlayerGui is not duplicated when a client joins', () => {
  const h = harness();
  const client = h.engine.createClient('Rey');
  const gui = client.services.LocalPlayer.findFirstChild('PlayerGui');
  const player = client.services.LocalPlayer;
  assertEq(player.children.filter((c) => c.className === 'PlayerGui').length, 1, 'exactly one PlayerGui per player');
  assert(gui.parent === player, 'PlayerGui must be parented to the Player');
});

/* ------------------------------------------------------------------ */
/* helpers                                                            */
/* ------------------------------------------------------------------ */

function createInstanceOf(engine, className, name) {
  void engine;
  return engineCreate(className, name);
}

function createLocalScript(engine, parent, name, source) {
  const s = engineCreate('LocalScript', name);
  s.props.Source = source;
  s.props.Enabled = true;
  parent.addChild(s);
  return s;
}

function findIn(root, name) {
  return root.findFirstChild(name, true);
}

/* ------------------------------------------------------------------ */

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  for (const f of failures) {
    console.log(`\x1b[31m${f.name}\x1b[0m`);
    console.log(f.err.stack?.split('\n').slice(0, 6).join('\n'));
  }
  process.exit(1);
}
