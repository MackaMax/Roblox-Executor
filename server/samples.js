/**
 * Ready-to-run example scripts for the IDE.
 *
 * Each sample shows one engine feature and is written the way the same idea
 * would be written in a real Roblox place — so they double as documentation.
 */

export const SAMPLE_PROJECTS = [
  {
    id: 'neon-pulse',
    name: 'Neon Pulse',
    description: 'Server script: makes every Neon pillar breathe with a sine wave.',
    parent: 'Workspace',
    className: 'Script',
    code: `-- Neon Pulse (server)
-- Every neon part in Showcase pulses brightness and transparency together.
local showcase = workspace:WaitForChild("Showcase")
local t = 0

local function pulseParts()
  for _, part in ipairs(showcase:GetDescendants()) do
    local light = part:FindFirstChildWhichIsA("PointLight")
    if light then
      local wave = (math.sin(t * 2 + part.Position.X * 0.1) + 1) / 2
      light.Brightness = 0.4 + wave * 3
      light.Range = 8 + wave * 12
      part.Transparency = 0.35 - wave * 0.3
    end
  end
end

game:GetService("RunService").Heartbeat:Connect(function(dt)
  t += dt
  pulseParts()
end)
`,
  },
  {
    id: 'spinning-parts',
    name: 'Spinning Ring',
    description: 'Server script: rotates a ring of parts with a CFrame animation.',
    parent: 'Workspace',
    className: 'Script',
    code: `-- Spinning Ring (server)
local model = Instance.new("Model")
model.Name = "Ring"
model.Parent = workspace

local parts = {}
local count = 24
for i = 1, count do
  local angle = (i / count) * math.pi * 2
  local p = Instance.new("Part")
  p.Name = "RingPart" .. i
  p.Shape = Enum.PartType.Ball
  p.Size = Vector3.new(1.4, 1.4, 1.4)
  p.Color = Color3.fromHSV(i / count, 0.8, 1)
  p.Material = Enum.Material.Neon
  p.Anchored = true
  p.CanCollide = false
  p.Position = Vector3.new(math.cos(angle) * 20, 14, math.sin(angle) * 20)
  p.Parent = model
  parts[i] = p
end

local t = 0
game:GetService("RunService").Heartbeat:Connect(function(dt)
  t += dt
  for i, p in ipairs(parts) do
    local a = (i / count) * math.pi * 2 + t
    local height = 14 + math.sin(t * 1.5 + i * 0.4) * 3
    p.Position = Vector3.new(math.cos(a) * 20, height, math.sin(a) * 20)
  end
end)
`,
  },
  {
    id: 'click-gui',
    name: 'Client GUI Button',
    description: 'LocalScript: builds a button in PlayerGui that spawns parts.',
    parent: 'StarterPlayer.StarterPlayerScripts',
    className: 'LocalScript',
    code: `-- Client GUI Button (LocalScript)
-- Runs in the player's client realm. GUI created here lives only on the client.
local Players = game:GetService("Players")
local player = Players.LocalPlayer
local playerGui = player:WaitForChild("PlayerGui")

local gui = Instance.new("ScreenGui")
gui.Name = "ButtonDemo"
gui.ResetOnSpawn = false
gui.Parent = playerGui

local frame = Instance.new("Frame")
frame.Name = "Panel"
frame.Size = UDim2.new(0, 220, 0, 90)
frame.Position = UDim2.new(0, 24, 0.5, -45)
frame.BackgroundColor3 = Color3.fromRGB(22, 26, 38)
frame.Parent = gui

local button = Instance.new("TextButton")
button.Name = "SpawnButton"
button.Size = UDim2.new(1, -24, 0, 40)
button.Position = UDim2.new(0, 12, 0, 12)
button.BackgroundColor3 = Color3.fromRGB(56, 200, 255)
button.TextColor3 = Color3.fromRGB(8, 12, 20)
button.TextScaled = true
button.Text = "SPAWN A PART"
button.Parent = frame

local label = Instance.new("TextLabel")
label.Size = UDim2.new(1, -24, 0, 22)
label.Position = UDim2.new(0, 12, 0, 58)
label.BackgroundTransparency = 1
label.TextColor3 = Color3.fromRGB(190, 210, 240)
label.TextScaled = true
label.Text = "clicks: 0"
label.Parent = frame

local clicks = 0
button.MouseButton1Click:Connect(function()
  clicks += 1
  label.Text = "clicks: " .. clicks
  -- ask the server to spawn something (RemoteEvent below)
  local remote = game:GetService("ReplicatedStorage"):FindFirstChild("SpawnRequest")
  if remote then
    remote:FireServer(Vector3.new(math.random(-30, 30), 20, math.random(-30, 30)))
  end
end)
`,
  },
  {
    id: 'remote-demo',
    name: 'RemoteEvent Round Trip',
    description: 'Paired server + client sample showing a secure RemoteEvent.',
    parent: 'ServerScriptService',
    className: 'Script',
    code: `-- RemoteEvent Round Trip (server)
-- Creates the remote the client sample fires, and answers it.
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local remote = ReplicatedStorage:FindFirstChild("SpawnRequest")
if not remote then
  remote = Instance.new("RemoteEvent")
  remote.Name = "SpawnRequest"
  remote.Parent = ReplicatedStorage
end

remote.OnServerEvent:Connect(function(player, spawnPosition)
  -- Never trust the client: validate the value before using it.
  if typeof(spawnPosition) ~= "Vector3" then
    warn("rejected malformed spawn request from", player and player.Name)
    return
  end

  local part = Instance.new("Part")
  part.Name = "RemotePart"
  part.Size = Vector3.new(2, 2, 2)
  part.Shape = Enum.PartType.Ball
  part.Color = Color3.fromHSV(math.random(), 0.7, 1)
  part.Material = Enum.Material.Neon
  part.Anchored = false
  part.Position = spawnPosition
  part.Parent = workspace

  -- clean it up after 8 seconds so the world does not fill up
  game:GetService("Debris"):AddItem(part, 8)
  print(player.Name .. " spawned a part at", spawnPosition)
end)
`,
  },
  {
    id: 'tower-defense-wave',
    name: 'Wave Spawner',
    description: 'Server script: spawns and tweens parts in waves, cleans up with Debris.',
    parent: 'Workspace',
    className: 'Script',
    code: `-- Wave Spawner (server)
local TweenService = game:GetService("TweenService")
local Debris = game:GetService("Debris")

local model = Instance.new("Model")
model.Name = "Waves"
model.Parent = workspace

local function spawnWave(n)
  for i = 1, 6 do
    local p = Instance.new("Part")
    p.Name = "WaveUnit"
    p.Size = Vector3.new(1.6, 1.6, 1.6)
    p.Material = Enum.Material.Glass
    p.Color = Color3.fromRGB(120, 220, 255)
    p.Anchored = true
    p.CanCollide = false
    p.Transparency = 1
    p.Position = Vector3.new(-40 + i * 8, 6, 40)
    p.Parent = model

    -- fade in and lift up
    local tween = TweenService:Create(
      p,
      TweenInfo and TweenInfo.new(0.6, Enum.EasingStyle.Quad, Enum.EasingDirection.Out) or { Time = 0.6 },
      { Transparency = 0.15, Position = Vector3.new(p.Position.X, 16, p.Position.Z) }
    )
    tween:Play()
    Debris:AddItem(p, 6)
  end
  print("wave", n, "spawned")
end

local wave = 0
while true do
  wave += 1
  spawnWave(wave)
  task.wait(4)
end
`,
  },
  {
    id: 'orbit-camera',
    name: 'Camera Orbit',
    description: 'Server script: drives Workspace.CurrentCamera around the scene.',
    parent: 'Workspace',
    className: 'Script',
    code: `-- Camera Orbit (server)
-- CurrentCamera is replicated to clients in real Roblox; here the viewport
-- reads it directly so you can see the effect.
local camera = workspace.CurrentCamera
local center = Vector3.new(0, 12, 0)
local radius = 42
local t = 0

game:GetService("RunService").Heartbeat:Connect(function(dt)
  t += dt * 0.25
  local pos = center + Vector3.new(math.cos(t) * radius, 10 + math.sin(t * 0.7) * 6, math.sin(t) * radius)
  camera.CFrame = CFrame.lookAt(pos, center)
end)
`,
  },
  {
    id: 'leaderstats',
    name: 'Player Stats',
    description: 'Server script: classic leaderstats folder with a timed score.',
    parent: 'ServerScriptService',
    className: 'Script',
    code: `-- Classic leaderstats (server)
local Players = game:GetService("Players")

local function setupPlayer(player)
  local stats = Instance.new("Folder")
  stats.Name = "leaderstats"
  stats.Parent = player

  local coins = Instance.new("IntValue")
  coins.Name = "Coins"
  coins.Value = 0
  coins.Parent = stats

  task.spawn(function()
    while player.Parent do
      task.wait(1)
      coins.Value = coins.Value + 5
    end
  end)

  print(player.Name .. " joined with leaderstats")
end

Players.PlayerAdded:Connect(setupPlayer)
for _, player in ipairs(Players:GetPlayers()) do
  setupPlayer(player)
end
`,
  },
  {
    id: 'server-validator',
    name: 'Server-Side Authority',
    description: 'Demonstrates why client-side changes must be validated on the server.',
    parent: 'ServerScriptService',
    className: 'Script',
    code: `-- Server-Side Authority (server)
-- This is the security lesson every Roblox developer learns: the client can
-- ask, but the server decides. Change the numbers below and press Run.
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local request = ReplicatedStorage:FindFirstChild("DamageRequest")
if not request then
  request = Instance.new("RemoteEvent")
  request.Name = "DamageRequest"
  request.Parent = ReplicatedStorage
end

local MAX_DAMAGE_PER_REQUEST = 25
local lastRequest = {}

request.OnServerEvent:Connect(function(player, amount)
  if typeof(amount) ~= "number" then
    warn("rejected: amount was", typeof(amount))
    return
  end
  if amount <= 0 or amount > MAX_DAMAGE_PER_REQUEST then
    warn("rejected: damage", amount, "outside allowed range 1.." .. MAX_DAMAGE_PER_REQUEST)
    return
  end

  -- simple rate limit: one request per player per 100ms
  local now = tick()
  if lastRequest[player] and now - lastRequest[player] < 0.1 then
    warn("rejected: rate limited")
    return
  end
  lastRequest[player] = now

  print("accepted", amount, "damage from", player.Name)
end)
`,
  },
];

export default SAMPLE_PROJECTS;
