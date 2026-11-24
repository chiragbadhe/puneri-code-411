// PUNERI: Real Pune — game orchestration (player, camera, missions, police, GPS, HUD, weather, day/night).
import * as THREE from 'three';
import { $, clamp, lerp, damp, wrapA, rr, rpick, R, isTouch, pointInPoly } from './util.js';
import { World } from './world.js';
import { Crowd } from './humans.js';
import { VEH, drive, NOIN, sirenR, sirenB, vehicleMesh } from './vehicles.js';
import { Traffic, Walkers, makeVehicle } from './traffic.js';
import { AU, STATIONS, initAudio, playCrash, jingle, honk, frameAudio } from './audio.js';

const AREA = new URLSearchParams(location.search).get('area') || 'peths_fc';

/* ---------------- renderer / scene ---------------- */
const renderer = new THREE.WebGLRenderer({ canvas: $('c'), antialias: !isTouch, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, isTouch ? 1.25 : 1.5));
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(62, 1, .6, 16000);
scene.fog = new THREE.Fog(0xffb38a, 160, 620);
const hemi = new THREE.HemisphereLight(0xffe8f4, 0x5a5060, .9); scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffc58a, 1.0); scene.add(sun); scene.add(sun.target);
function resize() { renderer.setSize(innerWidth, innerHeight, false); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); }
addEventListener('resize', resize); resize();

const skyU = { top: { value: new THREE.Color() }, hor: { value: new THREE.Color() }, sunDir: { value: new THREE.Vector3(0, 1, 0) }, sunCol: { value: new THREE.Color() }, cloud: { value: 0 } };
const sky = new THREE.Mesh(new THREE.SphereGeometry(2800, 32, 16), new THREE.ShaderMaterial({ uniforms: skyU, side: THREE.BackSide, depthWrite: false, fog: false,
  vertexShader: 'varying vec3 vP;void main(){vP=normalize(position);gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
  fragmentShader: 'uniform vec3 top,hor,sunCol,sunDir;uniform float cloud;varying vec3 vP;void main(){float h=max(vP.y,0.0);vec3 c=mix(hor,top,pow(h,0.5));float s=max(dot(vP,normalize(sunDir)),0.0);c+=sunCol*(pow(s,900.0)*2.0+pow(s,10.0)*0.35)*(1.0-cloud*.8);c=mix(c,vec3(dot(c,vec3(.33)))*.85,cloud*.6);if(vP.y<0.0)c=hor;gl_FragColor=vec4(c,1.0);}' }));
sky.renderOrder = -1; scene.add(sky);
const starGeo = new THREE.BufferGeometry(), sp = [];
for (let k = 0; k < 900; k++) { const a = rr() * Math.PI * 2, y = .15 + rr() * .85, r = Math.sqrt(1 - y * y); sp.push(Math.cos(a) * r * 2600, y * 2600, Math.sin(a) * r * 2600); }
starGeo.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3));
const starMat = new THREE.PointsMaterial({ color: 0xffffff, size: 2, sizeAttenuation: false, transparent: true, opacity: 0, fog: false, depthWrite: false });
const stars = new THREE.Points(starGeo, starMat); scene.add(stars);
// Pune's hills on the horizon (Parvati, Vetal tekdi, Chaturshringi, Taljai, Sinhagad range)
const hillMat = new THREE.MeshBasicMaterial({ color: 0x5a3d7a, fog: false });
const HILLS = [[-185, 2211, 260, 70], [-2600, -900, 900, 120], [-1900, -2700, 650, 95], [900, 3700, 950, 115], [-9000, 9500, 4200, 650], [-5200, 7000, 1800, 260], [6000, -6000, 2500, 180], [-7000, -3000, 2200, 220]];
for (const [x, z, r, h] of HILLS) { const m = new THREE.Mesh(new THREE.ConeGeometry(r, h, 12), hillMat); m.position.set(x, h / 2 - 8, z); m.scale.z = .7 + rr() * .4; scene.add(m); }

const world = new World(scene, renderer, `world/${AREA}/`);
let crowd, playerFig, traffic, walkers;
const vehicles = [];
const me = { x: 0, z: 0, y: 0, h: 0, car: null, walkPhase: 0, moving: 0, money: 250, done: {}, enter: null };
try { const s = JSON.parse(localStorage.getItem('puneri_real') || '{}'); me.money = s.money ?? 250; me.done = s.done || {}; } catch (e) { }
const save = () => { try { localStorage.setItem('puneri_real', JSON.stringify({ money: me.money, done: me.done })); } catch (e) { } };
const ppos = () => me.car || me;

/* ---------------- input ---------------- */
const keys = {}; let state = 'loading', mapOpen = false;
addEventListener('keydown', e => { if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault(); if (!keys[e.code]) onPress(e.code); keys[e.code] = true; });
addEventListener('keyup', e => { keys[e.code] = false; });
addEventListener('blur', () => { for (const k in keys) keys[k] = false; if (state === 'play') setPause(true); });
document.querySelectorAll('#touch button').forEach(b => { const k = b.dataset.k; const dn = e => { e.preventDefault(); if (!keys[k]) onPress(k); keys[k] = true; b.classList.add('on'); }, up = e => { e.preventDefault(); keys[k] = false; b.classList.remove('on'); };
  b.addEventListener('pointerdown', dn); b.addEventListener('pointerup', up); b.addEventListener('pointercancel', up); b.addEventListener('pointerleave', up); });
const input = () => ({ gas: (keys.KeyW || keys.ArrowUp) ? 1 : 0, brake: (keys.KeyS || keys.ArrowDown) ? 1 : 0, steer: ((keys.KeyA || keys.ArrowLeft) ? 1 : 0) - ((keys.KeyD || keys.ArrowRight) ? 1 : 0), hb: keys.Space ? 1 : 0, run: keys.ShiftLeft || keys.ShiftRight });
const cam = { yaw: 0, mode: 0, shake: 0 };
function onPress(code) {
  if (state === 'title') { if (code === 'Enter' || code === 'Space') startGame(); return; }
  if (code === 'KeyP' || code === 'Escape') { if (mapOpen) { toggleMap(); return; } setPause(state === 'play'); return; }
  if (state !== 'play') return;
  if (code === 'KeyF') enterExit(); if (code === 'KeyR') { AU.st = (AU.st + 1) % STATIONS.length; toastRadio(); }
  if (code === 'KeyM') toggleMap(); if (code === 'KeyC') cam.mode = (cam.mode + 1) % 3; if (code === 'KeyO') weather.target = weather.target > .5 ? 0 : 1;
}
$('startb').onclick = () => startGame(); $('resumeb').onclick = () => setPause(false);
$('resetb').onclick = () => { me.money = 250; me.done = {}; save(); setPause(false); bigMsg('FRESH START', 'Money and missions reset', '#2ff3e0', 2000); };
function setPause(p) { if (state === 'title' || state === 'loading') return; state = p ? 'pause' : 'play'; $('pause').classList.toggle('hidden', !p); }
function toggleMap() { mapOpen = !mapOpen; $('mapov').classList.toggle('hidden', !mapOpen); }
$('mapc').addEventListener('click', e => {
  const r = $('mapc').getBoundingClientRect(), mm = world.man.minimap, k = $('mapc').width / world.minimap.width;
  const x = mm.x0 + (e.clientX - r.left) * ($('mapc').width / r.width) / k * mm.mpp, z = mm.z0 + (e.clientY - r.top) * ($('mapc').height / r.height) / k * mm.mpp;
  gps.target = [x, z]; gps.label = 'Waypoint'; gps.t = 0; bigMsg('GPS SET', 'Follow the pink line on the radar', '#ff4fa3', 1500);
});

