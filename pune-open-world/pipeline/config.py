"""Area definitions and world-build settings.

Every playable region of Pune is an *area*: a lat/lon bounding box that the
pipeline fetches, caches and converts into streamed chunks. Start small, then
add areas (or one big "pune_city" area) once the pipeline is validated.
"""
import math

AREAS = {
    # Validated starter area: Shaniwar Wada, Dagdusheth, Laxmi Road, Tulshibaug,
    # Deccan, FC Road, JM Road, Mutha river, Sambhaji Bridge (Lakdi Pul).
    "peths_fc": {"name": "Peths + FC Road", "bbox": (18.5065, 73.8360, 18.5285, 73.8625)},
    # Next areas to add (uncomment and run the pipeline):
    # "camp_kp":  {"name": "Camp + Koregaon Park", "bbox": (18.5080, 73.8700, 18.5420, 73.9050)},
    # "kothrud":  {"name": "Kothrud + Karve Road", "bbox": (18.4950, 73.7950, 18.5150, 73.8350)},
    # "pune_city":{"name": "Pune (PMC core)",       "bbox": (18.4300, 73.7600, 18.6200, 73.9800)},
}

CHUNK_SIZE = 250.0          # metres per streamed chunk (square)
DEM_SPACING = 10.0          # metres between terrain samples
DEM_SMOOTH_SIGMA = 2.5      # gaussian blur (in samples) to remove SRTM roof/tree noise
OSM_TILE_DEG = 0.0075       # OSM API tile size (degrees). API limit: 50k nodes / request
FLOOR_HEIGHT = 3.2          # metres per building level

# Road classes: (drawn width m, drivable, minimap colour, traffic weight)
ROADS = {
    "trunk":          (16, True, "#f2c14e", 4), "trunk_link":     (8, True, "#f2c14e", 2),
    "primary":        (14, True, "#f2c14e", 4), "primary_link":   (8, True, "#f2c14e", 2),
    "secondary":      (12, True, "#f6e3a1", 3), "secondary_link": (7, True, "#f6e3a1", 2),
    "tertiary":       (10, True, "#ffffff", 3), "tertiary_link":  (6, True, "#ffffff", 1),
    "residential":    (7,  True, "#d9d9e3", 1), "unclassified":   (7,  True, "#d9d9e3", 1),
    "living_street":  (6,  True, "#d9d9e3", 1), "service":        (5,  True, "#bfbfcc", 0),
    "pedestrian":     (6,  False, "#e8d9c0", 0), "footway":       (2.5, False, "#e8d9c0", 0),
    "path":           (2,  False, "#e8d9c0", 0), "steps":         (2.5, False, "#e8d9c0", 0),
    "cycleway":       (2.5, False, "#e8d9c0", 0), "track":        (4,  False, "#c8b89a", 0),
}


def projector(bbox):
    """Local tangent-plane projection: x = east metres, z = south metres (Three.js / UE-friendly).

    For a single city (< 50 km) an equirectangular projection around the area
    centre is accurate to well under a metre per km, which is plenty for a game.
    For the whole city use one shared origin for every area (see docs/EXPANDING.md).
    """
    lat0 = (bbox[0] + bbox[2]) / 2
    lon0 = (bbox[1] + bbox[3]) / 2
    mx = 111320.0 * math.cos(math.radians(lat0))
    mz = 110574.0

    def proj(lat, lon):
        return ((lon - lon0) * mx, -(lat - lat0) * mz)

    return proj, (lat0, lon0)
