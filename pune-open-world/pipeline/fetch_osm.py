"""Download OpenStreetMap data for an area and cache it locally.

Uses the free OSM editing API (/api/0.6/map) in small tiles so each request
stays under the 50,000-node limit, then merges and de-duplicates. Tiles are
cached in data/raw/osm/tiles/ so re-runs cost nothing.

Usage:  python pipeline/fetch_osm.py peths_fc
Be polite: the OSM API is a shared, donated resource. For areas larger than a
few km, download a Geofabrik extract instead (see docs/EXPANDING.md).
"""
import json, math, os, sys, time, urllib.request
from config import AREAS, OSM_TILE_DEG

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
API = "https://api.openstreetmap.org/api/0.6/map.json?bbox={w:.5f},{s:.5f},{e:.5f},{n:.5f}"
UA = {"User-Agent": "pune-open-world/0.1 (personal game project)"}


def fetch_area(key):
    s, w, n, e = AREAS[key]["bbox"]
    tdir = os.path.join(ROOT, "data/raw/osm/tiles", key)
    os.makedirs(tdir, exist_ok=True)
    ny, nx = math.ceil((n - s) / OSM_TILE_DEG), math.ceil((e - w) / OSM_TILE_DEG)
    seen, elements = set(), []
    for a in range(ny):
        for b in range(nx):
            ts, tn = s + (n - s) * a / ny, s + (n - s) * (a + 1) / ny
            tw, te = w + (e - w) * b / nx, w + (e - w) * (b + 1) / nx
            path = os.path.join(tdir, f"{a}_{b}.json")
            if not os.path.exists(path):
                url = API.format(w=tw, s=ts, e=te, n=tn)
                print("GET", url)
                for attempt in range(4):
                    try:
                        with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120) as r:
                            data = r.read()
                        break
                    except Exception as ex:  # rate limit or transient error
                        print("  retry", attempt + 1, ex)
                        time.sleep(5 * (attempt + 1))
                else:
                    raise SystemExit("OSM API failed; try a smaller OSM_TILE_DEG or a Geofabrik extract")
                open(path, "wb").write(data)
                time.sleep(1.5)
            for el in json.load(open(path))["elements"]:
                k = el["type"][0] + str(el["id"])
                if k not in seen:
                    seen.add(k)
                    elements.append(el)
    out = os.path.join(ROOT, "data/raw/osm", key + ".json")
    json.dump({"bbox": {"minlat": s, "minlon": w, "maxlat": n, "maxlon": e},
               "copyright": "OpenStreetMap contributors, ODbL", "elements": elements}, open(out, "w"))
    print("wrote", out, len(elements), "elements")


if __name__ == "__main__":
    fetch_area(sys.argv[1] if len(sys.argv) > 1 else "peths_fc")
