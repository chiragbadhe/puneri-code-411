export const $ = id => document.getElementById(id);
export const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
export const lerp = (a, b, t) => a + (b - a) * t;
export const damp = (k, dt) => 1 - Math.exp(-k * dt);
export const wrapA = a => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
export const rr = Math.random;
export const rpick = a => a[Math.floor(rr() * a.length)];
export const R = (a, b) => a + (b - a) * rr();
export function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
export const isTouch = matchMedia('(pointer:coarse)').matches || ('ontouchstart' in window);

/** Closest point on segment ab to p. Returns [x, z, t]. */
export function closestOnSeg(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz;
  let t = L2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / L2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return [ax + dx * t, az + dz * t, t];
}
export function pointInPoly(x, z, p) {
  let inside = false;
  for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
    const xi = p[i], zi = p[i + 1], xj = p[j], zj = p[j + 1];
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
/** Polyline helper with cumulative lengths for walking along edges. */
export class Polyline {
  constructor(flat) {
    this.p = flat; this.cum = [0];
    for (let i = 2; i < flat.length; i += 2) this.cum.push(this.cum[this.cum.length - 1] + Math.hypot(flat[i] - flat[i - 2], flat[i + 1] - flat[i - 1]));
    this.len = this.cum[this.cum.length - 1];
  }
  /** position + unit direction at distance s (clamped). */
  at(s, out) {
    s = clamp(s, 0, this.len);
    const c = this.cum; let lo = 0, hi = c.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (c[m] <= s) lo = m; else hi = m; }
    const i = lo * 2, seg = c[hi] - c[lo] || 1e-6, t = (s - c[lo]) / seg;
    const ax = this.p[i], az = this.p[i + 1], bx = this.p[i + 2], bz = this.p[i + 3];
    const dx = (bx - ax) / seg, dz = (bz - az) / seg;
    out.x = ax + (bx - ax) * t; out.z = az + (bz - az) * t; out.dx = dx; out.dz = dz;
    return out;
  }
}
