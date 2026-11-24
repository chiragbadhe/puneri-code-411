// AI traffic and pedestrians that follow the real OSM road graph.
// Traffic keeps left (India), obeys one-way tags, follows the vehicle ahead and slows for sharp turns.
import { clamp, damp, wrapA, rr, rpick, R } from './util.js';
import { VEH, TRAFFIC_MIX, vehicleMesh, pickColor } from './vehicles.js';

const tmp = { x: 0, z: 0, dx: 0, dz: 0 }, tmp2 = { x: 0, z: 0, dx: 0, dz: 0 };

export function makeVehicle(scene, type, x, z, h, ai, col, rider) {
  const t = VEH[type]; col = col || pickColor(type);
  const c = { t, type, x, z, y: 0, h, vx: 0, vz: 0, steer: 0, ai, spd: 0, fwd: 0, slip: 0, lean: 0, pitch: 0, slope: 0, slopeAng: 0, spin: 0,
    mesh: vehicleMesh(type, col, rider), col, hasRider: !!rider && (t.bike || type === 'auto'), mx: x, mz: z, my: null, stuck: 0, rev: 0, timer: 0, honkT: 0 };
  c.mesh.position.set(x, 0, z); c.mesh.rotation.order = 'YXZ'; c.mesh.rotation.y = h; scene.add(c.mesh); return c;
}

export class Traffic {
  constructor(world, scene, vehicles, count) { this.world = world; this.scene = scene; this.vehicles = vehicles; this.count = count; }

