// GPU-animated low-poly people. One InstancedMesh per body type; the walk cycle, run, sit (riding/driving),
// flail (hit by a car) and idle poses run in the vertex shader, so 100+ people cost a few draw calls.
import * as THREE from 'three';

// Joint pivots in object space (character faces +z, feet at y=0, ~1.72 m tall)
const PIV = { hipL: [.1, .92, 0], kneeL: [.1, .5, 0], hipR: [-.1, .92, 0], kneeR: [-.1, .5, 0], shL: [.24, 1.42, 0], elL: [.26, 1.13, 0], shR: [-.24, 1.42, 0], elR: [-.26, 1.13, 0] };
// slot: 0 skin, 1 top, 2 bottom, 3 hair, 4 shoes/dark, 5 accent
function body(type) {
  const pos = [], nor = [], part = [], slot = [];
  const box = (w, h, d, cx, cy, cz, pt, sl, taper = 1) => {
    const x = w / 2, y = h / 2, z = d / 2, tx = x * taper, tz = z * taper;
    const v = [[-x, -y, z], [x, -y, z], [tx, y, tz], [-tx, y, tz], [x, -y, -z], [-x, -y, -z], [-tx, y, -tz], [tx, y, -tz]];
    const faces = [[0, 1, 2, 3, 0, 0, 1], [4, 5, 6, 7, 0, 0, -1], [5, 0, 3, 6, -1, 0, 0], [1, 4, 7, 2, 1, 0, 0], [3, 2, 7, 6, 0, 1, 0], [5, 4, 1, 0, 0, -1, 0]];
    for (const f of faces) for (const k of [0, 1, 2, 0, 2, 3]) { const p = v[f[k]]; pos.push(p[0] + cx, p[1] + cy, p[2] + cz); nor.push(f[4], f[5], f[6]); part.push(pt); slot.push(sl); }
  };
  const saree = type === 1, kurta = type === 2;
  // legs (thigh part 1/3, shin+foot part 2/4)
  for (const [s, th, sh] of [[1, 1, 2], [-1, 3, 4]]) {
    box(.16, .44, .18, .1 * s, .71, 0, th, 2);
    box(.14, .42, .15, .1 * s, .29, 0, sh, 2);
    box(.15, .08, .27, .1 * s, .04, .05, sh, 4);
  }
  // torso, neck, head, hair
  box(.42, .56, .24, 0, 1.2, 0, 0, 1, .95);
  box(.36, .14, .22, 0, .93, 0, 0, saree ? 1 : 2);
  box(.1, .08, .1, 0, 1.52, 0, 0, 0);
  box(.22, .25, .23, 0, 1.66, 0, 0, 0);
  box(.24, .08, .25, 0, 1.8, -.01, 0, 3);
  box(.24, .14, .06, 0, 1.7, -.115, 0, 3);
  if (saree) { box(.5, .86, .38, 0, .5, 0, 0, 1, .74); box(.12, .62, .26, .14, 1.22, 0, 0, 5); box(.18, .16, .14, 0, 1.68, -.16, 0, 3); }
  if (kurta) { box(.46, .48, .27, 0, .82, 0, 0, 1, 1.05); box(.25, .09, .26, 0, 1.84, 0, 0, 5); }
  if (type === 3) box(.2, .05, .02, 0, 1.68, .12, 0, 4);   // player: sunglasses
  // arms: upper (5/7), forearm+hand (6/8)
  for (const [s, up, lo] of [[1, 5, 6], [-1, 7, 8]]) {
    box(.12, .32, .13, .27 * s, 1.27, 0, up, 1);
    box(.1, .28, .11, .27 * s, .98, 0, lo, saree || kurta ? 0 : (type === 3 ? 0 : 0));
    box(.09, .09, .1, .27 * s, .8, 0, lo, 0);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('aPart', new THREE.Float32BufferAttribute(part, 1)); g.setAttribute('aSlot', new THREE.Float32BufferAttribute(slot, 1));
  g.setAttribute('color', new THREE.Float32BufferAttribute(new Array(pos.length).fill(1), 3));
  return g;
}

const v3 = a => `vec3(${a[0].toFixed(3)},${a[1].toFixed(3)},${a[2].toFixed(3)})`;
function makeMaterial() {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true });
  m.onBeforeCompile = sh => {
    sh.uniforms.uTime = { value: 0 }; m.userData.shader = sh;
    sh.vertexShader = sh.vertexShader.replace('#include <common>', `#include <common>
attribute float aPart; attribute float aSlot; attribute vec4 iAnim; attribute vec3 iSkin; attribute vec3 iTop; attribute vec3 iBot; attribute vec3 iHair;
uniform float uTime;
mat3 rX(float a){float c=cos(a),s=sin(a);return mat3(1.,0.,0.,0.,c,s,0.,-s,c);}
mat3 rZ(float a){float c=cos(a),s=sin(a);return mat3(c,s,0.,-s,c,0.,0.,0.,1.);}
vec3 animate(vec3 p, inout vec3 n){
  float ph=iAnim.x, amt=iAnim.y, mode=iAnim.z, sp=sin(ph);
  float A=.52*min(amt,1.)+.32*max(amt-1.,0.);
  float hipL=-sp*A, hipR=sp*A;
  float kneeL=A*1.5*max(0.,sin(ph+.9))+.05, kneeR=A*1.5*max(0.,-sin(ph+.9))+.05;
  float shL=sp*A*1.15, shR=-sp*A*1.15, elL=-.2-.45*min(amt,2.)*.5, elR=elL, armOut=0.;
  float bob=abs(cos(ph))*.045*min(amt,1.6);
  float breathe=sin(uTime*1.7+iAnim.w*6.)*.03*(1.-min(amt,1.));
  shL+=breathe; shR-=breathe;
  if(mode>.5&&mode<1.5){ float t=uTime*13.+iAnim.w*9.; hipL=sin(t)*.9; hipR=-sin(t*1.1)*.9; kneeL=kneeR=.9; shL=-2.4+.6*sin(t); shR=-2.4-.6*sin(t*.9); elL=elR=-.4; armOut=.5; bob=0.; }
  if(mode>1.5&&mode<2.5){ hipL=hipR=-1.5; kneeL=kneeR=1.45; shL=shR=-1.0; elL=elR=-.55; bob=0.; }
  if(mode>2.5){ shL=shR=-2.9; elL=elR=-.2; hipL=hipR=0.; kneeL=kneeR=.05; bob=0.; }
  int pt=int(aPart+.5);
  vec3 H,K; mat3 Rh,Rk;
  if(pt==1||pt==2){ H=${v3(PIV.hipL)}; K=${v3(PIV.kneeL)}; Rh=rX(hipL); Rk=rX(kneeL); }
  if(pt==3||pt==4){ H=${v3(PIV.hipR)}; K=${v3(PIV.kneeR)}; Rh=rX(hipR); Rk=rX(kneeR); }
  if(pt==5||pt==6){ H=${v3(PIV.shL)}; K=${v3(PIV.elL)}; Rh=rX(shL)*rZ(armOut); Rk=rX(elL); }
  if(pt==7||pt==8){ H=${v3(PIV.shR)}; K=${v3(PIV.elR)}; Rh=rX(shR)*rZ(-armOut); Rk=rX(elR); }
  if(pt==1||pt==3||pt==5||pt==7){ p=H+Rh*(p-H); n=Rh*n; }
  else if(pt!=0){ p=H+Rh*((K-H)+Rk*(p-K)); n=Rh*Rk*n; }
  p.y+=bob; return p;
}`).replace('#include <beginnormal_vertex>', 'vec3 objectNormal = vec3( normal ); vec3 animP = animate(vec3(position), objectNormal);')
      .replace('#include <begin_vertex>', 'vec3 transformed = animP;')
      .replace('#include <color_vertex>', 'vColor = aSlot<.5?iSkin:aSlot<1.5?iTop:aSlot<2.5?iBot:aSlot<3.5?iHair:aSlot<4.5?vec3(.06):iTop*.6+vec3(.3,.2,.05);');
  };
  return m;
}