/* ---------------- HUD helpers ---------------- */
const REELS = {
  crash: ['<b>@punekar_99</b> bhau ne gaadi thok di', '<b>@fc_road_foodie</b> this driver needs a misal break', '<b>@sadashiv_aaji</b> in my time we drove at 20 kmph', '<b>@pune_traffic_live</b> another one. Daily scene.'],
  drift: ['<b>@drift_deccan</b> Tokyo? No. PUNE.', '<b>@kothrud_kid</b> sideways on JM Road, legend', '<b>@peth_watch</b> even the cows clapped'],
  cops: ['<b>@pune_police_fan</b> chase happening right now!!', '<b>@breaking_411</b> cops in hot pursuit near {d}', '<b>@camp_kid</b> sirens louder than a Ganpati procession'],
  ped: ['<b>@peth_watch</b> uncle flew. uncle is fine. uncle is angry.', '<b>@footpath_union</b> footpath is for walking only', '<b>@kaka_on_scooter</b> I will write a letter to the editor'],
  pass: ['<b>@punekar_99</b> legend delivered on time', '<b>@chai_sutta</b> respect +100', '<b>@aai_says</b> at least someone in Pune is punctual'],
  busted: ['<b>@pune_police</b> another one in the bag', '<b>@sadashiv_aaji</b> told you. 20 kmph.'],
  river: ['<b>@mutha_watch</b> someone just parked in the river', '<b>@lakdi_pul_daily</b> bro thought it was a road'],
};
function feed(kind) { const el = document.createElement('div'); el.className = 'post'; el.innerHTML = rpick(REELS[kind]).replace('{d}', zone.name || 'Pune'); const f = $('feed'); f.appendChild(el); while (f.children.length > 4) f.removeChild(f.children[1]); setTimeout(() => el.remove(), 6000); }
let bigT = 0; function bigMsg(t, s, col, ms) { $('bigt').textContent = t; $('bigt').style.color = col || '#ffc83d'; $('bigs').textContent = s || ''; $('big').style.opacity = 1; clearTimeout(bigT); bigT = setTimeout(() => $('big').style.opacity = 0, ms || 2600); }
let curHint = ''; function hint(t) { if (t === curHint) return; curHint = t; $('hint').textContent = t; $('hint').classList.toggle('hidden', !t); }
function toastRadio() { const el = $('radio'); el.textContent = STATIONS[AU.st].name; el.style.opacity = 1; clearTimeout(el._t); el._t = setTimeout(() => el.style.opacity = 0, 2200); }
const ZONES = [['Shaniwar Wada', 230, 'Photography allowed. Selfie sticks, please behave.'], ['Dagdusheth', 170, 'Darshan queue starts here. Patience starts earlier.'], ['Mahatma Phule Mandai', 200, 'Bhaji fresh. Bargaining also fresh.'],
  ['Tulshibaug Ram Mandir', 150, 'Everything available. Parking not available.'], ['Fergusson College', 260, 'Canteen is not a classroom. Attendance is compulsory.'], ['Deccan Gymkhana', 220, 'Cricket ground. Not for drifting.'],
  ['Balgandharva', 150, 'Natak at 9:30 PM sharp. Sharp means sharp.'], ['Jangli Maharaj Mandir', 160, 'JM Road: footpath is for walking, not for shopping.'], ['Sambhaji Bridge', 160, 'Lakdi Pul: two-wheelers only. Four-wheelers, think twice.'],
  ['Sambhaji Udyan', 160, 'Garden closes at sunset. Ducks do not.'], ['Omkareshwar Mandir', 140, 'Riverside temple. Please do not honk at the river.'], ['Kasba Peth Metro', 170, 'Metro is on time. Are you?'], ['Deccan Corner', 160, 'Do not ask directions. Use your own intelligence.']];
const zone = { name: '', t: 0 };
let zoneT = 0; function showZone(name, patya) { $('zname').textContent = name; $('zpatya').textContent = patya; $('zone').style.opacity = 1; clearTimeout(zoneT); zoneT = setTimeout(() => $('zone').style.opacity = 0, 4200); }

/* ---------------- missions & GPS ---------------- */
const MISSIONS = [
  { id: 'bun', name: 'Bun Maska Run', col: '#ffc83d', from: 'Deccan Corner', stops: ['Deccan Corner', 'Tulshibaug Ram Mandir'], reward: 500, closed: [13, 16], brief: 'Twelve hot bun maska from Deccan to the Tulshibaug shopkeepers. Cold bun maska is a crime in Pune.' },
  { id: 'darshan', name: 'Darshan Dash', col: '#ff9a3c', from: 'Dagdusheth Ganpati', stops: ['Dagdusheth', 'Shaniwar Wada', 'Omkareshwar Mandir', 'Dagdusheth'], reward: 800, brief: 'Aaji wants Shaniwar Wada, Omkareshwar and back to Dagdusheth before aarti. No excuses.' },
  { id: 'fc', name: 'FC Road Food Crawl', col: '#2ff3e0', from: 'Fergusson College', stops: ['Fergusson College', 'Jangli Maharaj Mandir', 'Balgandharva', 'Deccan Gymkhana'], reward: 700, brief: 'Pick up the gang from FC, JM Road and Balgandharva. Table for six at Deccan is not going to wait.' },
  { id: 'lakdi', name: 'Lakdi Pul Getaway', col: '#ff4fa3', from: 'Mahatma Phule Mandai', stops: ['Mahatma Phule Mandai', 'Sambhaji Bridge', 'Deccan Gymkhana'], reward: 1200, heat: 2, brief: 'The mandai deal went sideways. Cops are already looking. Cross the Mutha at Lakdi Pul and disappear in Deccan.' },
  { id: 'peth', name: 'Peth Scooter Sprint', col: '#4dff88', from: 'Kasba Peth Metro', stops: ['Kasba Peth Metro', 'Laxmi', 'Bajirao', 'Shivaji Road'], reward: 900, bike: 1, brief: 'Only a two-wheeler fits these lanes. Laxmi Road, Bajirao Road, Shivaji Road. Go, go, go.' },
];
const gps = { target: null, route: null, t: 0, label: '' };
let mission = null, markerOK = true;
const markGeo = new THREE.CylinderGeometry(3.2, 3.2, 70, 20, 1, true);
function makeMarker(col) { const g = new THREE.Group(); const m = new THREE.Mesh(markGeo, new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: .35, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending, fog: false })); m.position.y = 35; g.add(m);
  const r = new THREE.Mesh(new THREE.RingGeometry(3.6, 5, 28), new THREE.MeshBasicMaterial({ color: col, side: THREE.DoubleSide, fog: false })); r.rotation.x = -Math.PI / 2; r.position.y = .45; g.add(r); scene.add(g); return g; }
