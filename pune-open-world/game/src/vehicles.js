// Vehicle models (cars, autos, buses, scooters, bikes) and arcade drift physics.
import * as THREE from 'three';
import { clamp, lerp, damp, rr, rpick } from './util.js';

export const VEH = {
  rani:   { name: 'Rani GT', max: 58, acc: 26, brake: 44, turn: 2.3, grip: 8, len: 4.6, wid: 2.0, h: 1.15, body: '#ff4fa3', stripe: '#2ff3e0', style: 'sport', r: 2.2, mass: 1 },
  padma:  { name: 'Padmavati Taxi', max: 40, acc: 17, brake: 34, turn: 2.15, grip: 9, len: 4.0, wid: 1.75, h: 1.5, body: '#1d1d1f', roof: '#ffd400', style: 'sedan', r: 2.0, mass: 1 },
  auto:   { name: 'Auto Rickshaw', max: 24, acc: 12, brake: 26, turn: 2.7, grip: 10, len: 2.8, wid: 1.4, h: 1.9, body: '#1f1f1f', roof: '#ffd23f', style: 'auto', r: 1.5, mass: .6 },
  hatch:  { name: 'Chhota Hatch', max: 38, acc: 17, brake: 32, turn: 2.3, grip: 9, len: 3.7, wid: 1.65, h: 1.5, body: '#c0392b', style: 'sedan', r: 1.9, mass: .9 },
  suv:    { name: 'Sahyadri SUV', max: 44, acc: 19, brake: 36, turn: 2.05, grip: 8.5, len: 4.6, wid: 2.0, h: 1.9, body: '#f3f0e8', style: 'suv', r: 2.3, mass: 1.3 },
  bus:    { name: 'City Bus', max: 22, acc: 8, brake: 20, turn: 1.4, grip: 10, len: 11, wid: 2.6, h: 3.2, body: '#c0392b', stripe: '#f5f5f5', style: 'bus', r: 4.0, mass: 4 },
  police: { name: 'Police Jeep', max: 52, acc: 25, brake: 42, turn: 2.4, grip: 9, len: 4.4, wid: 1.9, h: 1.9, body: '#f5f5f5', stripe: '#1e5eff', style: 'suv', r: 2.2, mass: 1.3, police: 1 },
  scooty: { name: 'Kinetika Scooter', max: 24, acc: 14, brake: 28, turn: 3.0, grip: 11, len: 1.8, wid: .7, h: 1.1, body: '#e8e8e8', style: 'scooter', r: .9, mass: .3, bike: 1 },
  raja:   { name: 'Raja 350', max: 34, acc: 18, brake: 32, turn: 2.8, grip: 10, len: 2.1, wid: .8, h: 1.1, body: '#202020', stripe: '#c9a227', style: 'moto', r: 1.0, mass: .45, bike: 1 },
};
export const TRAFFIC_MIX = ['scooty', 'scooty', 'scooty', 'raja', 'raja', 'auto', 'auto', 'auto', 'hatch', 'hatch', 'padma', 'suv', 'rani'];
const CAR_COLS = ['#f3f0e8', '#c0392b', '#2c3e50', '#95a5a6', '#16a085', '#8e44ad', '#f39c12', '#2980b9', '#e8d5b5', '#ffffff', '#7f8c8d'];
const SCOOT_COLS = ['#e8e8e8', '#c0392b', '#2c3e50', '#16a085', '#f1c40f', '#8e44ad', '#ff79c6', '#2980b9'];

const mc = {};
const ML = c => mc[c] || (mc[c] = new THREE.MeshLambertMaterial({ color: c }));
const MB = c => mc['b' + c] || (mc['b' + c] = new THREE.MeshBasicMaterial({ color: c }));
const GB = new THREE.BoxGeometry(1, 1, 1), GW = new THREE.CylinderGeometry(1, 1, 1, 14).rotateZ(Math.PI / 2);
export const sirenR = new THREE.MeshBasicMaterial({ color: 0xff2030 }), sirenB = new THREE.MeshBasicMaterial({ color: 0x2050ff });
const shadowMat = (() => { const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d'); const gr = g.createRadialGradient(32, 32, 4, 32, 32, 32); gr.addColorStop(0, 'rgba(0,0,0,.55)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.fillRect(0, 0, 64, 64); return new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false }); })();
const shadowGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);

