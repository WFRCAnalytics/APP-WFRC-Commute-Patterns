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
Wasatch Front Planning Workshop Areas — hidden/unlisted geography.

Source: WFRC_Administrative_and_Planning_Area_Boundaries FeatureServer,
layer 5 (BND_FWS). Eight named regional-planning workshop areas covering
the Wasatch Front (Salt Lake/Davis/Weber/Box Elder counties) — not
statewide, unlike Civic Boundaries or Planning Boundaries.

This geography is intentionally NOT exposed in the main UI. It's wired
into the app as a hidden third mode (see sidebar.js / main.js), but the
underlying data is generated the same way as any other geography — there
is no meaningful way to keep static-site data secret from someone who
inspects network requests, so "hidden" here means low-discoverability in
the UI, not access control.

The source has one degenerate feature: "Northern Salt Lake Co." appears
twice, once as the real polygon (Shape__Area ~9.2e8) and once as a
near-zero sliver (Shape__Area ~0.5) that is clearly a digitizing
artifact, not a second real area. AREA_MIN_M2 filters it out.

Functions consumed by process_data.py:

  build_workshop_lookup(xwalk_df)   -> dict[block_fips -> workshop_name|None]
  generate_workshop_boundaries()    -> writes data/workshop_boundaries.geojson
  build_workshop_meta()             -> list[{name, lat, lon}]
"""

import json
from pathlib import Path

import requests
import pandas as pd
import geopandas as gpd
from shapely.geometry import Point

from geo_utils import topo_simplify

DATA_DIR  = Path(__file__).parent.parent / "data"
CACHE_DIR = DATA_DIR / "cache"

WORKSHOP_SERVICE_URL = (
    "https://services1.arcgis.com/taguadKoI1XFwivx/ArcGIS/rest/services/"
    "WFRC_Administrative_and_Planning_Area_Boundaries/FeatureServer/5/query"
)
WORKSHOP_OUT_FIELDS = "BoundaryName,Shape__Area"
# Drops the "Northern Salt Lake Co." sliver artifact (~0.5 m²) while keeping
# every real area (smallest genuine polygon is on the order of 1e8 m²).
AREA_MIN_M2 = 1000

WORKSHOP_POLYGONS_CACHE = CACHE_DIR / "workshop_polygons.geojson"
WORKSHOP_BOUNDARIES_OUT = DATA_DIR / "workshop_boundaries.geojson"


def fetch_workshop_polygons(force=False):
    """Download (cached) the Workshop Areas layer as a GeoDataFrame in WGS-84.

    Only 8-9 features — no pagination needed, but the request still goes
    through outSR=4326&f=geojson like the TAZ fetch for consistency.
    """
    if not force and WORKSHOP_POLYGONS_CACHE.exists() and WORKSHOP_POLYGONS_CACHE.stat().st_size > 0:
        return gpd.read_file(WORKSHOP_POLYGONS_CACHE)

    params = {
        "where": "1=1",
        "outFields": WORKSHOP_OUT_FIELDS,
        "outSR": 4326,
        "f": "geojson",
    }
    r = requests.get(WORKSHOP_SERVICE_URL, params=params, timeout=60)
    r.raise_for_status()
    geojson = r.json()

    gdf = gpd.GeoDataFrame.from_features(geojson["features"], crs="EPSG:4326")
    before = len(gdf)
    gdf = gdf[gdf["Shape__Area"] >= AREA_MIN_M2].reset_index(drop=True)
    dropped = before - len(gdf)
    if dropped:
        print(f"  Dropped {dropped} degenerate/sliver workshop-area feature(s) (Shape__Area < {AREA_MIN_M2} m²)")

    CACHE_DIR.mkdir(exist_ok=True)
    gdf.to_file(WORKSHOP_POLYGONS_CACHE, driver="GeoJSON")
    print(f"  Cached {len(gdf)} workshop area polygons -> {WORKSHOP_POLYGONS_CACHE.name}")
    return gdf


def build_workshop_lookup(xwalk_df: pd.DataFrame) -> dict:
    """Return {block_fips: workshop_name} for blocks that fall inside a
    workshop area (most of the state won't match — this geography only
    covers the Wasatch Front). Spatial join via geopandas.sjoin.
    """
    workshop_gdf = fetch_workshop_polygons()

    valid = xwalk_df["blklatdd"].notna() & xwalk_df["blklondd"].notna()
    blocks_gdf = gpd.GeoDataFrame(
        xwalk_df.loc[valid, ["tabblk2020"]].copy(),
        geometry=[Point(lon, lat) for lat, lon in
                  zip(xwalk_df.loc[valid, "blklatdd"], xwalk_df.loc[valid, "blklondd"])],
        crs="EPSG:4326",
    )

    joined = gpd.sjoin(blocks_gdf, workshop_gdf[["BoundaryName", "geometry"]], how="left", predicate="within")
    joined = joined[~joined.index.duplicated(keep="first")]

    lookup = {
        row.tabblk2020: row.BoundaryName
        for row in joined.itertuples(index=False)
        if pd.notna(row.BoundaryName)
    }
    print(f"  Matched {len(lookup):,}/{len(blocks_gdf):,} blocks to a workshop area "
          f"(remainder are outside the Wasatch Front workshop coverage — expected)")
    return lookup


def generate_workshop_boundaries(force=False):
    """Write data/workshop_boundaries.geojson. Skips if it already exists
    unless force=True (matches generate_boundaries()/generate_planning_boundaries())."""
    if not force and WORKSHOP_BOUNDARIES_OUT.exists():
        print("  Workshop boundary file already exists, skipping.")
        return

    gdf = fetch_workshop_polygons()[["BoundaryName", "geometry"]].rename(columns={"BoundaryName": "name"})
    gdf = gdf.to_crs(epsg=26912)
    gdf = topo_simplify(gdf, tolerance=50)
    gdf = gdf.to_crs(epsg=4326)
    gdf.to_file(WORKSHOP_BOUNDARIES_OUT, driver="GeoJSON")
    print(f"  Wrote {WORKSHOP_BOUNDARIES_OUT.name} ({len(gdf)} workshop area polygons)")


def build_workshop_meta() -> list:
    """Build metadata list [{name, lat, lon}] for the workshop areas."""
    gdf = fetch_workshop_polygons()
    meta = []
    for _, row in gdf.iterrows():
        pt = row.geometry.representative_point()
        meta.append({"name": row["BoundaryName"], "lat": float(pt.y), "lon": float(pt.x)})
    return sorted(meta, key=lambda x: x["name"])


if __name__ == "__main__":
    gdf = fetch_workshop_polygons(force=True)
    print(f"\n{len(gdf)} workshop areas:")
    for name in sorted(gdf["BoundaryName"]):
        print(" ", name)