const cpMarker = makeMarker('#ffc83d'); cpMarker.visible = false;
function setupMissions() {
  for (const m of MISSIONS) {
    m.pts = m.stops.map(s => { const lm = world.man.landmarks[s]; if (!lm) return null; const e = world.nearestEdge(lm[0], lm[1], true, 250); return e ? [e.x, e.z] : lm; }).filter(Boolean);
    if (m.pts.length < 2) { m.disabled = true; continue; }
    m.marker = makeMarker(m.col); m.marker.position.set(m.pts[0][0], world.groundAt(...m.pts[0]), m.pts[0][1]);
  }
}
function routeLen(pts) { let L = 0; for (let k = 1; k < pts.length; k++) { const r = world.route(pts[k - 1], pts[k]); if (!r) { L += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]) * 1.4; continue; } for (let q = 1; q < r.length; q++) L += Math.hypot(r[q][0] - r[q - 1][0], r[q][1] - r[q - 1][1]); } return L; }
function startMission(m) {
  const hr = gameMin / 60; if (m.closed && hr >= m.closed[0] && hr < m.closed[1]) { bigMsg('CLOSED', 'Shops closed 1 to 4 PM for afternoon rest. Puneri rules.', '#ff4fa3', 3000); return; }
  if (m.bike && !(me.car && me.car.t.bike)) { bigMsg('NEED A TWO-WHEELER', 'Find a scooter or a Raja 350 for the Peth lanes.', '#ff4fa3', 2600); return; }
  const len = routeLen(m.pts), time = Math.ceil(len / (m.bike ? 9 : 11) + 20);
  mission = { m, i: 1, left: time }; if (m.heat) addWanted(m.heat);
  bigMsg(m.name.toUpperCase(), m.brief, m.col, 4500); jingle(true); setGps(m.pts[1], m.stops[1]);
}
function setGps(pt, label) { gps.target = pt; gps.label = label; gps.t = 0; gps.route = null; }
function endMission(ok, why) {
  const m = mission.m; mission = null; cpMarker.visible = false; $('obj').textContent = ''; gps.target = null; gps.route = null;
  if (ok) { const first = !me.done[m.id], pay = first ? m.reward : Math.round(m.reward * .5); me.money += pay; me.done[m.id] = 1; save(); bigMsg('MISSION PASSED!', '$' + pay + (first ? '' : '  (replay bonus)'), '#ffc83d', 3200); feed('pass'); jingle(true); }
  else { bigMsg('MISSION FAILED', why || '', '#ff3b3b', 3000); jingle(false); }
}

/* ---------------- police / wanted ---------------- */
const W = { level: 0, cool: 0, bust: 0, spawnT: 0 };
const nearPolice = r => { const P = ppos(); return vehicles.some(c => c.ai === 'police' && Math.hypot(c.x - P.x, c.z - P.z) < r); };
function addWanted(n) { const was = W.level; W.level = clamp(W.level + n, 0, 5); W.cool = 0; if (W.level > was && rr() < .6) feed('cops'); }
function policeAI(c, dt) {
  const P = ppos(), dx = P.x - c.x, dz = P.z - c.z, dist = Math.hypot(dx, dz); c.timer -= dt;
  if (c.timer <= 0) { c.timer = 1.2; c.direct = dist < 70 && world.lineOfSight(c.x, c.z, P.x, P.z); if (!c.direct) c.path = world.route([c.x, c.z], [P.x, P.z]); c.pi = 0; }
  let tx = P.x + (me.car ? me.car.vx * .35 : 0), tz = P.z + (me.car ? me.car.vz * .35 : 0);
  if (!c.direct && c.path) { while (c.pi < c.path.length - 1 && Math.hypot(c.path[c.pi][0] - c.x, c.path[c.pi][1] - c.z) < 10) c.pi++; [tx, tz] = c.path[Math.min(c.pi + 1, c.path.length - 1)]; }
  const diff = wrapA(Math.atan2(tx - c.x, tz - c.z) - c.h), inp = { gas: 1, brake: 0, steer: clamp(diff * 2.4, -1, 1), hb: 0 };
  if (Math.abs(diff) > 1.6 && c.fwd > 14) { inp.gas = 0; inp.brake = 1; } if (Math.abs(diff) > 1.1 && c.fwd > 22) inp.hb = 1;
  if (c.rev > 0) { c.rev -= dt; inp.gas = 0; inp.brake = 1; inp.steer = -Math.sign(diff); } else if (Math.abs(c.fwd) < 2.5) { c.stuck += dt; if (c.stuck > 1) { c.rev = 1.1; c.stuck = 0; } } else c.stuck = 0;
  return inp;
}
function busted() {
  const fine = Math.max(100, Math.round(me.money * .1)); bigMsg('BUSTED', 'Fine paid: $' + fine, '#2f8bff', 3200); me.money = Math.max(0, me.money - fine); save(); feed('busted');
  if (mission) { mission = null; cpMarker.visible = false; $('obj').textContent = ''; gps.target = null; }
  W.level = 0; W.bust = 0; for (const c of vehicles.slice()) if (c.ai === 'police') traffic.remove(c);
  if (me.car) { me.car.ai = 'dyn'; me.car.vx = me.car.vz = 0; me.car = null; }
  respawnOnFoot('Deccan Corner'); jingle(false);
}
function respawnOnFoot(lmName) {
  const lm = world.man.landmarks[lmName] || world.man.spawn, e = world.nearestEdge(lm[0], lm[1], true, 200);
  const ed = e.edge, p = {}; ed.pl.at(e.s, p); const off = ed.w / 2 + .7; me.x = p.x + p.dz * off; me.z = p.z - p.dx * off; me.h = Math.atan2(p.dx, p.dz);
  playerFig.list[0].visible = true;
  const c = makeVehicle(scene, 'scooty', p.x + p.dz * (ed.w / 2 - .8) + p.dx * 4, p.z - p.dx * (ed.w / 2 - .8) + p.dz * 4, me.h, 'parked', '#ff4fa3'); c.keep = true; vehicles.push(c);
}

