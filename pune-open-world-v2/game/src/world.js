// Real-Pune world: loads pipeline output, streams chunks, answers ground height and collision queries.
import * as THREE from 'three';
import { clamp, pointInPoly, closestOnSeg, mulberry32, isTouch, Polyline } from './util.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const DRIVE = new Set(['trunk', 'trunk_link', 'primary', 'primary_link', 'secondary', 'secondary_link', 'tertiary', 'tertiary_link', 'residential', 'unclassified', 'living_street', 'service']);
const BIG = new Set(['trunk', 'primary', 'secondary', 'trunk_link', 'primary_link', 'secondary_link']);
const CELL = 16;            // collision hash cell (m)
const ECELL = 40;           // road-graph hash cell (m)

function canvasTex(w, h, draw, renderer, repeat) {
  const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = Math.min(16, renderer.capabilities.getMaxAnisotropy());
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; }
  return t;
}

export class World {
  constructor(scene, renderer, base) {
    this.scene = scene; this.renderer = renderer; this.base = base;
    this.chunks = new Map(); this.queue = []; this.cells = new Map(); this.bridgeCells = new Map(); this.edgeCells = new Map();
    this.texSize = isTouch ? 512 : 1024; this.loadR = isTouch ? 420 : 560; this.dropR = this.loadR + 180;
    this.night = 0; this.wet = 0;
  }

  async load(progress) {
    const j = f => fetch(this.base + f).then(r => { if (!r.ok) throw new Error(f + ' ' + r.status); return r.json(); });
    progress(.05, 'manifest');
    this.man = await j('manifest.json');
    progress(.15, 'terrain'); this.ter = await j('terrain.json');
    progress(.3, 'roads'); this.roads = await j('roads.json');
    progress(.45, 'areas'); this.areas = await j('areas.json');
    progress(.6, 'road graph'); this.graph = await j('graph.json');
    progress(.7, 'minimap');
    this.minimap = await new Promise((ok, bad) => { const im = new Image(); im.onload = () => ok(im); im.onerror = bad; im.src = this.base + this.man.minimap.file; });
    const T = this.ter; this.tH = new Float32Array(T.dm.length); for (let i = 0; i < T.dm.length; i++) this.tH[i] = T.dm[i] / 10;
    this._prepGraph(); this._prepBridges(); this._makeMaterials();
    progress(.75, 'Blender assets'); await this._loadAssets();
    const [bx0, bz0, bx1, bz1] = this.man.bbox; this.bbox = { x0: bx0, z0: bz0, x1: bx1, z1: bz1 };
    this.chunkSet = new Set(this.man.chunks.map(c => c[0] + '_' + c[1]));
    progress(.8, 'city');
  }

  // ------------------------------------------------------------------ ground
  terrainAt(x, z) {
    const T = this.ter, fx = clamp((x - T.x0) / T.spacing, 0, T.w - 1.001), fz = clamp((z - T.z0) / T.spacing, 0, T.h - 1.001);
    const i = fx | 0, j = fz | 0, u = fx - i, v = fz - j, w = T.w, H = this.tH, k = j * w + i;
    return H[k] * (1 - u) * (1 - v) + H[k + 1] * u * (1 - v) + H[k + w] * (1 - u) * v + H[k + w + 1] * u * v;
  }
  groundAt(x, z) {
    let y = this.terrainAt(x, z);
    const list = this.bridgeCells.get(this._key(x, z, CELL));
    if (list) for (const s of list) {
      const [cx, cz, t] = closestOnSeg(x, z, s.ax, s.az, s.bx, s.bz);
      if ((x - cx) ** 2 + (z - cz) ** 2 < s.hw * s.hw) y = Math.max(y, s.ya + (s.yb - s.ya) * t);
    }
    return y;
  }
  _key(x, z, c) { return (Math.floor(x / c) + 32768) * 65536 + (Math.floor(z / c) + 32768); }  // collision-free cell key

  _prepBridges() {
    const deckMat = new THREE.MeshLambertMaterial({ color: 0x9a948a }), railMat = new THREE.MeshLambertMaterial({ color: 0xd8d2c4 });
    this.bridgeMeshes = [];
    for (const rd of this.roads) {
      if (!rd.b || !DRIVE.has(rd.c)) continue;
      const pl = new Polyline(rd.p), p = rd.p, n = p.length / 2;
      const ya = this.terrainAt(p[0], p[1]) + .25, yb = this.terrainAt(p[p.length - 2], p[p.length - 1]) + .25;
      const hw = rd.w / 2 + 1.2, pos = [], idx = [];
      for (let i = 0; i < n; i++) {
        const s = pl.cum[i], y = ya + (yb - ya) * (s / (pl.len || 1));
        const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
        let dx = p[b * 2] - p[a * 2], dz = p[b * 2 + 1] - p[a * 2 + 1]; const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
        const lx = -dz * hw, lz = dx * hw, x = p[i * 2], z = p[i * 2 + 1];
        pos.push(x + lx, y, z + lz, x - lx, y, z - lz, x + lx, y - 1.4, z + lz, x - lx, y - 1.4, z - lz);
        if (i < n - 1) { const o = i * 4; idx.push(o, o + 4, o + 1, o + 1, o + 4, o + 5, o + 2, o + 3, o + 6, o + 3, o + 7, o + 6, o, o + 2, o + 4, o + 2, o + 6, o + 4, o + 1, o + 5, o + 3, o + 3, o + 5, o + 7); }
        if (i < n - 1) {
          const sa = { ax: x, az: z, bx: p[i * 2 + 2], bz: p[i * 2 + 3], ya: y, yb: ya + (yb - ya) * (pl.cum[i + 1] / (pl.len || 1)), hw };
          const steps = Math.ceil(Math.hypot(sa.bx - sa.ax, sa.bz - sa.az) / 6) + 1;
          for (let k = 0; k <= steps; k++) for (const off of [-hw, 0, hw]) {
            const tx = sa.ax + (sa.bx - sa.ax) * k / steps - dz * off, tz = sa.az + (sa.bz - sa.az) * k / steps + dx * off;
            const key = this._key(tx, tz, CELL); if (!this.bridgeCells.has(key)) this.bridgeCells.set(key, []);
            const arr = this.bridgeCells.get(key); if (!arr.includes(sa)) arr.push(sa);
          }
        }
      }
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
      const deck = new THREE.Mesh(g, deckMat); this.scene.add(deck); this.bridgeMeshes.push(deck);
      // railings
      for (let i = 0; i < n - 1; i++) {
        const ax = p[i * 2], az = p[i * 2 + 1], bx = p[i * 2 + 2], bz = p[i * 2 + 3], L = Math.hypot(bx - ax, bz - az) || 1, dx = (bx - ax) / L, dz = (bz - az) / L;
        const y = ya + (yb - ya) * ((pl.cum[i] + pl.cum[i + 1]) / 2 / (pl.len || 1));
        for (const sgn of [-1, 1]) {
          const m = new THREE.Mesh(this._box || (this._box = new THREE.BoxGeometry(1, 1, 1)), railMat);
          m.scale.set(.35, 1.1, L); m.position.set((ax + bx) / 2 - dz * hw * sgn, y + .55, (az + bz) / 2 + dx * hw * sgn); m.rotation.y = Math.atan2(dx, dz);
          this.scene.add(m);
        }
      }
      // the deck should also draw the road surface: paint stripe texture via a thin top quad
      const top = new THREE.Mesh(g, this.asphaltBridge || (this.asphaltBridge = new THREE.MeshLambertMaterial({ color: 0x47454f, polygonOffset: true, polygonOffsetFactor: -2 })));
      top.position.y = .02; this.scene.add(top);
    }
  }