  /** Pick a drivable edge near (but not too near) the player and place a new AI vehicle on it. */
  spawn(px, pz, minD, maxD, forceType) {
    const W = this.world;
    for (let tries = 0; tries < 12; tries++) {
      const a = rr() * Math.PI * 2, d = R(minD, maxD), hit = W.nearestEdge(px + Math.cos(a) * d, pz + Math.sin(a) * d, true, 80);
      if (!hit) continue; const ed = hit.edge; if (ed.len < 12) continue;
      const dd = Math.hypot(hit.x - px, hit.z - pz); if (dd < minD * .8) continue;
      let type = forceType || rpick(TRAFFIC_MIX); if (type === 'rani' && rr() < .5) type = 'hatch';
      if (!forceType && ed.weight >= 3 && rr() < .12) type = 'bus';
      const dirOk = []; if (ed.oneway !== -1) dirOk.push(1); if (ed.oneway !== 1) dirOk.push(-1); if (!dirOk.length) continue;
      const dir = rpick(dirOk);
      const c = makeVehicle(this.scene, type, hit.x, hit.z, 0, 'traffic', null, true);
      c.edge = ed; c.dir = dir; c.u = dir > 0 ? hit.s : ed.len - hit.s; c.next = null;
      c.cruise = Math.min(c.t.max * .75, (ed.weight >= 3 ? 15 : 10) * (c.t.bike ? R(1.05, 1.3) : R(.85, 1.1)));
      c.laneBias = c.t.bike ? R(.6, 1) : R(.35, .55);
      this._pose(c, true); this.vehicles.push(c); return c;
    }
    return null;
  }
  _laneOff(c) { const w = c.edge.w; return c.edge.oneway ? (c.laneBias - .5) * w * .8 : clamp(w * .5 * c.laneBias, 1.1, w / 2 - .6); }
  _pose(c, snap) {
    const ed = c.edge, s = c.dir > 0 ? c.u : ed.len - c.u; ed.pl.at(s, tmp);
    const sAhead = c.dir > 0 ? Math.min(ed.len, s + 4) : Math.max(0, s - 4); ed.pl.at(sAhead, tmp2);
    let dx = (tmp2.x - tmp.x), dz = (tmp2.z - tmp.z); const L = Math.hypot(dx, dz);
    if (L < .3) { dx = tmp.dx * c.dir; dz = tmp.dz * c.dir; } else { dx /= L; dz /= L; }
    const off = this._laneOff(c);
    c.x = tmp.x + dz * off; c.z = tmp.z - dx * off;     // left of travel = (dz, -dx)
    const th = Math.atan2(dx, dz);
    c.h = snap ? th : c.h + wrapA(th - c.h) * .12;
    c.fx = dx; c.fz = dz;
    if (snap) { c.mx = c.x; c.mz = c.z; }
  }
  _chooseNext(c) {
    const W = this.world, ed = c.edge, node = c.dir > 0 ? ed.b : ed.a;
    let opts = W.nodeAdj[node].filter(e => e !== ed && e.drive && W.canTraverse(e, node));
    if (!opts.length) return { edge: ed, dir: -c.dir };
    // prefer bigger roads a little, avoid tiny service lanes
    const bag = []; for (const e of opts) for (let k = 0; k < 1 + e.weight; k++) bag.push(e);
    const e = rpick(bag); return { edge: e, dir: e.a === node ? 1 : -1 };
  }
  step(dt, player, all) {
    for (const c of this.vehicles) {
      if (c.ai !== 'traffic') continue;
      const fx = Math.sin(c.h), fz = Math.cos(c.h);
      let want = c.cruise; const lim = c.t.len * .5 + 9;
      for (const o of all) {
        if (o === c) continue; const rx = o.x - c.x, rz = o.z - c.z; if (Math.abs(rx) > 30 || Math.abs(rz) > 30) continue;
        const ah = rx * fx + rz * fz; if (ah <= 0 || ah > lim + (o.t ? o.t.len * .5 : 0)) continue;
        const lat = Math.abs(rx * fz - rz * fx), wid = (c.t.wid + (o.t ? o.t.wid : .6)) * .5 + .5;
        if (lat < wid) want = Math.min(want, Math.max(0, (ah - c.t.len * .5 - (o.t ? o.t.len * .5 : .5) - 2.5) * 1.5));
      }
      if (!c.next && c.edge.len - c.u < 18) {
        c.next = this._chooseNext(c);
        const ne = c.next.edge, s0 = c.next.dir > 0 ? 0 : ne.len; ne.pl.at(s0, tmp);
        const nd = { x: tmp.dx * c.next.dir, z: tmp.dz * c.next.dir }; c.turn = Math.abs(wrapA(Math.atan2(nd.x, nd.z) - c.h));
      }
      if (c.next && c.turn > .6) want = Math.min(want, c.turn > 2.5 ? 3 : 7);
      c.spd += clamp(want - c.spd, -26 * dt, (c.t.bike ? 9 : 6) * dt);
      if (c.spd < .5 && want < .5) c.honkT += dt; else c.honkT = 0;
      c.u += c.spd * dt;
      while (c.u >= c.edge.len) { const over = c.u - c.edge.len; const nx = c.next || this._chooseNext(c); c.edge = nx.edge; c.dir = nx.dir; c.u = over; c.next = null; }
      this._pose(c, false);
      c.vx = c.fx * c.spd; c.vz = c.fz * c.spd; c.fwd = c.spd;
      c.steer = clamp(wrapA(Math.atan2(c.fx, c.fz) - c.h) * 3, -1, 1);
    }
  }
  recycle(px, pz) {
    for (const c of this.vehicles.slice()) {
      if (c.ai !== 'traffic' && c.ai !== 'dyn') continue; if (c.keep) continue;
      const d = Math.hypot(c.x - px, c.z - pz);
      if ((c.ai === 'traffic' && d > 440) || (c.ai === 'dyn' && d > (c.leaving ? 160 : 520))) this.remove(c);
    }
    let n = this.vehicles.filter(c => c.ai === 'traffic').length, guard = 0;
    while (n < this.count && guard++ < 4) { if (this.spawn(px, pz, 160, 400)) n++; }
  }
  remove(c) { this.scene.remove(c.mesh); const k = this.vehicles.indexOf(c); if (k >= 0) this.vehicles.splice(k, 1); }
}