const SKIN = ['#8d5a3b', '#a8714a', '#c48a5c', '#7a4a30', '#b97a52', '#d0a07a'];
const TOPS = { 0: ['#ffffff', '#e74c3c', '#3498db', '#2c3e50', '#f1c40f', '#16a085', '#ecf0f1', '#9b59b6', '#e67e22', '#95a5a6'],
  1: ['#c0392b', '#8e44ad', '#16a085', '#f39c12', '#d35400', '#e84393', '#27ae60', '#2980b9', '#fd79a8'],
  2: ['#f5f5f5', '#f7e7c6', '#d6eaf8', '#fdebd0', '#e8daef', '#ffffff'] };
const BOTS = { 0: ['#2c3e50', '#34495e', '#1f3a5f', '#4a4a4a', '#6b5b45', '#283747'], 1: ['#c0392b', '#8e44ad', '#16a085', '#f39c12'], 2: ['#f5f5f5', '#ffffff', '#ecf0f1'] };

export class Crowd {
  /** counts: per body type [male, saree, kurta] */
  constructor(scene, counts) {
    this.mat = makeMaterial(); this.meshes = []; this.list = [];
    const shadowTex = (() => { const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d'); const gr = g.createRadialGradient(32, 32, 3, 32, 32, 32); gr.addColorStop(0, 'rgba(0,0,0,.5)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.fillRect(0, 0, 64, 64); return new THREE.CanvasTexture(c); })();
    this.shadowMat = new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false });
    const total = counts.reduce((a, b) => a + b, 0);
    this.shadow = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), this.shadowMat, total + 1); this.shadow.frustumCulled = false; scene.add(this.shadow);
    counts.forEach((n, type) => {
      const g = body(type), mesh = new THREE.InstancedMesh(g, this.mat, Math.max(1, n));
      const attr = (name, size) => { const a = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, n) * size), size); a.setUsage(THREE.DynamicDrawUsage); g.setAttribute(name, a); return a; };
      mesh.userData = { anim: attr('iAnim', 4), skin: attr('iSkin', 3), top: attr('iTop', 3), bot: attr('iBot', 3), hair: attr('iHair', 3) };
      mesh.frustumCulled = false; mesh.count = n; scene.add(mesh); this.meshes.push(mesh);
      const c = new THREE.Color();
      for (let k = 0; k < n; k++) {
        const pick = a => a[Math.floor(Math.random() * a.length)];
        const set = (a, hex) => { c.set(hex); a.setXYZ(k, c.r, c.g, c.b); };
        set(mesh.userData.skin, pick(SKIN)); set(mesh.userData.top, pick(TOPS[type])); set(mesh.userData.bot, pick(BOTS[type]));
        set(mesh.userData.hair, type === 2 && Math.random() < .5 ? '#f5f5f5' : (Math.random() < .15 ? '#8a8a8a' : '#151515'));
        this.list.push({ mesh, k, type, x: 0, y: -100, z: 0, h: 0, phase: Math.random() * 6, amt: 0, mode: 0, seed: Math.random(), tilt: 0, visible: false });
      }
    });
    this.d = new THREE.Object3D();
  }
  /** Player-style single character with chosen colours. */
  static player(scene) {
    const cr = new Crowd(scene, [0, 0, 0]);
    const g = body(3), mesh = new THREE.InstancedMesh(g, cr.mat, 1);
    const attr = (name, size, v) => { const a = new THREE.InstancedBufferAttribute(new Float32Array(v), size); a.setUsage(THREE.DynamicDrawUsage); g.setAttribute(name, a); return a; };
    const c = new THREE.Color(), col = h => (c.set(h), [c.r, c.g, c.b]);
    mesh.userData = { anim: attr('iAnim', 4, [0, 0, 0, 0]), skin: attr('iSkin', 3, col('#a8714a')), top: attr('iTop', 3, col('#2ff3e0')), bot: attr('iBot', 3, col('#f5efe0')), hair: attr('iHair', 3, col('#151515')) };
    mesh.frustumCulled = false; scene.add(mesh); cr.meshes.push(mesh);
    cr.list.push({ mesh, k: 0, type: 3, x: 0, y: 0, z: 0, h: 0, phase: 0, amt: 0, mode: 0, seed: .3, tilt: 0, roll: 0, visible: true });
    return cr;
  }
  update(time) {
    if (this.mat.userData.shader) this.mat.userData.shader.uniforms.uTime.value = time;
    const d = this.d; let si = 0;
    for (const p of this.list) {
      const ud = p.mesh.userData;
      if (!p.visible) { d.position.set(0, -500, 0); d.scale.set(0, 0, 0); }
      else { d.position.set(p.x, p.y, p.z); d.rotation.set(p.tilt || 0, p.h, p.roll || 0, 'YXZ'); d.scale.set(1, 1, 1); }
      d.updateMatrix(); p.mesh.setMatrixAt(p.k, d.matrix);
      ud.anim.setXYZW(p.k, p.phase, p.amt, p.mode, p.seed);
      if (p.visible && p.mode !== 2) { d.position.set(p.x, p.gy !== undefined ? p.gy + .04 : p.y + .04, p.z); d.rotation.set(0, 0, 0); d.scale.set(1.1, 1, 1.1); } else { d.scale.set(0, 0, 0); }
      d.updateMatrix(); this.shadow.setMatrixAt(si++, d.matrix);
    }
    this.shadow.count = si; this.shadow.instanceMatrix.needsUpdate = true;
    for (const m of this.meshes) { m.instanceMatrix.needsUpdate = true; m.userData.anim.needsUpdate = true; }
  }
}