/* ---------------- player ---------------- */
function enterExit() {
  const fig = playerFig.list[0];
  if (me.car) {
    const c = me.car; if (Math.hypot(c.vx, c.vz) > 7) return;
    const fx = Math.sin(c.h), fz = Math.cos(c.h), side = c.t.bike ? .9 : c.t.wid / 2 + 1.0;
    me.x = c.x + fz * side; me.z = c.z - fx * side; me.h = c.h; c.ai = 'dyn'; me.car = null; fig.visible = true; fig.mode = 0; fig.roll = 0; return;
  }
  let best = null, bd = 1e9; for (const c of vehicles) { const d = Math.hypot(c.x - me.x, c.z - me.z) - c.t.r; if (d < bd) { bd = d; best = c; } }
  if (best && bd < 3) {
    if (best.ai === 'traffic') { if (nearPolice(90)) addWanted(1); feed('crash'); }
    if (best.t.police) addWanted(2);
    const fx = Math.sin(best.h), fz = Math.cos(best.h), side = best.t.bike ? .7 : best.t.wid / 2 + .8;
    me.enter = { c: best, tx: best.x + fz * side, tz: best.z - fx * side, t: 0 }; best.ai = 'held'; best.vx = best.vz = 0; best.spd = 0;
  }
}
function finishEnter() {
  const c = me.enter.c; me.enter = null;
  // the AI rider jumps off a stolen two-wheeler/auto: swap to a rider-less model
  if (c.hasRider) { scene.remove(c.mesh); c.mesh = vehicleMesh(c.type, c.col, false); c.mesh.rotation.order = 'YXZ'; scene.add(c.mesh); c.hasRider = false; }
  c.ai = 'player'; me.car = c; playerFig.list[0].visible = !!c.t.bike; playerFig.list[0].mode = c.t.bike ? 2 : 0; hint(''); toastRadio(); cam.yaw = c.h;
}
function walk(inp, dt) {
  const fig = playerFig.list[0];
  if (me.enter) { const e = me.enter, dx = e.tx - me.x, dz = e.tz - me.z, d = Math.hypot(dx, dz); e.t += dt; me.moving = 1;
    if (d < .25 || e.t > .9) { finishEnter(); return; } const sp = Math.min(6, d / dt); me.x += dx / d * sp * dt; me.z += dz / d * sp * dt; me.h += wrapA(Math.atan2(dx, dz) - me.h) * damp(12, dt); me.walkPhase += sp * dt * (2 * Math.PI / 1.6); fig.amt = 1.3; return; }
  const sp = inp.run ? 7.2 : 2.6, mv = (inp.gas ? 1 : 0) - (inp.brake ? .6 : 0);
  me.h += inp.steer * 2.6 * dt; me.x += Math.sin(me.h) * mv * sp * dt; me.z += Math.cos(me.h) * mv * sp * dt;
  me.moving = Math.abs(mv) > 0; me.walkPhase += Math.abs(mv) * sp * dt * (2 * Math.PI / (inp.run ? 2.2 : 1.45)) * Math.sign(mv || 1);
  fig.amt += ((me.moving ? (inp.run ? 2 : 1) : 0) - fig.amt) * damp(8, dt);
  world.collide(me, .45);
  for (const c of vehicles) { const dx = me.x - c.x, dz = me.z - c.z, d = Math.hypot(dx, dz), r = c.t.r * .8 + .4; if (d < r && d > 1e-4) { me.x += dx / d * (r - d); me.z += dz / d * (r - d); } }
}
function carVsWorld(c) {
  const h = world.collide(c, c.t.r * (c.t.bike ? .7 : .85)); if (!h) return;
  const vn = c.vx * h.nx + c.vz * h.nz; if (vn < 0) { c.vx -= 1.3 * vn * h.nx; c.vz -= 1.3 * vn * h.nz; c.vx *= .9; c.vz *= .9; if (c === me.car && -vn > 10) crash(-vn, null); }
}
function carVsCar() {
  for (let a = 0; a < vehicles.length; a++) { const A = vehicles[a]; for (let b = a + 1; b < vehicles.length; b++) { const B = vehicles[b];
    const dx = B.x - A.x, dz = B.z - A.z, rs = A.t.r + B.t.r; if (Math.abs(dx) > rs || Math.abs(dz) > rs) continue; const d2 = dx * dx + dz * dz; if (d2 >= rs * rs) continue;
    let kA = A.ai === 'traffic' || A.ai === 'parked' || A.ai === 'held', kB = B.ai === 'traffic' || B.ai === 'parked' || B.ai === 'held'; if (kA && kB) continue;
    const d = Math.sqrt(d2) || .01, nx = dx / d, nz = dz / d, pen = rs - d, rel = (B.vx - A.vx) * nx + (B.vz - A.vz) * nz, imp = -rel;
    if (imp > 3.5) { if (kA && A.ai !== 'held') { A.ai = 'dyn'; kA = false; } if (kB && B.ai !== 'held') { B.ai = 'dyn'; kB = false; } }
    const iA = kA ? 0 : 1 / A.t.mass, iB = kB ? 0 : 1 / B.t.mass, s = iA + iB; if (!s) continue;
    A.x -= nx * pen * iA / s; A.z -= nz * pen * iA / s; B.x += nx * pen * iB / s; B.z += nz * pen * iB / s;
    if (rel < 0) { const j = -1.35 * rel / s; A.vx -= j * iA * nx; A.vz -= j * iA * nz; B.vx += j * iB * nx; B.vz += j * iB * nz;
      if (A === me.car || B === me.car) { if (imp > 6) crash(imp, A === me.car ? B : A); } else if ((A.ai === 'police' || B.ai === 'police') && imp > 6) playCrash(imp * .4); }
  } }
}
function crash(imp, other) {
  playCrash(imp); cam.shake = Math.min(1, imp / 35); if (rr() < .35) feed('crash');
  if (other && other.ai === 'police') addWanted(1); else if (other && imp > 13 && nearPolice(110)) addWanted(1); else if (other && imp > 22 && W.level === 0 && rr() < .35) addWanted(1);
  if (me.car && me.car.t.bike && imp > 14) { // thrown off the bike
    const c = me.car; me.car = null; c.ai = 'dyn'; const fig = playerFig.list[0]; fig.visible = true; me.x = c.x; me.z = c.z; me.fly = { vx: c.vx * .6, vz: c.vz * .6, vy: 6, t: 0 }; fig.mode = 1;
  }
}

