# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "pandas>=2.0",
#   "geopandas>=0.14",
#   "requests>=2.31",
#   "shapely>=2.0",
#   "topojson>=1.10",
# ]
# ///
"""
MAG Workshop Areas — hidden/unlisted geography, sibling to workshop_areas.py.

Source: MAG_Workshop_Areas FeatureServer, layer 0. Four named RTP-planning
workshop subregions covering Utah County (Mountainland Association of
Governments) — not the Wasatch Front, unlike workshop_areas.py's WFRC
Workshop Areas. The two geographies don't overlap.

This geography is intentionally NOT exposed in the main UI, same rationale
as workshop_areas.py: it's wired into the app as a second hidden subject
type under Workshop Areas mode (see sidebar.js / main.js), not access-
controlled.

Functions consumed by process_data.py:

  build_mag_workshop_lookup(xwalk_df)   -> dict[block_fips -> subregion_name|None]
  generate_mag_workshop_boundaries()    -> writes data/mag_workshop_boundaries.geojson
  build_mag_workshop_meta()             -> list[{name, lat, lon}]
"""

from pathlib import Path

import requests
import pandas as pd
import geopandas as gpd
from shapely.geometry import Point

from geo_utils import topo_simplify

DATA_DIR  = Path(__file__).parent.parent / "data"
CACHE_DIR = DATA_DIR / "cache"

MAG_WORKSHOP_SERVICE_URL = (
    "https://services2.arcgis.com/EiGeaCDLpVDPqdJ5/arcgis/rest/services/"
    "MAG_Workshop_Areas/FeatureServer/0/query"
)
MAG_WORKSHOP_OUT_FIELDS = "Subregion,Shape__Area"

MAG_WORKSHOP_POLYGONS_CACHE = CACHE_DIR / "mag_workshop_polygons.geojson"
MAG_WORKSHOP_BOUNDARIES_OUT = DATA_DIR / "mag_workshop_boundaries.geojson"


def fetch_mag_workshop_polygons(force=False):
    """Download (cached) the MAG Workshop Areas layer as a GeoDataFrame in WGS-84.

    Only 4 features — no pagination needed, but the request still goes
    through outSR=4326&f=geojson like the WFRC workshop fetch for consistency.
    """
    if not force and MAG_WORKSHOP_POLYGONS_CACHE.exists() and MAG_WORKSHOP_POLYGONS_CACHE.stat().st_size > 0:
        return gpd.read_file(MAG_WORKSHOP_POLYGONS_CACHE)

    params = {
        "where": "1=1",
        "outFields": MAG_WORKSHOP_OUT_FIELDS,
        "outSR": 4326,
        "f": "geojson",
    }
    r = requests.get(MAG_WORKSHOP_SERVICE_URL, params=params, timeout=60)
    r.raise_for_status()
    geojson = r.json()

    gdf = gpd.GeoDataFrame.from_features(geojson["features"], crs="EPSG:4326")

    CACHE_DIR.mkdir(exist_ok=True)
    gdf.to_file(MAG_WORKSHOP_POLYGONS_CACHE, driver="GeoJSON")
    print(f"  Cached {len(gdf)} MAG workshop area polygons -> {MAG_WORKSHOP_POLYGONS_CACHE.name}")
    return gdf


def build_mag_workshop_lookup(xwalk_df: pd.DataFrame) -> dict:
    """Return {block_fips: subregion_name} for blocks that fall inside a MAG
    workshop subregion (most of the state won't match — this geography only
    covers Utah County). Spatial join via geopandas.sjoin.
    """
    workshop_gdf = fetch_mag_workshop_polygons()

    valid = xwalk_df["blklatdd"].notna() & xwalk_df["blklondd"].notna()
    blocks_gdf = gpd.GeoDataFrame(
        xwalk_df.loc[valid, ["tabblk2020"]].copy(),
        geometry=[Point(lon, lat) for lat, lon in
                  zip(xwalk_df.loc[valid, "blklatdd"], xwalk_df.loc[valid, "blklondd"])],
        crs="EPSG:4326",
    )

    joined = gpd.sjoin(blocks_gdf, workshop_gdf[["Subregion", "geometry"]], how="left", predicate="within")
    joined = joined[~joined.index.duplicated(keep="first")]

    lookup = {
        row.tabblk2020: row.Subregion
        for row in joined.itertuples(index=False)
        if pd.notna(row.Subregion)
    }
    print(f"  Matched {len(lookup):,}/{len(blocks_gdf):,} blocks to a MAG workshop subregion "
          f"(remainder are outside Utah County MAG workshop coverage — expected)")
    return lookup


def generate_mag_workshop_boundaries(force=False):
    """Write data/mag_workshop_boundaries.geojson. Skips if it already exists
    unless force=True (matches generate_workshop_boundaries())."""
    if not force and MAG_WORKSHOP_BOUNDARIES_OUT.exists():
        print("  MAG workshop boundary file already exists, skipping.")
        return

    gdf = fetch_mag_workshop_polygons()[["Subregion", "geometry"]].rename(columns={"Subregion": "name"})
    gdf = gdf.to_crs(epsg=26912)
    gdf = topo_simplify(gdf, tolerance=50)
    gdf = gdf.to_crs(epsg=4326)
    gdf.to_file(MAG_WORKSHOP_BOUNDARIES_OUT, driver="GeoJSON")
    print(f"  Wrote {MAG_WORKSHOP_BOUNDARIES_OUT.name} ({len(gdf)} MAG workshop subregion polygons)")


def build_mag_workshop_meta() -> list:
    """Build metadata list [{name, lat, lon}] for the MAG workshop subregions."""
    gdf = fetch_mag_workshop_polygons()
    meta = []
    for _, row in gdf.iterrows():
        pt = row.geometry.representative_point()
        meta.append({"name": row["Subregion"], "lat": float(pt.y), "lon": float(pt.x)})
    return sorted(meta, key=lambda x: x["name"])


if __name__ == "__main__":
    gdf = fetch_mag_workshop_polygons(force=True)
    print(f"\n{len(gdf)} MAG workshop subregions:")
    for name in sorted(gdf["Subregion"]):
        print(" ", name)
