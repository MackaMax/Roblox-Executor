/**
 * Small math library for Roblox-style transforms.
 *
 * A CFrame (Coordinate Frame) is a rotation (3x3 matrix) plus a position.
 * We represent it as a plain object so it can travel over the wire and be
 * stored in instance properties:
 *
 *   { __t: 'CFrame', p: [x, y, z], r: [r00..r22] }   // rotation row-major
 *
 * Rotations in *script* land are expressed in radians. Roblox properties like
 * `Part.Orientation` use degrees, so conversion helpers live here too.
 */

export const IDENTITY_R = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function cframe(x = 0, y = 0, z = 0, r = IDENTITY_R) {
  return { __t: 'CFrame', p: [x, y, z], r: [...r] };
}

export function cframeFromPosition(v) {
  return cframe(v?.x ?? 0, v?.y ?? 0, v?.z ?? 0);
}

export function posOf(cf) {
  const p = cf?.p ?? [0, 0, 0];
  return { x: p[0], y: p[1], z: p[2] };
}

/** Multiply rotation matrices (row-major 3x3). */
export function matMul(a, b) {
  const o = new Array(9);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      o[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
    }
  }
  return o;
}

export function matTranspose(a) {
  return [a[0], a[3], a[6], a[1], a[4], a[7], a[2], a[5], a[8]];
}

export function matVec(a, v) {
  return [
    a[0] * v[0] + a[1] * v[1] + a[2] * v[2],
    a[3] * v[0] + a[4] * v[1] + a[5] * v[2],
    a[6] * v[0] + a[7] * v[1] + a[8] * v[2],
  ];
}

/** Compose: a * b (b applied first, then a). */
export function cfMul(a, b) {
  const p = matVec(a.r, b.p);
  return {
    __t: 'CFrame',
    p: [p[0] + a.p[0], p[1] + a.p[1], p[2] + a.p[2]],
    r: matMul(a.r, b.r),
  };
}

export function cfTranslate(a, v) {
  return { __t: 'CFrame', p: [a.p[0] + v.x, a.p[1] + v.y, a.p[2] + v.z], r: [...a.r] };
}

export function cfInverse(a) {
  const rt = matTranspose(a.r);
  const p = matVec(rt, a.p);
  return { __t: 'CFrame', p: [-p[0], -p[1], -p[2]], r: rt };
}

export function cfPointToWorld(a, v) {
  const p = matVec(a.r, [v.x, v.y, v.z]);
  return { x: p[0] + a.p[0], y: p[1] + a.p[1], z: p[2] + a.p[2] };
}

export function cfPointToObject(a, v) {
  const inv = cfInverse(a);
  return cfPointToWorld(inv, v);
}

export function cfVectorToWorld(a, v) {
  const p = matVec(a.r, [v.x, v.y, v.z]);
  return { x: p[0], y: p[1], z: p[2] };
}

export function cfVectorToObject(a, v) {
  const rt = matTranspose(a.r);
  const p = matVec(rt, [v.x, v.y, v.z]);
  return { x: p[0], y: p[1], z: p[2] };
}

/** Rotation matrices for a single axis. */
export function rotX(t) {
  const c = Math.cos(t), s = Math.sin(t);
  return [1, 0, 0, 0, c, -s, 0, s, c];
}
export function rotY(t) {
  const c = Math.cos(t), s = Math.sin(t);
  return [c, 0, s, 0, 1, 0, -s, 0, c];
}
export function rotZ(t) {
  const c = Math.cos(t), s = Math.sin(t);
  return [c, -s, 0, s, c, 0, 0, 0, 1];
}

/** Roblox `CFrame.Angles(x, y, z)`: rotations applied X then Y then Z (R = Rx*Ry*Rz). */
export function anglesXYZ(x, y, z) {
  return { __t: 'CFrame', p: [0, 0, 0], r: matMul(matMul(rotX(x), rotY(y)), rotZ(z)) };
}