/* ---------------- step / logic ---------------- */
let gameMin = 18 * 60 + 20, drift = 0, driftT = 0, waterT = 0;
const waterPolys = () => world.areas.filter(a => a.k === 'water').map(a => a.p);
let WATER = [];
function vehicleGround(c) {
  const fx = Math.sin(c.h), fz = Math.cos(c.h), L = Math.max(1.2, c.t.len * .45);
  const hf = world.groundAt(c.x + fx * L, c.z + fz * L), hb = world.groundAt(c.x - fx * L, c.z - fz * L);
  c.y = (hf + hb) / 2; if (c.my === null) c.my = c.y; c.slope = (hf - hb) / (2 * L); c.slopeAng = Math.atan(c.slope);
}
function step(dt) {
  gameMin += dt * 2; if (gameMin >= 1440) gameMin -= 1440;
  const inp = input();
  if (me.fly) { const f = me.fly, fig = playerFig.list[0]; f.t += dt; me.x += f.vx * dt; me.z += f.vz * dt; f.vy -= 22 * dt; me.yOff = (me.yOff || 0) + f.vy * dt; fig.tilt = Math.min(1.4, f.t * 3);
    if (me.yOff <= 0 && f.vy < 0) { me.yOff = 0; if (f.t > 1.6) { me.fly = null; fig.mode = 0; fig.tilt = 0; } else { f.vx *= .8; f.vz *= .8; f.vy = 0; } } world.collide(me, .45); }
  else if (me.car) drive(me.car, inp, dt, weather.v > .5); else walk(inp, dt);
  traffic.step(dt, ppos(), vehicles);
  for (const c of vehicles) { if (c === me.car || c.ai === 'traffic') continue; if (c.ai === 'police') drive(c, policeAI(c, dt), dt, weather.v > .5); else if (c.ai === 'dyn' && (Math.abs(c.vx) + Math.abs(c.vz) > .05)) drive(c, NOIN, dt, false); }
  for (const c of vehicles) if (c.ai === 'player' || c.ai === 'police' || c.ai === 'dyn') carVsWorld(c);
  carVsCar();
}
let logicT = 0;
function logic(dt) {
  const P = ppos();
  for (const c of vehicles) vehicleGround(c);
  me.y = world.groundAt(me.x, me.z);
  walkers.step(dt, P.x, P.z, vehicles.filter(c => Math.abs(c.vx) + Math.abs(c.vz) > 4), (c, s) => { if (c === me.car) { playCrash(s * .5); if (rr() < .5) feed('ped'); if (W.level === 0 || nearPolice(120)) addWanted(1); } });
  // missions
  if (!mission) {
    let near = null; for (const m of MISSIONS) { if (m.disabled) continue; const d = Math.hypot(m.pts[0][0] - P.x, m.pts[0][1] - P.z); if (!near || d < near.d) near = { m, d }; }
    if (near && near.d < 6) { if (markerOK && me.car) { markerOK = false; startMission(near.m); } else if (!me.car) hint('Get a vehicle to start ' + near.m.name); }
    else { if (!near || near.d > 12) markerOK = true;
      if (near && near.d < 45) hint(near.m.name + ' · ' + near.m.from + ' · drive into the marker');
      else if (!me.car && !me.enter) { let cd = 1e9, cv = null; for (const c of vehicles) { const d = Math.hypot(c.x - me.x, c.z - me.z) - c.t.r; if (d < cd) { cd = d; cv = c; } } hint(cd < 3 ? 'Press F to get on the ' + cv.t.name : ''); }
      else hint(''); }
  } else {
    const m = mission.m, cp = m.pts[mission.i]; cpMarker.visible = true; cpMarker.position.set(cp[0], world.groundAt(cp[0], cp[1]), cp[1]); mission.left -= dt; hint('');
    const d = Math.hypot(cp[0] - P.x, cp[1] - P.z); $('obj').textContent = (mission.i < m.pts.length - 1 ? 'Go to ' + m.stops[mission.i] : 'Final stop: ' + m.stops[mission.i]) + ' · ' + Math.round(d) + ' m';
    if (d < 9 && me.car) { mission.i++; jingle(true); if (mission.i >= m.pts.length) endMission(true); else setGps(m.pts[mission.i], m.stops[mission.i]); }
    else if (mission.left <= 0) endMission(false, 'Out of time. Puneri patience is also out.');
  }
  for (const m of MISSIONS) if (m.marker) m.marker.visible = !mission;
  // wanted
  if (W.level > 0) {
    const seen = vehicles.some(c => c.ai === 'police' && Math.hypot(c.x - P.x, c.z - P.z) < 130 && world.lineOfSight(c.x, c.z, P.x, P.z));
    if (seen) W.cool = 0; else { W.cool += dt; if (W.cool > 8 + W.level * 3) { W.level--; W.cool = 0; if (!W.level) bigMsg('LOST THEM', '', '#2ff3e0', 1600); } }
    W.spawnT -= dt; const want = Math.min(4, W.level + (W.level > 2 ? 1 : 0)), have = vehicles.filter(c => c.ai === 'police').length;
    if (W.spawnT <= 0 && have < want) { W.spawnT = 2.5; for (let t = 0; t < 8; t++) { const a = rr() * Math.PI * 2, e = world.nearestEdge(P.x + Math.cos(a) * 200, P.z + Math.sin(a) * 200, true, 80); if (!e) continue; if (Math.hypot(e.x - P.x, e.z - P.z) < 120) continue; const c = makeVehicle(scene, 'police', e.x, e.z, Math.atan2(P.x - e.x, P.z - e.z), 'police'); c.timer = 0; vehicles.push(c); break; } }
    let close = false; for (const c of vehicles) if (c.ai === 'police' && Math.hypot(c.x - P.x, c.z - P.z) < 7.5) close = true;
    const slow = me.car ? Math.abs(me.car.fwd) < 3 : true; if (close && slow) { W.bust += dt; if (W.bust > (me.car ? 2.2 : 1.2)) busted(); } else W.bust = Math.max(0, W.bust - dt);
  } else for (const c of vehicles) if (c.ai === 'police') { c.ai = 'dyn'; c.leaving = 1; }
  // drift bonus
  if (me.car && !me.car.t.bike && Math.abs(me.car.slip) > 6 && Math.abs(me.car.fwd) > 14) { drift += dt * Math.abs(me.car.fwd); driftT = .6; }
  else if (driftT > 0) { driftT -= dt; if (driftT <= 0 && drift > 0) { if (drift > 110) { const pay = Math.round(drift / 6); me.money += pay; bigMsg('DRIFT BONUS', '$' + pay, '#2ff3e0', 1500); if (rr() < .6) feed('drift'); save(); } drift = 0; } }
  // slower checks
  logicT -= dt; if (logicT > 0) return; logicT = .3;
  traffic.recycle(P.x, P.z); world.update(P.x, P.z);
  let zn = null; for (const [n, r, pt] of ZONES) { const lm = world.man.landmarks[n]; if (lm && Math.hypot(lm[0] - P.x, lm[1] - P.z) < r) { zn = [n === 'Dagdusheth' ? 'Dagdusheth Ganpati' : n === 'Sambhaji Bridge' ? 'Lakdi Pul' : n, pt]; break; } }
  if (!zn) zn = P.x < -150 ? ['Deccan & FC Road', 'Parking for customers only. Customers also not allowed to park.'] : ['The Peths', 'Shop closed 1 to 4 PM. Do not ring bell. Do not ask why.'];
  if (zn[0] !== zone.name) { zone.name = zn[0]; showZone(zn[0], zn[1]); }
  const e = world.nearestEdge(P.x, P.z, false, 60); $('street').textContent = e && e.edge.name ? e.edge.name : '';
  // river
  if (me.car && !me.fly) { const g = world.groundAt(me.car.x, me.car.z), t = world.terrainAt(me.car.x, me.car.z); if (g - t < 1 && WATER.some(p => pointInPoly(me.car.x, me.car.z, p))) { waterT += .3; me.car.vx *= .5; me.car.vz *= .5; if (waterT > 1) { waterT = 0; feed('river'); bigMsg('SPLASH!', 'You drove into the Mutha. A kind fisherman pulled you out.', '#2ff3e0', 2600); const c = me.car; me.car = null; c.ai = 'dyn'; playerFig.list[0].visible = true; respawnOnFoot('Sambhaji Bridge'); } } else waterT = 0; }
  // GPS
  gps.t -= .3; if (gps.target && gps.t <= 0) { gps.t = 2.5; gps.route = world.route([P.x, P.z], gps.target); }
  // honks
  for (const c of vehicles) if (c.ai === 'traffic' && c.honkT > 2.5) { c.honkT = -4 - rr() * 4; honk(Math.hypot(c.x - P.x, c.z - P.z)); }
}

