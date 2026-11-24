"""Blender asset factory for Puneri: Real Pune.

Models Pune building facade modules in 3D (windows with MS grilles and chajja sunshades, balconies,
AC units, wooden wada windows, glass curtain wall, rolling-shutter shop fronts, Mangalore roof tiles),
renders them with Cycles into tileable facade atlases (+ night window masks), and exports 3D props
(water tank, AC unit, balcony, stair head, dish, street lamp) as one GLB.

Run (Blender as a module):   python tools/blender/make_assets.py
or inside Blender:            blender -b -P tools/blender/make_assets.py
Outputs: game/assets/*.png, game/assets/props.glb
"""
import math, os, random, sys
import bpy, bmesh

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(ROOT, "game", "assets"); os.makedirs(OUT, exist_ok=True)
TMP = os.path.join(ROOT, "tools", "blender", "renders"); os.makedirs(TMP, exist_ok=True)
random.seed(411)
BAY = 3.2   # metres per window bay and per floor


# ------------------------------------------------------------------ helpers
def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.render.engine = "CYCLES"; sc.cycles.device = "CPU"; sc.cycles.samples = 48
    try: sc.cycles.use_denoising = True
    except Exception: pass
    sc.view_settings.view_transform = "Standard"; sc.view_settings.look = "None"; sc.view_settings.exposure = -0.45
    sc.render.film_transparent = False
    w = bpy.data.worlds.new("w"); sc.world = w; w.use_nodes = True
    w.node_tree.nodes["Background"].inputs[0].default_value = (0.78, 0.8, 0.85, 1); w.node_tree.nodes["Background"].inputs[1].default_value = 0.9
    return sc


def mat(name, rgb, rough=.8, metal=0., emit=None, noise=0.):
    m = bpy.data.materials.get(name)
    if m: return m
    m = bpy.data.materials.new(name); m.use_nodes = True
    nt = m.node_tree; b = nt.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*rgb, 1); b.inputs["Roughness"].default_value = rough; b.inputs["Metallic"].default_value = metal
    if emit:
        b.inputs["Emission Color"].default_value = (*emit, 1); b.inputs["Emission Strength"].default_value = 1.0
    if noise:  # plaster/stain variation
        tex = nt.nodes.new("ShaderNodeTexNoise"); tex.inputs["Scale"].default_value = 6; tex.inputs["Detail"].default_value = 8
        mix = nt.nodes.new("ShaderNodeMix"); mix.data_type = "RGBA"; mix.inputs[0].default_value = noise
        mix.inputs[6].default_value = (*rgb, 1); mix.inputs[7].default_value = (rgb[0] * .78, rgb[1] * .76, rgb[2] * .72, 1)
        nt.links.new(tex.outputs["Fac"], mix.inputs[0]); nt.links.new(mix.outputs[2], b.inputs["Base Color"])
        bump = nt.nodes.new("ShaderNodeBump"); bump.inputs["Strength"].default_value = .15
        nt.links.new(tex.outputs["Fac"], bump.inputs["Height"]); nt.links.new(bump.outputs["Normal"], b.inputs["Normal"])
    return m


def box(name, size, loc, m, bevel=0.0):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
    o = bpy.context.active_object; o.name = name; o.scale = size
    bpy.ops.object.transform_apply(scale=True)
    if bevel:
        mod = o.modifiers.new("bev", "BEVEL"); mod.width = bevel; mod.segments = 2
    o.data.materials.append(m); return o


