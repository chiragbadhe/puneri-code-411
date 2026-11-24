"""Export each world chunk as a .glb (buildings + terrain + road surface) for Unreal Engine 5 / Blender.

glTF is Y-up, metres. Unreal's Interchange importer converts to Z-up centimetres
automatically; place every chunk at (0,0,0) because vertices are already in
world space (origin = area centre). See docs/UNREAL.md.

Usage:  python pipeline/export_gltf.py peths_fc [--only 5_4]
"""
import json, os, sys
import numpy as np
import trimesh
from shapely.geometry import Polygon, LineString
from config import ROADS

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def hexrgb(h):
    h = h.lstrip("#"); return [int(h[i:i + 2], 16) for i in (0, 2, 4)] + [255]


def main(key, only=None):
    wd = os.path.join(ROOT, "data/world", key)
    man = json.load(open(os.path.join(wd, "manifest.json")))
    ter = json.load(open(os.path.join(wd, "terrain.json")))
    roads = json.load(open(os.path.join(wd, "roads.json")))
    T = np.array(ter["dm"], dtype=np.float32).reshape(ter["h"], ter["w"]) / 10.0

    def ground(x, z):
        fx = np.clip((x - ter["x0"]) / ter["spacing"], 0, ter["w"] - 1.001); fz = np.clip((z - ter["z0"]) / ter["spacing"], 0, ter["h"] - 1.001)
        i, j = int(fx), int(fz); u, v = fx - i, fz - j
        return float(T[j, i] * (1 - u) * (1 - v) + T[j, i + 1] * u * (1 - v) + T[j + 1, i] * (1 - u) * v + T[j + 1, i + 1] * u * v)

    out = os.path.join(ROOT, "exports/glb", key); os.makedirs(out, exist_ok=True)
    CS = man["chunk_size"]; bx0, bz0 = man["bbox"][0], man["bbox"][1]
    n = 0
    for ci, cj in man["chunks"]:
        if only and f"{ci}_{cj}" != only: continue
        ch = json.load(open(os.path.join(wd, f"chunks/c_{ci}_{cj}.json")))
        meshes = []
        for kind, h, col, name, p in ch["b"]:
            ring = list(zip(p[0::2], p[1::2]))
            poly = Polygon(ring).buffer(0)
            if poly.is_empty or poly.geom_type != "Polygon": continue
            base = min(ground(x, z) for x, z in ring) - 0.3
            m = trimesh.creation.extrude_polygon(poly, h + 0.3)       # extrudes along +Z in (x, y=z) plane
            v = m.vertices.copy(); m.vertices = np.column_stack([v[:, 0], v[:, 2] + base, v[:, 1]])  # -> x, y-up, z
            m.invert()            # the axis swap above is a reflection, so flip winding back
            m.fix_normals()
            m.visual.vertex_colors = np.tile(hexrgb(col), (len(m.vertices), 1))
            meshes.append(m)
        # terrain tile for this chunk (10 m grid) + road ribbons
        x0, z0 = bx0 + ci * CS, bz0 + cj * CS
        N = int(CS / 10) + 1
        gx, gz = np.meshgrid(np.linspace(x0, x0 + CS, N), np.linspace(z0, z0 + CS, N))
        gy = np.vectorize(ground)(gx, gz)
        verts = np.column_stack([gx.ravel(), gy.ravel(), gz.ravel()])
        faces = []
        for j in range(N - 1):
            for i in range(N - 1):
                a = j * N + i; faces += [[a, a + N, a + 1], [a + 1, a + N, a + N + 1]]
        tm = trimesh.Trimesh(verts, faces, process=False)
        tm.visual.vertex_colors = np.tile(hexrgb("#8a8f6a"), (len(verts), 1))
        meshes.append(tm)
        for ri in ch["r"]:
            rd = roads[ri]
            if not ROADS[rd["c"]][1]: continue
            ls = LineString(list(zip(rd["p"][0::2], rd["p"][1::2])))
            poly = ls.buffer(rd["w"] / 2, cap_style=2, join_style=2).intersection(Polygon([(x0, z0), (x0 + CS, z0), (x0 + CS, z0 + CS), (x0, z0 + CS)]))
            for g in getattr(poly, "geoms", [poly]):
                if g.is_empty or g.geom_type != "Polygon": continue
                m = trimesh.creation.extrude_polygon(g, 0.05)
                v = m.vertices.copy()
                m.vertices = np.column_stack([v[:, 0], [ground(a, b) + 0.08 + c for a, b, c in zip(v[:, 0], v[:, 1], v[:, 2])], v[:, 1]])
                m.invert()
                m.visual.vertex_colors = np.tile(hexrgb("#3d3b48"), (len(m.vertices), 1))
                meshes.append(m)
        scene = trimesh.Scene(meshes)
        scene.export(os.path.join(out, f"chunk_{ci}_{cj}.glb"))
        n += 1
    print("exported", n, "chunks to", out)


if __name__ == "__main__":
    args = sys.argv[1:]
    only = args[args.index("--only") + 1] if "--only" in args else None
    main(args[0] if args and not args[0].startswith("--") else "peths_fc", only)