/* ---------------- HUD ---------------- */
let hudT = 0, hudMoney = -1;
function hud(dt) {
  hudT -= dt; if (hudT > 0) return; hudT = .1;
  const hh = Math.floor(gameMin / 60), mm = Math.floor(gameMin % 60); $('clock').textContent = String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
  if (hudMoney !== me.money) { hudMoney = me.money; $('money').textContent = '$' + String(Math.max(0, Math.floor(me.money))).padStart(8, '0'); }
  $('stars').textContent = '★'.repeat(W.level) + '☆'.repeat(5 - W.level); $('stars').classList.toggle('flash', W.level > 0 && nearPolice(160));
  $('speed').textContent = me.car ? Math.round(Math.abs(me.car.fwd) * 3.6) + ' km/h · ' + me.car.t.name : 'On foot';
  $('timer').textContent = mission ? Math.max(0, Math.ceil(mission.left)) + 's' : '';
}
const rc = $('radar'), rg = rc.getContext('2d'), mapc = $('mapc'), mg = mapc.getContext('2d');
function drawRadar() {
  const S = rc.width, cx = S / 2, P = ppos(), spd = me.car ? Math.abs(me.car.fwd) : 0, upp = 1.4 + spd * .035, th = cam.yaw - Math.PI, mm = world.man.minimap;
  rg.fillStyle = '#1d2230'; rg.fillRect(0, 0, S, S); rg.save(); rg.translate(cx, cx); rg.rotate(th); rg.scale(mm.mpp / upp, mm.mpp / upp);
  rg.translate(-(P.x - mm.x0) / mm.mpp, -(P.z - mm.z0) / mm.mpp); rg.drawImage(world.minimap, 0, 0);
  if (gps.route) { rg.strokeStyle = '#ff4fa3'; rg.lineWidth = 6 / (mm.mpp / upp); rg.lineJoin = 'round'; rg.beginPath(); gps.route.forEach((p, k) => { const x = (p[0] - mm.x0) / mm.mpp, y = (p[1] - mm.z0) / mm.mpp; k ? rg.lineTo(x, y) : rg.moveTo(x, y); }); rg.stroke(); }
  rg.restore();
  const blip = (x, z, col, sz, sq) => { let dx = (x - P.x) / upp, dz = (z - P.z) / upp; let bx = dx * Math.cos(th) - dz * Math.sin(th), by = dx * Math.sin(th) + dz * Math.cos(th); const d = Math.hypot(bx, by), lim = cx - 9; if (d > lim) { bx *= lim / d; by *= lim / d; }
    rg.fillStyle = col; rg.strokeStyle = '#000'; rg.lineWidth = 2; rg.beginPath(); if (sq) rg.rect(cx + bx - sz, cx + by - sz, sz * 2, sz * 2); else rg.arc(cx + bx, cx + by, sz, 0, 7); rg.fill(); rg.stroke(); };
  if (mission) { const cp = mission.m.pts[mission.i]; blip(cp[0], cp[1], '#ffc83d', 7, true); } else for (const m of MISSIONS) if (!m.disabled) blip(m.pts[0][0], m.pts[0][1], m.col, 6, true);
  if (gps.target && !mission) blip(gps.target[0], gps.target[1], '#ff4fa3', 6, true);
  const fl = Math.floor(performance.now() / 200) % 2; for (const c of vehicles) if (c.ai === 'police') blip(c.x, c.z, fl ? '#ff3040' : '#3060ff', 4.5);
  rg.fillStyle = '#fff'; rg.strokeStyle = '#000'; rg.lineWidth = 2; rg.beginPath(); rg.moveTo(cx, cx - 9); rg.lineTo(cx + 7, cx + 7); rg.lineTo(cx, cx + 3); rg.lineTo(cx - 7, cx + 7); rg.closePath(); rg.fill(); rg.stroke();
  rg.font = 'bold 14px Rajdhani,sans-serif'; rg.textAlign = 'center'; rg.fillStyle = '#fff'; rg.fillText('N', cx + Math.sin(-th) * (cx - 14), cx - Math.cos(-th) * (cx - 14) + 5);
}
function drawMap() {
  const im = world.minimap, mm = world.man.minimap, maxW = Math.min(innerWidth * .94, 1400), maxH = innerHeight * .84, k = Math.min(maxW / im.width, maxH / im.height);
  const w = Math.floor(im.width * k), h = Math.floor(im.height * k); if (mapc.width !== w) { mapc.width = w; mapc.height = h; }
  mg.drawImage(im, 0, 0, w, h); const w2m = (x, z) => [(x - mm.x0) / mm.mpp * k, (z - mm.z0) / mm.mpp * k];
  mg.textAlign = 'center'; mg.font = '700 ' + Math.max(11, w / 85) + 'px Rajdhani,sans-serif';
  for (const [n, p] of Object.entries(world.man.landmarks)) { const [x, y] = w2m(p[0], p[1]); const label = { Laxmi: 'Laxmi Road', Bajirao: 'Bajirao Road', Kumthekar: 'Kumthekar Road', 'Jangli Maharaj': 'JM Road', Dagdusheth: 'Dagdusheth Ganpati', 'Sambhaji Bridge': 'Lakdi Pul' }[n] || n; mg.fillStyle = 'rgba(0,0,0,.7)'; mg.fillText(label, x + 1, y + 1); mg.fillStyle = '#ffe9a8'; mg.fillText(label, x, y); }
  if (gps.route) { mg.strokeStyle = '#ff4fa3'; mg.lineWidth = 4; mg.beginPath(); gps.route.forEach((p, q) => { const [x, y] = w2m(p[0], p[1]); q ? mg.lineTo(x, y) : mg.moveTo(x, y); }); mg.stroke(); }
  for (const m of MISSIONS) { if (m.disabled || (mission && mission.m === m)) continue; const [x, y] = w2m(m.pts[0][0], m.pts[0][1]); mg.fillStyle = m.col; mg.fillRect(x - 6, y - 6, 12, 12); mg.strokeStyle = '#000'; mg.strokeRect(x - 6, y - 6, 12, 12); }
  const P = ppos(), [px, py] = w2m(P.x, P.z), hh = me.car ? me.car.h : me.h; mg.save(); mg.translate(px, py); mg.rotate(Math.PI - hh); mg.fillStyle = '#fff'; mg.strokeStyle = '#ff4fa3'; mg.lineWidth = 2; mg.beginPath(); mg.moveTo(0, -12); mg.lineTo(9, 9); mg.lineTo(0, 4); mg.lineTo(-9, 9); mg.closePath(); mg.fill(); mg.stroke(); mg.restore();
  mg.font = '600 12px Rajdhani,sans-serif'; mg.fillStyle = 'rgba(255,255,255,.75)'; mg.textAlign = 'right'; mg.fillText('Map data © OpenStreetMap contributors', w - 8, h - 8);
}

