// Real-Pune world: loads pipeline output, streams chunks, answers ground height and collision queries.
import * as THREE from 'three';
import { clamp, pointInPoly, closestOnSeg, mulberry32, isTouch, Polyline } from './util.js';

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
  _dropColliders(chunkKey) { for (const [k, arr] of this.cells) { const f = arr.filter(r => r.c !== chunkKey); if (f.length) this.cells.set(k, f); else this.cells.delete(k); } }
  /** Push a circle {x,z} of radius r out of buildings. Returns contact normal or null. */
  collide(o, r) {
    let hit = null; const seen = new Set();
    for (let i = Math.floor((o.x - r) / CELL); i <= Math.floor((o.x + r) / CELL); i++) for (let j = Math.floor((o.z - r) / CELL); j <= Math.floor((o.z + r) / CELL); j++) {
      const arr = this.cells.get((i + 32768) * 65536 + (j + 32768)); if (!arr) continue;
      for (const rec of arr) {
        if (seen.has(rec)) continue; seen.add(rec);
        const bb = rec.bb; if (o.x + r < bb[0] || o.x - r > bb[2] || o.z + r < bb[1] || o.z - r > bb[3]) continue;
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
  insideBuilding(x, z) { const arr = this.cells.get(this._key(x, z, CELL)); if (!arr) return false; for (const r of arr) if (r.solid && pointInPoly(x, z, r.p)) return true; return false; }
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
    const tm = new THREE.Mesh(tg, new THREE.MeshLambertMaterial({ map: ch.tex })); tm.receiveShadow = false; ch.group.add(tm); ch.ground = tm;
    this._buildBuildings(ch, data);
    this._buildTrees(ch, data);
    this._buildSigns(ch, data);
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

  _buildBuildings(ch, data) {
    const groups = { wall: [], shop: [], roof: [], stone: [] }; // each: {pos,nor,uv,col}
    const mk = () => ({ pos: [], nor: [], uv: [], col: [] });
    for (const k in groups) groups[k] = mk();
    const tanks = [], spires = [];
    const c = new THREE.Color(), cr = new THREE.Color();
    const quad = (G, ax, az, bx, bz, y0, y1, u0, u1, v0, v1, nx, nz, col) => {
      G.pos.push(ax, y0, az, bx, y0, bz, bx, y1, bz, ax, y0, az, bx, y1, bz, ax, y1, az);
      for (let q = 0; q < 6; q++) { G.nor.push(nx, 0, nz); G.col.push(col.r, col.g, col.b); }
      G.uv.push(u0, v0, u1, v0, u1, v1, u0, v0, u1, v1, u0, v1);
    };
    for (const [kind, h, colHex, name, p0] of data.b) {
      let p = p0, A = 0; for (let n = 0, m = p.length - 2; n < p.length; m = n, n += 2) A += p[m] * p[n + 1] - p[n] * p[m + 1];
      if (A > 0) { p = []; for (let n = p0.length - 2; n >= 0; n -= 2) p.push(p0[n], p0[n + 1]); }
      let gmin = 1e9, gmax = -1e9; for (let n = 0; n < p.length; n += 2) { const y = this.terrainAt(p[n], p[n + 1]); gmin = Math.min(gmin, y); gmax = Math.max(gmax, y); }
      const base = gmin - .5, top = gmax + h;
      c.set(colHex); const shade = .88 + ((p[0] * 13.1 + p[1] * 7.7) % 1 + 1) % 1 * .2; c.multiplyScalar(shade);
      if (kind === 'fort') {
        for (let n = 0, m = p.length - 2; n < p.length; m = n, n += 2) {
          const ax = p[m], az = p[m + 1], bx = p[n], bz = p[n + 1], L = Math.hypot(bx - ax, bz - az), dx = (bx - ax) / L, dz = (bz - az) / L;
          quad(groups.stone, ax, az, bx, bz, base, gmax + 12, 0, L / 8, 0, (gmax + 12 - base) / 8, -dz, dx, c);
          spires.push({ x: ax, z: az, y: this.terrainAt(ax, az), r: 4.2, h: 15, kind: 'bastion' });
        }
        continue;
      }
      const tall = top - base, shopH = (kind === 'building' && h >= 6) ? Math.min(3.6, tall * .4) : 0;
      let u = 0;
      for (let n = 0, m = p.length - 2; n < p.length; m = n, n += 2) {
        const ax = p[m], az = p[m + 1], bx = p[n], bz = p[n + 1], L = Math.hypot(bx - ax, bz - az); if (L < .05) continue;
        const nx = -(bz - az) / L, nz = (bx - ax) / L;
        if (kind === 'ruin' || kind === 'temple' || kind === 'temple_gold') { quad(kind === 'ruin' ? groups.stone : groups.roof, ax, az, bx, bz, base, top, u / 8, (u + L) / 8, 0, tall / 8, nx, nz, c); u += L; continue; }
        if (shopH > 0) quad(groups.shop, ax, az, bx, bz, base, base + shopH, u / 16, (u + L) / 16, 0, 1, nx, nz, c);
        quad(groups.wall, ax, az, bx, bz, base + shopH, top, u / 12.8, (u + L) / 12.8, 0, (top - base - shopH) / 12.8, nx, nz, c);
        u += L;
      }
      // roof
      const contour = []; for (let n = 0; n < p.length; n += 2) contour.push(new THREE.Vector2(p[n], p[n + 1]));
      let tris = []; try { tris = THREE.ShapeUtils.triangulateShape(contour, []); } catch (e) { tris = []; }
      cr.copy(c).multiplyScalar(kind === 'ruin' ? .9 : .72);
      const R = kind === 'ruin' ? groups.stone : groups.roof;
      for (const t of tris) {
        let [a, b, d] = t; const ax = contour[a].x, az = contour[a].y, bx = contour[b].x, bz = contour[b].y, dx = contour[d].x, dz = contour[d].y;
        const cy = (bx - ax) * (dz - az) - (bz - az) * (dx - ax);
        const order = cy > 0 ? [a, d, b] : [a, b, d];
        for (const o of order) { R.pos.push(contour[o].x, top, contour[o].y); R.nor.push(0, 1, 0); R.col.push(cr.r, cr.g, cr.b); R.uv.push(contour[o].x / 8, contour[o].y / 8); }
      }
      const cx = p.reduce((s, v, n) => n % 2 ? s : s + v, 0) / (p.length / 2), cz = p.reduce((s, v, n) => n % 2 ? s + v : s, 0) / (p.length / 2);
      if (kind === 'temple' || kind === 'temple_gold') {
        let rmax = 1e9; for (let n = 0; n < p.length; n += 2) rmax = Math.min(rmax, Math.hypot(p[n] - cx, p[n + 1] - cz));
        spires.push({ x: cx, z: cz, y: top, r: clamp(rmax * .8, 1.5, 7), h: clamp(rmax * 2.4, 4, 16), kind });
      } else if (kind === 'building' && h > 5 && ((cx * 7.3 + cz * 3.1) % 1 + 1) % 1 < .35 && pointInPoly(cx, cz, p)) tanks.push([cx, top, cz]);
    }
    const mats = { wall: this.mWall, shop: this.mShop, roof: this.mRoof, stone: this.mStone };
    for (const k in groups) {
      const G = groups[k]; if (!G.pos.length) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(G.pos, 3)); geo.setAttribute('normal', new THREE.Float32BufferAttribute(G.nor, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(G.uv, 2)); geo.setAttribute('color', new THREE.Float32BufferAttribute(G.col, 3));
      geo.computeBoundingSphere(); ch.group.add(new THREE.Mesh(geo, mats[k]));
    }
    if (tanks.length) { const im = new THREE.InstancedMesh(this.gTank, this.mTank, tanks.length); const d = new THREE.Object3D(); tanks.forEach((t, n) => { d.position.set(t[0], t[1], t[2]); d.updateMatrix(); im.setMatrixAt(n, d.matrix); }); this.gTank.userData.shared = true; ch.group.add(im); }
    for (const s of spires) {
      if (s.kind === 'bastion') { const m = new THREE.Mesh(this._cyl || (this._cyl = new THREE.CylinderGeometry(1, 1.1, 1, 12).translate(0, .5, 0)), this.mStone); this._cyl.userData.shared = true; m.scale.set(s.r, s.h, s.r); m.position.set(s.x, s.y - .5, s.z); ch.group.add(m); continue; }
      const gold = s.kind === 'temple_gold';
      for (let t = 0; t < 3; t++) { const m = new THREE.Mesh(this._cone || (this._cone = new THREE.ConeGeometry(1, 1, 8).translate(0, .5, 0)), gold || t === 2 ? this.mGold : this.mTempleW); this._cone.userData.shared = true; const f = 1 - t * .28; m.scale.set(s.r * f, s.h * (t === 2 ? .5 : .45), s.r * f); m.position.set(s.x, s.y + s.h * t * .32, s.z); ch.group.add(m); }
      const fl = new THREE.Mesh(this._flag || (this._flag = new THREE.PlaneGeometry(1.6, 1)), this._flagMat || (this._flagMat = new THREE.MeshBasicMaterial({ color: 0xff7a00, side: THREE.DoubleSide }))); this._flag.userData.shared = true; fl.position.set(s.x + .8, s.y + s.h * 1.05, s.z); ch.group.add(fl);
    }
  }

  _buildTrees(ch, data) {
    const t = data.t, n = t.length / 2; if (!n) return;
    const trunk = new THREE.InstancedMesh(this.gTrunk, this.mTrunk, n), crown = new THREE.InstancedMesh(this.gCrown, this.mCrown, n);
    this.gTrunk.userData.shared = this.gCrown.userData.shared = true;
    const d = new THREE.Object3D(), c = new THREE.Color(), greens = ['#3f7a36', '#4d8a3c', '#5a9446', '#35693a', '#6b9a3e'];
    for (let k = 0; k < n; k++) {
      const x = t[k * 2], z = t[k * 2 + 1], y = this.terrainAt(x, z), s = .8 + ((x * 3.7 + z * 1.3) % 1 + 1) % 1 * .7;
      d.position.set(x, y, z); d.rotation.set(0, x, 0); d.scale.set(s, 4.2 * s, s); d.updateMatrix(); trunk.setMatrixAt(k, d.matrix);
      d.position.set(x, y + 4.6 * s, z); d.scale.set(3.2 * s, 2.6 * s, 3.2 * s); d.updateMatrix(); crown.setMatrixAt(k, d.matrix);
      crown.setColorAt(k, c.set(greens[(k * 7 + Math.floor(x)) % greens.length]));
    }
    ch.group.add(trunk, crown);
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
    this.mWall.emissiveIntensity = n * .9; this.mShop.emissiveIntensity = n * .85; this.mGold.emissiveIntensity = .15 + n * .6; this.mTempleW.emissiveIntensity = n * .25;
    for (const m of this.signCache.values()) m.emissiveIntensity = n * .7;
  }
}
