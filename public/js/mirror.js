/**
 * Instance mirror — the browser's lightweight copy of the engine tree.
 *
 * The server owns the truth; snapshots arrive over the WebSocket and are
 * applied here. This mirrors how a real Roblox client keeps a local copy of
 * replicated instances: the client can read them, draw them, and make local
 * predictions, but the server is authoritative.
 */

export class MirrorInstance {
  constructor(snapshot, parent = null) {
    this.id = snapshot.id;
    this.className = snapshot.className;
    this.name = snapshot.name;
    this.props = { ...snapshot.props };
    this.tags = new Set(snapshot.tags ?? []);
    this.parent = parent;
    this.children = [];
    this.byName = new Map();
    this.dirty = true;
  }

  get fullName() {
    return this.parent ? `${this.parent.fullName}.${this.name}` : this.name;
  }

  addChild(child) {
    if (child.parent) child.parent.removeChild(child);
    child.parent = this;
    this.children.push(child);
    this.byName.set(child.name, child);
  }

  removeChild(child) {
    const i = this.children.indexOf(child);
    if (i !== -1) this.children.splice(i, 1);
    if (this.byName.get(child.name) === child) this.byName.delete(child.name);
    child.parent = null;
  }

  findFirstChild(name, recursive = false) {
    const direct = this.byName.get(name);
    if (direct) return direct;
    if (recursive) {
      for (const c of this.children) {
        const found = c.findFirstChild(name, true);
        if (found) return found;
      }
    }
    return null;
  }

  findFirstChildOfClass(className) {
    return this.children.find((c) => c.className === className) ?? null;
  }

  isA(className) {
    if (this.className === className) return true;
    const chain = MIRROR_HIERARCHY[this.className] ?? [];
    return chain.includes(className);
  }

