# Puneri: Real Pune — a GTA-style open world on the real map of Pune

A playable, geographically accurate slice of Pune (the Peths + FC Road, about 2.8 × 2.4 km) built
entirely from free data: **OpenStreetMap** for roads, buildings, parks, water and shops, and
**SRTM** elevation for terrain. There are no paid APIs or servers, and nothing recurring to pay for.

| Layer | What it does |
|---|---|
| `pipeline/` (Python) | Fetches and caches OSM + DEM, converts lat/lon to local metres, generates buildings, the road graph, terrain, the minimap and streamed chunks, and exports `.glb` for Unreal/Blender |
| `game/` (Three.js, static files) | Chunk streaming, real roads and buildings, GPU-animated people, cars, autos, buses, scooters and bikes, left-hand AI traffic on the real road graph, pedestrians, police and wanted level, 5 missions at real landmarks, GPS (A*), radar and map, day/night, monsoon rain, synthesised radio |
| `exports/glb/` | One `.glb` per 250 m chunk (buildings, terrain, road surface), ready for UE5 World Partition or Blender |

## Quick start
```bash
pip install -r requirements.txt
python pipeline/fetch_osm.py peths_fc      # cached in data/raw/osm (already included)
python pipeline/fetch_dem.py peths_fc      # cached in data/raw/dem (already included)
python pipeline/build_world.py peths_fc    # -> data/world/peths_fc + game/world/peths_fc
python pipeline/export_gltf.py peths_fc    # optional: -> exports/glb/peths_fc/*.glb
cd game && python -m http.server 8000      # open http://localhost:8000
```
The game needs a local web server (ES modules + fetch); opening `index.html` directly will not work.

## Controls
W/S accelerate, brake and reverse · A/D steer · Space handbrake drift · Shift run · F enter or exit vehicle ·
M map (click to set GPS) · R radio · C camera · H horn · O weather · P/Esc pause. Touch controls appear on phones.

## Missions (all at real places)
Bun Maska Run (Deccan Corner → Tulshibaug) · Darshan Dash (Dagdusheth → Shaniwar Wada → Omkareshwar → Dagdusheth) ·
FC Road Food Crawl (Fergusson College → JM Road → Balgandharva → Deccan Gymkhana) · Lakdi Pul Getaway (Mandai → Sambhaji Bridge → Deccan, with cops on you) ·
Peth Scooter Sprint (two-wheeler only: Kasba Peth → Laxmi Road → Bajirao Road → Shivaji Road). Time limits come from the real GPS route length.

## Docs
- `docs/ARCHITECTURE.md`: why this architecture, data flow, coordinate system, file formats
- `docs/EXPANDING.md`: scaling from one area to all of Pune
- `docs/UNREAL.md`: taking the same data into Unreal Engine 5

## Credits and licences
Map data © OpenStreetMap contributors, available under the Open Database License (ODbL). Any public
build must show this attribution (the game does, top-right and on the map). Elevation: SRTM via AWS
Terrain Tiles (public domain). Building heights are estimated where OSM has no `building:levels`.
All characters, vehicle names, shops and music are original and fictional. This is a fan project, not affiliated with Rockstar Games.