export function anglesYXZ(y, x, z) {
  return { __t: 'CFrame', p: [0, 0, 0], r: matMul(matMul(rotY(y), rotX(x)), rotZ(z)) };
}

export function fromEulerDegrees(x, y, z) {
  return anglesXYZ((x * Math.PI) / 180, (y * Math.PI) / 180, (z * Math.PI) / 180);
}

/** Extract XYZ Euler angles (radians) from a rotation matrix. */
export function toEulerXYZ(r) {
  // R = Rx * Ry * Rz
  const sy = -r[6]; // -R20
  const cy = Math.sqrt(r[0] * r[0] + r[3] * r[3]);
  if (cy > 1e-7) {
    return [Math.atan2(r[7], r[8]), Math.atan2(sy, cy), Math.atan2(r[3], r[0])];
  }
  return [Math.atan2(-r[5], r[4]), Math.atan2(sy, cy), 0];
}

export function toEulerDegrees(cf) {
  const [x, y, z] = toEulerXYZ(cf?.r ?? IDENTITY_R);
  const deg = (v) => (v * 180) / Math.PI;
  return { x: deg(x), y: deg(y), z: deg(z) };
}

export function lookAtMatrix(eye, target, up = [0, 1, 0]) {
  let fx = target[0] - eye[0], fy = target[1] - eye[1], fz = target[2] - eye[2];
  let len = Math.hypot(fx, fy, fz) || 1;
  fx /= len; fy /= len; fz /= len;
  // right = forward x up
  let rx = fy * up[2] - fz * up[1];
  let ry = fz * up[0] - fx * up[2];
  let rz = fx * up[1] - fy * up[0];
  len = Math.hypot(rx, ry, rz);
  if (len < 1e-6) {
    // forward parallel to up: pick a different up
    return lookAtMatrix(eye, target, [0, 0, 1]);
  }
  rx /= len; ry /= len; rz /= len;
  // up = right x forward
  const ux = ry * fz - rz * fy;
  const uy = rz * fx - rx * fz;
  const uz = rx * fy - ry * fx;
  // Roblox convention: LookVector = -R[2] column (third column negated)
  return [
    -rx, -ry, -rz,
    ux, uy, uz,
    -fx, -fy, -fz,
  ];
}

export function cframeLookAt(eye, target, up) {
  const e = Array.isArray(eye) ? eye : [eye.x, eye.y, eye.z];
  const t = Array.isArray(target) ? target : [target.x, target.y, target.z];
  const r = lookAtMatrix(e, t, up);
  return { __t: 'CFrame', p: e, r };
}

export function cfLerp(a, b, t) {
  const p = [
    a.p[0] + (b.p[0] - a.p[0]) * t,
    a.p[1] + (b.p[1] - a.p[1]) * t,
    a.p[2] + (b.p[2] - a.p[2]) * t,
  ];
  // naive component lerp + orthonormalise (good enough for animation)
  const r = new Array(9);
  for (let i = 0; i < 9; i++) r[i] = a.r[i] + (b.r[i] - a.r[i]) * t;
  return { __t: 'CFrame', p, r: orthonormalize(r) };
}

function orthonormalize(r) {
  let x = [r[0], r[3], r[6]];
  let y = [r[1], r[4], r[7]];
  const norm = (v) => {
    const l = Math.hypot(...v) || 1;
    return v.map((c) => c / l);
  };
  x = norm(x);
  const d = x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
  y = norm([y[0] - x[0] * d, y[1] - x[1] * d, y[2] - x[2] * d]);
  const z = [
    x[1] * y[2] - x[2] * y[1],
    x[2] * y[0] - x[0] * y[2],
    x[0] * y[1] - x[1] * y[0],
  ];
  return [x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]];
}

export function cfLookVector(cf) {
  return { x: -cf.r[2], y: -cf.r[5], z: -cf.r[8] };
}

