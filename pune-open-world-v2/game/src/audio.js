// All sound is synthesised with Web Audio: 4 original radio stations, engine, skid, siren, horn, rain, crashes.
import { clamp, mulberry32 } from './util.js';

export const AU = { ctx: null, st: 0 };
const mtof = m => 440 * Math.pow(2, (m - 69) / 12);
export function initAudio() {
  if (AU.ctx) { if (AU.ctx.state === 'suspended') AU.ctx.resume(); return; }
  try { AU.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return; }
  const x = AU.ctx; AU.master = x.createGain(); AU.master.gain.value = .75; AU.master.connect(x.destination);
  AU.music = x.createGain(); AU.music.gain.value = .38; AU.music.connect(AU.master);
  AU.dl = x.createDelay(); AU.dl.delayTime.value = .27; const fb = x.createGain(); fb.gain.value = .3; AU.dl.connect(fb); fb.connect(AU.dl); const dg = x.createGain(); dg.gain.value = .35; AU.dl.connect(dg); dg.connect(AU.music);
  AU.sfx = x.createGain(); AU.sfx.gain.value = .8; AU.sfx.connect(AU.master);
  const nb = x.createBuffer(1, x.sampleRate, x.sampleRate), nd = nb.getChannelData(0); for (let k = 0; k < nd.length; k++) nd[k] = Math.random() * 2 - 1; AU.noise = nb;
  AU.engF = x.createBiquadFilter(); AU.engF.type = 'lowpass'; AU.eng = x.createGain(); AU.eng.gain.value = 0; AU.engF.connect(AU.eng); AU.eng.connect(AU.sfx);
  AU.e1 = x.createOscillator(); AU.e1.type = 'sawtooth'; AU.e2 = x.createOscillator(); AU.e2.type = 'square'; const g2 = x.createGain(); g2.gain.value = .45; AU.e1.connect(AU.engF); AU.e2.connect(g2); g2.connect(AU.engF); AU.e1.start(); AU.e2.start();
  const loopNoise = (type, f, q) => { const s = x.createBufferSource(); s.buffer = nb; s.loop = true; const fl = x.createBiquadFilter(); fl.type = type; fl.frequency.value = f; fl.Q.value = q; const g = x.createGain(); g.gain.value = 0; s.connect(fl); fl.connect(g); g.connect(AU.sfx); s.start(); return g; };
  AU.sk = loopNoise('bandpass', 1700, 1.6); AU.rain = loopNoise('highpass', 900, .5); AU.amb = loopNoise('lowpass', 400, .3);
  AU.sir = x.createOscillator(); AU.sir.type = 'square'; const sf = x.createBiquadFilter(); sf.type = 'lowpass'; sf.frequency.value = 1800; AU.sirG = x.createGain(); AU.sirG.gain.value = 0; AU.sir.connect(sf); sf.connect(AU.sirG); AU.sirG.connect(AU.sfx); AU.sir.start();
  AU.horn = x.createGain(); AU.horn.gain.value = 0; const hf = x.createBiquadFilter(); hf.type = 'lowpass'; hf.frequency.value = 1400; AU.horn.connect(hf); hf.connect(AU.sfx); [392, 494].forEach(f => { const o = x.createOscillator(); o.type = 'square'; o.frequency.value = f; o.connect(AU.horn); o.start(); });
  AU.next = x.currentTime + .1; AU.step = 0; setInterval(sched, 25);
}
function tone(t, f, dur, type, vol, cut, out, att, toDelay) {
  const x = AU.ctx, o = x.createOscillator(), g = x.createGain(); o.type = type; o.frequency.value = f; let n = o;
  if (cut) { const fl = x.createBiquadFilter(); fl.type = 'lowpass'; fl.frequency.value = cut; o.connect(fl); n = fl; }
  n.connect(g); g.connect(out || AU.music); if (toDelay) g.connect(AU.dl);
  att = att || .006; g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + att); g.gain.exponentialRampToValueAtTime(.0005, t + Math.max(dur, att + .02)); o.start(t); o.stop(t + dur + .05);
}
function nz(t, dur, vol, type, f, out) { const x = AU.ctx, s = x.createBufferSource(); s.buffer = AU.noise; const fl = x.createBiquadFilter(); fl.type = type; fl.frequency.value = f; const g = x.createGain(); g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(.0005, t + dur); s.connect(fl); fl.connect(g); g.connect(out || AU.music); s.start(t, Math.random() * .5); s.stop(t + dur + .03); }
function drum(t, f0, f1, dur, vol, out) { const x = AU.ctx, o = x.createOscillator(), g = x.createGain(); o.type = 'sine'; o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + dur * .6); g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(.0005, t + dur); o.connect(g); g.connect(out || AU.music); o.start(t); o.stop(t + dur + .03); }
function melody(seed, len, scale, rest) { const m = mulberry32(seed), a = []; let idx = 2; for (let k = 0; k < len; k++) { if (m() < rest) { a.push(null); continue; } idx = clamp(idx + Math.round((m() - .5) * 4), 0, scale.length * 2 - 1); a.push(scale[idx % scale.length] + (idx >= scale.length ? 12 : 0)); } return a; }
const MEL = { lav: melody(7, 32, [0, 1, 4, 5, 7, 8, 11], .35), gaz: melody(21, 32, [0, 2, 3, 5, 7, 8, 10], .55), dis: melody(3, 32, [0, 3, 5, 7, 10], .4) };
export const STATIONS = [
  { name: 'Disco Deccan FM', bpm: 118, play(s, t, sp) { const b = Math.floor(s / 16) % 4, q = s % 16, ch = [[57, 60, 64], [53, 57, 60], [60, 64, 67], [55, 59, 62]][b];
    if (q % 4 === 0) drum(t, 150, 42, .35, .9); if (q === 4 || q === 12) nz(t, .18, .32, 'bandpass', 1500); if (q % 2 === 1) nz(t, .05, .1, 'highpass', 8000); if (q % 4 === 2) nz(t, .14, .07, 'highpass', 7000);
    if (q % 2 === 0) tone(t, mtof(ch[0] - 24 + (q % 4 === 2 ? 12 : 0)), sp * 1.6, 'sawtooth', .2, 700); tone(t, mtof(ch[q % 3] + 12 + (q % 8 > 3 ? 12 : 0)), sp * .9, 'square', .035, 2600, null, 0, true);
    if (q === 0) ch.forEach(n => tone(t, mtof(n), sp * 16, 'sawtooth', .028, 1300, null, .3)); const mn = MEL.dis[s % 32]; if (mn !== null && q % 2 === 0 && b > 1) tone(t, mtof(69 + mn), sp * 1.8, 'triangle', .06, 0, null, 0, true); } },
  { name: 'Lavani Beats 98.3', bpm: 138, play(s, t, sp) { const q = s % 16; if ([0, 3, 6, 10, 12].includes(q)) drum(t, 120, 58, .28, .75); if ([2, 5, 8, 11, 14].includes(q)) { drum(t, 340, 250, .12, .32); nz(t, .04, .1, 'highpass', 3000); }
    if (q === 13 || q === 15) nz(t, .07, .18, 'bandpass', 2600); if (s % 64 === 0) { tone(t, mtof(50), sp * 64, 'sawtooth', .04, 500, null, 1); tone(t, mtof(57), sp * 64, 'sawtooth', .03, 500, null, 1); }
    const mn = MEL.lav[s % 32]; if (mn !== null && q % 2 === 0) tone(t, mtof(62 + mn), sp * 2.2, 'sawtooth', .06, 1800, null, .03, true); } },
  { name: 'Ghazal Nights', bpm: 74, play(s, t, sp) { const b = Math.floor(s / 16) % 4, q = s % 16, ch = [[57, 60, 64], [55, 59, 62], [53, 57, 60], [52, 56, 59]][b];
    if (q === 0) ch.forEach(n => tone(t, mtof(n), sp * 16, 'square', .025, 900, null, .2)); if ([0, 6, 8, 14].includes(q)) drum(t, 95, 70, .35, .5); if ([3, 10, 12].includes(q)) drum(t, 430, 400, .15, .22);
    const mn = MEL.gaz[s % 32]; if (mn !== null && q % 2 === 0) tone(t, mtof(69 + mn), sp * 3, 'sine', .09, 0, null, .02, true); } },
  { name: 'Lo-fi Kothrud', bpm: 80, play(s, t, sp) { const b = Math.floor(s / 16) % 4, q = s % 16; if (q % 2 === 1) t += sp * .18; const ch = [[53, 57, 60, 64], [52, 55, 59, 62], [50, 53, 57, 60], [55, 59, 62, 65]][b];
    if ([0, 7, 10].includes(q)) { drum(t, 110, 45, .3, .75); tone(t, mtof(ch[0] - 24), sp * 3, 'sine', .22); } if (q === 4 || q === 12) { nz(t, .2, .22, 'bandpass', 1800); drum(t, 190, 150, .1, .18); } if (q % 2 === 0) nz(t, .04, .05, 'highpass', 7000);
    if (q === 0 || q === 8) ch.forEach(n => { tone(t, mtof(n), sp * 7, 'sine', .05, 0, null, .02); tone(t, mtof(n + 12), sp * 4, 'triangle', .012, 1500); }); if (Math.random() < .35) nz(t, .02, .02 + Math.random() * .03, 'highpass', 5000); } },
  { name: 'Radio off', bpm: 0 },
];
function sched() {
  const x = AU.ctx; if (!x) return; const st = STATIONS[AU.st];
  if (AU.next < x.currentTime - .2) AU.next = x.currentTime + .05;
  if (!st.bpm) { AU.next = x.currentTime + .05; return; }
  const sp = 60 / st.bpm / 4; while (AU.next < x.currentTime + .12) { st.play(AU.step, AU.next, sp); AU.next += sp; AU.step++; }
}
export function playCrash(imp) { if (!AU.ctx) return; const t = AU.ctx.currentTime, v = clamp(imp / 30, .15, 1); nz(t, .45, v * .8, 'lowpass', 900, AU.sfx); drum(t, 90, 35, .3, v * .7, AU.sfx); nz(t, .12, v * .3, 'highpass', 4000, AU.sfx); }
export function jingle(ok) { if (!AU.ctx) return; const t = AU.ctx.currentTime; (ok ? [60, 64, 67, 72, 76] : [67, 63, 60, 55]).forEach((n, k) => tone(t + k * .12, mtof(n), .4, 'square', .07, 3000, AU.sfx)); }
export function honk(dist) { if (!AU.ctx || dist > 120) return; const t = AU.ctx.currentTime, v = .05 * (1 - dist / 120), f = [420, 520, 610][Math.floor(Math.random() * 3)]; tone(t, f, .25, 'square', v, 1600, AU.sfx); if (Math.random() < .5) tone(t + .3, f, .18, 'square', v, 1600, AU.sfx); }
export function frameAudio({ playing, car, gas, slip, policeDist, horn, rain, time }) {
  if (!AU.ctx) return; const now = AU.ctx.currentTime;
  if (car && playing) {
    const s = Math.abs(car.fwd), span = car.t.max / 5, gear = Math.min(4, Math.floor(s / span)), r = (s - gear * span) / span;
    const base = car.t.bike ? 70 : car.type === 'auto' ? 90 : car.type === 'bus' ? 35 : 50;
    const f = base + r * 75 + gear * 9 + (gas ? 8 : 0);
    AU.e1.frequency.setTargetAtTime(f, now, .05); AU.e2.frequency.setTargetAtTime(f * .5, now, .05); AU.engF.frequency.setTargetAtTime(380 + r * 900 + (gas ? 350 : 0), now, .06); AU.eng.gain.setTargetAtTime(.07, now, .1);
    AU.sk.gain.setTargetAtTime(Math.abs(slip) > 5 && s > 8 ? Math.min(.22, Math.abs(slip) / 45) : 0, now, .05);
  } else { AU.eng.gain.setTargetAtTime(0, now, .1); AU.sk.gain.setTargetAtTime(0, now, .05); }
  AU.sirG.gain.setTargetAtTime(playing && policeDist < 260 ? .06 * (1 - policeDist / 260) : 0, now, .1);
  AU.sir.frequency.setTargetAtTime(Math.floor(time * 2.2) % 2 ? 960 : 720, now, .03);
  AU.horn.gain.setTargetAtTime(horn && car && playing ? .07 : 0, now, .02);
  AU.rain.gain.setTargetAtTime(playing ? rain * .12 : 0, now, .4); AU.amb.gain.setTargetAtTime(playing ? .05 : 0, now, .5);
}
