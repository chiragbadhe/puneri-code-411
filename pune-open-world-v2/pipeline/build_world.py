"""Convert cached OSM + DEM for an area into an engine-neutral, streamable world.

Output (data/world/<area>/ and copied to game/world/<area>/):
  manifest.json   area info, local bbox, chunk grid, landmarks, spawn, stats
  terrain.json    smoothed elevation grid (decimetres above `base`)
  roads.json      every highway polyline: class, width, name, bridge, oneway
  areas.json      water / park / campus / parking polygons
  graph.json      contracted road graph (intersections + polyline edges) for traffic, peds, GPS
  chunks/c_X_Z.json  buildings, trees, POIs and the road/area ids touching each chunk
  minimap.png     top-down map for the radar and pause map (2 m per pixel)

Coordinates: x = east metres, z = south metres, y = up, origin = area centre.
Usage:  python pipeline/build_world.py peths_fc
"""
import json, math, os, shutil, sys, hashlib
from collections import defaultdict
import numpy as np
from shapely.geometry import Polygon, LineString, MultiPolygon
from shapely.ops import polygonize, unary_union, linemerge
from config import AREAS, CHUNK_SIZE, DEM_SMOOTH_SIGMA, FLOOR_HEIGHT, ROADS, projector

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

WALL_COLOURS = ["#e9dfc8", "#f1e8d6", "#d8c8a6", "#e8cbb0", "#cfd9c4", "#d3dbe0", "#f2d9a8",
                "#e2bba3", "#f7f4ee", "#bfae95", "#e6d3e0", "#c8dfe6"]          # modern Pune plaster
PETH_COLOURS = ["#b0845e", "#9c7556", "#c49a6c", "#d2b48c", "#a66e4e", "#e0c9a6"]   # old wada timber/brick
LANDMARK_RULES = [  # (name fragment, kind, height m, colour)
    ("Shaniwar", "fort", 13, "#8f6a48"),
    ("Dagdusheth", "temple_gold", 14, "#f2c24b"),
    ("Ram Mandir", "temple", 12, "#f0e0c8"),
    ("Omkareshwar", "temple", 12, "#d9d2c3"),
    ("Mandir", "temple", 9, "#f3e6cf"),
    ("Mandai", "market", 14, "#b5523b"),
    ("Fergusson", "college", 14, "#a65a3f"),
    ("Balgandharva", "theatre", 13, "#e8e2d6"),
]
NOTABLE = ["Shaniwar Wada", "Dagdusheth", "Fergusson College", "Deccan Gymkhana", "Balgandharva", "Mahatma Phule Mandai",
           "Tulshibaug Ram Mandir", "Omkareshwar Mandir", "Sambhaji Bridge", "Sambhaji Udyan", "Kasba Peth Metro",
           "Vishrambag Wada", "Jangli Maharaj Mandir", "Kibe Laxmi Theatre", "Deccan Corner"]
POI_KINDS = {"pharmacy": "MEDICAL", "bank": "BANK", "atm": "ATM", "restaurant": "HOTEL", "cafe": "CAFE",
             "fast_food": "VADA PAV", "ice_cream": "ICE CREAM", "place_of_worship": "MANDIR"}
SHOP_KINDS = {"clothes": "SAREE CENTRE", "jewelry": "JEWELLERS", "sweets": "SWEETS", "confectionery": "SWEETS",
              "bakery": "BAKERY", "mobile_phone": "MOBILE", "books": "BOOK DEPOT", "stationery": "STATIONERY",
              "electronics": "ELECTRONICS", "shoes": "FOOTWEAR", "optician": "OPTICIANS", "copyshop": "XEROX",
              "supermarket": "KIRANA", "convenience": "KIRANA", "hardware": "HARDWARE", "tea": "CHAI"}


def h01(*parts):
    """Deterministic 0..1 hash so rebuilding gives the same city."""
    return int(hashlib.md5("|".join(map(str, parts)).encode()).hexdigest()[:8], 16) / 0xFFFFFFFF


def r1(v): return round(v, 1)


def flat(coords): return [r1(c) for p in coords for c in p]