/* ---------------- weather & time of day ---------------- */
const weather = { v: 0, target: 0, t: 90 };
const RAIN_N = isTouch ? 700 : 1600, rainPos = new Float32Array(RAIN_N * 6);
const rainGeo = new THREE.BufferGeometry(); rainGeo.setAttribute('position', new THREE.BufferAttribute(rainPos, 3));
const rain = new THREE.LineSegments(rainGeo, new THREE.LineBasicMaterial({ color: 0xaab8d8, transparent: true, opacity: 0 })); rain.frustumCulled = false; scene.add(rain);
for (let k = 0; k < RAIN_N; k++) { rainPos[k * 6] = R(-40, 40); rainPos[k * 6 + 1] = R(0, 40); rainPos[k * 6 + 2] = R(-40, 40); }
function updateWeather(dt) {
  weather.t -= dt; if (weather.t < 0) { weather.t = R(80, 200); weather.target = rr() < .3 ? 1 : 0; }
  weather.v += (weather.target - weather.v) * damp(.4, dt); rain.material.opacity = weather.v * .55; rain.visible = weather.v > .02;
  if (!rain.visible) return; const c = camera.position;
  for (let k = 0; k < RAIN_N; k++) { const o = k * 6; rainPos[o + 1] -= 32 * dt; if (rainPos[o + 1] < -2) { rainPos[o] = R(-40, 40); rainPos[o + 1] = 38; rainPos[o + 2] = R(-40, 40); } rainPos[o + 3] = rainPos[o] + .1; rainPos[o + 4] = rainPos[o + 1] - .9; rainPos[o + 5] = rainPos[o + 2]; }
  rain.position.set(c.x, c.y - 10, c.z); rainGeo.attributes.position.needsUpdate = true;
}
const TOD = [[0, '#070820', '#241a4a', .05, .3, 1], [5, '#0b0b2a', '#3a2350', .08, .32, 1], [6.3, '#5a5fb0', '#ffb38a', .45, .6, .45], [8, '#3f8fe0', '#bfe3ff', 1, .95, 0], [16.5, '#3f8fe0', '#d4ecff', .95, .95, 0], [18, '#4b2a86', '#ff8a7a', .75, .82, .12], [19, '#24124f', '#ff5c9e', .35, .58, .55], [20.5, '#0a0a26', '#3a1d5c', .06, .34, 1], [24, '#070820', '#241a4a', .05, .3, 1]];
const cA = new THREE.Color(), cB = new THREE.Color(), cGrey = new THREE.Color('#7d8290'), cHD = new THREE.Color('#fff2f8'), cHN = new THREE.Color('#8a7cff'), cMount = new THREE.Color('#3a2856');
const headSpot = new THREE.SpotLight(0xfff2cc, 0, 90, .55, .5, 1.2); scene.add(headSpot); scene.add(headSpot.target);
let night = 0;
function applyTOD() {
  const hr = gameMin / 60; let k = 0; while (k < TOD.length - 2 && hr >= TOD[k + 1][0]) k++; const a = TOD[k], b = TOD[k + 1], f = clamp((hr - a[0]) / (b[0] - a[0]), 0, 1), wv = weather.v;
  skyU.top.value.copy(cA.set(a[1]).lerp(cB.set(b[1]), f)).lerp(cGrey, wv * .5); skyU.hor.value.copy(cA.set(a[2]).lerp(cB.set(b[2]), f)).lerp(cGrey, wv * .55); skyU.cloud.value = wv;
  const hor = skyU.hor.value; scene.fog.color.copy(hor); renderer.setClearColor(hor); scene.fog.far = lerp(640, 380, wv); scene.fog.near = lerp(170, 60, wv);
  sun.intensity = lerp(a[3], b[3], f) * (1 - wv * .6) * 1.6; hemi.intensity = Math.max(lerp(a[4], b[4], f) * 1.15, .62) * (1 - wv * .2); night = Math.max(lerp(a[5], b[5], f), wv * .35);
  hemi.color.copy(cHD).lerp(cHN, night); const ang = (hr - 6) / 12 * Math.PI, sd = new THREE.Vector3(-Math.cos(ang), Math.sin(ang), -.35).normalize(); skyU.sunDir.value.copy(sd);
  skyU.sunCol.value.set(hr > 5 && hr < 19.5 ? (Math.abs(hr - 12) > 4.5 ? '#ff9a5a' : '#fff6d0') : '#000000'); sun.color.set(Math.abs(hr - 12) > 4.5 ? '#ff9a6a' : '#fff1dc');
  const P = ppos(); sun.position.set(P.x + sd.x * 400, Math.max(.25, sd.y) * 400, P.z + sd.z * 400); sun.target.position.set(P.x, 0, P.z);
  world.setNight(night); starMat.opacity = night * (1 - wv); hillMat.color.copy(hor).lerp(cMount, .5);
}

/* ---------------- camera & mesh sync ---------------- */
const camT = new THREE.Vector3();
function updateCamera(dt) {
  if (state === 'title' || state === 'loading') { cam.orbit = (cam.orbit || 0) + dt * .06; const lm = state === 'title' ? [me.x, me.z] : (world.man ? (world.man.landmarks['Deccan Corner'] || [0, 0]) : [0, 0]); const y = world.tH ? world.terrainAt(lm[0], lm[1]) : 0;
    camera.position.set(lm[0] + Math.cos(cam.orbit) * 120, y + 55, lm[1] + Math.sin(cam.orbit) * 120); camera.lookAt(lm[0], y + 5, lm[1]); return; }
  const c = me.car, tg = c ? { x: c.mx, z: c.mz, y: c.my } : { x: me.x, z: me.z, y: me.y + (me.yOff || 0) }, spd = c ? Math.hypot(c.vx, c.vz) : 0;
  cam.yaw += wrapA((c ? c.h : me.h) - cam.yaw) * damp(c ? 4.2 : 4.5, dt);
  const base = c ? (c.t.bike ? [6.5, 9, 4.2][cam.mode] : [10.5, 15, 6.5][cam.mode] + c.t.len * .35) : [5.2, 8, 3.2][cam.mode];
  const dist = base + spd * .05, fx = Math.sin(cam.yaw), fz = Math.cos(cam.yaw);
  let px = tg.x - fx * dist, pz = tg.z - fz * dist, py = tg.y + (c ? (cam.mode === 2 ? 2.4 : 3.9) + c.t.h * .55 : 2.6) + spd * .02;
  for (let f = 1; f > .3 && world.insideBuilding(px, pz); f -= .1) { px = tg.x - fx * dist * f; pz = tg.z - fz * dist * f; py += .35; }
  py = Math.max(py, world.groundAt(px, pz) + 1.2);
  const k = damp(c ? 14 : 10, dt); camera.position.x += (px - camera.position.x) * k; camera.position.z += (pz - camera.position.z) * k; camera.position.y += (py - camera.position.y) * k;
  if (cam.shake > 0) { cam.shake = Math.max(0, cam.shake - dt * 2.5); camera.position.x += (rr() - .5) * cam.shake; camera.position.y += (rr() - .5) * cam.shake; }
  camT.set(tg.x + fx * 4, tg.y + (c ? 1.3 : 1.5), tg.z + fz * 4); camera.lookAt(camT);
  const fov = clamp(62 + spd * .32, 62, 84); if (Math.abs(fov - camera.fov) > .05) { camera.fov = lerp(camera.fov, fov, damp(4, dt)); camera.updateProjectionMatrix(); }
}
function sync(dt, t) {
  for (const c of vehicles) {
    const m = c.mesh, smooth = c.ai === 'traffic';
    if (smooth) { c.mx += (c.x - c.mx) * damp(10, dt); c.mz += (c.z - c.mz) * damp(10, dt); } else { c.mx = c.x; c.mz = c.z; }
    if (c.my === null) c.my = world.groundAt(c.x, c.z); c.my += ((c.y || c.my) - c.my) * damp(18, dt);
    m.position.set(c.mx, c.my, c.mz); m.rotation.y = c.h; m.rotation.x = -c.slopeAng;
    const b = m.userData.body; b.rotation.z = -c.lean; b.rotation.x = c.pitch;
    c.spin += c.fwd * dt / .36; for (const w of m.userData.wheels) { w.children[0].rotation.x = c.spin; if (w.name === 'wf') w.rotation.y = c.steer * .45; }
  }
  const fig = playerFig.list[0];
  if (me.car && me.car.t.bike) { const c = me.car, fx = Math.sin(c.h), fz = Math.cos(c.h), lean = -c.lean; fig.x = c.mx - fx * .2 - Math.cos(c.h) * Math.sin(lean) * .55; fig.z = c.mz - fz * .2 + Math.sin(c.h) * Math.sin(lean) * .55; fig.y = c.my + .42; fig.h = c.h; fig.roll = lean; fig.mode = 2; fig.amt = 0; fig.gy = undefined; fig.tilt = -c.slopeAng; }
  else if (!me.car) { fig.x = me.x; fig.z = me.z; fig.y = me.y + (me.yOff || 0); fig.gy = me.y; fig.h = me.h; fig.phase = me.walkPhase; fig.roll = 0; if (!me.fly) fig.tilt = 0; }
  const fl = Math.floor(t * 6) % 2; sirenR.color.setRGB(fl ? 1 : .25, fl ? .1 : .03, fl ? .15 : .05); sirenB.color.setRGB(fl ? .05 : .1, fl ? .1 : .25, fl ? .3 : 1);
  for (const m of MISSIONS) if (m.marker) { m.marker.children[0].material.opacity = .25 + .15 * Math.sin(t * 3); m.marker.rotation.y = t; }
  cpMarker.children[0].material.opacity = .3 + .2 * Math.sin(t * 5);
  const c = me.car; if (c && night > .25 && !c.t.bike) { headSpot.intensity = 60 * night; const fx = Math.sin(c.h), fz = Math.cos(c.h); headSpot.position.set(c.x + fx * 2, c.my + 1.4, c.z + fz * 2); headSpot.target.position.set(c.x + fx * 30, c.my, c.z + fz * 30); } else headSpot.intensity = 0;
  sky.position.copy(camera.position); stars.position.copy(camera.position);
}

