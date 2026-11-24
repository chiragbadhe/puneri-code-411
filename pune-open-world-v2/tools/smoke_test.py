"""Headless smoke test: serves game/, plays for a while, captures screenshots and console errors.
Usage: python tools/smoke_test.py [outdir]
Needs: pip install playwright && a Chrome/Chromium binary (uses /usr/bin/google-chrome if present).
"""
import os, sys, time, threading, http.server, functools, json
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'tools', 'shots')
os.makedirs(OUT, exist_ok=True)
THREE = None
for p in ['/home/claude/deps2/node_modules/three/build/three.module.js', os.path.join(ROOT, 'node_modules/three/build/three.module.js')]:
    if os.path.exists(p): THREE = open(p).read(); break

handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=os.path.join(ROOT, 'game'))
class Quiet(handler.func):
    def log_message(self, *a): pass
srv = http.server.ThreadingHTTPServer(('127.0.0.1', 8765), functools.partial(Quiet, directory=os.path.join(ROOT, 'game')))
threading.Thread(target=srv.serve_forever, daemon=True).start()

errors = []
with sync_playwright() as p:
    exe = '/usr/bin/google-chrome' if os.path.exists('/usr/bin/google-chrome') else None
    b = p.chromium.launch(executable_path=exe, args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'])
    pg = b.new_page(viewport={'width': 1280, 'height': 720})
    pg.on('console', lambda m: errors.append(m.type + ': ' + m.text) if m.type in ('error', 'warning') else None)
    pg.on('pageerror', lambda e: errors.append('PAGEERROR: ' + str(e)))
    def route(r):
        u = r.request.url
        if '/npm/three@0.160.0/' in u:
            local = u.split('/npm/three@0.160.0/')[1]
            for base in ['/home/claude/deps2/node_modules/three/', os.path.join(ROOT, 'node_modules/three/')]:
                if os.path.exists(base + local): r.fulfill(status=200, content_type='application/javascript', body=open(base + local).read()); return
            r.abort()
        elif u.startswith('http://127.0.0.1'): r.continue_()
        else: r.abort()
    pg.route('**/*', route)
    pg.goto('http://127.0.0.1:8765/index.html')
    for _ in range(120):
        time.sleep(1)
        if pg.evaluate("()=>window.__game && window.__game.state==='title'"): break
    print('state', pg.evaluate("()=>window.__game ? window.__game.state : document.getElementById('loadtxt').textContent"))
    pg.screenshot(path=f'{OUT}/1_title.png')
    pg.keyboard.press('Enter'); time.sleep(1.5)
    pg.screenshot(path=f'{OUT}/2_onfoot.png')
    pg.keyboard.down('KeyW'); time.sleep(1.2); pg.keyboard.up('KeyW')
    pg.screenshot(path=f'{OUT}/3_walk.png')
    # get into the nearest vehicle
    pg.evaluate("""()=>{const g=window.__game;let best=null,bd=1e9;for(const c of g.vehicles){if(c.type!=='rani')continue;const d=Math.hypot(c.x-g.me.x,c.z-g.me.z);if(d<bd){bd=d;best=c}}g.me.x=best.x+2.6*Math.cos(best.h);g.me.z=best.z-2.6*Math.sin(best.h);}""")
    time.sleep(.3); pg.keyboard.press('KeyF'); time.sleep(1.5)
    print('in car', pg.evaluate("()=>window.__game.me.car && window.__game.me.car.type"))
    pg.keyboard.down('KeyW'); time.sleep(4); pg.screenshot(path=f'{OUT}/4_drive.png')
    pg.keyboard.down('KeyA'); pg.keyboard.down('Space'); time.sleep(1); pg.keyboard.up('Space'); pg.keyboard.up('KeyA'); time.sleep(2)
    pg.keyboard.up('KeyW'); pg.screenshot(path=f'{OUT}/5_drive2.png')
    fps = pg.evaluate("()=>new Promise(r=>{let n=0;const t0=performance.now();function f(){n++;if(performance.now()-t0<2000)requestAnimationFrame(f);else r(n/2)}requestAnimationFrame(f)})")
    info = pg.evaluate("""()=>{const g=window.__game;return {chunks:g.world.chunks.size,vehicles:g.vehicles.length,traffic:g.vehicles.filter(c=>c.ai==='traffic').length,walkers:g.walkers.list.filter(a=>a.state!=='off').length,car:g.me.car&&g.me.car.type,x:Math.round(g.ppos?0:g.me.car?g.me.car.x:g.me.x)}}""")
    print('fps (software GL)', fps, info)
    pg.keyboard.press('KeyM'); time.sleep(.6); pg.screenshot(path=f'{OUT}/6_map.png'); pg.keyboard.press('KeyM')
    # night + rain + wanted
    pg.evaluate("()=>{const g=window.__game;g.setTime(20.6);g.weather.target=1;g.weather.v=1;g.W.level=2}")
    time.sleep(5); pg.screenshot(path=f'{OUT}/7_night_rain.png')
    print('police', pg.evaluate("()=>window.__game.vehicles.filter(c=>c.ai==='police').length"))
    # scooter
    pg.evaluate("()=>{const g=window.__game;g.setTime(10);g.weather.target=0;g.weather.v=0;g.W.level=0}")
    pg.keyboard.down('KeyS'); time.sleep(2.5); pg.keyboard.up('KeyS'); time.sleep(1); pg.keyboard.press('KeyF'); time.sleep(.5)
    pg.evaluate("""()=>{const g=window.__game;let best=null,bd=1e9;for(const c of g.vehicles){if(!c.t.bike)continue;const d=Math.hypot(c.x-g.me.x,c.z-g.me.z);if(d<bd){bd=d;best=c}}g.me.car=null;g.me.x=best.x+1.2*Math.cos(best.h);g.me.z=best.z-1.2*Math.sin(best.h);}""")
    time.sleep(.3); pg.keyboard.press('KeyF'); time.sleep(1.2); pg.keyboard.down('KeyW'); time.sleep(2.5); pg.keyboard.down('KeyA'); time.sleep(.8)
    pg.screenshot(path=f'{OUT}/8_scooter_day.png'); pg.keyboard.up('KeyA'); pg.keyboard.up('KeyW')
    print('bike', pg.evaluate("()=>window.__game.me.car && window.__game.me.car.type"))
    b.close()
srv.shutdown()
errs = [e for e in errors if 'GL Driver' not in e and 'GPU stall' not in e]
print('\n'.join(errs[:25]) or 'NO ERRORS')
