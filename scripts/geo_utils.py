# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "geopandas>=0.14",
#   "topojson>=1.10",
# ]
# ///
"""
Shared geometry helpers used by both process_data.py and taz_districts.py,
plus the single TIGER vintage pin shared by every script that downloads
Census TIGER/Line files.
"""

# Census TIGER/Line vintage. Bump this one constant to move to a newer release;
# URLs and cache filenames below are derived from it.
TIGER_YEAR = 2026
TIGER_BASE = f"https://www2.census.gov/geo/tiger/TIGER{TIGER_YEAR}"


def tiger_file(layer, name):
    """('PLACE', '49_place') -> ('<url>', 'tl_2026_49_place.zip'): URL + cache filename."""
    fname = f"tl_{TIGER_YEAR}_{name}.zip"
    return f"{TIGER_BASE}/{layer}/{fname}", fname


def topo_simplify(gdf, tolerance):
    """Topology-preserving simplification via the topojson library.

    Unlike geopandas .simplify() (which simplifies each polygon independently),
    this method encodes shared boundaries once and simplifies them consistently,
    so adjacent polygons never develop gaps after simplification.

    gdf must already be in a projected CRS; tolerance is in those units (metres).
    Returns a new GeoDataFrame with the same columns and CRS.
    """
    import topojson
    topo = topojson.Topology(gdf, prequantize=False)
    simplified = topo.toposimplify(tolerance).to_gdf()
    # toposimplify returns a GeoDataFrame; restore index and column order
    simplified = simplified.set_index(gdf.index)
    simplified.crs = gdf.crs
    return simplified[gdf.columns]