  getDescendants() {
    const out = [];
    const walk = (n) => {
      for (const c of n.children) {
        out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }

  /** Apply a fresh snapshot without throwing away the object identity. */
  update(snapshot, parent = null) {
    this.name = snapshot.name;
    this.className = snapshot.className;
    this.props = { ...snapshot.props };
    this.tags = new Set(snapshot.tags ?? []);
    this.parent = parent;
    this.dirty = true;

    const seen = new Set();
    for (const childSnap of snapshot.children ?? []) {
      const existing = this.byName.get(childSnap.name);
      if (existing && existing.className === childSnap.className) {
        existing.update(childSnap, this);
        seen.add(existing);
      } else {
        const inst = new MirrorInstance(childSnap, this);
        this.children.push(inst);
        this.byName.set(inst.name, inst);
        seen.add(inst);
      }
    }
    // drop children that vanished
    for (const child of [...this.children]) {
      if (!seen.has(child)) {
        this.children.splice(this.children.indexOf(child), 1);
        if (this.byName.get(child.name) === child) this.byName.delete(child.name);
      }
    }
    // rebuild the name index defensively (duplicate names allowed in Roblox)
    this.byName = new Map();
    for (const child of this.children) {
      if (!this.byName.has(child.name)) this.byName.set(child.name, child);
    }
  }
}

const MIRROR_HIERARCHY = {
  Part: ['BasePart', 'PVInstance', 'Instance'],
  MeshPart: ['BasePart', 'PVInstance', 'Instance'],
  SpawnLocation: ['BasePart', 'PVInstance', 'Instance'],
  Workspace: ['Model', 'Instance'],
  Model: ['PVInstance', 'Instance'],
  TextLabel: ['GuiLabel', 'GuiObject', 'GuiBase2d', 'Instance'],
  TextButton: ['GuiButton', 'GuiObject', 'GuiBase2d', 'Instance'],
  Frame: ['GuiObject', 'GuiBase2d', 'Instance'],
  ScreenGui: ['LayerCollector', 'Instance'],
  BillboardGui: ['LayerCollector', 'Instance'],
  Script: ['BaseScript', 'Instance'],
  LocalScript: ['BaseScript', 'Instance'],
  PointLight: ['Light', 'Instance'],
};

/* ====================================================================== */
/* Three.js viewport                                                      */
/* ====================================================================== */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const colorToHex = (c) => {
  if (!c || typeof c !== 'object') return 0xaaaaaa;
  const to = (v) => Math.round(Math.max(0, Math.min(1, v)) * 255);
  return (to(c.r) << 16) | (to(c.g) << 8) | to(c.b);
};

const MATERIAL_PRESET = {
  Neon: { emissiveIntensity: 1.6, roughness: 0.4, metalness: 0 },
  Glass: { transmission: 0.85, roughness: 0.15, metalness: 0.1, transparent: true },
  SmoothPlastic: { roughness: 0.5, metalness: 0.05 },
  Plastic: { roughness: 0.7, metalness: 0.02 },
  Metal: { roughness: 0.35, metalness: 0.85 },
  DiamondPlate: { roughness: 0.3, metalness: 0.9 },
  CorrodedMetal: { roughness: 0.8, metalness: 0.5 },
  Wood: { roughness: 0.85, metalness: 0 },
  WoodPlanks: { roughness: 0.85, metalness: 0 },
  Grass: { roughness: 0.95, metalness: 0 },
  Slate: { roughness: 0.9, metalness: 0.05 },
  Concrete: { roughness: 0.95, metalness: 0 },
  Brick: { roughness: 0.9, metalness: 0 },
  Granite: { roughness: 0.6, metalness: 0.1 },
  Marble: { roughness: 0.3, metalness: 0.1 },
  Sand: { roughness: 1, metalness: 0 },
  Fabric: { roughness: 1, metalness: 0 },
  Ice: { roughness: 0.1, metalness: 0.2, transparent: true, opacity: 0.7 },
  ForceField: { emissiveIntensity: 1, transparent: true, opacity: 0.35 },
};

export class Viewport {
  constructor(canvas) {
    this.canvas = canvas;
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0x8fa7bf, 180, 620);

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.camera = new THREE.PerspectiveCamera(70, 1, 0.3, 4000);
    this.camera.position.set(46, 34, 62);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.04;
    this.controls.minDistance = 5;
    this.controls.maxDistance = 480;
    this.controls.target.set(0, 6, 0);

    this.setupEnvironment();

    this.meshByInstanceId = new Map(); // mirror instance id -> { mesh, light, gui }
    this.root = new THREE.Group();
    this.scene.add(this.root);

    this.selectedId = null;
    this.selectionBox = new THREE.BoxHelper(new THREE.Object3D(), 0x5ee7ff);
    this.selectionBox.visible = false;
    this.scene.add(this.selectionBox);

    this.clock = new THREE.Clock();
    this.raycaster = new THREE.Raycaster();
    this.cameraOverride = null;

    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.animate();
  }

  setupEnvironment() {
    // sky gradient via a large sphere with a shader
    const skyGeo = new THREE.SphereGeometry(1800, 32, 16);
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        top: { value: new THREE.Color(0x2b4a72) },
        bottom: { value: new THREE.Color(0xb9d3e8) },
        offset: { value: 120 },
        exponent: { value: 0.85 },
      },
      vertexShader: `
        varying vec3 vWorld;
        void main() {
          vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 top; uniform vec3 bottom; uniform float offset; uniform float exponent;
        varying vec3 vWorld;
        void main() {
          float h = normalize(vWorld + vec3(0.0, offset, 0.0)).y;
          float t = pow(max(h, 0.0), exponent);
          gl_FragColor = vec4(mix(bottom, top, t), 1.0);
        }
      `,
    });
    this.sky = new THREE.Mesh(skyGeo, skyMat);
    this.scene.add(this.sky);

    const hemi = new THREE.HemisphereLight(0xcfe4ff, 0x4a5a45, 1.1);
    this.scene.add(hemi);

    this.sun = new THREE.DirectionalLight(0xfff3dd, 2.2);
    this.sun.position.set(70, 110, 45);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.left = -120;
    this.sun.shadow.camera.right = 120;
    this.sun.shadow.camera.top = 120;
    this.sun.shadow.camera.bottom = -120;
    this.sun.shadow.camera.far = 420;
    this.sun.shadow.bias = -0.0008;
    this.scene.add(this.sun);

    this.ambient = new THREE.AmbientLight(0xffffff, 0.35);
    this.scene.add(this.ambient);

    // subtle grid on the ground plane
    const grid = new THREE.GridHelper(400, 80, 0x2e4a5c, 0x24394a);
    grid.position.y = -0.02;
    grid.material.opacity = 0.28;
    grid.material.transparent = true;
    this.scene.add(grid);
  }

  resize() {
    const w = this.canvas.clientWidth || this.canvas.parentElement.clientWidth;
    const h = this.canvas.clientHeight || this.canvas.parentElement.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /* ------------------------------------------------------------------ */
  /* scene sync                                                          */
  /* ------------------------------------------------------------------ */

  /** Rebuild the whole 3D scene from a workspace mirror. */
  syncWorkspace(workspaceMirror) {
    this.workspaceMirror = workspaceMirror;
    this.syncChildren(workspaceMirror, this.root);
  }

  syncChildren(mirror, group) {
    const seen = new Set();
    for (const child of mirror.children) {
      if (SKIP_CLASSES.has(child.className)) continue;
      const key = child.id;
      let entry = this.meshByInstanceId.get(key);
      if (!entry) {
        entry = this.createEntry(child);
        if (!entry) continue;
        this.meshByInstanceId.set(key, entry);
        group.add(entry.object);
      }
      seen.add(key);
      this.applyEntry(entry, child);

      if (child.children.length && entry.object) {
        this.syncChildren(child, entry.childrenGroup ?? entry.object);
      }
    }
    // remove objects whose instances disappeared
    for (const [id, entry] of [...this.meshByInstanceId]) {
      if (!seen.has(id) && entry.parentGroup === group) {
        group.remove(entry.object);
        this.disposeEntry(entry);
        this.meshByInstanceId.delete(id);
      }
    }
  }

  createEntry(mirror) {
    const cls = mirror.className;

    if (cls === 'Part' || cls === 'MeshPart' || cls === 'SpawnLocation') {
      const isBall = mirror.props.Shape === 'Ball';
      const geo = isBall
        ? new THREE.SphereGeometry(0.5, 32, 24)
        : new THREE.BoxGeometry(1, 1, 1);
      const material = this.materialFor(mirror);
      const mesh = new THREE.Mesh(geo, material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.instanceId = mirror.id;

      const wrapper = new THREE.Group();
      wrapper.add(mesh);
      const childrenGroup = new THREE.Group();
      wrapper.add(childrenGroup);

      return {
        kind: 'part',
        object: wrapper,
        mesh,
        childrenGroup,
        parentGroup: null,
        material,
      };
    }

    if (cls === 'PointLight') {
      const light = new THREE.PointLight(0xffffff, 1, 10, 1.6);
      light.castShadow = false;
      return { kind: 'light', object: light, light };
    }

    if (cls === 'BillboardGui') {
      const group = new THREE.Group();
      return { kind: 'billboard', object: group, childrenGroup: group };
    }

    if (cls === 'TextLabel' || cls === 'TextButton') {
      const canvas = document.createElement('canvas');
      canvas.width = 512;
      canvas.height = 256;
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      const material = new THREE.MeshBasicMaterial({
        map: texture,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 0.5), material);
      return { kind: 'text', object: mesh, canvas, texture, material };
    }

    if (cls === 'Model' || cls === 'Folder' || cls === 'Workspace') {
      const group = new THREE.Group();
      return { kind: 'group', object: group, childrenGroup: group };
    }

    if (cls === 'Camera') {
      return null; // handled separately
    }

    return null;
  }

  materialFor(mirror) {
    const preset = MATERIAL_PRESET[mirror.props.Material] ?? MATERIAL_PRESET.Plastic;
    const color = colorToHex(mirror.props.Color);
    const opts = {
      color,
      roughness: 0.7,
      metalness: 0.05,
      ...preset,
    };
    if (opts.emissiveIntensity !== undefined) {
      opts.emissive = new THREE.Color(color);
    }
    if (mirror.props.Transparency !== undefined && mirror.props.Transparency > 0) {
      opts.transparent = true;
      opts.opacity = Math.max(0.02, 1 - mirror.props.Transparency);
    }
    if (mirror.props.Reflectance) opts.envMapIntensity = 0.5;
    return new THREE.MeshStandardMaterial(opts);
  }

  applyEntry(entry, mirror) {
    entry.parentGroup = this.groupFor(mirror.parent);
    if (entry.kind === 'part') {
      const size = mirror.props.Size ?? { x: 4, y: 1.2, z: 2 };
      const pos = mirror.props.Position ?? { x: 0, y: 0, z: 0 };
      const rot = mirror.props.Orientation ?? { x: 0, y: 0, z: 0 };

      if (mirror.props.Shape === 'Ball') {
        const diameter = Math.max(size.x, size.y, size.z);
        entry.mesh.scale.setScalar(diameter);
      } else {
        entry.mesh.scale.set(Math.max(0.01, size.x), Math.max(0.01, size.y), Math.max(0.01, size.z));
      }
      entry.object.position.set(pos.x, pos.y, pos.z);
      entry.object.rotation.set(
        (rot.x * Math.PI) / 180,
        (rot.y * Math.PI) / 180,
        (rot.z * Math.PI) / 180
      );

      const transparent = (mirror.props.Transparency ?? 0) > 0;
      const targetOpacity = transparent ? Math.max(0.02, 1 - mirror.props.Transparency) : 1;
      const needsMaterialReset =
        entry.material.userData.colorHex !== colorToHex(mirror.props.Color) ||
        entry.material.userData.material !== mirror.props.Material;
      if (needsMaterialReset) {
        const next = this.materialFor(mirror);
        entry.mesh.material.dispose();
        entry.mesh.material = next;
        entry.material = next;
        next.userData.colorHex = colorToHex(mirror.props.Color);
        next.userData.material = mirror.props.Material;
      }
      entry.material.opacity = targetOpacity;
      entry.material.transparent = transparent || entry.material.userData.forceTransparent === true;
    }

    if (entry.kind === 'light') {
      const color = colorToHex(mirror.props.Color ?? { r: 1, g: 1, b: 1 });
      entry.light.color.setHex(color);
      entry.light.intensity = (mirror.props.Brightness ?? 1) * 6;
      entry.light.distance = mirror.props.Range ?? 8;
      entry.light.visible = mirror.props.Enabled !== false;
    }

    if (entry.kind === 'billboard') {
      const parentPart = mirror.parent;
      const offset = mirror.props.StudsOffset ?? { x: 0, y: 0, z: 0 };
      if (parentPart) {
        const size = parentPart.props.Size ?? { x: 1, y: 1, z: 1 };
        entry.object.position.set(offset.x, offset.y + (size.y ?? 1) / 2 + 1.2, offset.z);
      }
    }

    if (entry.kind === 'text') {
      this.drawText(entry, mirror);
      const size = mirror.props.Size ?? { w: 0.2, h: 0.1 };
      const w = (size.w ?? 0.2) * 12;
      const h = (size.h ?? 0.1) * 12;
      entry.object.scale.setScalar(1);
      entry.object.geometry.dispose();
      entry.object.geometry = new THREE.PlaneGeometry(w, h);
      // billboard text always faces the camera
      entry.object.userData.isBillboard = true;
    }
  }

  drawText(entry, mirror) {
    const { canvas, texture } = entry;
    const ctx = canvas.getContext('2d');
    const text = mirror.props.Text ?? '';
    const bg = mirror.props.BackgroundTransparency === 1 ? null : mirror.props.BackgroundColor3;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (bg) {
      ctx.fillStyle = `rgb(${Math.round((bg.r ?? 0) * 255)}, ${Math.round((bg.g ?? 0) * 255)}, ${Math.round((bg.b ?? 0) * 255)})`;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    const c = mirror.props.TextColor3 ?? { r: 1, g: 1, b: 1 };
    ctx.fillStyle = `rgb(${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)})`;
    const size = mirror.props.TextSize ?? 64;
    const fontSize = Math.max(18, Math.min(160, size * 2));
    ctx.font = `600 ${fontSize}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(text), canvas.width / 2, canvas.height / 2, canvas.width - 24);
    texture.needsUpdate = true;
  }

  groupFor(mirror) {
    if (!mirror) return this.root;
    for (const [, entry] of this.meshByInstanceId) {
      if (entry.object?.userData?.instanceId === mirror.id && entry.childrenGroup) return entry.childrenGroup;
      if (entry.mirrorId === mirror.id) return entry.childrenGroup ?? entry.object;
    }
    return this.root;
  }

  disposeEntry(entry) {
    entry.object?.traverse?.((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
        else obj.material.dispose();
      }
    });
    if (entry.texture) entry.texture.dispose();
  }

  /* ------------------------------------------------------------------ */
  /* camera from the engine                                              */
  /* ------------------------------------------------------------------ */

  applyCamera(cameraMirror) {
    if (!cameraMirror) {
      this.cameraOverride = null;
      return;
    }
    const cf = cameraMirror.props.CFrame;
    if (!cf) {
      this.cameraOverride = null;
      return;
    }
    const p = cf.p;
    const r = cf.r;
    // Roblox LookVector = -third column
    const forward = new THREE.Vector3(-r[2], -r[5], -r[8]).normalize();
    const up = new THREE.Vector3(r[1], r[4], r[7]).normalize();
    this.cameraOverride = {
      position: new THREE.Vector3(p[0], p[1], p[2]),
      target: new THREE.Vector3(p[0], p[1], p[2]).add(forward),
      up,
      fov: cameraMirror.props.FieldOfView ?? 70,
    };
    void up;
  }

  /* ------------------------------------------------------------------ */
  /* picking / selection                                                 */
  /* ------------------------------------------------------------------ */

  pick(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const meshes = [];
    this.root.traverse((obj) => {
      if (obj.isMesh) meshes.push(obj);
    });
    const hits = this.raycaster.intersectObjects(meshes, false);
    if (!hits.length) return null;
    let obj = hits[0].object;
    while (obj && !obj.userData.instanceId) obj = obj.parent;
    return obj?.userData.instanceId ?? null;
  }

  select(instanceId) {
    this.selectedId = instanceId;
    let target = null;
    if (instanceId) {
      for (const [, entry] of this.meshByInstanceId) {
        if (entry.kind === 'part' && entry.mesh.userData.instanceId === instanceId) {
          target = entry.mesh;
          break;
        }
      }
    }
    if (target) {
      this.selectionBox.setFromObject(target);
      this.selectionBox.visible = true;
    } else {
      this.selectionBox.visible = false;
    }
  }

  focusOn(instanceId) {
    let target = null;
    for (const [, entry] of this.meshByInstanceId) {
      if (entry.kind === 'part' && entry.mesh.userData.instanceId === instanceId) {
        target = entry.object;
        break;
      }
    }
    if (!target) return;
    const box = new THREE.Box3().setFromObject(target);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3()).length();
    this.controls.target.copy(center);
    const dir = new THREE.Vector3(1, 0.8, 1).normalize();
    this.camera.position.copy(center).addScaledVector(dir, Math.max(12, size * 2.4));
    this.controls.update();
  }

  /* ------------------------------------------------------------------ */
  /* frame loop                                                          */
  /* ------------------------------------------------------------------ */

  animate() {
    requestAnimationFrame(() => this.animate());
    const dt = Math.min(0.05, this.clock.getDelta());
    void dt;

    if (this.cameraOverride) {
      this.camera.position.lerp(this.cameraOverride.position, 0.16);
      this.controls.target.lerp(this.cameraOverride.target, 0.16);
      this.camera.up.copy(this.cameraOverride.up);
      if (this.camera.fov !== this.cameraOverride.fov) {
        this.camera.fov = this.cameraOverride.fov;
        this.camera.updateProjectionMatrix();
      }
    }

    this.controls.update();

    // billboards face the camera
    this.root.traverse((obj) => {
      if (obj.userData?.isBillboard) obj.lookAt(this.camera.position);
    });

    // keep the selection box in sync with moving parts
    if (this.selectionBox.visible) {
      for (const [, entry] of this.meshByInstanceId) {
        if (entry.kind === 'part' && entry.mesh.userData.instanceId === this.selectedId) {
          this.selectionBox.setFromObject(entry.mesh);
          break;
        }
      }
    }

    this.renderer.render(this.scene, this.camera);
  }
}

const SKIP_CLASSES = new Set([
  'Camera',
  'Script',
  'LocalScript',
  'ModuleScript',
  'SpawnLocation',
  'RemoteEvent',
  'BindableEvent',
  'Folder',
  'Sky',
  'Atmosphere',
  'Sound',
  'PointLight',
]);

// SpawnLocation is drawn like a part: remove it from the skip list at runtime
SKIP_CLASSES.delete('SpawnLocation');
SKIP_CLASSES.delete('PointLight');
SKIP_CLASSES.delete('Folder');

export { colorToHex, MIRROR_HIERARCHY };