/** Pedestrians walking the footpaths of the road graph, driving the GPU crowd. */
export class Walkers {
  constructor(world, crowd) { this.world = world; this.crowd = crowd; this.list = crowd.list.map(p => ({ p, state: 'off' })); }
  place(a, px, pz, minD, maxD) {
    for (let t = 0; t < 8; t++) {
      const ang = rr() * Math.PI * 2, d = R(minD, maxD), hit = this.world.nearestEdge(px + Math.cos(ang) * d, pz + Math.sin(ang) * d, false, 60);
      if (!hit || hit.edge.len < 6) continue;
      a.edge = hit.edge; a.dir = rr() < .5 ? 1 : -1; a.u = a.dir > 0 ? hit.s : hit.edge.len - hit.s; a.side = rr() < .5 ? 1 : -1;
      a.speed = R(1.0, 1.6); a.state = rr() < .18 ? 'idle' : 'walk'; a.idleT = R(3, 10); a.p.visible = true; a.p.mode = 0; a.p.tilt = 0; a.p.roll = 0; a.p.amt = 0;
      this._pose(a, 0); return true;
    }
    a.state = 'off'; a.p.visible = false; return false;
  }
  _pose(a, dt) {
    const ed = a.edge, s = a.dir > 0 ? a.u : ed.len - a.u; ed.pl.at(clamp(s, 0, ed.len), tmp);
    const dx = tmp.dx * a.dir, dz = tmp.dz * a.dir, off = ed.drive ? ed.w / 2 + 1.4 : .6;
    const x = tmp.x + dz * off * a.side, z = tmp.z - dx * off * a.side;
    a.p.x = x; a.p.z = z; a.p.y = a.p.gy = this.world.groundAt(x, z);
    const th = Math.atan2(dx, dz); a.p.h = dt ? a.p.h + wrapA(th - a.p.h) * damp(8, dt) : th;
  }
  step(dt, px, pz, vehicles, onHit) {
    for (const a of this.list) {
      const p = a.p;
      if (a.state === 'off') { if (rr() < .05) this.place(a, px, pz, 40, 220); continue; }
      if (a.state === 'walk' || a.state === 'idle') {
        if (a.state === 'idle') { a.idleT -= dt; p.amt += (0 - p.amt) * damp(6, dt); if (a.idleT < 0) { a.state = 'walk'; } }
        else {
          a.u += a.speed * dt; p.amt += (1 - p.amt) * damp(5, dt); p.phase += a.speed * dt * (2 * Math.PI / 1.45);
          if (a.u >= a.edge.len) {
            const node = a.dir > 0 ? a.edge.b : a.edge.a, opts = this.world.nodeAdj[node].filter(e => e !== a.edge);
            const e = opts.length ? rpick(opts) : a.edge; a.dir = opts.length ? (e.a === node ? 1 : -1) : -a.dir; a.edge = e; a.u = 0;
            if (rr() < .08) { a.state = 'idle'; a.idleT = R(2, 7); }
          }
          this._pose(a, dt);
        }
        if (Math.hypot(p.x - px, p.z - pz) > 260) { this.place(a, px, pz, 80, 220); continue; }
        for (const c of vehicles) {
          const s = Math.hypot(c.vx, c.vz); if (s < 5) continue;
          const dx = p.x - c.x, dz = p.z - c.z; if (dx * dx + dz * dz < (c.t.r + .4) ** 2) {
            a.state = 'fly'; a.vx = c.vx * .7 + dx * 2; a.vz = c.vz * .7 + dz * 2; a.vy = 6 + s * .16; a.spin = R(-6, 6); a.t = 0;
            p.mode = 1; p.amt = 0; onHit(c, s); break;
          }
        }
      } else if (a.state === 'fly') {
        a.t += dt; p.x += a.vx * dt; p.z += a.vz * dt; p.y += a.vy * dt; a.vy -= 22 * dt; p.h += a.spin * dt; p.tilt = Math.min(Math.PI / 2, p.tilt + dt * 3.2);
        const g = this.world.groundAt(p.x, p.z); p.gy = g;
        if (p.y <= g + .15 && a.vy < 0) { if (Math.abs(a.vy) > 4) { a.vy = -a.vy * .3; a.vx *= .5; a.vz *= .5; p.y = g + .15; } else { p.y = g + .15; a.state = 'down'; a.t = 4; p.mode = 0; p.amt = 0; } }
      } else if (a.state === 'down') { a.t -= dt; if (a.t < 0) { p.tilt = 0; this.place(a, px, pz, 90, 220); } }
    }
  }
}
