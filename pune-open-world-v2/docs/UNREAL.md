# Taking the world into Unreal Engine 5

The pipeline output is engine-neutral. These steps bring the same Pune into UE 5.3+.

## 1. Import the city chunks
1. `python pipeline/export_gltf.py peths_fc` → `exports/glb/peths_fc/chunk_I_J.glb` (world-space vertices, metres, Y-up).
2. Create a new **Open World** level (World Partition enabled).
3. Drag the `.glb` files into the Content Browser (Interchange importer). Keep *Combine Meshes* off.
   UE converts Y-up metres to Z-up centimetres automatically.
4. Place every imported actor at **(0, 0, 0)**. Vertices are already in world space, so the chunks tile exactly.
5. World Partition → *Build HLODs* for distant chunks. Enable **Nanite** on the building meshes.

## 2. Materials
The glb uses vertex colours. Make one master material that multiplies a tiling window/shop-front texture
(world-aligned UV: U = distance along wall / 3.2 m, V = height / 3.2 m) by `VertexColor`, as the web runtime does.

## 3. Terrain around the city (optional Cesium)
Cesium for Unreal is still useful *outside* the playable area: add **Cesium World Terrain** or a local
GeoTIFF of the DEM for the hills (Parvati, Vetal tekdi, Sinhagad), and set the Cesium georeference origin to
`manifest.json → origin_latlon`. Do not use Google Photorealistic 3D Tiles (licence, and not game-usable).

## 4. Roads, traffic and navigation
- `graph.json` edges are polylines in the same local coordinates. Import them with a small Python editor
  script (`unreal` module) as **Spline Components** for traffic lanes, or feed them to the **Mass Traffic**
  setup from Epic's City Sample (ZoneGraph lanes).
- One-way (`oneway`), width and road weight are on every edge. Drive on the **left**.
- Pedestrians: use non-drivable edges + footpath offsets (`width / 2 + 1.4 m`) for Mass crowd lanes.

## 5. Gameplay
Start from the **Third Person** template (character), **Chaos Vehicles** (cars), and port the systems from
`game/src` (mission list, wanted level, GPS using the same graph). The mission data and landmark positions are
in `manifest.json` and `game/src/main.js → MISSIONS`.

## Coordinate conversion
`UE (cm) = (x × 100, z × 100, y × 100)` with UE X = east, UE Y = south, UE Z = up after Interchange's Y-up
conversion. Lat/lon ↔ local: see `pipeline/config.py → projector`.