export function cfRightVector(cf) {
  return { x: cf.r[0], y: cf.r[3], z: cf.r[6] };
}

export function cfUpVector(cf) {
  return { x: cf.r[1], y: cf.r[4], z: cf.r[7] };
}

/* ------------------------------ helpers ------------------------------ */

export function v3(x = 0, y = 0, z = 0) {
  return { x, y, z };
}

export function vadd(a, b) {
  return v3(a.x + b.x, a.y + b.y, a.z + b.z);
}
export function vsub(a, b) {
  return v3(a.x - b.x, a.y - b.y, a.z - b.z);
}
export function vmul(a, s) {
  return v3(a.x * s, a.y * s, a.z * s);
}
export function vdot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}
export function vcross(a, b) {
  return v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
}
export function vlen(a) {
  return Math.hypot(a.x, a.y, a.z);
}
export function vnorm(a) {
  const l = vlen(a) || 1;
  return v3(a.x / l, a.y / l, a.z / l);
}
export function vlerp(a, b, t) {
  return v3(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);
}

export function color3(r = 0, g = 0, b = 0) {
  return { __t: 'Color3', r, g, b };
}

export function colorLerp(a, b, t) {
  return color3(a.r + (b.r - a.r) * t, a.g + (b.g - a.g) * t, a.b + (b.b - a.b) * t);
}

/** HSV (0..1 each) -> Color3, matching Color3.fromHSV. */
export function fromHSV(h, s, v) {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  const table = [
    [v, t, p],
    [q, v, p],
    [p, v, t],
    [p, q, v],
    [t, p, v],
    [v, p, q],
  ][((i % 6) + 6) % 6];
  return color3(...table);
}

/** Color3 -> HSV, matching Color3:ToHSV(). */
export function toHSV(c) {
  const max = Math.max(c.r, c.g, c.b);
  const min = Math.min(c.r, c.g, c.b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === c.r) h = ((c.g - c.b) / d) % 6;
    else if (max === c.g) h = (c.b - c.r) / d + 2;
    else h = (c.r - c.g) / d + 4;
    h /= 6;
    if (h < 0) h += 1;
  }
  const s = max === 0 ? 0 : d / max;
  return { h, s, v: max };
}

/* ------------------------------- raycasts ------------------------------- */

/** Slab test against an axis-aligned box. Returns entry distance or null. */
export function rayAABB(origin, dir, min, max) {
  let tmin = -Infinity;
  let tmax = Infinity;
  for (const axis of ['x', 'y', 'z']) {
    const o = origin[axis], d = dir[axis];
    const lo = min[axis], hi = max[axis];
    if (Math.abs(d) < 1e-9) {
      if (o < lo || o > hi) return null;
    } else {
      let t1 = (lo - o) / d;
      let t2 = (hi - o) / d;
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return null;
    }
  }
  if (tmax < 0) return null;
  return tmin >= 0 ? tmin : 0;
}

/** Axis aligned bounds of a part (rotation-aware for the common Y-only case). */
export function partBounds(part) {
  const cf = part.props.CFrame ?? cframe();
  const size = part.props.Size ?? { x: 4, y: 1, z: 2 };
  const p = posOf(cf);
  const [ex, ey, ez] = toEulerXYZ(cf.r).map((r) => Math.abs(r));
  const cos = Math.cos(ey), sin = Math.sin(ey);
  const hx = size.x / 2, hy = size.y / 2, hz = size.z / 2;
  // For yaw-only rotation, the AABB half-extents are:
  const wx = Math.abs(hx * cos) + Math.abs(hz * sin);
  const wz = Math.abs(hx * sin) + Math.abs(hz * cos);
  void ex; void ez;
  return {
    min: { x: p.x - Math.max(wx, hx), y: p.y - hy, z: p.z - Math.max(wz, hz) },
    max: { x: p.x + Math.max(wx, hx), y: p.y + hy, z: p.z + Math.max(wz, hz) },
  };
}