def smooth(grid, sigma):
    if sigma <= 0: return grid
    rad = int(sigma * 3)
    k = np.exp(-0.5 * (np.arange(-rad, rad + 1) / sigma) ** 2); k /= k.sum()
    g = np.pad(grid, rad, mode="edge")
    g = np.apply_along_axis(lambda m: np.convolve(m, k, mode="valid"), 1, g)
    g = np.apply_along_axis(lambda m: np.convolve(m, k, mode="valid"), 0, g)
    return g


def load_heights(key, origin):
    """Per-footprint height from Google Open Buildings 2.5D Temporal (data/raw/heights/<key>_obt2023.*).
    Returns f(polygon_in_local_xz) -> robust height (m) or None. Uses the 80th percentile of building
    pixels inside the footprint (shrunk by 1 m so neighbouring roofs do not bleed in)."""
    meta_p = os.path.join(ROOT, "data/raw/heights", key + "_obt2023.json")
    if not os.path.exists(meta_p): return None
    meta = json.load(open(meta_p))
    H = np.fromfile(meta_p.replace(".json", ".u8"), dtype=np.uint8).reshape(meta["height"], meta["width"]).astype(np.float32) / 2.0
    from pyproj import Transformer
    import shapely
    to_utm = Transformer.from_crs("EPSG:4326", meta["crs"], always_xy=True)
    lat0, lon0 = origin
    mx, mz = 111320.0 * math.cos(math.radians(lat0)), 110574.0
    def f(poly):
        xs, zs = np.array(poly.exterior.coords).T
        ux, uy = to_utm.transform(lon0 + xs / mx, lat0 - zs / mz)
        up = Polygon(zip(ux, uy)); inner = up.buffer(-1.0)
        if inner.is_empty or inner.area < 4: inner = up
        x0, y0, x1, y1 = inner.bounds
        c0, c1 = int((x0 - meta["x0"]) / meta["pixel_m"]), int((x1 - meta["x0"]) / meta["pixel_m"]) + 1
        r0, r1 = int((meta["y_top"] - y1) / meta["pixel_m"]), int((meta["y_top"] - y0) / meta["pixel_m"]) + 1
        if c1 <= 0 or r1 <= 0 or c0 >= meta["width"] or r0 >= meta["height"]: return None
        c0, r0 = max(c0, 0), max(r0, 0); c1, r1 = min(c1, meta["width"]), min(r1, meta["height"])
        cc, rr_ = np.meshgrid(np.arange(c0, c1), np.arange(r0, r1))
        px = meta["x0"] + (cc + .5) * meta["pixel_m"]; py = meta["y_top"] - (rr_ + .5) * meta["pixel_m"]
        inside = shapely.contains_xy(inner, px, py)
        v = H[r0:r1, c0:c1][inside]
        if v.size < 3: return None
        v = v[v > 0]
        if v.size < max(3, inside.sum() * .25): return None
        return float(np.percentile(v, 80))
    return f


