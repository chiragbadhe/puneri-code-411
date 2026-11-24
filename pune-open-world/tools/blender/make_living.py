"""Blender: Pune trees and people.

Trees (trees.glb): neem, gulmohar (flame tree, orange blossom), banyan with aerial roots, coconut palm, ashoka.
People (people.glb): organic low-poly bodies built with Blender's Skin modifier, split into rig parts so the
game can animate them on the GPU. Object names encode rig data: p<part>_s<slot>_<name>
  part: 0 body/head, 1 thigh L, 2 shin+foot L, 3 thigh R, 4 shin+foot R, 5 upper arm L, 6 forearm+hand L, 7 upper arm R, 8 forearm+hand R
  slot: 0 skin, 1 top, 2 bottom, 3 hair, 4 shoes, 5 accent (dupatta / pallu / cap)
Blender axes: Z up, character faces -Y (glTF export turns this into Y up, facing +Z).
Run: python tools/blender/make_living.py
"""
import math, os, random
import bpy, bmesh

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(ROOT, "game", "assets"); os.makedirs(OUT, exist_ok=True)


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def mat(name, rgb, rough=.85):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True; b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*rgb, 1); b.inputs["Roughness"].default_value = rough
    return m


def apply_all(o):
    bpy.context.view_layer.objects.active = o; o.select_set(True)
    for m in list(o.modifiers): bpy.ops.object.modifier_apply(modifier=m.name)


def join(objs, name):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs: o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]; bpy.ops.object.join()
    o = bpy.context.active_object; o.name = name; return o


def blob(loc, r, m, scale=(1, 1, 1), sub=2, noise=.25, seed=0):
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=sub, radius=r, location=loc)
    o = bpy.context.active_object; o.scale = scale; o.data.materials.append(m)
    tex = bpy.data.textures.new(f"n{seed}", "CLOUDS"); tex.noise_scale = r * .6
    d = o.modifiers.new("d", "DISPLACE"); d.texture = tex; d.strength = r * noise; d.mid_level = .5
    apply_all(o); bpy.ops.object.shade_flat(); return o


def limb(a, b, r0, r1, m, verts=7):
    """Tapered cylinder from point a to b."""
    ax, ay, az = a; bx, by, bz = b; L = math.dist(a, b)
    bpy.ops.mesh.primitive_cone_add(vertices=verts, radius1=r0, radius2=r1, depth=L, location=((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2))
    o = bpy.context.active_object
    d = (bx - ax, by - ay, bz - az); o.rotation_mode = "QUATERNION"
    from mathutils import Vector
    o.rotation_quaternion = Vector((0, 0, 1)).rotation_difference(Vector(d).normalized())
    o.data.materials.append(m); apply_rot(o); return o


def apply_rot(o):
    bpy.context.view_layer.objects.active = o; o.select_set(True); bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)


