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

## Building heights
Priority: OSM `height` / `building:levels × 3.2 m` (75 buildings) → **measured** height from Google Open Buildings
2.5D Temporal 2023 (6,296 buildings) → estimate from type/area/district (490 buildings).
The measured raster (1 m resampled from the 0.5 m COG, band `building_height` masked by `building_presence ≥ 0.5`)
lives in `data/raw/heights/peths_fc_obt2023.u8` (+ `.json` with CRS EPSG:32643 and origin). For each footprint the
pipeline reprojects to UTM, shrinks it 1 m (so neighbouring roofs don't bleed in), takes the 80th percentile of
building pixels and snaps to whole floors (3.2 m) + 0.9 m parapet. To fetch another area: find the S2 level-2 token
(`3b` covers Pune), read `gs://open-buildings-temporal-data/v1/manifests/<token>_EPSG_<utm>_2023_06_30.json`,
pick the tile whose bounds cover the area, and window-read it with rasterio or geotiff.js (public HTTPS, no key).

## Building style, roofs and street fronts
The pipeline classifies each building as `old` (Peth wada, timber/lime), `house`, `apt` or `tower`, adds `+shop`
when a wall faces a busy street (shop fronts only on those walls), chooses `gable`/`hip` Mangalore-tile roofs for
small near-rectangular old houses, and records which walls face a road. The runtime builds walls with whole window
bays and real floor counts, roof parapets, tiled pitched roofs, grime at the base, and instanced Blender props:
Sintex water tanks, stair heads, dishes, AC units, 3D balconies and street lamps. Trees are kept off carriageways
(910 removed), get a Pune species (neem, gulmohar, banyan, coconut palm, ashoka) and are solid (trunk collision).

## Blender asset pipeline (tools/blender)
`make_assets.py` models facade bays in 3D (MS window grilles, chajja sunshades, balconies with laundry, AC units,
teak wada galleries, glass curtain wall, rolling-shutter shops), renders them with Cycles into tileable atlases plus
night-window masks, renders a Mangalore roof-tile texture, and exports `props.glb`. `make_living.py` builds the trees
and Skin-modifier people (`people.glb`), whose object names carry rig part/slot ids for GPU animation. Landmarks get custom treatment: Shaniwar Wada is fort walls with bastions and ruins
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
