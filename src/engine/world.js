/**
 * Builds the default DataModel: the same service layout a real Roblox place
 * has, plus a small starter scene so the viewport is not empty.
 */

import { createInstance, COLOR3 } from './instance.js';
import { cframe, fromEulerDegrees } from './math/transform.js';

export const SERVICES = [
  'Workspace',
  'Lighting',
  'Players',
  'ReplicatedStorage',
  'ServerScriptService',
  'ServerStorage',
  'StarterGui',
  'StarterPlayer',
  'Teams',
  'SoundService',
  'RunService',
  'TweenService',
  'Debris',
  'CollectionService',
  'HttpService',
  'UserInputService',
  'ContextActionService',
  'TeleportService',
];

export function buildDataModel() {
  const dataModel = createInstance('DataModel', 'Game');
  const byName = {};

  for (const service of SERVICES) {
    const inst = createInstance(service, service);
    inst.props.ServiceName = service;
    dataModel.addChild(inst);
    byName[service] = inst;
  }

  const workspace = byName.Workspace;
  workspace.props.Gravity = 196.2;
  workspace.props.FilteringEnabled = true;

  const lighting = byName.Lighting;
  lighting.props.Ambient = COLOR3(0.45, 0.47, 0.5);
  lighting.props.Brightness = 2.2;
  lighting.props.ClockTime = 14;
  lighting.props.OutdoorAmbient = COLOR3(0.5, 0.6, 0.7);
  lighting.props.FogColor = COLOR3(0.75, 0.82, 0.9);
  lighting.props.FogEnd = 900;
  lighting.props.GlobalShadows = true;
  lighting.props.GeographicLatitude = 12;

  const sky = createInstance('Sky', 'Sky');
  sky.props.VertexColor = COLOR3(0.62, 0.75, 0.95);
  sky.props.SkyColor = COLOR3(0.28, 0.36, 0.5);
  lighting.addChild(sky);

  const atmosphere = createInstance('Atmosphere', 'Atmosphere');
  atmosphere.props.Density = 0.32;
  atmosphere.props.Offset = 0.25;
  atmosphere.props.Haze = 1.2;
  lighting.addChild(atmosphere);

  // RunService: the heart of every game loop
  const runService = byName.RunService;
  runService.props.RunContext = 'Server';

  // TweenService placeholder state lives on the instance
  byName.TweenService.props.ClassInfo = 'TweenService';

  // Debris: auto-cleans parts after a delay
  byName.Debris.props.MaxItems = 1000;

  // CollectionService tag registry
  byName.CollectionService.props.ClassInfo = 'CollectionService';

  // HttpService is present but inert (no outbound network in the sandbox)
  byName.HttpService.props.HttpEnabled = false;

  // StarterPlayer containers (client script roots)
  const starterPlayer = byName.StarterPlayer;
  const sps = createInstance('Folder', 'StarterPlayerScripts');
  starterPlayer.addChild(sps);
  const starterCharacter = createInstance('Folder', 'StarterCharacterScripts');
  starterPlayer.addChild(starterCharacter);

  // Camera lives in Workspace exactly like the real client
  const camera = createInstance('Camera', 'Camera');
  camera.props.CFrame = cframe(0, 8, 24);
  camera.props.FieldOfView = 70;
  workspace.addChild(camera);
  workspace._meta.camera = camera;

  return { dataModel, services: byName };
}

/* ------------------------------------------------------------------------- */
/* Starter scene                                                              */
/* ------------------------------------------------------------------------- */