# ------------------------------------------------------------------ trees
def trees():
    reset(); random.seed(5)
    bark, bark_l = mat("bark", (.27, .19, .13), .95), mat("bark_light", (.42, .36, .3), .95)
    neem_l, neem_d = mat("leaf_neem", (.17, .36, .1)), mat("leaf_neem_dark", (.11, .27, .08))
    gul_g, gul_f = mat("leaf_gulmohar", (.22, .42, .12)), mat("flower_gulmohar", (.93, .32, .08))
    ban_l, palm_l, ash_l = mat("leaf_banyan", (.13, .3, .1)), mat("leaf_palm", (.33, .48, .15)), mat("leaf_ashoka", (.09, .24, .08))
    out = []

    # neem: forked trunk, layered irregular canopy
    parts = [limb((0, 0, 0), (0, 0, 3.2), .32, .22, bark), limb((0, 0, 3.0), (1.3, .4, 5.2), .18, .1, bark), limb((0, 0, 3.0), (-1.1, -.6, 5.6), .17, .09, bark), limb((0, 0, 3.0), (.2, -1.0, 6.0), .15, .08, bark)]
    for k, (x, y, z, r) in enumerate([(1.5, .4, 6.0, 2.0), (-1.3, -.6, 6.3, 2.1), (.2, -1.1, 7.0, 1.9), (.1, .9, 6.6, 1.8), (0, 0, 7.6, 1.6)]):
        parts.append(blob((x, y, z), r, neem_l if k % 2 else neem_d, (1.15, 1.15, .78), 2, .35, k))
    out.append(join(parts, "tree_neem"))

    # gulmohar: short trunk, wide flat umbrella canopy with orange blossom
    parts = [limb((0, 0, 0), (0, 0, 2.6), .3, .22, bark_l)]
    for a in range(5):
        ang = a / 5 * math.tau; parts.append(limb((0, 0, 2.5), (math.cos(ang) * 3.2, math.sin(ang) * 3.2, 4.4), .14, .06, bark_l))
    for k in range(9):
        ang = k / 9 * math.tau; rr = 2.4 if k else 0
        parts.append(blob((math.cos(ang) * rr * 1.4, math.sin(ang) * rr * 1.4, 5.0 + random.random() * .5), 1.9, gul_f if k % 3 == 0 else gul_g, (1.3, 1.3, .5), 2, .3, 10 + k))
    out.append(join(parts, "tree_gulmohar"))

    # banyan / peepal: massive trunk, aerial roots, huge canopy
    parts = [limb((0, 0, 0), (0, 0, 4.0), .9, .6, bark)]
    for a in range(6):
        ang = a / 6 * math.tau + .3; parts.append(limb((0, 0, 3.6), (math.cos(ang) * 4.5, math.sin(ang) * 4.5, 6.2), .32, .14, bark))
    for a in range(10):
        ang = random.random() * math.tau; d = 2 + random.random() * 3.5
        parts.append(limb((math.cos(ang) * d, math.sin(ang) * d, 6.2), (math.cos(ang) * d, math.sin(ang) * d, 0), .05, .04, bark_l, 5))
    for k in range(10):
        ang = k / 10 * math.tau; rr = 3.8 if k else 0
        parts.append(blob((math.cos(ang) * rr * 1.2, math.sin(ang) * rr * 1.2, 7.6 + random.random()), 2.8, ban_l if k % 2 else neem_d, (1.2, 1.2, .72), 2, .3, 30 + k))
    out.append(join(parts, "tree_banyan"))

    # coconut palm: curved segmented trunk, drooping fronds
    parts = []; px = py = 0; pz = 0
    for k in range(7):
        nx, nz = px + .18 * k / 6, pz + 1.55
        parts.append(limb((px, py, pz), (nx, py, nz), .2 - k * .012, .19 - k * .012, bark_l, 8)); px, pz = nx, nz
    top = (px, py, pz)
    for f in range(11):
        ang = f / 11 * math.tau
        bm = bmesh.new(); seg = 8
        for s_ in range(seg + 1):
            t = s_ / seg; L = 3.6 * t; droop = -1.8 * t * t + .5 * t; w = .55 * math.sin(math.pi * min(1, t * 1.15))
            for side in (-1, 1):
                bm.verts.new((L, side * w, droop + (-.18 * abs(side) * t)))
        bm.verts.ensure_lookup_table()
        for s_ in range(seg):
            a, b, c, d = s_ * 2, s_ * 2 + 1, s_ * 2 + 3, s_ * 2 + 2
            bm.faces.new((bm.verts[a], bm.verts[d], bm.verts[c], bm.verts[b]))
        me = bpy.data.meshes.new("frond"); bm.to_mesh(me); bm.free()
        o = bpy.data.objects.new("frond", me); bpy.context.collection.objects.link(o)
        o.location = top; o.rotation_euler = (0, -.15, ang); o.data.materials.append(palm_l); apply_rot(o)
        bpy.context.view_layer.objects.active = o; bpy.ops.object.transform_apply(location=True); parts.append(o)
    for k in range(4): parts.append(blob((top[0] + math.cos(k) * .25, math.sin(k) * .25, top[2] - .3), .17, mat("coconut", (.35, .42, .12)), (1, 1, 1), 1, .05, 60 + k))
    out.append(join(parts, "tree_palm"))

    # ashoka (Polyalthia): tall narrow column of drooping foliage
    parts = [limb((0, 0, 0), (0, 0, 9.5), .2, .08, bark)]
    for k in range(8):
        z = 2.2 + k * .95; r = 1.15 - abs(k - 3) * .1
        parts.append(blob((0, 0, z), r, ash_l if k % 2 else neem_d, (1, 1, .95), 2, .35, 80 + k))
    parts.append(blob((0, 0, 10.0), .6, ash_l, (1, 1, 1.4), 2, .3, 99))
    out.append(join(parts, "tree_ashoka"))

    for i, o in enumerate(out):   # lay them out side by side for preview; origins at trunk base
        o.location = (0, 0, 0)
    for o in out:
        for p in o.data.polygons: p.use_smooth = False
    bpy.ops.export_scene.gltf(filepath=os.path.join(OUT, "trees.glb"), export_format="GLB", export_yup=True, export_apply=True)


# ------------------------------------------------------------------ people
def skin_part(name, pts, edges, radii, m):
    """Organic tube mesh through joint points using the Skin modifier."""
    me = bpy.data.meshes.new(name); me.from_pydata(pts, edges, []); o = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(o); bpy.context.view_layer.objects.active = o
    sk = o.modifiers.new("skin", "SKIN"); sk.use_smooth_shade = True
    for i, r in enumerate(radii): me.skin_vertices[""].data[i].radius = r
    me.skin_vertices[""].data[0].use_root = True
    sub = o.modifiers.new("sub", "SUBSURF"); sub.levels = 1; sub.render_levels = 1
    o.data.materials.append(m); apply_all(o); return o


def sphere(name, loc, r, scale, m, segs=12):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=segs, ring_count=segs // 2 + 2, radius=r, location=loc)
    o = bpy.context.active_object; o.name = name; o.scale = scale; o.data.materials.append(m); apply_rot(o)
    bpy.ops.object.shade_smooth(); return o