def build(key):
    area = AREAS[key]
    proj, origin = projector(area["bbox"])
    osm = json.load(open(os.path.join(ROOT, "data/raw/osm", key + ".json")))
    dem = json.load(open(os.path.join(ROOT, "data/raw/dem", key + ".json")))
    s, w, n, e = area["bbox"]
    minx, minz = proj(n, w)
    maxx, maxz = proj(s, e)
    print(f"area {key}: {maxx-minx:.0f} m x {maxz-minz:.0f} m")

    heights = load_heights(key, origin)

    nodes, ways, rels = {}, {}, []
    for el in osm["elements"]:
        if el["type"] == "node": nodes[el["id"]] = el
        elif el["type"] == "way": ways[el["id"]] = el
        else: rels.append(el)
    xy = {i: proj(nd["lat"], nd["lon"]) for i, nd in nodes.items()}

    def way_pts(wy): return [xy[i] for i in wy["nodes"] if i in xy]

    # ---------------- terrain ----------------
    W, H = dem["width"], dem["height"]
    grid = np.array(dem["dm"], dtype=np.float64).reshape(H, W) / 10.0
    grid = smooth(grid, DEM_SMOOTH_SIGMA)
    base = float(np.floor(grid.min())) - 1.0
    tx0, tz0 = proj(dem["bbox"]["maxlat"], dem["bbox"]["minlon"])
    terrain = {"x0": r1(tx0), "z0": r1(tz0), "spacing": dem["spacing_m"], "w": W, "h": H, "base_m": base,
               "dm": [int(round((v - base) * 10)) for v in grid.ravel()], "source": dem["source"]}

    # ---------------- buildings ----------------
    def rel_polys(rel):
        rings = [LineString(way_pts(ways[m["ref"]])) for m in rel.get("members", [])
                 if m["type"] == "way" and m.get("role", "outer") in ("outer", "") and m["ref"] in ways and len(ways[m["ref"]]["nodes"]) > 1]
        if not rings: return []
        u = unary_union(rings)
        try: u = linemerge(u)
        except ValueError: pass
        return [p for p in polygonize(u) if p.area > 8]

    build_src = []
    for wy in ways.values():
        t = wy.get("tags", {})
        if "building" in t and len(wy["nodes"]) >= 4 and wy["nodes"][0] == wy["nodes"][-1]:
            pts = way_pts(wy)
            if len(pts) >= 4: build_src.append((wy["id"], t, Polygon(pts)))
    for rel in rels:
        t = rel.get("tags", {})
        if "building" in t:
            for p in rel_polys(rel): build_src.append((rel["id"], t, p))

    def classify(bid, t, poly):
        name = t.get("name", "")
        for frag, kind, hh, col in LANDMARK_RULES:
            if frag in name: return kind, hh, col, name
        if t.get("building") == "temple" or t.get("amenity") == "place_of_worship":
            return "temple", 8 + 4 * h01(bid), "#f3e6cf", name
        lv = t.get("building:levels")
        hh = None
        try:
            if "height" in t: hh = float(str(t["height"]).split()[0])
            elif lv: hh = float(lv) * FLOOR_HEIGHT
        except ValueError: hh = None
        cx, cz = poly.centroid.x, poly.centroid.y
        peth = cx > -250 and cz < 900 and cz > -900  # old city east of the river crossing
        src = "osm" if hh is not None else None
        if hh is None and heights is not None:
            m = heights(poly)
            if m is not None:
                lv = max(1, round((m - 0.6) / FLOOR_HEIGHT))          # snap to whole floors (+ parapet)
                hh, src = lv * FLOOR_HEIGHT + 0.9, "obt"
        if hh is None:
            a = poly.area
            r = h01(bid, "h")
            bt = t.get("building")
            if bt in ("house", "hut", "shed", "garage", "roof"): lv = 1 + int(r * 2)
            elif bt in ("apartments", "residential", "dormitory", "hotel"): lv = 4 + int(r * 4)
            elif bt in ("commercial", "office", "retail", "school", "college"): lv = 3 + int(r * 4)
            elif peth: lv = 2 + int(r * 3) + (1 if a > 400 else 0)
            else: lv = 2 + int(r * 3) + (2 if a > 300 else 0) + (2 if a > 900 else 0)
            hh = lv * FLOOR_HEIGHT
        hh = max(3.0, min(hh, 80.0))
        old = peth and hh <= 10.5 and h01(bid, "p") < 0.55
        pal = PETH_COLOURS if old else WALL_COLOURS
        classify.src[src or "est"] += 1
        return "building", hh, pal[int(h01(bid, "c") * len(pal))], name if any(k in name for k in NOTABLE) else ""

    classify.src = defaultdict(int)
    buildings = []
    for bid, t, poly in build_src:
        if not poly.is_valid: poly = poly.buffer(0)
        if isinstance(poly, MultiPolygon): poly = max(poly.geoms, key=lambda g: g.area)
        if poly.is_empty or poly.area < 8: continue
        poly = poly.simplify(0.25, preserve_topology=True)
        ring = list(poly.exterior.coords)[:-1]
        if Polygon(ring).exterior.is_ccw: ring.reverse()   # store clockwise in x/z (= CCW seen from above with z south)
        kind, hh, col, name = classify(bid, t, poly)
        buildings.append({"id": bid, "k": kind, "h": r1(hh), "c": col, "n": name, "p": flat(ring),
                          "cx": poly.centroid.x, "cz": poly.centroid.y})

    # Structures inside the Shaniwar Wada fort walls are ruins/plinths today.
    forts = [Polygon(list(zip(b["p"][0::2], b["p"][1::2]))).buffer(-1) for b in buildings if b["k"] == "fort"]
    for b in buildings:
        if b["k"] == "building" and any(f.contains(Polygon(list(zip(b["p"][0::2], b["p"][1::2]))).centroid) for f in forts):
            b["k"], b["h"], b["c"] = "ruin", 1.4, "#9c7a58"

    # ---------------- roads ----------------
    roads = []
    for wy in ways.values():
        t = wy.get("tags", {})
        hw = t.get("highway")
        if hw not in ROADS: continue
        pts = way_pts(wy)
        if len(pts) < 2: continue
        width = ROADS[hw][0]
        if "lanes" in t:
            try: width = max(width, float(t["lanes"]) * 3.3)
            except ValueError: pass
        ow = t.get("oneway", "no")
        oneway = 1 if ow in ("yes", "1", "true") or t.get("junction") == "roundabout" else (-1 if ow == "-1" else 0)
        roads.append({"id": wy["id"], "c": hw, "w": width, "n": t.get("name", ""), "b": 1 if t.get("bridge") else 0,
                      "o": oneway, "p": flat(pts), "nodes": [i for i in wy["nodes"] if i in xy]})

    # ---------------- style, roof type, street-facing walls ----------------
    from shapely.strtree import STRtree
    drive_lines = [LineString(list(zip(rd["p"][0::2], rd["p"][1::2]))) for rd in roads if ROADS[rd["c"]][1]]
    drive_w = [rd["w"] for rd in roads if ROADS[rd["c"]][1]]
    big = [rd["c"] in ("trunk", "primary", "secondary", "tertiary") for rd in roads if ROADS[rd["c"]][1]]
    tree = STRtree(drive_lines)
    from shapely.geometry import Point
    for b in buildings:
        ring = list(zip(b["p"][0::2], b["p"][1::2])); n = len(ring)
        front, on_big = [], False
        for k in range(n):
            ax, az = ring[k - 1]; bx, bz = ring[k]
            if math.hypot(bx - ax, bz - az) < 2.5: continue
            mid = Point((ax + bx) / 2, (az + bz) / 2)
            for idx in tree.query(mid.buffer(14)):
                if drive_lines[idx].distance(mid) < drive_w[idx] / 2 + 7:
                    front.append(k); on_big = on_big or big[idx]; break
        b["f"] = front
        h, farea = b["h"], Polygon(ring).area
        peth = b["cx"] > -250 and -900 < b["cz"] < 900
        if b["k"] != "building": b["s"], b["r"] = "landmark", "flat"; continue
        if h > 24: style = "tower"
        elif peth and h <= 10.5 and b["c"] in PETH_COLOURS: style = "old"
        elif h <= 7.5 and farea < 160: style = "house"
        else: style = "apt"
        if front and (on_big or (peth and h01(b["id"], "shop") < .7)) and style != "tower": style = style + "+shop"
        roof = "flat"
        if style.startswith(("old", "house")) and farea < 320:
            mrr = Polygon(ring).minimum_rotated_rectangle
            if Polygon(ring).area / max(mrr.area, 1) > .82: roof = "gable" if h01(b["id"], "roof") < .75 else "hip"
        b["s"], b["r"] = style, roof
    print("height sources:", dict(classify.src))

    # ---------------- areas ----------------
    def area_kind(t):
        if t.get("natural") == "water" or t.get("waterway") == "riverbank" or "water" in t: return "water"
        if t.get("leisure") in ("park", "garden", "playground"): return "park"
        if t.get("leisure") in ("pitch", "stadium"): return "pitch"
        if t.get("landuse") in ("grass", "recreation_ground", "forest", "cemetery"): return "park"
        if t.get("amenity") in ("college", "school", "university", "hospital") or t.get("landuse") == "religious": return "campus"
        if t.get("amenity") == "parking": return "parking"
        return None

    areas = []
    for wy in ways.values():
        t = wy.get("tags", {})
        k = area_kind(t)
        if k and len(wy["nodes"]) >= 4 and wy["nodes"][0] == wy["nodes"][-1]:
            areas.append({"k": k, "p": flat(way_pts(wy))})
        if t.get("waterway") in ("river", "canal", "stream") and len(wy["nodes"]) > 1:
            width = 60 if t["waterway"] == "river" else 8
            areas.append({"k": "water", "p": flat(list(LineString(way_pts(wy)).buffer(width / 2, cap_style=2).exterior.coords))})
    for rel in rels:
        k = area_kind(rel.get("tags", {}))
        if k:
            for p in rel_polys(rel): areas.append({"k": k, "p": flat(list(p.exterior.coords))})
    water_union = unary_union([Polygon(list(zip(a["p"][0::2], a["p"][1::2]))).buffer(0) for a in areas if a["k"] == "water"]) if any(a["k"] == "water" for a in areas) else None

    # ---------------- trees & POIs ----------------
    trees = [list(map(r1, xy[i])) for i, nd in nodes.items() if nd.get("tags", {}).get("natural") == "tree"]
    for a in areas:
        if a["k"] == "park":
            poly = Polygon(list(zip(a["p"][0::2], a["p"][1::2]))).buffer(0)
            if poly.is_empty: continue
            bx0, bz0, bx1, bz1 = poly.bounds
            count = int(poly.area / 180)
            for t_ in range(count):
                px = bx0 + (bx1 - bx0) * h01(bx0, t_, "x"); pz = bz0 + (bz1 - bz0) * h01(bz0, t_, "z")
                if poly.contains(Polygon([(px, pz), (px + .1, pz), (px, pz + .1)])): trees.append([r1(px), r1(pz)])
    for rd in roads:   # avenue trees along bigger roads, on the footpath
        if rd["c"] not in ("primary", "secondary", "tertiary", "trunk"): continue
        ls = LineString(list(zip(rd["p"][0::2], rd["p"][1::2])))
        d = 6.0
        while d < ls.length:
            if h01(rd["id"], d) < 0.55:
                a, b = ls.interpolate(d), ls.interpolate(min(ls.length, d + 1))
                dx, dz = b.x - a.x, b.y - a.y; L = math.hypot(dx, dz) or 1
                side = 1 if h01(rd["id"], d, "s") < .5 else -1
                off = rd["w"] / 2 + 1.6
                trees.append([r1(a.x - dz / L * off * side), r1(a.y + dx / L * off * side)])
            d += 14 + 10 * h01(rd["id"], d, "g")
    pois = []
    for i, nd in nodes.items():
        t = nd.get("tags", {})
        label = SHOP_KINDS.get(t.get("shop")) or POI_KINDS.get(t.get("amenity"))
        if not label and "shop" in t: label = "SHOP"
        if label: pois.append([r1(xy[i][0]), r1(xy[i][1]), label])

    # ---------------- road graph (contracted) ----------------
    use = defaultdict(int)
    for rd in roads:
        for k_, nid in enumerate(rd["nodes"]):
            use[nid] += 1 if 0 < k_ < len(rd["nodes"]) - 1 else 2
    gidx, gnodes, edges = {}, [], []
    def gnode(nid):
        if nid not in gidx:
            gidx[nid] = len(gnodes) // 2; gnodes.extend([r1(xy[nid][0]), r1(xy[nid][1])])
        return gidx[nid]
    names = []
    name_ix = {}
    for rd in roads:
        ns = rd["nodes"]
        drive = ROADS[rd["c"]][1]
        nm = rd["n"]
        if nm not in name_ix: name_ix[nm] = len(names); names.append(nm)
        start = 0
        for k_ in range(1, len(ns)):
            if use[ns[k_]] >= 2 or k_ == len(ns) - 1:
                seg = ns[start:k_ + 1]
                pts = [xy[q] for q in seg]
                length = sum(math.dist(pts[q], pts[q + 1]) for q in range(len(pts) - 1))
                if length > 0.5:
                    a_, b_ = gnode(seg[0]), gnode(seg[-1])
                    edges.append([a_, b_, rd["o"], 1 if drive else 0, ROADS[rd["c"]][3], r1(rd["w"]), name_ix[nm], r1(length), flat(pts)])
                start = k_
    graph = {"nodes": gnodes, "names": names,
             "edge_fields": ["a", "b", "oneway(1 a->b, -1 b->a, 0 two-way)", "drivable", "traffic_weight", "width", "name_index", "length", "polyline"],
             "edges": edges}

    area_polys = [(a, Polygon(list(zip(a["p"][0::2], a["p"][1::2]))).bounds) for a in areas if len(a["p"]) >= 6]
    def areas_near(pt):
        return [a for a, (x0, z0, x1, z1) in area_polys if x0 <= pt.x <= x1 and z0 <= pt.y <= z1]

    # ---------------- chunks ----------------
    CS = CHUNK_SIZE
    nx, nz = math.ceil((maxx - minx) / CS), math.ceil((maxz - minz) / CS)
    def cidx(x, z): return (min(nx - 1, max(0, int((x - minx) // CS))), min(nz - 1, max(0, int((z - minz) // CS))))
    chunks = defaultdict(lambda: {"b": [], "t": [], "poi": [], "r": [], "a": []})
    for b in buildings:
        c = chunks[cidx(b["cx"], b["cz"])]
        c["b"].append([b["k"], b["h"], b["c"], b["n"], b["p"], b.get("s", "apt"), b.get("r", "flat"), b.get("f", [])])
    # trees: never on a carriageway, inside a building or in the river; pick a Pune species
    bpolys = [Polygon(list(zip(b["p"][0::2], b["p"][1::2]))).buffer(0) for b in buildings]
    btree = STRtree(bpolys)
    kept = dropped = 0
    for t_ in trees:
        pt = Point(t_[0], t_[1])
        if water_union is not None and water_union.contains(pt): dropped += 1; continue
        if any(drive_lines[i].distance(pt) < drive_w[i] / 2 + .9 for i in tree.query(pt.buffer(20))): dropped += 1; continue
        if any(bpolys[i].distance(pt) < 1.2 for i in btree.query(pt.buffer(3))): dropped += 1; continue
        r = h01(t_[0], t_[1], "sp")
        in_park = any(a["k"] in ("park", "pitch", "campus") and Polygon(list(zip(a["p"][0::2], a["p"][1::2]))).buffer(0).contains(pt) for a in areas_near(pt))
        # 0 neem, 1 gulmohar, 2 banyan/peepal, 3 coconut palm, 4 ashoka
        sp = (2 if r < .25 else 3 if r < .45 else 0 if r < .75 else 1) if in_park else (1 if r < .35 else 0 if r < .75 else 4 if r < .9 else 3)
        chunks[cidx(*t_)]["t"].extend([t_[0], t_[1], sp]); kept += 1
    print("trees kept", kept, "dropped (road/building/water)", dropped)
    for p in pois: chunks[cidx(p[0], p[1])]["poi"].append(p)
    def touch(lst, key, idx, pad):
        xs, zs = lst[0::2], lst[1::2]
        i0, j0 = cidx(min(xs) - pad, min(zs) - pad); i1, j1 = cidx(max(xs) + pad, max(zs) + pad)
        for i in range(i0, i1 + 1):
            for j in range(j0, j1 + 1): chunks[(i, j)][key].append(idx)
    for k_, rd in enumerate(roads): touch(rd["p"], "r", k_, rd["w"])
    for k_, a in enumerate(areas): touch(a["p"], "a", k_, 2)

    # ---------------- landmarks & spawn ----------------
    landmarks = {}
    for b in buildings:
        if b["n"]:
            for key_ in NOTABLE:
                if key_ in b["n"] and key_ not in landmarks: landmarks[key_] = [r1(b["cx"]), r1(b["cz"])]
    for rd in roads:
        for key_ in NOTABLE:
            if key_ in rd["n"] and key_ not in landmarks:
                m = len(rd["p"]) // 4 * 2; landmarks[key_] = [rd["p"][m], rd["p"][m + 1]]
    for el in list(ways.values()) + rels:
        nm = el.get("tags", {}).get("name", "")
        for key_ in NOTABLE:
            if key_ in nm and key_ not in landmarks:
                pts = way_pts(el) if el["type"] == "way" else []
                if pts: landmarks[key_] = [r1(sum(p[0] for p in pts) / len(pts)), r1(sum(p[1] for p in pts) / len(pts))]
    for rd in roads:   # famous roads (longest named piece)
        for nm in ("Fergusson College Road", "Jangli Maharaj", "Laxmi", "Bajirao", "Shivaji Road", "Tilak Road", "Kumthekar"):
            if nm in rd["n"]:
                L = len(rd["p"]) // 2
                if nm not in landmarks or L > landmarks[nm][2]:
                    m = (L // 2) * 2; landmarks[nm] = [rd["p"][m], rd["p"][m + 1], L]
    for k_ in list(landmarks):
        landmarks[k_] = landmarks[k_][:2]

    # ---------------- minimap ----------------
    from PIL import Image, ImageDraw
    MPP = 2.0
    iw, ih = int((maxx - minx) / MPP), int((maxz - minz) / MPP)
    img = Image.new("RGB", (iw, ih), "#2a2e3b")
    dr = ImageDraw.Draw(img)
    P = lambda lst: [((lst[i] - minx) / MPP, (lst[i + 1] - minz) / MPP) for i in range(0, len(lst), 2)]
    fills = {"water": "#2a7fb0", "park": "#3c7a4e", "pitch": "#4f8f4a", "campus": "#3a3f4f", "parking": "#3a3d48"}
    for k in ("campus", "parking", "park", "pitch", "water"):
        for a in areas:
            if a["k"] == k and len(a["p"]) >= 6: dr.polygon(P(a["p"]), fill=fills[k])
    for b in buildings: dr.polygon(P(b["p"]), fill="#4b5166" if b["k"] == "building" else "#b8902f")
    order = ["footway", "path", "steps", "cycleway", "track", "pedestrian", "service", "living_street", "unclassified", "residential",
             "tertiary_link", "tertiary", "secondary_link", "secondary", "primary_link", "primary", "trunk_link", "trunk"]
    for cls in order:
        for rd in roads:
            if rd["c"] == cls: dr.line(P(rd["p"]), fill=ROADS[cls][2], width=max(1, int(rd["w"] / MPP * .8)), joint="curve")

    # ---------------- write ----------------
    out = os.path.join(ROOT, "data/world", key)
    if os.path.exists(out): shutil.rmtree(out)
    os.makedirs(os.path.join(out, "chunks"))
    dump = lambda name, obj: json.dump(obj, open(os.path.join(out, name), "w"), separators=(",", ":"))
    for (i, j), c in chunks.items(): dump(f"chunks/c_{i}_{j}.json", c)
    dump("terrain.json", terrain)
    dump("roads.json", [{k: v for k, v in rd.items() if k not in ("nodes", "id")} for rd in roads])
    dump("areas.json", areas)
    dump("graph.json", graph)
    img.save(os.path.join(out, "minimap.png"), optimize=True)
    drive_edges = sum(1 for e_ in edges if e_[3])
    manifest = {"key": key, "name": area["name"], "origin_latlon": origin, "bbox_latlon": area["bbox"],
                "bbox": [r1(minx), r1(minz), r1(maxx), r1(maxz)], "chunk_size": CS, "grid": [nx, nz],
                "chunks": sorted([list(k) for k in chunks]), "minimap": {"file": "minimap.png", "mpp": MPP, "x0": r1(minx), "z0": r1(minz)},
                "landmarks": landmarks, "spawn": landmarks.get("Deccan Corner") or [0, 0],
                "stats": {"buildings": len(buildings), "roads": len(roads), "areas": len(areas), "trees": len(trees), "pois": len(pois),
                          "graph_nodes": len(gnodes) // 2, "graph_edges": len(edges), "drivable_edges": drive_edges},
                "attribution": "Map data (c) OpenStreetMap contributors, ODbL. Elevation: SRTM via AWS Terrain Tiles."}
    dump("manifest.json", manifest)
    game_dst = os.path.join(ROOT, "game/world", key)
    if os.path.exists(game_dst): shutil.rmtree(game_dst)
    shutil.copytree(out, game_dst)
    print(json.dumps(manifest["stats"]), "landmarks:", list(landmarks))


if __name__ == "__main__":
    build(sys.argv[1] if len(sys.argv) > 1 else "peths_fc")