export function buildShowcase(workspace) {
  const scene = createInstance('Model', 'Showcase');
  scene.props.PrimaryPart = null;
  workspace.addChild(scene);

  const spawned = [];
  const part = (name, x, y, z, size, color, opts = {}) => {
    const p = createInstance('Part', name);
    p.props.Position = { __t: 'Vector3', x, y, z };
    p.props.Size = { __t: 'Vector3', ...size };
    p.props.Color = COLOR3(...(Array.isArray(color) ? color : [color, color, color]));
    p.props.Orientation = { __t: 'Vector3', ...(opts.rotation ?? { x: 0, y: 0, z: 0 }) };
    if (opts.transparency !== undefined) p.props.Transparency = opts.transparency;
    if (opts.anchored !== undefined) p.props.Anchored = opts.anchored;
    if (opts.material) p.props.Material = opts.material;
    if (opts.shape) p.props.Shape = opts.shape;
    if (opts.canCollide !== undefined) p.props.CanCollide = opts.canCollide;
    p.props.CFrame = {
      __t: 'CFrame',
      p: [x, y, z],
      r: fromEulerDegrees(
        (opts.rotation?.x ?? 0),
        (opts.rotation?.y ?? 0),
        (opts.rotation?.z ?? 0)
      ).r,
    };
    scene.addChild(p);
    if (opts.spawn) spawned.push(p);
    return p;
  };

  // Ground
  part('Baseplate', 0, -0.5, 0, { x: 220, y: 1, z: 220 }, [0.35, 0.4, 0.38], {
    material: 'Grass',
    canCollide: true,
  });

  // Neon ring of pillars
  const ringRadius = 26;
  for (let i = 0; i < 12; i++) {
    const angle = (i / 12) * Math.PI * 2;
    const x = Math.cos(angle) * ringRadius;
    const z = Math.sin(angle) * ringRadius;
    const hue = i / 12;
    const pillar = part(`Pillar${i + 1}`, x, 4, z, { x: 2.4, y: 8, z: 2.4 }, hsv(hue), {
      material: 'Neon',
      canCollide: true,
      rotation: { x: 0, y: (i / 12) * 360, z: 0 },
    });
    pillar.props.Transparency = 0.15;
    const light = createInstance('PointLight', 'Glow');
    light.props.Color = COLOR3(...hsv(hue));
    light.props.Brightness = 1.6;
    light.props.Range = 18;
    pillar.addChild(light);
  }

  // Floating islands
  const islandSpots = [
    { x: -46, y: 18, z: -18, r: 0 },
    { x: 48, y: 26, z: 22, r: 0 },
    { x: 24, y: 14, z: -52, r: 0 },
  ];
  for (let i = 0; i < islandSpots.length; i++) {
    const s = islandSpots[i];
    const island = part(`Island${i + 1}`, s.x, s.y, s.z, { x: 16, y: 1.2, z: 16 }, [0.55, 0.5, 0.42], {
      material: 'Slate',
      canCollide: true,
    });
    island.props.Rotation = { x: 0, y: s.r, z: 0 };
    const crystal = part(`Crystal${i + 1}`, s.x, s.y + 5, s.z, { x: 2, y: 8, z: 2 }, [0.3, 0.8, 1], {
      material: 'Glass',
      transparency: 0.2,
      canCollide: false,
      rotation: { x: 0, y: 45, z: 0 },
    });
    const light = createInstance('PointLight', 'CrystalGlow');
    light.props.Color = COLOR3(0.35, 0.8, 1);
    light.props.Brightness = 3;
    light.props.Range = 26;
    crystal.addChild(light);
  }

  // Spawn
  const spawn = createInstance('SpawnLocation', 'SpawnLocation');
  spawn.props.Position = { __t: 'Vector3', x: 0, y: 0.1, z: 0 };
  spawn.props.CFrame = { __t: 'CFrame', p: [0, 0.1, 0], r: [1, 0, 0, 0, 1, 0, 0, 0, 1] };
  spawn.props.Color = COLOR3(0.15, 0.85, 0.35);
  workspace.addChild(spawn);

  // A sign the starter scripts can manipulate
  const sign = part('WelcomeSign', 0, 6, -16, { x: 14, y: 5, z: 0.6 }, [0.12, 0.16, 0.3], {
    material: 'SmoothPlastic',
    canCollide: false,
  });
  const billboard = createInstance('BillboardGui', 'SignGui');
  billboard.props.StudsOffset = { __t: 'Vector3', x: 0, y: 0, z: 0 };
  billboard.props.AlwaysOnTop = true;
  billboard.props.Size = { __t: 'Vector2', x: 10, y: 4 };
  sign.addChild(billboard);
  const label = createInstance('TextLabel', 'Title');
  label.props.Text = 'SCRIPT EXECUTOR LAB';
  label.props.TextColor3 = COLOR3(0.35, 0.95, 1);
  label.props.TextScaled = true;
  label.props.BackgroundTransparency = 1;
  label.props.Size = { x: 1, y: 1, w: 0, h: 0 };
  label.props.Position = { x: 0, y: 0, w: 0, h: 0 };
  billboard.addChild(label);

  // Starter server-side scripts shipped with the place
  const serverScripts = createInstance('Folder', 'ServerScripts');
  workspace.addChild(serverScripts);

  const spinner = createInstance('Script', 'CrystalSpinner');
  spinner.props.Source = `-- Server script: shipped with the place.
-- Runs once on the server when the place loads.
local scene = workspace:FindFirstChild("Showcase")
if not scene then return end

for _, part in ipairs(scene:GetChildren()) do
  if string.find(part.Name, "Crystal") then
    task.spawn(function()
      local base = part.CFrame
      local t = 0
      while true do
        t += task.wait(0.02)
        part.CFrame = base * CFrame.Angles(0, t * 0.9, 0) * CFrame.new(0, math.sin(t * 2) * 1.5, 0)
        part.Orientation = Vector3.new(0, (t * 0.9 * 180 / math.pi) % 360, 0)
      end
    end)
  end
end

print("[server] CrystalSpinner ready")
`;
  spinner.props.Enabled = true;
  serverScripts.addChild(spinner);

  const dayNight = createInstance('Script', 'DayNight');
  dayNight.props.Source = `-- Server script: slowly advances the clock.
while true do
  task.wait(1)
  local lighting = game:GetService("Lighting")
  lighting.ClockTime = (lighting.ClockTime + 0.05) % 24
end
`;
  serverScripts.addChild(dayNight);

  return { scene };
}

function hsv(h) {
  const s = 0.85, v = 1;
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  return [
    [v, t, p],
    [q, v, p],
    [p, v, t],
    [p, q, v],
    [t, p, v],
    [v, p, q],
  ][((i % 6) + 6) % 6];
}
