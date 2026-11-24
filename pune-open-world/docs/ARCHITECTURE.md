# Architecture

## Decision: engine-neutral pipeline + web runtime first, Unreal second

The brief preferred Unreal Engine 5 + Cesium. I chose a different first step, for these reasons:

1. **Validate the pipeline before the engine.** Turning OSM into a drivable city (clean footprints, heights,
   a road graph, terrain, chunking) is most of the work and is independent of the engine. The pipeline
   writes plain JSON + PNG + glTF, which every engine reads.
2. **Zero cost, instant playtesting.** The web runtime is static files: no server, no install, no licence,
   no GPU-cloud bill. Anyone with a browser can test a build, and it runs on an average gaming PC
   (and phones, at reduced detail).
3. **Cesium + Google 3D Tiles is the wrong base for a game.** Photogrammetry meshes have no separable
   buildings, no collision-friendly roads and licence limits, and Google data is excluded by the brief.
   Cesium is still useful in UE5 for *terrain and imagery* around the playable city (see UNREAL.md).
4. **Unreal stays the upgrade path.** `export_gltf.py` produces one `.glb` per chunk in world space, and
   `graph.json` carries the road network for UE traffic. Nothing is thrown away.

## Data flow
```
OSM API (tiles, cached) ──► data/raw/osm/<area>.json ─┐
AWS terrain tiles (SRTM) ─► data/raw/dem/<area>.json ─┼─► build_world.py ─► data/world/<area>/ ─┬─► game/world/<area>/ (web runtime)
                                                      │                                       └─► export_gltf.py ─► exports/glb/<area>/*.glb (UE5/Blender)
config.py (areas, chunk size, road classes) ──────────┘
```

## Coordinate system
Local tangent plane around the area centre: **x = east (m), z = south (m), y = up (m)**, with heights
relative to `terrain.base_m` (the lowest smoothed DEM sample − 1 m). This matches Three.js and glTF
(Y-up, metres). Equirectangular projection error is < 0.1 % over 10 km, which a game never notices.

## World files (data/world/&lt;area&gt;/)
| File | Content |
|---|---|
| `manifest.json` | origin lat/lon, local bbox, chunk grid, landmark positions, spawn, stats, attribution |
| `terrain.json` | 10 m grid of smoothed SRTM heights (decimetres) |
| `roads.json` | every highway: class, width (from `lanes` or class), name, bridge, one-way, polyline |
| `areas.json` | water, park, pitch, campus and parking polygons (river centre-lines buffered to 60 m) |
| `graph.json` | contracted road graph: nodes are intersections, edges are polylines with one-way, drivable, weight, width, name, length |
| `chunks/c_I_J.json` | per 250 m chunk: buildings `[kind, height, colour, name, ring]`, trees, shop POIs, ids of roads/areas touching the chunk |
| `minimap.png` | 2 m/pixel render for the radar and pause map |

Building heights: `height` or `building:levels × 3.2 m` when tagged (79 of 6,885 buildings here), otherwise
a deterministic estimate from building type, footprint area and district (older Peth buildings are lower and
partly timber-brown). Landmarks get custom treatment: Shaniwar Wada is fort walls with bastions and ruins
inside, temples get shikharas, and Dagdusheth gets a gold one.

## Runtime (game/src)
| Module | Responsibility |
|---|---|
| `world.js` | loads world files; terrain height (bilinear) and bridge decks; chunk streaming (load radius 560 m, one chunk built per frame); per-chunk terrain mesh with a canvas-painted road texture (footpaths, asphalt, lane markings, parks, river); merged building meshes (shop-front band + window floors + roofs + water tanks); trees, shop signs; spatial-hash collision against footprints; road-graph queries and A* routing |
| `humans.js` | GPU-animated people: walk, run, idle-breathe, ride/sit, flail and hands-up poses run in the vertex shader on a jointed low-poly rig. Three body types (shirt/trousers, saree, kurta with Gandhi cap) plus the player. One draw call per type |
| `vehicles.js` | car, auto, bus, scooter and motorbike models; arcade drift physics (lateral grip damping, handbrake, slope gravity, wet grip) |
| `traffic.js` | AI traffic on the graph (keeps left, respects one-ways, follows the vehicle ahead, slows for turns, honks when stuck); pedestrians on footpaths, ragdoll-lite when hit |
| `audio.js` | synthesised radio (4 original stations), engine with gears, skid, siren, horn, rain, crashes |
| `main.js` | player (walk/run, enter and exit with a walk-to-door step, bike riding pose), camera spring with building avoidance, police AI with A* pursuit, wanted and busted, missions, GPS, HUD, radar, map, weather, day/night |

Physics runs at a fixed 120 Hz with render interpolation via damped mesh smoothing, so motion is smooth at any frame rate.

## Performance budget (desktop)
About 27 chunks resident, roughly 2,000 buildings drawn as ~4 merged meshes per chunk. 34 AI vehicles,
100 pedestrians (3 instanced draw calls), and the fog distance matched to the stream radius. Phones get
half-size road textures, a smaller radius and fewer agents.
