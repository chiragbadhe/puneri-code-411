# Expanding from one area to the whole of Pune

The starter area validated every step. Scaling is mostly data volume, and the order below keeps it cheap.

## 1. Add neighbouring areas (fastest)
Uncomment or add entries in `pipeline/config.py → AREAS` (Camp + Koregaon Park, Kothrud, …) and run:
```bash
python pipeline/fetch_osm.py camp_kp && python pipeline/fetch_dem.py camp_kp && python pipeline/build_world.py camp_kp
```
Play it with `http://localhost:8000/?area=camp_kp`.

## 2. One shared origin for a seamless city
Separate areas each have their own origin. For one continuous world:
1. Add a `"pune_city"` area covering the PMC core (`18.43, 73.76 → 18.62, 73.98`, about 23 × 21 km).
2. In `config.projector`, use a **fixed** origin (e.g. Shaniwar Wada, 18.5195, 73.8553) instead of the bbox
   centre, so every future area lines up exactly.
3. Keep `CHUNK_SIZE = 250`. The city is about 8,000 chunks, but only ~27 are ever loaded.

## 3. Use a Geofabrik extract instead of the OSM API
The editing API is for small areas. For the whole city:
```bash
wget https://download.geofabrik.de/asia/india/western-zone-latest.osm.pbf   # free, updated daily
osmium extract -b 73.76,18.43,73.98,18.62 western-zone-latest.osm.pbf -o pune.osm.pbf
osmium export pune.osm.pbf -f geojsonseq -o pune.geojsonseq
```
Then add a small reader in `build_world.py` (GeoJSON features → the same `nodes/ways` structures). For
national scale, `pyosmium` streaming avoids loading everything into memory.

## 4. Elevation for the city
`fetch_dem.py` already works for any bbox (tiles are cached). For better terrain, use the free 30 m
Copernicus GLO-30 DEM instead of SRTM and keep the same output format.

## 5. Build-time optimisations for ~150k buildings
- Process chunks in parallel (`multiprocessing.Pool` over chunk ids).
- Write chunk files as binary (Float32 + Uint8) or gzip JSON. The 250 m chunks here average 8 KB.
- Add **LOD**: per chunk, also write a simplified "far" mesh (footprints merged by block, flat colour) and
  show it between 560 m and 2 km in the runtime or as UE HLODs.
- Pre-bake the road texture per chunk to WebP in the pipeline instead of painting it at runtime.

## 6. Runtime changes when the world gets big
- `World.update` already streams by distance. Add a second ring of far-LOD chunks.
- Traffic and pedestrians spawn only near the player, so they scale for free.
- A* over the full city graph (~200k nodes) needs a binary heap. Replace the linear open-set scan in `World.route`.
- Load `graph.json` per region (e.g. 2 × 2 km tiles) instead of globally.

## 7. Data quality
- Building heights: OSM coverage of `building:levels` in Pune is low. Contribute levels on OSM
  (StreetComplete makes this easy) and rebuild. Every improvement flows into the game.
- Missing footprints: the free Microsoft or Google Open Buildings datasets (ODbL/CC-BY) can fill gaps.
  Check each licence and attribute.

## 8. Hosting at zero cost
The `game/` folder is static. GitHub Pages, Cloudflare Pages or Netlify free tiers host it. A full-city build
is about 1 GB of chunks, which still fits Cloudflare's free static limits when split into ≤25 MB files.