function part(par, mat, w, h, d, x, y, z, geo) { const m = new THREE.Mesh(geo || GB, mat); m.scale.set(w, h, d); m.position.set(x, y, z); par.add(m); return m; }
function rider(par, y, z, shirt, helmet) {
  const sk = ML('#a8714a');
  part(par, ML(shirt), .42, .55, .26, 0, y + .5, z - .05); part(par, sk, .22, .24, .22, 0, y + .92, z - .02);
  part(par, ML(helmet || '#151515'), .26, helmet ? .24 : .1, .26, 0, y + (helmet ? 1.02 : 1.06), z - .03);
  part(par, ML('#2c3e50'), .4, .18, .5, 0, y + .18, z + .12);
  for (const s of [-1, 1]) { part(par, ML(shirt), .12, .12, .45, .25 * s, y + .62, z + .2); part(par, ML('#2c3e50'), .13, .45, .14, .18 * s, y - .05, z + .32); }
}
const templates = {};
function build(t, col, withRider) {
  const g = new THREE.Group(), body = new THREE.Group(); body.name = 'body'; g.add(body);
  const L = t.len, W = t.wid, H = t.h, mb = ML(col), glass = ML('#1e2a3a'), dark = ML('#1a1a1a'), hl = MB('#fff4cc'), tl = MB('#ff2a2a'), roof = t.roof ? ML(t.roof) : mb;
  const sh = new THREE.Mesh(shadowGeo, shadowMat); sh.scale.set(Math.max(W * 1.6, 1.2), 1, L * 1.25); sh.position.y = .05; g.add(sh);
  const wr = t.style === 'bus' ? .55 : t.style === 'auto' ? .32 : t.bike ? .3 : .37;
  const wheel = (x, z, front) => { const p = new THREE.Group(); p.position.set(x, wr, z); const w = new THREE.Mesh(GW, dark); w.scale.set(t.bike ? .12 : .3, wr, wr); p.add(w); (t.bike ? body : g).add(p); p.name = front ? 'wf' : 'wr'; };
  if (t.bike) {
    const scoot = t.style === 'scooter';
    if (scoot) { part(body, mb, .42, .5, 1.0, 0, .55, -.1); part(body, mb, .36, .75, .3, 0, .75, .55); part(body, ML('#1a1a1a'), .34, .12, .6, 0, .86, -.2); part(body, mb, .3, .2, .5, 0, .35, .25); }
    else { part(body, mb, .3, .35, .8, 0, .78, .05); part(body, ML(t.stripe), .32, .08, .5, 0, .97, .2); part(body, ML('#1a1a1a'), .3, .1, .6, 0, .92, -.38); part(body, ML('#8a8a8a'), .22, .3, .5, 0, .45, 0); part(body, ML('#9a9a9a'), .08, .08, .9, .18, .4, -.5); }
    part(body, dark, .7, .05, .05, 0, scoot ? 1.12 : 1.08, scoot ? .62 : .58); part(body, hl, .18, .14, .06, 0, scoot ? .98 : .92, scoot ? .72 : .78); part(body, tl, .14, .08, .05, 0, .8, -.62);
    wheel(0, L / 2 - .3, 1); wheel(0, -L / 2 + .3, 0);
    if (withRider) rider(body, .62, -.15, rpick(['#ecf0f1', '#e74c3c', '#3498db', '#2c3e50', '#f1c40f', '#16a085', '#ff79c6']), rr() < .6 ? rpick(['#f5f5f5', '#c0392b', '#2c3e50', '#f1c40f']) : null);
    return g;
  }
  if (t.style === 'auto') {
    part(body, mb, W, .7, L * .86, 0, .75, -.15); part(body, mb, W * .5, 1, .7, 0, .95, L / 2 - .35); part(body, roof, W * 1.04, .12, L * .86, 0, 2.05, -.15); part(body, roof, W * 1.04, .95, .1, 0, 1.6, -L / 2 + .06);
    part(body, glass, W * .8, .75, .06, 0, 1.6, L / 2 - .62); for (const s of [-1, 1]) part(body, dark, .08, .9, .08, s * W / 2, 1.6, L / 2 - .65); part(body, hl, .3, .22, .1, 0, 1.15, L / 2 + .02);
    if (withRider) rider(body, .85, .35, '#e8dcc0', null);
    wheel(0, L / 2 - .35, 1); wheel(-W / 2 + .05, -L / 2 + .55, 0); wheel(W / 2 - .05, -L / 2 + .55, 0);
  } else if (t.style === 'bus') {
    part(body, mb, W, H * .55, L, 0, .55 + H * .275, 0); part(body, glass, W * 1.01, H * .28, L * .92, 0, .55 + H * .69, 0); part(body, ML(t.stripe), W * 1.02, .25, L, 0, .55 + H * .5, 0); part(body, mb, W, .15, L, 0, .55 + H * .9, 0);
    for (const s of [-1, 1]) { part(body, hl, .5, .3, .1, s * W * .32, 1.1, L / 2 + .02); part(body, tl, .4, .3, .1, s * W * .35, 1.1, -L / 2 - .02); }
    for (const z of [L / 2 - 1.8, -L / 2 + 2]) for (const s of [-1, 1]) wheel(s * W / 2, z, z > 0);
  } else {
    const sport = t.style === 'sport', suv = t.style === 'suv', lowH = H * (sport ? .5 : .44), base = .3, lowY = base + lowH / 2;
    part(body, mb, W, lowH, L, 0, lowY, 0); const cl = L * (sport ? .38 : suv ? .6 : .5), cz = sport ? -L * .08 : -L * .04, ch = H * (sport ? .38 : .36);
    part(body, glass, W * .84, ch, cl, 0, base + lowH + ch / 2, cz); part(body, roof, W * .86, .1, cl * .94, 0, base + lowH + ch + .05, cz);
    part(body, dark, W * 1.01, .22, .25, 0, base + .12, L / 2 - .05); part(body, dark, W * 1.01, .22, .25, 0, base + .12, -L / 2 + .05);
    for (const s of [-1, 1]) { part(body, hl, .42, .22, .08, s * W * .32, lowY + .08, L / 2 + .02); part(body, tl, .42, .2, .08, s * W * .32, lowY + .08, -L / 2 - .02); }
    if (sport) { const st = ML(t.stripe); part(body, st, .32, .03, L, -.28, base + lowH + .01, 0); part(body, st, .32, .03, L, .28, base + lowH + .01, 0); part(body, mb, W * .92, .08, .5, 0, base + lowH + .38, -L / 2 + .25); for (const s of [-1, 1]) part(body, dark, .08, .36, .08, s * W * .35, base + lowH + .18, -L / 2 + .25); }
    if (t.police) { part(body, ML(t.stripe), W * 1.02, .22, L * .9, 0, lowY, 0); part(body, sirenR, W * .36, .18, .34, -W * .2, base + lowH + ch + .19, cz); part(body, sirenB, W * .36, .18, .34, W * .2, base + lowH + ch + .19, cz); }
    if (t.roof && t.style === 'sedan') part(body, roof, W * .4, .3, .5, 0, base + lowH + ch + .22, cz);
    const fz = L / 2 - L * .18, rz = -L / 2 + L * .18; for (const s of [-1, 1]) { wheel(s * W / 2, fz, 1); wheel(s * W / 2, rz, 0); }
  }
  return g;
}
export function vehicleMesh(type, col, withRider) {
  const k = type + col + (withRider ? 'r' : ''); if (!templates[k]) templates[k] = build(VEH[type], col, withRider);
  const m = templates[k].clone(true), wh = []; m.traverse(o => { if (o.name === 'wf' || o.name === 'wr') wh.push(o); });
  m.userData = { body: m.getObjectByName('body'), wheels: wh }; return m;
}
export function pickColor(type) {
  const t = VEH[type];
  if (t.bike) return type === 'scooty' ? rpick(SCOOT_COLS) : t.body;
  if (type === 'hatch' || type === 'suv') return rpick(CAR_COLS);
  if (type === 'auto') return rr() < .3 ? '#2e8b57' : t.body;
  return t.body;
}