def cyl(name, r, h, loc, m, verts=16, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_cylinder_add(radius=r, depth=h, location=loc, vertices=verts, rotation=rot)
    o = bpy.context.active_object; o.name = name; o.data.materials.append(m); return o


def cut(target, cutter):
    mod = target.modifiers.new("cut", "BOOLEAN"); mod.object = cutter; mod.operation = "DIFFERENCE"
    bpy.context.view_layer.objects.active = target; bpy.ops.object.modifier_apply(modifier=mod.name)
    bpy.data.objects.remove(cutter, do_unlink=True)


def camera_and_sun(w, h, cx, cz):
    bpy.ops.object.camera_add(location=(cx, -20, cz), rotation=(math.radians(90), 0, 0))
    cam = bpy.context.active_object; cam.data.type = "ORTHO"; cam.data.ortho_scale = max(w, h)
    bpy.context.scene.camera = cam
    bpy.ops.object.light_add(type="SUN", rotation=(math.radians(52), math.radians(-18), math.radians(-28)))
    sun = bpy.context.active_object; sun.data.energy = 3.2; sun.data.angle = math.radians(4)


def render(path, px_w, px_h):
    sc = bpy.context.scene; sc.render.resolution_x = px_w; sc.render.resolution_y = px_h; sc.render.resolution_percentage = 100
    sc.render.filepath = path; sc.render.image_settings.file_format = "PNG"; bpy.ops.render.render(write_still=True)


# ------------------------------------------------------------------ facade modules
WHITE = (0.86, 0.85, 0.82)

def wall(w=BAY, h=BAY):
    wm = mat("plaster", WHITE, .9, noise=.35)
    o = box("wall", (w, .3, h), (w / 2, .15, h / 2), wm)
    box("slab", (w, .12, .2), (w / 2, -.05, .1), mat("slab", (.74, .72, .68), .9, noise=.2))
    return o

def window(o, x, z, w, h, style="ms", lit=False):
    cutter = box("c", (w, 1, h), (x, 0, z), mat("x", (0, 0, 0))); cut(o, cutter)
    glass = mat("glass_lit" if lit else "glass", (.08, .1, .13) if not lit else (0, 0, 0), .15, emit=(1, .78, .45) if lit else None)
    if lit and style == "ms" and random.random() < .4: glass = mat("glass_lit_cool", (0, 0, 0), .2, emit=(.75, .9, 1))
    box("glass", (w, .02, h), (x, .2, z), glass)
    frame = mat("frame_wood" if style == "wood" else "frame", (.32, .18, .09) if style == "wood" else (.55, .56, .55), .6)
    for dx in (-w / 2, w / 2): box("f", (.06, .08, h), (x + dx, .12, z), frame)
    for dz in (-h / 2, h / 2): box("f", (w, .08, .06), (x, .12, z + dz), frame)
    box("mid", (.04, .06, h), (x, .14, z), frame)
    if style == "ms":   # mild-steel window grille, very Pune
        g = mat("grille", (.18, .2, .2), .5, .6)
        for k in range(1, 7): box("g", (.025, .03, h), (x - w / 2 + k * w / 7, -.02, z), g)
        for k in (1, 2): box("g", (w, .03, .025), (x, -.02, z - h / 2 + k * h / 3), g)
    if style == "wood":  # wooden shutters half open
        sh = mat("shutter", (.36, .2, .1), .7)
        box("sh", (.08, .5, h * .95), (x - w / 2 - .2, -.15, z), sh)
    # chajja (concrete sunshade) above the window
    box("chajja", (w + .5, .55, .07), (x, -.25, z + h / 2 + .2), mat("chajja", (.8, .79, .76), .9, noise=.4))
    box("sill", (w + .1, .15, .05), (x, -.05, z - h / 2 - .03), mat("chajja", (.8, .79, .76), .9))

def balcony(x, w, top=1.05):
    s = mat("slab", (.74, .72, .68), .9)
    box("bslab", (w, 1.1, .14), (x, -.55, .2), s)
    rail = mat("rail", (.15, .17, .17), .5, .7)
    box("rtop", (w, .05, .05), (x, -1.08, .2 + top), rail)
    for k in range(int(w / .12)): box("rb", (.02, .02, top), (x - w / 2 + .06 + k * .12, -1.08, .2 + top / 2), rail)
    for side in (-1, 1): box("rside", (.04, 1.1, .04), (x + side * w / 2, -.55, .2 + top), rail)

def ac_unit(x, z):
    a = mat("ac", (.88, .87, .82), .5)
    box("ac", (.8, .3, .55), (x, -.2, z), a, .02)
    cyl("fan", .2, .03, (x - .12, -.36, z), mat("acfan", (.2, .2, .2), .6), 20, (math.radians(90), 0, 0))
    for k in range(6): box("pipe", (.02, .02, .3), (x + .3, -.1, z + .3 + k * 0), mat("pipe", (.8, .8, .8), .4))

def clothes(x, z, w):
    for k in range(5):
        c = mat(f"cloth{k}", random.choice([(.75, .1, .12), (.1, .3, .7), (.9, .75, .1), (.9, .9, .9), (.2, .55, .3), (.8, .3, .55)]), .9)
        box("cloth", (.35, .02, .55), (x - w / 2 + .3 + k * (w - .5) / 4, -1.0, z), c)

def build_bay(kind, variant, lit):
    reset(); random.seed(hash((kind, variant)) % 1000)
    if kind == "apt":
        o = wall()
        if variant == 0: window(o, 1.6, 1.7, 1.6, 1.3, "ms", lit)
        elif variant == 1: window(o, 1.0, 1.75, 1.1, 1.25, "ms", lit); window(o, 2.5, 1.75, .7, 1.25, "ms", lit and random.random() < .5)
        elif variant == 2: window(o, 1.6, 1.4, .95, 2.05, "plain", lit); balcony(1.6, 3.0); clothes(1.6, 1.0, 2.6)
        else: window(o, 1.6, 1.7, 1.6, 1.3, "ms", lit); ac_unit(2.55, .75)
    elif kind == "old":
        o = wall(); o.data.materials[0] = mat("lime", (.86, .8, .68), .95, noise=.5)
        if variant in (0, 1): window(o, 1.6, 1.7, 1.0 if variant == 0 else 1.5, 1.4, "wood", lit)
        if variant == 2:   # wooden gallery balcony of a wada
            window(o, 1.6, 1.5, 1.0, 1.9, "wood", lit)
            wd = mat("teak", (.34, .19, .09), .7)
            box("gal", (3.2, .9, .12), (1.6, -.45, .25), wd); box("galtop", (3.2, .06, .08), (1.6, -.88, 1.25), wd)
            for k in range(14): box("bal", (.06, .06, 1.0), (.15 + k * .22, -.88, .75), wd)
        if variant == 3: window(o, .9, 1.7, .8, 1.3, "wood", lit); window(o, 2.3, 1.7, .8, 1.3, "wood", lit and random.random() < .5)
        box("tilechajja", (3.2, .7, .08), (1.6, -.3, 2.75), mat("terracotta", (.55, .22, .12), .8, noise=.4))
    elif kind == "tower":
        o = wall(); o.data.materials[0] = mat("towerclad", (.82, .83, .85), .6)
        g = mat("tglass_lit" if lit else "tglass", (0, 0, 0) if lit else (.18, .3, .42), .08, .3 if not lit else 0, emit=(.95, .95, 1) if lit else None)
        cutter = box("c", (2.9, 1, 2.5), (1.6, 0, 1.6), mat("x", (0, 0, 0))); cut(o, cutter)
        box("tg", (2.9, .02, 2.5), (1.6, .2, 1.6), g)
        m = mat("mullion", (.6, .62, .65), .3, .8)
        for k in range(4): box("mu", (.05, .1, 2.5), (.15 + k * .967, .12, 1.6), m)
        box("mh", (2.9, .1, .05), (1.6, .12, 2.2), m)
    elif kind == "shop":
        o = wall(BAY, 3.6)
        sign = mat(f"sign{variant}", [(.72, .1, .1), (.08, .3, .62), (.95, .62, .05), (.07, .45, .35)][variant], .5, emit=None)
        box("board", (3.1, .12, .75), (1.6, -.08, 3.1), sign)
        for k in range(5): box("letter", (.32, .02, .32), (.55 + k * .52, -.15, 3.12), mat("letters", (.97, .95, .9), .4))
        cutter = box("c", (2.9, 1, 2.55), (1.6, 0, 1.33), mat("x", (0, 0, 0))); cut(o, cutter)
        if variant % 2 == 0:   # rolling shutter partly up
            sh = mat("shutter_ms", (.55, .57, .58), .45, .7)
            for k in range(10): box("s", (2.9, .05, .1), (1.6, .05, 2.55 - k * .1), sh)
            box("inside", (2.9, .02, 1.6), (1.6, .25, .85), mat("shop_in_lit" if lit else "shop_in", (.35, .25, .15) if not lit else (0, 0, 0), .8, emit=(1, .85, .55) if lit else None))
        else:                   # open shop with goods
            box("inside", (2.9, .02, 2.55), (1.6, .3, 1.33), mat("shop_in_lit" if lit else "shop_in", (.35, .25, .15) if not lit else (0, 0, 0), .8, emit=(1, .85, .55) if lit else None))
            for k in range(6):
                c = mat(f"goods{k}", random.choice([(.8, .2, .2), (.2, .4, .8), (.9, .8, .2), (.9, .9, .9), (.3, .6, .3)]), .7)
                box("goods", (.4, .3, .5), (.5 + k * .45, .05, .5 + (k % 2) * .6), c)
        if variant in (1, 2):  # awning
            aw = mat(f"awning{variant}", [(.1, .45, .55), (.75, .15, .15)][variant - 1], .8)
            bpy.ops.mesh.primitive_plane_add(size=1, location=(1.6, -.6, 2.55)); a = bpy.context.active_object
            a.scale = (3.1, 1.2, 1); a.rotation_euler = (math.radians(-25), 0, 0); a.data.materials.append(aw)
    camera_and_sun(BAY, 3.6 if kind == "shop" else BAY, 1.6, (3.6 if kind == "shop" else BAY) / 2)
    if lit:  # night pass: only emitters visible
        for m in bpy.data.materials:
            if "lit" in m.name: continue
            if m.node_tree:
                b = m.node_tree.nodes.get("Principled BSDF")
                if b: b.inputs["Base Color"].default_value = (0, 0, 0, 1); b.inputs["Roughness"].default_value = 1
        for o in bpy.data.objects:
            if o.type == "LIGHT": o.data.energy = 0
        bpy.context.scene.world.node_tree.nodes["Background"].inputs[1].default_value = 0
    path = os.path.join(TMP, f"{kind}_{variant}_{'lit' if lit else 'day'}.png")
    render(path, 256, 288 if kind == "shop" else 256)
    return path


def roof_tiles():
    """Mangalore-tile roof texture (2 m x 2 m, tileable)."""
    reset()
    bpy.ops.mesh.primitive_plane_add(size=2, location=(1, 1, 0)); bpy.context.active_object.data.materials.append(mat("battens", (.3, .14, .08), .9))
    t = mat("mangalore", (.62, .24, .12), .75, noise=.55)
    rows, cols = 8, 7
    for r in range(rows):
        for c in range(cols):
            x = (c + .5) * 2 / cols + (.0 if r % 2 == 0 else 0); y = (r + .5) * 2 / rows
            bpy.ops.mesh.primitive_cylinder_add(radius=2 / cols / 2 * 1.02, depth=2 / rows * 1.15, location=(x, y, 0), vertices=14, rotation=(math.radians(90 - 8), 0, 0))
            o = bpy.context.active_object; o.scale = (1, .45, 1); o.data.materials.append(t)
    bpy.ops.object.camera_add(location=(1, 1, 10)); cam = bpy.context.active_object; cam.data.type = "ORTHO"; cam.data.ortho_scale = 2; bpy.context.scene.camera = cam
    bpy.ops.object.light_add(type="SUN", rotation=(math.radians(35), 0, math.radians(20))); bpy.context.active_object.data.energy = 3
    p = os.path.join(OUT, "roof_tiles.png"); render(p, 256, 256); return p


# ------------------------------------------------------------------ props (GLB)
def props():
    reset()
    objs = []
    def keep(o, name): o.name = name; objs.append(o); return o
    # Sintex-style ribbed black water tank, 1000 L
    t = mat("tank", (.04, .04, .045), .55)
    tank = cyl("tank", .55, 1.3, (0, 0, .65), t, 24)
    for k in range(4): cyl("rib", .57, .06, (0, 0, .2 + k * .3), t, 24)
    cyl("lid", .25, .12, (0, 0, 1.36), t, 16)
    bpy.ops.object.select_all(action="DESELECT")
    for o in bpy.data.objects:
        if o.name.startswith(("tank", "rib", "lid")): o.select_set(True)
    bpy.context.view_layer.objects.active = tank; bpy.ops.object.join(); keep(tank, "water_tank")
    # AC outdoor unit
    a = box("ac", (.8, .3, .55), (3, 0, .3), mat("acbody", (.9, .89, .85), .5), .02)
    cyl("fan", .19, .04, (2.88, -.16, .3), mat("acgrill", (.25, .25, .25), .6), 20, (math.radians(90), 0, 0))
    bpy.ops.object.select_all(action="DESELECT")
    for o in bpy.data.objects:
        if o.name.startswith(("ac", "fan")): o.select_set(True)
    bpy.context.view_layer.objects.active = a; bpy.ops.object.join(); keep(a, "ac_unit")
    # balcony (3 m wide, origin at the wall/floor line, sticks out along -Y)
    s = mat("bslab", (.78, .76, .72), .9); rail = mat("brail", (.16, .18, .18), .5, .7)
    b = box("balc", (3, 1.1, .14), (6, -.55, .07), s)
    box("balc_t", (3, .05, .05), (6, -1.08, 1.07), rail)
    for k in range(25): box("balc_b", (.025, .025, 1.0), (4.56 + k * .12, -1.08, .57), rail)
    for side in (-1, 1): box("balc_s", (.04, 1.1, .04), (6 + side * 1.5, -.55, 1.07), rail)
    bpy.ops.object.select_all(action="DESELECT")
    for o in bpy.data.objects:
        if o.name.startswith("balc"): o.select_set(True)
    bpy.context.view_layer.objects.active = b; bpy.ops.object.join(); keep(b, "balcony")
    # stair head room on flat roofs
    st = box("stair", (2.4, 3.0, 2.4), (9, 0, 1.2), mat("stairplaster", (.84, .83, .8), .9, noise=.3))
    box("stair_door", (.9, .05, 1.9), (9, -1.52, .95), mat("stairdoor", (.35, .3, .25), .7))
    bpy.ops.object.select_all(action="DESELECT")
    for o in bpy.data.objects:
        if o.name.startswith("stair"): o.select_set(True)
    bpy.context.view_layer.objects.active = st; bpy.ops.object.join(); keep(st, "stair_head")
    # satellite dish
    d = cyl("dish", .35, .05, (12, 0, 1.0), mat("dishw", (.92, .92, .92), .4), 20, (math.radians(60), 0, 0))
    cyl("dish_pole", .03, 1.0, (12, .15, .5), mat("pole", (.4, .4, .4), .4, .8), 8)
    bpy.ops.object.select_all(action="DESELECT")
    for o in bpy.data.objects:
        if o.name.startswith("dish"): o.select_set(True)
    bpy.context.view_layer.objects.active = d; bpy.ops.object.join(); keep(d, "dish")
    # Pune street lamp (double arm)
    pm = mat("lamp_pole", (.35, .37, .38), .5, .6)
    lp = cyl("lamp", .1, 9, (15, 0, 4.5), pm, 10)
    for side in (-1, 1):
        box("lamp_arm", (.08, 1.6, .08), (15, side * .8, 9.0), pm)
        box("lamp_head", (.35, .6, .15), (15, side * 1.55, 8.9), mat("lamp_glass", (1, .9, .7), .3, emit=(1, .85, .55)))
    bpy.ops.object.select_all(action="DESELECT")
    for o in bpy.data.objects:
        if o.name.startswith("lamp"): o.select_set(True)
    bpy.context.view_layer.objects.active = lp; bpy.ops.object.join(); keep(lp, "street_lamp")
    # centre each prop on its own origin (x/y), base at z=0
    for o in objs:
        bpy.context.view_layer.objects.active = o; o.select_set(True)
        bx = sum(v.co.x for v in o.data.vertices) / len(o.data.vertices); by = sum(v.co.y for v in o.data.vertices) / len(o.data.vertices)
        if o.name == "balcony": by = 0
        bz = min(v.co.z for v in o.data.vertices)
        for v in o.data.vertices: v.co.x -= bx; v.co.y -= by; v.co.z -= bz
        o.location = (0, 0, 0)
        for m in o.modifiers: bpy.ops.object.modifier_apply(modifier=m.name)
    p = os.path.join(OUT, "props.glb")
    bpy.ops.export_scene.gltf(filepath=p, export_format="GLB", export_apply=True, export_yup=True)
    return p


def compose():
    """Pack rendered modules into tileable atlases: each atlas = 4 bays x 4 floors, random variant per cell."""
    from PIL import Image
    rnd = random.Random(7)
    for kind, nvar, ph in (("apt", 4, 256), ("old", 4, 256), ("tower", 1, 256), ("shop", 4, 288)):
        rows = 1 if kind == "shop" else 4
        day = Image.new("RGB", (1024, ph * rows)); night = Image.new("RGB", (1024, ph * rows))
        for r in range(rows):
            for c in range(4):
                v = rnd.randrange(nvar)
                day.paste(Image.open(os.path.join(TMP, f"{kind}_{v}_day.png")).convert("RGB"), (c * 256, r * ph))
                lit = Image.open(os.path.join(TMP, f"{kind}_{v}_lit.png")).convert("RGB")
                if rnd.random() < (.55 if kind != "shop" else .85): night.paste(lit, (c * 256, r * ph))
        day.save(os.path.join(OUT, f"facade_{kind}.png")); night.save(os.path.join(OUT, f"facade_{kind}_night.png"))


if __name__ == "__main__":
    only = sys.argv[1] if len(sys.argv) > 1 else "all"
    if only in ("all", "facades"):
        for kind, n in (("apt", 4), ("old", 4), ("tower", 1), ("shop", 4)):
            for v in range(n):
                for lit in (False, True): print("render", build_bay(kind, v, lit))
        compose()
    if only in ("all", "roof"): print(roof_tiles())
    if only in ("all", "props"): print(props())
