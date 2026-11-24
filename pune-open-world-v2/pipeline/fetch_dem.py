"""Download free elevation (SRTM-derived AWS Terrain Tiles) for an area.

Terrarium PNG tiles: height_m = R*256 + G + B/256 - 32768.
Samples a regular grid (DEM_SPACING metres, north row first) and caches it to
data/raw/dem/<area>.json. No API key, no cost.

Usage:  python pipeline/fetch_dem.py peths_fc
"""
import io, json, math, os, sys, urllib.request
from config import AREAS, DEM_SPACING

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TILE = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
Z = 15


def lon2x(lon): return (lon + 180) / 360 * 2 ** Z
def lat2y(lat):
    r = math.radians(lat)
    return (1 - math.log(math.tan(r) + 1 / math.cos(r)) / math.pi) / 2 * 2 ** Z


def fetch_dem(key):
    from PIL import Image
    s, w, n, e = AREAS[key]["bbox"]
    cache = os.path.join(ROOT, "data/raw/dem/tiles")
    os.makedirs(cache, exist_ok=True)
    tiles = {}
    for x in range(int(lon2x(w)), int(lon2x(e)) + 1):
        for y in range(int(lat2y(n)), int(lat2y(s)) + 1):
            p = os.path.join(cache, f"{Z}_{x}_{y}.png")
            if not os.path.exists(p):
                urllib.request.urlretrieve(TILE.format(z=Z, x=x, y=y), p)
            tiles[(x, y)] = Image.open(p).convert("RGB").load()
    lat0 = (s + n) / 2
    mx, mz = 111320 * math.cos(math.radians(lat0)), 110574
    W = round((e - w) * mx / DEM_SPACING) + 1
    H = round((n - s) * mz / DEM_SPACING) + 1
    dm = []
    for j in range(H):
        for i in range(W):
            fx, fy = lon2x(w + i * DEM_SPACING / mx), lat2y(n - j * DEM_SPACING / mz)
            t = tiles.get((int(fx), int(fy)))
            h = 0.0
            if t:
                r, g, b = t[min(255, int((fx % 1) * 256)), min(255, int((fy % 1) * 256))]
                h = r * 256 + g + b / 256 - 32768
            dm.append(round(h * 10))
    out = os.path.join(ROOT, "data/raw/dem", key + ".json")
    json.dump({"source": "AWS Terrain Tiles (terrarium, SRTM-derived) z15",
               "bbox": {"minlat": s, "minlon": w, "maxlat": n, "maxlon": e},
               "spacing_m": DEM_SPACING, "width": W, "height": H, "row0": "north",
               "units": "decimetres", "dm": dm}, open(out, "w"))
    print("wrote", out, W, "x", H)


if __name__ == "__main__":
    fetch_dem(sys.argv[1] if len(sys.argv) > 1 else "peths_fc")