export const NOIN = { gas: 0, brake: 0, steer: 0, hb: 0 };
/** Arcade drift model: integrate world velocity, damp the lateral part by grip. */
export function drive(c, inp, dt, wet) {
  const t = c.t;
  let fx = Math.sin(c.h), fz = Math.cos(c.h); const vF0 = c.vx * fx + c.vz * fz;
  c.steer += clamp(inp.steer - c.steer, -5 * dt, 5 * dt);
  const mx = t.max, sf = clamp(vF0 / 6, -1, 1) * (1 - .5 * Math.min(1, Math.abs(vF0) / mx));
  c.h += c.steer * t.turn * sf * (inp.hb ? 1.45 : 1) * dt;
  fx = Math.sin(c.h); fz = Math.cos(c.h); const rx = -fz, rz = fx;
  let vF = c.vx * fx + c.vz * fz, vR = c.vx * rx + c.vz * rz;
  if (inp.gas) { if (vF < -.5) vF += t.brake * dt; else vF += t.acc * inp.gas * dt * (1 - .6 * Math.max(0, vF) / mx); }
  if (inp.brake) { if (vF > .5) vF -= t.brake * dt * (wet ? .75 : 1); else vF -= t.acc * .6 * dt; }
  const roll = (inp.gas || inp.brake) ? .3 : (c.ai === 'dyn' ? 9 : 3.5); vF -= Math.sign(vF) * Math.min(Math.abs(vF), (roll + Math.abs(vF) * .025) * dt);
  if (inp.hb) vF -= Math.sign(vF) * Math.min(Math.abs(vF), 9 * dt);
  // slope: gravity along heading
  if (c.slope) vF -= c.slope * 9.8 * dt * .6;
  vF = clamp(vF, -mx * .35, mx);
  const grip = inp.hb ? 1.3 : (c.ai === 'dyn' ? 4 : t.grip * (wet ? .7 : 1));
  vR *= Math.exp(-grip * dt);
  c.pitch = lerp(c.pitch, clamp((vF - c.fwd) / dt * -.004, -.06, .06), damp(6, dt)); c.fwd = vF; c.slip = vR;
  c.vx = fx * vF + rx * vR; c.vz = fz * vF + rz * vR; c.x += c.vx * dt; c.z += c.vz * dt;
  if (t.bike) c.lean = lerp(c.lean, clamp(c.steer * Math.abs(vF) * .028, -.55, .55), damp(6, dt));
  else c.lean = lerp(c.lean, clamp(vR * .012 + c.steer * vF * .0018, -.12, .12), damp(8, dt));
}