def body(kind):
    """kind: male | saree | kurta | player"""
    col = bpy.data.collections.new("body_" + kind); bpy.context.scene.collection.children.link(col)
    lc = bpy.context.view_layer.layer_collection.children[col.name]; bpy.context.view_layer.active_layer_collection = lc
    M = lambda n: mat(n, (.8, .8, .8))
    objs = []
    # torso (pelvis -> chest -> shoulders -> neck)
    objs.append(skin_part(f"p0_s1_torso_{kind}", [(0, 0, .9), (0, 0, 1.06), (0, 0, 1.26), (0, 0, 1.4), (0, 0, 1.47), (0, 0, 1.56)], [(0, 1), (1, 2), (2, 3), (3, 4), (4, 5)],
                          [(.135, .085), (.12, .08), (.14, .09), (.155, .085), (.07, .06), (.048, .048)], M("top")))
    objs.append(skin_part(f"p0_s2_hips_{kind}", [(0, 0, .82), (0, 0, .95)], [(0, 1)], [(.14, .09), (.135, .088)], M("bottom")))
    objs.append(sphere(f"p0_s0_head_{kind}", (0, -.01, 1.64), .105, (.9, 1, 1.12), M("skin")))
    objs.append(sphere(f"p0_s0_nose_{kind}", (0, -.11, 1.63), .022, (.8, 1, 1.2), M("skin"), 8))
    hair_z = 1.69 if kind != "saree" else 1.7
    objs.append(sphere(f"p0_s3_hair_{kind}", (0, .012, hair_z), .112, (.93, 1.02, .95 if kind != "saree" else 1.0), M("hair")))
    if kind == "saree":
        objs.append(sphere(f"p0_s3_bun_{kind}", (0, .1, 1.62), .055, (1, 1, 1), M("hair"), 10))
        objs.append(skin_part(f"p0_s5_skirt_{kind}", [(0, 0, 1.02), (0, 0, .55), (0, 0, .05)], [(0, 1), (1, 2)], [(.14, .1), (.17, .13), (.2, .16)], M("accent")))
        objs.append(skin_part(f"p0_s5_pallu_{kind}", [(-.12, -.04, 1.44), (.0, -.09, 1.22), (.13, -.05, 1.0), (.17, .06, .8)], [(0, 1), (1, 2), (2, 3)], [(.05, .025), (.07, .025), (.07, .025), (.06, .02)], M("accent")))
    if kind == "kurta":
        objs.append(skin_part(f"p0_s1_kurta_{kind}", [(0, 0, 1.1), (0, 0, .8), (0, 0, .5)], [(0, 1), (1, 2)], [(.125, .085), (.15, .1), (.165, .11)], M("top")))
        objs.append(sphere(f"p0_s5_cap_{kind}", (0, .0, 1.77), .1, (.95, 1.05, .42), M("accent"), 10))
    if kind == "player":
        objs.append(skin_part(f"p0_s4_shades_{kind}", [(-.06, -.1, 1.66), (.06, -.1, 1.66)], [(0, 1)], [(.025, .012), (.025, .012)], M("shoes")))
    # legs: thigh (part 1/3), shin + foot (2/4)
    for s, th, sh in ((1, 1, 2), (-1, 3, 4)):
        x = .085 * s
        objs.append(skin_part(f"p{th}_s2_thigh{s}_{kind}", [(x, 0, .9), (x, 0, .47)], [(0, 1)], [(.072, .075), (.054, .056)], M("bottom")))
        objs.append(skin_part(f"p{sh}_s2_shin{s}_{kind}", [(x, 0, .54), (x, .01, .07)], [(0, 1)], [(.05, .052), (.037, .04)], M("bottom")))
        objs.append(skin_part(f"p{sh}_s4_foot{s}_{kind}", [(x, .03, .05), (x, -.15, .03)], [(0, 1)], [(.045, .04), (.04, .03)], M("shoes")))
        # arms: upper (5/7), forearm + hand (6/8)
        up, lo = (5, 6) if s > 0 else (7, 8)
        sx = .185 * s
        objs.append(skin_part(f"p{up}_s1_upper{s}_{kind}", [(sx - .01 * s, 0, 1.43), (sx + .02 * s, 0, 1.12)], [(0, 1)], [(.05, .05), (.04, .04)], M("top")))
        objs.append(skin_part(f"p{lo}_s{1 if kind == 'kurta' else 0}_fore{s}_{kind}", [(sx + .02 * s, 0, 1.16), (sx + .03 * s, -.01, .9)], [(0, 1)], [(.036, .036), (.028, .028)], M("skin")))
        objs.append(skin_part(f"p{lo}_s0_hand{s}_{kind}", [(sx + .03 * s, -.01, .92), (sx + .035 * s, -.02, .8)], [(0, 1)], [(.03, .018), (.027, .016)], M("skin")))
    return objs


def people():
    reset()
    for k in ("male", "saree", "kurta", "player"): body(k)
    bpy.ops.export_scene.gltf(filepath=os.path.join(OUT, "people.glb"), export_format="GLB", export_yup=True, export_apply=True)


if __name__ == "__main__":
    trees(); print("trees.glb")
    people(); print("people.glb")
