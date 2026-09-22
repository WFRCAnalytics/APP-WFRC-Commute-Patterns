# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "geopandas>=0.14",
#   "topojson>=1.10",
# ]
# ///
"""
Shared geometry helpers used by both process_data.py and taz_districts.py.
"""


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