/* ---------------- loop ---------------- */
const STEP = 1 / 120; let acc = 0, last = performance.now(), frames = 0;
function frame(now) {
  requestAnimationFrame(frame); const dt = Math.min(.05, (now - last) / 1000); last = now; const t = now / 1000; frames++;
  if (state === 'loading') { updateCamera(dt); renderer.render(scene, camera); return; }
  if (state === 'play' && !mapOpen) { acc += dt; let n = 0; while (acc >= STEP && n < 8) { step(STEP); acc -= STEP; n++; } if (n >= 8) acc = 0; logic(dt); }
  else if (state === 'title') { gameMin = 18 * 60 + 25; world.update(camera.position.x, camera.position.z); }
  world.pump();
  updateWeather(dt); applyTOD(); updateCamera(dt); sync(state === 'play' ? dt : 0, t); crowd.update(t); playerFig.update(t);
  renderer.render(scene, camera);
  if (state !== 'title') { hud(dt); drawRadar(); if (mapOpen) drawMap(); }
  frameAudio({ playing: state === 'play', car: me.car, gas: keys.KeyW || keys.ArrowUp, slip: me.car ? me.car.slip : 0, policeDist: Math.min(1e9, ...vehicles.filter(c => c.ai === 'police').map(c => Math.hypot(c.x - ppos().x, c.z - ppos().z))), horn: keys.KeyH, rain: weather.v, time: t });
}
function startGame() {
  if (state !== 'title') return; state = 'play'; $('title').classList.add('hidden'); $('hud').classList.remove('hidden'); if (isTouch) $('touch').classList.remove('hidden');
  initAudio(); cam.yaw = me.h; camera.fov = 62; camera.updateProjectionMatrix();
  setTimeout(() => bigMsg('WELCOME TO PUNE', 'Real streets from OpenStreetMap. Press F near the pink scooter or the Rani GT. M opens the map.', '#ff4fa3', 5000), 300); setTimeout(toastRadio, 700);
}

async function boot() {
  requestAnimationFrame(frame);
  const prog = (f, txt) => { $('loadfill').style.width = Math.round(f * 100) + '%'; $('loadtxt').textContent = txt; };
  try { await world.load(prog); }
  catch (e) { $('loadtxt').textContent = 'Could not load the world data: ' + e.message; console.error(e.stack); return; }
  WATER = waterPolys();
  const counts = isTouch ? [26, 12, 8] : [56, 26, 18];
  crowd = new Crowd(scene, counts); playerFig = Crowd.player(scene);
  walkers = new Walkers(world, crowd); traffic = new Traffic(world, scene, vehicles, isTouch ? 18 : 34);
  setupMissions();
  // spawn on foot at Deccan Corner, with a Rani GT and a pink scooter waiting
  respawnOnFoot('Deccan Corner');
  { const fx = Math.sin(me.h), fz = Math.cos(me.h), e = world.nearestEdge(me.x, me.z, true, 100), p = {}; e.edge.pl.at(Math.min(e.edge.len, e.s + 12), p);
    const lane = e.edge.w / 2 - 1.6, c = makeVehicle(scene, 'rani', p.x + p.dz * lane, p.z - p.dx * lane, Math.atan2(p.dx, p.dz), 'parked'); c.keep = true; vehicles.push(c); }
  for (const [lm, type] of [['Fergusson College', 'rani'], ['Shaniwar Wada', 'raja'], ['Dagdusheth', 'scooty'], ['Mahatma Phule Mandai', 'auto'], ['Kasba Peth Metro', 'scooty'], ['Balgandharva', 'suv'], ['Deccan Gymkhana', 'raja'], ['Tulshibaug Ram Mandir', 'scooty'], ['Jangli Maharaj Mandir', 'padma']]) {
    const p = world.man.landmarks[lm]; if (!p) continue; const e = world.nearestEdge(p[0] + 20, p[1] + 20, true, 150); if (!e) continue; const q = {}; e.edge.pl.at(e.s, q); const lane = e.edge.w / 2 - 1.4;
    const c = makeVehicle(scene, type, q.x + q.dz * lane, q.z - q.dx * lane, Math.atan2(q.dx, q.dz), 'parked'); c.keep = true; vehicles.push(c);
  }
  await world.loadAround(me.x, me.z, prog);
  for (let k = 0; k < traffic.count; k++) traffic.spawn(me.x, me.z, 30, 380);
  for (const a of walkers.list) walkers.place(a, me.x, me.z, 8, 200);
  $('loading').classList.add('hidden'); $('title').classList.remove('hidden'); state = 'title';
  if (isTouch) $('startb').textContent = 'TAP TO PLAY';
  window.__game = { world, vehicles, me, W, get state() { return state; }, gps, traffic, walkers, keys, setTime: h => gameMin = h * 60, weather };
}
boot();