  // ------------------------------------------------------------------ graph
  _prepGraph() {
    const G = this.graph; this.nodeAdj = Array.from({ length: G.nodes.length / 2 }, () => []);
    this.edges = G.edges.map((e, i) => {
      const ed = { i, a: e[0], b: e[1], oneway: e[2], drive: !!e[3], weight: e[4], w: e[5], name: G.names[e[6]], len: e[7], pl: new Polyline(e[8]) };
      this.nodeAdj[ed.a].push(ed); this.nodeAdj[ed.b].push(ed);
      const p = e[8];
      for (let k = 0; k < p.length - 2; k += 2) {
        const L = Math.hypot(p[k + 2] - p[k], p[k + 3] - p[k + 1]), st = Math.ceil(L / 15);
        for (let s = 0; s <= st; s++) {
          const key = this._key(p[k] + (p[k + 2] - p[k]) * s / st, p[k + 1] + (p[k + 3] - p[k + 1]) * s / st, ECELL);
          if (!this.edgeCells.has(key)) this.edgeCells.set(key, new Set()); this.edgeCells.get(key).add(ed);
        }
      }
      return ed;
    });
  }
  nodeXZ(n) { return [this.graph.nodes[n * 2], this.graph.nodes[n * 2 + 1]]; }
  /** nearest edge to a point; drivableOnly filters. Returns {edge, s, dist, x, z} */
  nearestEdge(x, z, drivableOnly, maxR = 120) {
    let best = null, bd = 1e18;
    for (let r = 0; r <= maxR / ECELL && !best; r++) {
      for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) {
        if (Math.max(Math.abs(i), Math.abs(j)) !== r) continue;
        const set = this.edgeCells.get(this._key(x + i * ECELL, z + j * ECELL, ECELL)); if (!set) continue;
        for (const ed of set) {
          if (drivableOnly && !ed.drive) continue;
          const p = ed.pl.p;
          for (let k = 0; k < p.length - 2; k += 2) {
            const [cx, cz, t] = closestOnSeg(x, z, p[k], p[k + 1], p[k + 2], p[k + 3]); const d = (x - cx) ** 2 + (z - cz) ** 2;
            if (d < bd) { bd = d; best = { edge: ed, s: ed.pl.cum[k / 2] + t * (ed.pl.cum[k / 2 + 1] - ed.pl.cum[k / 2]), dist: Math.sqrt(d), x: cx, z: cz }; }
          }
        }
      }
    }
    return best;
  }
  canTraverse(ed, fromNode) { return fromNode === ed.a ? ed.oneway !== -1 : ed.oneway !== 1; }
  /** A* on the drivable graph. Returns array of [x,z] points. */
  route(fromXZ, toXZ) {
    const s = this.nearestEdge(fromXZ[0], fromXZ[1], true, 300), t = this.nearestEdge(toXZ[0], toXZ[1], true, 300);
    if (!s || !t) return null;
    const goalNodes = new Set([t.edge.a, t.edge.b]), [gx, gz] = toXZ;
    const h = n => { const [x, z] = this.nodeXZ(n); return Math.hypot(x - gx, z - gz); };
    const open = new Map(), came = new Map(), g = new Map(), closed = new Set();
    for (const n of [s.edge.a, s.edge.b]) { const d = n === s.edge.a ? s.s : s.edge.len - s.s; g.set(n, d); open.set(n, d + h(n)); came.set(n, null); }
    let end = null, guard = 0;
    while (open.size && guard++ < 20000) {
      let cur = null, cf = 1e18; for (const [n, f] of open) if (f < cf) { cf = f; cur = n; }
      open.delete(cur); if (goalNodes.has(cur)) { end = cur; break; } closed.add(cur);
      for (const ed of this.nodeAdj[cur]) {
        if (!ed.drive || !this.canTraverse(ed, cur)) continue;
        const nb = ed.a === cur ? ed.b : ed.a; if (closed.has(nb)) continue;
        const ng = g.get(cur) + ed.len * (ed.weight >= 3 ? .85 : 1);
        if (!g.has(nb) || ng < g.get(nb)) { g.set(nb, ng); came.set(nb, { n: cur, ed }); open.set(nb, ng + h(nb)); }
      }
    }
    if (end === null) return null;
    const pts = [[t.x, t.z]]; let n = end;
    while (came.get(n)) { const { n: prev, ed } = came.get(n); const p = ed.pl.p; const fwd = ed.a === prev;
      const seq = []; for (let k = 0; k < p.length; k += 2) seq.push([p[k], p[k + 1]]); if (fwd) seq.reverse(); pts.push(...seq); n = prev; }
    pts.push([s.x, s.z]); pts.reverse(); return pts;
  }

  // ------------------------------------------------------------------ collision
  _addCollider(chunkKey, poly, solid) {
    const p = poly, rec = { p, c: chunkKey, solid };
    let x0 = 1e9, z0 = 1e9, x1 = -1e9, z1 = -1e9;
    for (let i = 0; i < p.length; i += 2) { x0 = Math.min(x0, p[i]); x1 = Math.max(x1, p[i]); z0 = Math.min(z0, p[i + 1]); z1 = Math.max(z1, p[i + 1]); }
    rec.bb = [x0, z0, x1, z1];
    for (let i = Math.floor(x0 / CELL); i <= Math.floor(x1 / CELL); i++) for (let j = Math.floor(z0 / CELL); j <= Math.floor(z1 / CELL); j++) {
      const k = (i + 32768) * 65536 + (j + 32768); if (!this.cells.has(k)) this.cells.set(k, []); this.cells.get(k).push(rec);
    }
  }
  _addCircle(chunkKey, x, z, r, canopy, top, bottom) {
    const rec = { circle: true, x, z, r, c: chunkKey, bb: [x - r, z - r, x + r, z + r], canopy: canopy || 0, top: top || 0, bottom: bottom || 0 };
    if (canopy) { (this.canopies || (this.canopies = new Map())); const k2 = this._key(x, z, 24); if (!this.canopies.has(k2)) this.canopies.set(k2, []); this.canopies.get(k2).push(rec); }
    const k = (Math.floor(x / CELL) + 32768) * 65536 + (Math.floor(z / CELL) + 32768);
    if (!this.cells.has(k)) this.cells.set(k, []); this.cells.get(k).push(rec);
  }
  /** true if a camera at (x,y,z) would sit inside a tree canopy */
  inCanopy(x, y, z) {
    if (!this.canopies) return false;
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) { const arr = this.canopies.get(this._key(x + i * 24, z + j * 24, 24)); if (!arr) continue;
      for (const r of arr) if (y < r.top && y > r.bottom - .4 && (x - r.x) ** 2 + (z - r.z) ** 2 < r.canopy * r.canopy) return r; }
    return null;
  }
  _dropColliders(chunkKey) {
    if (this.canopies) for (const [k, arr] of this.canopies) { const f = arr.filter(r => r.c !== chunkKey); if (f.length) this.canopies.set(k, f); else this.canopies.delete(k); } for (const [k, arr] of this.cells) { const f = arr.filter(r => r.c !== chunkKey); if (f.length) this.cells.set(k, f); else this.cells.delete(k); } }
  /** Push a circle {x,z} of radius r out of buildings. Returns contact normal or null. */
  collide(o, r) {
    let hit = null; const seen = new Set();
    for (let i = Math.floor((o.x - r) / CELL); i <= Math.floor((o.x + r) / CELL); i++) for (let j = Math.floor((o.z - r) / CELL); j <= Math.floor((o.z + r) / CELL); j++) {
      const arr = this.cells.get((i + 32768) * 65536 + (j + 32768)); if (!arr) continue;
      for (const rec of arr) {
        if (seen.has(rec)) continue; seen.add(rec);
        const bb = rec.bb; if (o.x + r < bb[0] || o.x - r > bb[2] || o.z + r < bb[1] || o.z - r > bb[3]) continue;
        if (rec.circle) { const dx = o.x - rec.x, dz = o.z - rec.z, d = Math.hypot(dx, dz), rr2 = r + rec.r; if (d < rr2 && d > 1e-4) { const nx = dx / d, nz = dz / d; o.x = rec.x + nx * rr2; o.z = rec.z + nz * rr2; hit = { nx, nz }; } continue; }
        const p = rec.p; let bd = 1e18, bx = 0, bz = 0;
        for (let k = 0, m = p.length - 2; k < p.length; m = k, k += 2) {
          const [cx, cz] = closestOnSeg(o.x, o.z, p[m], p[m + 1], p[k], p[k + 1]); const d = (o.x - cx) ** 2 + (o.z - cz) ** 2;
          if (d < bd) { bd = d; bx = cx; bz = cz; }
        }
        const inside = rec.solid && pointInPoly(o.x, o.z, p);
        if (inside || bd < r * r) {
          const d = Math.sqrt(bd) || 1e-4; let nx = (o.x - bx) / d, nz = (o.z - bz) / d;
          if (inside) { nx = -nx; nz = -nz; }
          const pen = inside ? r + d : r - d; o.x += nx * pen; o.z += nz * pen; hit = { nx, nz };
        }
      }
    }
    const b = this.bbox, m = 4;
    if (o.x < b.x0 + m) { o.x = b.x0 + m; hit = { nx: 1, nz: 0 }; } if (o.x > b.x1 - m) { o.x = b.x1 - m; hit = { nx: -1, nz: 0 }; }
    if (o.z < b.z0 + m) { o.z = b.z0 + m; hit = { nx: 0, nz: 1 }; } if (o.z > b.z1 - m) { o.z = b.z1 - m; hit = { nx: 0, nz: -1 }; }
    return hit;
  }
  insideBuilding(x, z) { const arr = this.cells.get(this._key(x, z, CELL)); if (!arr) return false; for (const r of arr) if (r.solid && !r.circle && pointInPoly(x, z, r.p)) return true; return false; }
  lineOfSight(x1, z1, x2, z2) { const d = Math.hypot(x2 - x1, z2 - z1), n = Math.ceil(d / 5); for (let k = 1; k < n; k++) if (this.insideBuilding(x1 + (x2 - x1) * k / n, z1 + (z2 - z1) * k / n)) return false; return true; }

  // ------------------------------------------------------------------ materials & textures
  _makeMaterials() {
    const r = this.renderer, rnd = mulberry32(411);
    const bay = (g, x, y, w, h, lit, variant) => {
      if (lit) { g.fillStyle = rnd() < .45 ? ['#ffd27a', '#ffe9b0', '#a9e8ff', '#ffc0e0'][Math.floor(rnd() * 4)] : '#000'; g.fillRect(x + 10, y + 12, w - 20, h - 26); return; }
      g.fillStyle = '#efe9df'; g.fillRect(x, y, w, h);
      g.fillStyle = '#d9d0c2'; g.fillRect(x, y + h - 6, w, 6);                         // floor slab line
      g.fillStyle = '#3e4a5a'; g.fillRect(x + 10, y + 12, w - 20, h - 26);               // window
      g.fillStyle = '#e8e2d6'; g.fillRect(x + w / 2 - 1, y + 12, 2, h - 26);
      if (variant === 1) { g.fillStyle = '#5d6470'; for (let k = 0; k < 6; k++) g.fillRect(x + 8, y + h - 22 + k * 0, w - 16, 2); g.fillRect(x + 8, y + h - 24, w - 16, 3); for (let k = x + 10; k < x + w - 8; k += 6) g.fillRect(k, y + h - 24, 1.5, 12); }
      if (variant === 2) { g.fillStyle = '#d7d3cc'; g.fillRect(x + w - 26, y + 16, 18, 12); g.fillStyle = '#8a8a8a'; g.fillRect(x + w - 24, y + 18, 14, 2); }
      if (variant === 3) { g.fillStyle = '#7a5a3a'; g.fillRect(x + 10, y + 12, w - 20, h - 26); g.fillStyle = '#5a3f28'; for (let k = y + 14; k < y + h - 14; k += 4) g.fillRect(x + 11, k, w - 22, 1.5); }
    };
    const winDraw = lit => (g) => { for (let fy = 0; fy < 4; fy++) for (let bx = 0; bx < 4; bx++) bay(g, bx * 64, fy * 64, 64, 64, lit, Math.floor(rnd() * 4)); };
    const shopDraw = lit => (g) => {
      const signs = ['#c0392b', '#1f6fb2', '#f39c12', '#16a085', '#8e44ad', '#d35400', '#2c3e50', '#27ae60'];
      for (let s = 0; s < 4; s++) {
        const x = s * 64;
        if (lit) { g.fillStyle = '#000'; g.fillRect(x, 0, 64, 64); g.fillStyle = rnd() < .8 ? '#ffcf8a' : '#000'; g.fillRect(x + 4, 22, 56, 40); g.fillStyle = '#fff3c4'; g.fillRect(x + 2, 4, 60, 14); continue; }
        g.fillStyle = '#d8d0c0'; g.fillRect(x, 0, 64, 64);
        g.fillStyle = signs[Math.floor(rnd() * signs.length)]; g.fillRect(x + 2, 4, 60, 14);
        g.fillStyle = 'rgba(255,255,255,.85)'; for (let k = 0; k < 5; k++) g.fillRect(x + 8 + k * 10, 8, 6, 6);
        if (rnd() < .45) { g.fillStyle = '#8d9096'; g.fillRect(x + 4, 22, 56, 40); g.fillStyle = '#6f7278'; for (let k = 24; k < 62; k += 3) g.fillRect(x + 4, k, 56, 1); }
        else { g.fillStyle = '#3b2f2a'; g.fillRect(x + 4, 22, 56, 40); g.fillStyle = ['#e8b04b', '#d95d39', '#4aa3df', '#e5e5e5'][Math.floor(rnd() * 4)]; for (let k = 0; k < 4; k++) g.fillRect(x + 8 + k * 13, 40, 10, 20); }
      }
    };
    const W = 256;
    this.winTex = canvasTex(W, W, winDraw(false), r, true); this.winLit = canvasTex(W, W, winDraw(true), r, true);
    this.shopTex = canvasTex(W, 64, shopDraw(false), r, true); this.shopLit = canvasTex(W, 64, shopDraw(true), r, true);
    this.stoneTex = canvasTex(128, 128, (g) => { g.fillStyle = '#9a7652'; g.fillRect(0, 0, 128, 128); for (let y = 0; y < 128; y += 16) for (let x = (y / 16) % 2 * 16; x < 128; x += 32) { g.fillStyle = `rgb(${130 + rnd() * 40},${98 + rnd() * 30},${66 + rnd() * 24})`; g.fillRect(x + 1, y + 1, 30, 14); } }, r, true);
    this.mWall = new THREE.MeshLambertMaterial({ map: this.winTex, emissiveMap: this.winLit, emissive: 0xffffff, emissiveIntensity: 0, vertexColors: true });
    this.mShop = new THREE.MeshLambertMaterial({ map: this.shopTex, emissiveMap: this.shopLit, emissive: 0xffffff, emissiveIntensity: 0, vertexColors: true });
    this.mRoof = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.mStone = new THREE.MeshLambertMaterial({ map: this.stoneTex, vertexColors: true, side: THREE.DoubleSide });
    this.mGold = new THREE.MeshLambertMaterial({ color: 0xf2c24b, emissive: 0xff9a1f, emissiveIntensity: .15 });
    this.mTempleW = new THREE.MeshLambertMaterial({ color: 0xf6efe2, emissive: 0xffb060, emissiveIntensity: 0 });
    this.mTrunk = new THREE.MeshLambertMaterial({ color: 0x6b4a2f }); this.mCrown = new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true });
    this.mTank = new THREE.MeshLambertMaterial({ color: 0x1f1f22 });
    this.gTrunk = new THREE.CylinderGeometry(.25, .38, 1, 6).translate(0, .5, 0); this.gCrown = new THREE.IcosahedronGeometry(1, 1);
    this.gTank = new THREE.CylinderGeometry(.6, .6, 1.5, 8).translate(0, .75, 0);
    this.noise = document.createElement('canvas'); this.noise.width = this.noise.height = 128;
    { const g = this.noise.getContext('2d'); for (let k = 0; k < 2600; k++) { const v = Math.floor(rnd() * 255); g.fillStyle = `rgba(${v},${v},${v},${.05 + rnd() * .08})`; g.fillRect(rnd() * 128, rnd() * 128, 1 + rnd() * 2, 1 + rnd() * 2); } }
    this.signCache = new Map();
  }
  async _loadAssets() {
    const A = this.assetBase || 'assets/', tl = new THREE.TextureLoader(), an = Math.min(16, this.renderer.capabilities.getMaxAnisotropy());
    const tex = f => new Promise(ok => tl.load(A + f, t => { t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = an; ok(t); }, undefined, () => ok(null)));
    const [apt, aptN, old, oldN, tower, towerN, shop, shopN, tiles] = await Promise.all(['facade_apt.png', 'facade_apt_night.png', 'facade_old.png', 'facade_old_night.png', 'facade_tower.png', 'facade_tower_night.png', 'facade_shop.png', 'facade_shop_night.png', 'roof_tiles.png'].map(tex));
    const fac = (map, night, fb) => new THREE.MeshLambertMaterial({ map: map || fb.map, emissiveMap: night || fb.emissiveMap, emissive: 0xffffff, emissiveIntensity: 0, vertexColors: true });
    this.mApt = fac(apt, aptN, this.mWall); this.mOld = fac(old, oldN, this.mWall); this.mTower = fac(tower, towerN, this.mWall); this.mShop = fac(shop, shopN, this.mShop);
    this.facades = [this.mApt, this.mOld, this.mTower, this.mShop];
    this.mPlain = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
    this.mTile = new THREE.MeshLambertMaterial({ map: tiles, vertexColors: true, side: THREE.DoubleSide });
    try {
      const gl = await new GLTFLoader().loadAsync(A + 'props.gltf.json'); gl.scene.updateMatrixWorld(true); this.props = {}; this.lampMats = [];
      const tg = await new GLTFLoader().loadAsync(A + 'trees.gltf.json'); tg.scene.updateMatrixWorld(true); this.treeParts = [];
      ['tree_neem', 'tree_gulmohar', 'tree_banyan', 'tree_palm', 'tree_ashoka'].forEach((name, i) => {
        const node = tg.scene.getObjectByName(name); const parts = [];
        if (node) node.traverse(o => { if (o.isMesh) { const g = o.geometry.clone().applyMatrix4(o.matrixWorld); g.userData.shared = true; parts.push({ geo: g, mat: o.material }); } });
        this.treeParts[i] = parts;
      });
      for (const name of ['water_tank', 'ac_unit', 'balcony', 'stair_head', 'dish', 'street_lamp']) {
        const node = gl.scene.getObjectByName(name); if (!node) continue; const parts = [];
        node.traverse(o => { if (o.isMesh) { const g = o.geometry.clone().applyMatrix4(o.matrixWorld); g.userData.shared = true; const m = o.material; if (m.emissive && m.emissive.r > .5) this.lampMats.push(m); parts.push({ geo: g, mat: m }); } });
        this.props[name] = parts;
      }
    } catch (e) { console.warn('props.glb', e); }
  }
  signTex(label) {
    if (this.signCache.has(label)) return this.signCache.get(label);
    const bgs = ['#b3261e', '#0d5c9e', '#e0a100', '#11806a', '#6c2a8c', '#1d1d1d'], fgs = ['#ffffff', '#ffe14d', '#ffffff', '#fff5d6', '#ffe14d', '#2ff3e0'];
    const k = [...label].reduce((a, c) => a + c.charCodeAt(0), 0) % bgs.length;
    const t = canvasTex(256, 64, g => { g.fillStyle = bgs[k]; g.fillRect(0, 0, 256, 64); g.strokeStyle = fgs[k]; g.lineWidth = 4; g.strokeRect(4, 4, 248, 56); g.fillStyle = fgs[k]; g.font = 'bold 36px Rajdhani, Arial, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(label, 128, 35); }, this.renderer);
    const m = new THREE.MeshLambertMaterial({ map: t, emissive: 0xffffff, emissiveMap: t, emissiveIntensity: 0, side: THREE.DoubleSide });
    this.signCache.set(label, m); return m;
  }

  // ------------------------------------------------------------------ streaming
  update(px, pz) {
    const CS = this.man.chunk_size, b = this.bbox;
    const ci = Math.floor((px - b.x0) / CS), cj = Math.floor((pz - b.z0) / CS), rad = Math.ceil(this.loadR / CS) + 1;
    const want = [];
    for (let i = ci - rad; i <= ci + rad; i++) for (let j = cj - rad; j <= cj + rad; j++) {
      const key = i + '_' + j; if (!this.chunkSet.has(key) || this.chunks.has(key)) continue;
      const cx = b.x0 + (i + .5) * CS, cz = b.z0 + (j + .5) * CS, d = Math.hypot(cx - px, cz - pz);
      if (d < this.loadR + CS * .7) want.push([d, i, j, key]);
    }
    want.sort((a, c) => a[0] - c[0]);
    for (const w of want) if (!this.queue.some(q => q[3] === w[3])) this.queue.push(w);
    this.queue.sort((a, c) => Math.hypot(b.x0 + (a[1] + .5) * CS - px, b.z0 + (a[2] + .5) * CS - pz) - Math.hypot(b.x0 + (c[1] + .5) * CS - px, b.z0 + (c[2] + .5) * CS - pz));
    for (const [key, ch] of this.chunks) {
      const d = Math.hypot(ch.cx - px, ch.cz - pz);
      if (d > this.dropR + CS * .7 && ch.ready) { this.scene.remove(ch.group); ch.group.traverse(o => { if (o.geometry && !o.geometry.userData.shared) o.geometry.dispose(); }); ch.tex && ch.tex.dispose(); this._dropColliders(key); this.chunks.delete(key); }
    }
  }
  /** Build at most one queued chunk per call (keeps frames smooth). */
  async pump() {
    if (this.busy || !this.queue.length) return; this.busy = true;
    const [, i, j, key] = this.queue.shift();
    try { if (!this.chunks.has(key)) await this._buildChunk(i, j, key); } catch (e) { console.error('chunk', key, e); }
    this.busy = false;
  }
  async loadAround(px, pz, progress) {
    this.update(px, pz); const total = this.queue.length || 1;
    while (this.queue.length) { await this.pump(); progress(.8 + .2 * (1 - this.queue.length / total), 'chunks ' + (total - this.queue.length) + '/' + total); }
  }

  async _buildChunk(i, j, key) {
    const CS = this.man.chunk_size, x0 = this.bbox.x0 + i * CS, z0 = this.bbox.z0 + j * CS;
    const ch = { key, cx: x0 + CS / 2, cz: z0 + CS / 2, group: new THREE.Group(), ready: false };
    this.chunks.set(key, ch);
    const data = await fetch(this.base + `chunks/c_${i}_${j}.json`).then(r => r.json());
    ch.data = data;
    // terrain with painted roads
    const N = 26, pos = [], uv = [], idx = [];
    for (let b = 0; b < N; b++) for (let a = 0; a < N; a++) { const x = x0 + CS * a / (N - 1), z = z0 + CS * b / (N - 1); pos.push(x, this.terrainAt(x, z), z); uv.push(a / (N - 1), 1 - b / (N - 1)); }
    for (let b = 0; b < N - 1; b++) for (let a = 0; a < N - 1; a++) { const k = b * N + a; idx.push(k, k + N, k + 1, k + 1, k + N, k + N + 1); }
    const tg = new THREE.BufferGeometry(); tg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); tg.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); tg.setIndex(idx); tg.computeVertexNormals();
    ch.tex = canvasTex(this.texSize, this.texSize, (g, S) => this._paint(g, S, x0, z0, CS, data), this.renderer);
    ch.tex.generateMipmaps = true;
    const tm = new THREE.Mesh(tg, new THREE.MeshLambertMaterial({ map: ch.tex })); tm.receiveShadow = true; ch.group.add(tm); ch.ground = tm;
    this._buildBuildings(ch, data);
    this._buildTrees(ch, data);
    this._buildSigns(ch, data);
    this._buildLamps(ch, data);
    for (const b of data.b) this._addCollider(key, b[4], b[0] !== 'fort');
    this.scene.add(ch.group); ch.ready = true;
  }

  _paint(g, S, x0, z0, CS, data) {
    const k = S / CS, P = (x, z) => [(x - x0) * k, (z - z0) * k];
    g.fillStyle = '#8f8670'; g.fillRect(0, 0, S, S);
    g.fillStyle = g.createPattern(this.noise, 'repeat'); g.fillRect(0, 0, S, S);
    const poly = (p, fill) => { g.beginPath(); for (let n = 0; n < p.length; n += 2) { const [x, y] = P(p[n], p[n + 1]); n ? g.lineTo(x, y) : g.moveTo(x, y); } g.closePath(); g.fillStyle = fill; g.fill(); };
    const fills = { campus: '#9d947d', parking: '#7c7a77', park: '#5c8a43', pitch: '#6b9e4c', water: '#2e7d96' };
    for (const kind of ['campus', 'parking', 'park', 'pitch', 'water']) for (const ai of data.a) { const a = this.areas[ai]; if (a.k === kind) poly(a.p, fills[kind]); }
    // water ripples
    g.save(); g.globalAlpha = .25; g.fillStyle = g.createPattern(this.noise, 'repeat'); for (const ai of data.a) { const a = this.areas[ai]; if (a.k === 'water') poly(a.p, g.fillStyle); } g.restore();
    const line = (p, w, col, dash) => { g.beginPath(); for (let n = 0; n < p.length; n += 2) { const [x, y] = P(p[n], p[n + 1]); n ? g.lineTo(x, y) : g.moveTo(x, y); } g.lineWidth = Math.max(1, w * k); g.strokeStyle = col; g.setLineDash(dash || []); g.stroke(); };
    g.lineCap = 'round'; g.lineJoin = 'round';
    const rs = data.r.map(ri => this.roads[ri]).filter(r => !r.b).sort((a, b) => a.w - b.w);
    for (const rd of rs) if (DRIVE.has(rd.c)) line(rd.p, rd.w + (BIG.has(rd.c) ? 5 : 3), '#b3ab9b');         // footpaths
    for (const rd of rs) if (!DRIVE.has(rd.c)) line(rd.p, rd.w, rd.c === 'steps' ? '#a89f8c' : '#c8bca4');
    for (const rd of rs) if (DRIVE.has(rd.c)) line(rd.p, rd.w, BIG.has(rd.c) ? '#43414b' : '#4d4b54');
    g.lineCap = 'butt';
    for (const rd of rs) if (DRIVE.has(rd.c) && rd.w >= 9) line(rd.p, .18, rd.o ? '#e8e4d8' : '#efe7c9', rd.o ? [3 * k, 6 * k] : [3 * k, 4 * k]);
    for (const rd of rs) if (BIG.has(rd.c)) { // edge lines
      const p = rd.p; for (const side of [-1, 1]) { g.beginPath(); for (let n = 0; n < p.length; n += 2) { const a = Math.max(0, n - 2), b = Math.min(p.length - 2, n + 2); let dx = p[b] - p[a], dz = p[b + 1] - p[a + 1]; const L = Math.hypot(dx, dz) || 1; const off = (rd.w / 2 - .6) * side; const [x, y] = P(p[n] - dz / L * off, p[n + 1] + dx / L * off); n ? g.lineTo(x, y) : g.moveTo(x, y); } g.lineWidth = Math.max(1, .15 * k); g.strokeStyle = 'rgba(240,236,226,.8)'; g.setLineDash([]); g.stroke(); }
    }
    g.globalAlpha = .5; g.fillStyle = g.createPattern(this.noise, 'repeat'); g.fillRect(0, 0, S, S); g.globalAlpha = 1;
  }

  // ---------- realistic buildings: Blender-baked facades, real floor counts, parapets, pitched tile roofs, props
  _buildBuildings(ch, data) {
    const mk = () => ({ pos: [], nor: [], uv: [], col: [] }), G = {};
    for (const k of ['apt', 'old', 'tower', 'shop', 'plain', 'roof', 'tile', 'stone', 'temple']) G[k] = mk();
    const P = { tank: [], stair: [], dish: [], ac: [], balcony: [] }, spires = [];
    const c = new THREE.Color(), cTop = new THREE.Color(), cLow = new THREE.Color(), cRoof = new THREE.Color(), grey = new THREE.Color('#9a968e');
    const quad = (g, ax, az, bx, bz, y0, y1, u0, u1, v0, v1, nx, nz, c0, c1) => {
      g.pos.push(ax, y0, az, bx, y0, bz, bx, y1, bz, ax, y0, az, bx, y1, bz, ax, y1, az);
      const cs = [c0, c0, c1, c0, c1, c1]; for (let q = 0; q < 6; q++) { g.nor.push(nx, 0, nz); g.col.push(cs[q].r, cs[q].g, cs[q].b); }
      g.uv.push(u0, v0, u1, v0, u1, v1, u0, v0, u1, v1, u0, v1);
    };
    const tri = (g, A, B, C, uvA, uvB, uvC, col) => {   // arbitrary triangle, normal from winding (made to face up/out)
      const ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2], vx = C[0] - A[0], vy = C[1] - A[1], vz = C[2] - A[2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; const L = Math.hypot(nx, ny, nz) || 1;
      if (ny < 0) { [B, C] = [C, B]; [uvB, uvC] = [uvC, uvB]; nx = -nx; ny = -ny; nz = -nz; }
      g.pos.push(...A, ...B, ...C); for (let q = 0; q < 3; q++) { g.nor.push(nx / L, ny / L, nz / L); g.col.push(col.r, col.g, col.b); } g.uv.push(...uvA, ...uvB, ...uvC);
    };
    const rnd = mulberry32((ch.cx * 7 + ch.cz * 13) | 0);
    const inside = (p, bb, tries) => { for (let t = 0; t < tries; t++) { const x = bb[0] + (bb[2] - bb[0]) * (.15 + .7 * rnd()), z = bb[1] + (bb[3] - bb[1]) * (.15 + .7 * rnd()); if (pointInPoly(x, z, p)) return [x, z]; } return null; };
    for (const rec of data.b) {
      const [kind, h, colHex, name, p0, style = 'apt', roof = 'flat', front0 = []] = rec;
      let p = p0, A = 0, n = p0.length / 2; for (let i = 0, m = p.length - 2; i < p.length; m = i, i += 2) A += p[m] * p[i + 1] - p[i] * p[m + 1];
      let front = new Set(front0);
      if (A > 0) { p = []; for (let i = p0.length - 2; i >= 0; i -= 2) p.push(p0[i], p0[i + 1]); front = new Set(front0.map(k => (n - k) % n)); }
      let gmin = 1e9, gmax = -1e9, bb = [1e9, 1e9, -1e9, -1e9];
      for (let i = 0; i < p.length; i += 2) { const y = this.terrainAt(p[i], p[i + 1]); gmin = Math.min(gmin, y); gmax = Math.max(gmax, y); bb[0] = Math.min(bb[0], p[i]); bb[1] = Math.min(bb[1], p[i + 1]); bb[2] = Math.max(bb[2], p[i]); bb[3] = Math.max(bb[3], p[i + 1]); }
      const base = gmin - .4; c.set(colHex); const shade = .9 + rnd() * .16; c.multiplyScalar(shade);
      cLow.copy(c).multiplyScalar(.68); cTop.copy(c);
      // ---- landmarks keep their bespoke treatment
      if (kind === 'fort') {
        for (let i = 0, m = p.length - 2; i < p.length; m = i, i += 2) {
          const ax = p[m], az = p[m + 1], bx = p[i], bz = p[i + 1], L = Math.hypot(bx - ax, bz - az), dx = (bx - ax) / L, dz = (bz - az) / L;
          quad(G.stone, ax, az, bx, bz, base, gmax + 12, 0, L / 8, 0, (gmax + 12 - base) / 8, -dz, dx, cLow, c);
          spires.push({ x: ax, z: az, y: this.terrainAt(ax, az), r: 4.2, h: 15, kind: 'bastion' });
        }
        continue;
      }
      if (kind !== 'building') {
        const top = gmax + h, gk = kind === 'ruin' ? 'stone' : 'temple'; let u = 0;
        for (let i = 0, m = p.length - 2; i < p.length; m = i, i += 2) { const ax = p[m], az = p[m + 1], bx = p[i], bz = p[i + 1], L = Math.hypot(bx - ax, bz - az); if (L < .05) continue; quad(G[gk], ax, az, bx, bz, base, top, u / 8, (u + L) / 8, 0, (top - base) / 8, -(bz - az) / L, (bx - ax) / L, cLow, c); u += L; }
        this._flatRoof(G[gk === 'stone' ? 'stone' : 'roof'], p, top, cRoof.copy(c).multiplyScalar(.8));
        if (kind.startsWith('temple')) { let rm = 1e9; const cx = (bb[0] + bb[2]) / 2, cz = (bb[1] + bb[3]) / 2; for (let i = 0; i < p.length; i += 2) rm = Math.min(rm, Math.hypot(p[i] - cx, p[i + 1] - cz)); spires.push({ x: cx, z: cz, y: top, r: clamp(rm * .8, 1.5, 7), h: clamp(rm * 2.4, 4, 16), kind }); }
        continue;
      }
      // ---- ordinary buildings
      const st = style.split('+')[0], shop = style.includes('+shop'), fac = st === 'tower' ? 'tower' : st === 'old' ? 'old' : 'apt';
      const pitched = roof === 'gable' || roof === 'hip';
      const floors = Math.max(1, Math.round((h - (pitched ? 1.6 : .9)) / 3.2)), shopH = shop ? 3.6 : 0;
      const wallTop = gmax + floors * 3.2 + (shop ? .4 : 0);
      const blankSides = front.size > 0 && rnd() < .55;
      for (let i = 0, m = p.length - 2, k = 0; i < p.length; m = i, i += 2, k++) {
        const ax = p[m], az = p[m + 1], bx = p[i], bz = p[i + 1], L = Math.hypot(bx - ax, bz - az); if (L < .05) continue;
        const nx = -(bz - az) / L, nz = (bx - ax) / L, bays = Math.max(1, Math.round(L / 3.2)), u1 = bays / 4, isFront = front.has(k);
        const uo = Math.floor(rnd() * 4) / 4;
        if (!isFront && blankSides) { quad(G.plain, ax, az, bx, bz, base, wallTop, 0, 1, 0, 1, nx, nz, cLow, cTop); continue; }
        let y0 = base;
        if (shop && isFront) { quad(G.shop, ax, az, bx, bz, base, base + shopH + (gmax - gmin), uo, uo + u1, 0, 1, nx, nz, c, c); y0 = base + shopH + (gmax - gmin); }
        const fl = (wallTop - y0) / 3.2, vo = Math.floor(rnd() * 4) / 4;
        if (fl > .2) quad(G[fac], ax, az, bx, bz, y0, wallTop, uo, uo + u1, vo, vo + Math.max(.25, Math.round(fl) / 4), nx, nz, y0 === base ? cLow : c, cTop);
        // props on the wall: AC units everywhere, 3D balconies on street-facing apartment walls
        if (fac !== 'tower' && L > 3) for (let f = (shop && isFront) ? 1 : 0; f < floors; f++) for (let bI = 0; bI < bays; bI++) {
          const t = (bI + .5) / bays, wx = ax + (bx - ax) * t, wz = az + (bz - az) * t, fy = gmax + (shop ? .4 : 0) + f * 3.2, ry = Math.atan2(nx, nz);
          const r = rnd();
          if (isFront && fac === 'apt' && f > 0 && r < .22) P.balcony.push([wx + nx * .05, fy + .02, wz + nz * .05, ry]);
          else if (r > .9) P.ac.push([wx + nx * .02 + (bx - ax) / L * .9, fy + .55, wz + nz * .02 + (bz - az) / L * .9, ry]);
        }
      }
      cRoof.copy(c).lerp(grey, .55).multiplyScalar(.85);
      if (pitched) this._pitchedRoof(G.tile, G.plain, p, wallTop, roof, cTop);
      else {
        // parapet (outer + inner faces), then the roof slab
        for (let i = 0, m = p.length - 2; i < p.length; m = i, i += 2) {
          const ax = p[m], az = p[m + 1], bx = p[i], bz = p[i + 1], L = Math.hypot(bx - ax, bz - az); if (L < .05) continue;
          const nx = -(bz - az) / L, nz = (bx - ax) / L;
          quad(G.plain, ax, az, bx, bz, wallTop, wallTop + .9, 0, 1, 0, 1, nx, nz, cTop, cTop);
          quad(G.plain, bx - nx * .22, bz - nz * .22, ax - nx * .22, az - nz * .22, wallTop, wallTop + .9, 0, 1, 0, 1, -nx, -nz, cRoof, cRoof);
          quad(G.plain, ax, az, ax - nx * .22, az - nz * .22, wallTop + .9, wallTop + .9, 0, 0, 0, 0, 0, 0, cTop, cTop); // degenerate-safe cap seam
        }
        this._flatRoof(G.roof, p, wallTop + .05, cRoof);
        // rooftop life: Sintex tanks, stair heads, dishes
        const area = Math.abs(A) / 2;
        const nT = area > 600 ? 3 : area > 250 ? 2 : area > 50 ? 1 : 0;
        for (let t = 0; t < nT; t++) { const q = inside(p, bb, 6); if (q) P.tank.push([q[0], wallTop + .05, q[1], rnd() * 6]); }
        if (floors >= 3 && area > 90 && rnd() < .6) { const q = inside(p, bb, 6); if (q) P.stair.push([q[0], wallTop + .05, q[1], Math.floor(rnd() * 4) * Math.PI / 2]); }
        if (rnd() < .25) { const q = inside(p, bb, 4); if (q) P.dish.push([q[0], wallTop + .05, q[1], rnd() * 6]); }
      }
    }
    const mats = { apt: this.mApt, old: this.mOld, tower: this.mTower, shop: this.mShop, plain: this.mPlain, roof: this.mRoof, tile: this.mTile, stone: this.mStone, temple: this.mRoof };
    for (const k in G) {
      const g = G[k]; if (!g.pos.length) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(g.pos, 3)); geo.setAttribute('normal', new THREE.Float32BufferAttribute(g.nor, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(g.uv, 2)); geo.setAttribute('color', new THREE.Float32BufferAttribute(g.col, 3));
      geo.computeBoundingSphere(); const mesh = new THREE.Mesh(geo, mats[k]); mesh.castShadow = mesh.receiveShadow = true; ch.group.add(mesh);
    }
    this._instanceProps(ch, { water_tank: P.tank, stair_head: P.stair, dish: P.dish, ac_unit: P.ac, balcony: P.balcony });
    for (const s of spires) {
      if (s.kind === 'bastion') { const m = new THREE.Mesh(this._cyl || (this._cyl = new THREE.CylinderGeometry(1, 1.1, 1, 12).translate(0, .5, 0)), this.mStone); this._cyl.userData.shared = true; m.scale.set(s.r, s.h, s.r); m.position.set(s.x, s.y - .5, s.z); m.castShadow = true; ch.group.add(m); continue; }
      const gold = s.kind === 'temple_gold';
      for (let t = 0; t < 3; t++) { const m = new THREE.Mesh(this._cone || (this._cone = new THREE.ConeGeometry(1, 1, 8).translate(0, .5, 0)), gold || t === 2 ? this.mGold : this.mTempleW); this._cone.userData.shared = true; const f = 1 - t * .28; m.scale.set(s.r * f, s.h * (t === 2 ? .5 : .45), s.r * f); m.position.set(s.x, s.y + s.h * t * .32, s.z); m.castShadow = true; ch.group.add(m); }
      const fl = new THREE.Mesh(this._flag || (this._flag = new THREE.PlaneGeometry(1.6, 1)), this._flagMat || (this._flagMat = new THREE.MeshBasicMaterial({ color: 0xff7a00, side: THREE.DoubleSide }))); this._flag.userData.shared = true; fl.position.set(s.x + .8, s.y + s.h * 1.05, s.z); ch.group.add(fl);
    }
  }
  _flatRoof(g, p, y, col) {
    const contour = []; for (let i = 0; i < p.length; i += 2) contour.push(new THREE.Vector2(p[i], p[i + 1]));
    let tris = []; try { tris = THREE.ShapeUtils.triangulateShape(contour, []); } catch (e) { }
    for (const t of tris) {
      const [a, b, d] = t, ax = contour[a].x, az = contour[a].y, cy = (contour[b].x - ax) * (contour[d].y - az) - (contour[b].y - az) * (contour[d].x - ax);
      for (const o of (cy > 0 ? [a, d, b] : [a, b, d])) { g.pos.push(contour[o].x, y, contour[o].y); g.nor.push(0, 1, 0); g.col.push(col.r, col.g, col.b); g.uv.push(contour[o].x / 6, contour[o].y / 6); }
    }
  }
  /** Gable or hip roof over the footprint's oriented bounding box (old Peth houses, Mangalore tiles). */
  _pitchedRoof(tile, plain, p, eave, type, wallCol) {
    let best = 0, ax = 1, az = 0;
    for (let i = 0, m = p.length - 2; i < p.length; m = i, i += 2) { const dx = p[i] - p[m], dz = p[i + 1] - p[m + 1], L = Math.hypot(dx, dz); if (L > best) { best = L; ax = dx / L; az = dz / L; } }
    const bx = -az, bz = ax; let u0 = 1e9, u1 = -1e9, v0 = 1e9, v1 = -1e9;
    for (let i = 0; i < p.length; i += 2) { const u = p[i] * ax + p[i + 1] * az, v = p[i] * bx + p[i + 1] * bz; u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
    const o = .45; u0 -= o; u1 += o; v0 -= o; v1 += o;
    const W = v1 - v0, rh = clamp(W * .36, 1.2, 3.4), vm = (v0 + v1) / 2, ridgeY = eave + rh;
    const P3 = (u, v, y) => [u * ax + v * bx, y, u * az + v * bz];
    const slope = Math.hypot(W / 2, rh), white = new THREE.Color(1, 1, 1);
    const hipIn = type === 'hip' ? Math.min(W / 2, (u1 - u0) / 2 - .01) : 0, ra = u0 + hipIn, rb = u1 - hipIn;
    for (const side of [0, 1]) {
      const ve = side ? v1 : v0;
      const A = P3(u0, ve, eave - .25), B = P3(u1, ve, eave - .25), C = P3(rb, vm, ridgeY), D = P3(ra, vm, ridgeY);
      const L = (u1 - u0) / 2;
      tri(tile, A, B, C, [0, 0], [L, 0], [(rb - u0) / 2, slope / 2], white); tri(tile, A, C, D, [0, 0], [(rb - u0) / 2, slope / 2], [(ra - u0) / 2, slope / 2], white);
    }
    for (const end of [0, 1]) {
      const ue = end ? u1 : u0, ur = end ? rb : ra;
      const A = P3(ue, v0, eave - .25), B = P3(ue, v1, eave - .25), C = P3(ur, vm, ridgeY);
      if (type === 'hip') tri(tile, A, B, C, [0, 0], [W / 2, 0], [W / 4, slope / 2], white);
      else { const A2 = P3(ue + (end ? -o : o), v0 + o, eave), B2 = P3(ue + (end ? -o : o), v1 - o, eave), C2 = P3(ue + (end ? -o : o), vm, ridgeY - .1); triV(plain, A2, B2, C2, wallCol); }
    }
    function tri(g, A, B, C, ua, ub, uc, col) {
      const ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2], vx = C[0] - A[0], vy = C[1] - A[1], vz = C[2] - A[2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      if (ny < 0) { [B, C] = [C, B]; [ub, uc] = [uc, ub]; nx = -nx; ny = -ny; nz = -nz; }
      const L = Math.hypot(nx, ny, nz) || 1; g.pos.push(...A, ...B, ...C);
      for (let q = 0; q < 3; q++) { g.nor.push(nx / L, ny / L, nz / L); g.col.push(col.r, col.g, col.b); } g.uv.push(...ua, ...ub, ...uc);
    }
    function triV(g, A, B, C, col) {   // vertical gable triangle, both faces
      const ux = B[0] - A[0], uz = B[2] - A[2], L = Math.hypot(ux, uz) || 1, nx = -uz / L, nz = ux / L;
      for (const [s, X, Y] of [[1, B, C], [-1, C, B]]) { g.pos.push(...A, ...X, ...Y); for (let q = 0; q < 3; q++) { g.nor.push(nx * s, 0, nz * s); g.col.push(col.r, col.g, col.b); } g.uv.push(0, 0, 1, 0, .5, 1); }
    }
  }
  _instanceProps(ch, lists) {
    if (!this.props) return;
    const d = new THREE.Object3D();
    for (const [name, list] of Object.entries(lists)) {
      const parts = this.props[name]; if (!parts || !list.length) continue;
      for (const part of parts) {
        const im = new THREE.InstancedMesh(part.geo, part.mat, list.length);
        list.forEach((q, i) => { d.position.set(q[0], q[1], q[2]); d.rotation.set(0, q[3] || 0, 0); d.scale.set(1, 1, 1); d.updateMatrix(); im.setMatrixAt(i, d.matrix); });
        im.castShadow = name !== 'ac_unit'; im.receiveShadow = true; ch.group.add(im);
      }
    }
  }
  _buildLamps(ch, data) {
    if (!this.props || !this.props.street_lamp) return;
    const CS = this.man.chunk_size, x0 = ch.cx - CS / 2, z0 = ch.cz - CS / 2, list = [], tmp = {};
    for (const ri of data.r) {
      const rd = this.roads[ri]; if (!BIG.has(rd.c) || rd.b) continue;
      const pl = new Polyline(rd.p); let side = 1;
      for (let s = 10; s < pl.len; s += 34) { pl.at(s, tmp); side = -side; const off = rd.w / 2 + 1.1, x = tmp.x + tmp.dz * off * side, z = tmp.z - tmp.dx * off * side;
        if (x < x0 || x >= x0 + CS || z < z0 || z >= z0 + CS || this.insideBuilding(x, z)) continue;
        list.push([x, this.terrainAt(x, z), z, Math.atan2(tmp.dz, -tmp.dx)]); this._addCircle(ch.key, x, z, .2); }
    }
    this._instanceProps(ch, { street_lamp: list });
  }

  _buildTrees(ch, data) {
    const t = data.t, n = t.length / 3; if (!n) return;
    const R = [.35, .3, .85, .22, .22], d = new THREE.Object3D(), bySp = [[], [], [], [], []];
    for (let k = 0; k < n; k++) {
      const x = t[k * 3], z = t[k * 3 + 1], sp = t[k * 3 + 2] | 0, s = .78 + (((x * 3.7 + z * 1.3) % 1 + 1) % 1) * .45;
      const y = this.terrainAt(x, z); bySp[sp].push([x, y - .1, z, x * 1.7, s]);
      this._addCircle(ch.key, x, z, R[sp] * s, [3.6, 5, 7.5, 2.2, 1.4][sp] * s, y + [9, 7, 11, 12, 11][sp] * s, y + [3.6, 3.3, 4.8, 9.5, 1.8][sp] * s);
    }
    bySp.forEach((list, sp) => {
      const parts = this.treeParts && this.treeParts[sp]; if (!list.length) return;
      if (!parts || !parts.length) {   // fallback blobs
        const trunk = new THREE.InstancedMesh(this.gTrunk, this.mTrunk, list.length), crown = new THREE.InstancedMesh(this.gCrown, this.mCrown, list.length);
        list.forEach((q, i) => { d.position.set(q[0], q[1], q[2]); d.rotation.set(0, q[3], 0); d.scale.set(q[4], 4.2 * q[4], q[4]); d.updateMatrix(); trunk.setMatrixAt(i, d.matrix); d.position.y += 4.6 * q[4]; d.scale.set(3.2 * q[4], 2.6 * q[4], 3.2 * q[4]); d.updateMatrix(); crown.setMatrixAt(i, d.matrix); });
        ch.group.add(trunk, crown); return;
      }
      for (const part of parts) {
        const im = new THREE.InstancedMesh(part.geo, part.mat, list.length);
        list.forEach((q, i) => { d.position.set(q[0], q[1], q[2]); d.rotation.set(0, q[3], 0); d.scale.set(q[4], q[4], q[4]); d.updateMatrix(); im.setMatrixAt(i, d.matrix); });
        im.castShadow = true; im.receiveShadow = true; ch.group.add(im);
      }
    });
  }

  /** true if (x,z) lies on the carriageway of any drivable road other than `exclude` */
  onRoad(x, z, exclude) {
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      const set = this.edgeCells.get(this._key(x + i * ECELL, z + j * ECELL, ECELL)); if (!set) continue;
      for (const ed of set) {
        if (!ed.drive || ed === exclude) continue; const p = ed.pl.p, lim = (ed.w / 2 + .6) ** 2;
        for (let k = 0; k < p.length - 2; k += 2) { const [cx, cz] = closestOnSeg(x, z, p[k], p[k + 1], p[k + 2], p[k + 3]); if ((x - cx) ** 2 + (z - cz) ** 2 < lim) return true; }
      }
    }
    return false;
  }
  /** which footpath sides of an edge are walkable (not on another carriageway, e.g. the inner side of a divided road) */
  walkSides(ed) {
    if (ed._walk) return ed._walk; const res = [], q = {};
    if (ed.weight === 0 || ed.len < 8) return (ed._walk = res);   // no pedestrians in service lanes, bus-stand aisles or parking
    for (const side of [1, -1]) {
      let ok = 0;
      for (const f of [.2, .5, .8]) { ed.pl.at(ed.len * f, q); const off = ed.w / 2 + 1.5, x = q.x + q.dz * off * side, z = q.z - q.dx * off * side; if (!this.onRoad(x, z, ed)) ok++; }
      if (ok >= 2) res.push(side);
    }
    return (ed._walk = res);
  }

  _buildSigns(ch, data) {
    const geo = this._signGeo || (this._signGeo = new THREE.PlaneGeometry(4.2, 1.05)); geo.userData.shared = true;
    for (const [x, z, label] of data.poi) {
      let best = null, bd = 1e9;
      for (const ri of data.r) { const rd = this.roads[ri]; if (!DRIVE.has(rd.c)) continue; const p = rd.p; for (let k = 0; k < p.length - 2; k += 2) { const [cx, cz] = closestOnSeg(x, z, p[k], p[k + 1], p[k + 2], p[k + 3]); const d = (cx - x) ** 2 + (cz - z) ** 2; if (d < bd) { bd = d; best = [cx, cz, rd.w]; } } }
      if (!best || bd > 40 * 40) continue;
      const dist = Math.sqrt(bd), nx = (best[0] - x) / (dist || 1), nz = (best[1] - z) / (dist || 1);
      const off = Math.max(0, dist - best[2] / 2 - 3.2), sx = x + nx * off, sz = z + nz * off;
      const m = new THREE.Mesh(geo, this.signTex(label)); m.position.set(sx, this.terrainAt(sx, sz) + 3.9, sz); m.rotation.y = Math.atan2(nx, nz); ch.group.add(m);
    }
  }

  setNight(n) {
    this.mWall.emissiveIntensity = n * .9; this.mShop.emissiveIntensity = n * .85;
    if (this.facades) { this.mApt.emissiveIntensity = this.mOld.emissiveIntensity = n * 1.1; this.mTower.emissiveIntensity = n * 1.2; this.mShop.emissiveIntensity = n * 1.3; }
    if (this.lampMats) for (const m of this.lampMats) m.emissiveIntensity = .2 + n * 3; this.mGold.emissiveIntensity = .15 + n * .6; this.mTempleW.emissiveIntensity = n * .25;
    for (const m of this.signCache.values()) m.emissiveIntensity = n * .7;
  }
}
