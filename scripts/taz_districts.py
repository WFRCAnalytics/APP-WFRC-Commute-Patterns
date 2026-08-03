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
TAZ Planning Boundaries — modular extension providing the Small/Medium/Large/
Super District geography ("Planning Boundaries" mode), derived from the Utah
Statewide Travel Model (USTM) TAZ shapefile.

Source: USTM_TAZ_2021_09_22 ArcGIS FeatureServer (statewide, 9,815 TAZ
polygons; live-verified county coverage matches process_data.UTAH_COUNTIES
exactly via CO_FIPS). Each TAZ polygon is pre-tagged with all four nested
district levels as attributes, so a single spatial join (LEHD block centroid
-> TAZ polygon) resolves a block's Small/Medium/Large/Super District in one
pass — no separate TAZ-to-district attribute lookup is needed.

IMPORTANT — neither the numeric code (DSML/DISTMED/DISTLRG) nor the name
field is a reliable statewide-unique key on its own for Small/Medium/Large:
codes are only locally scoped (the same code number is reused for unrelated
areas in different counties), and a handful of names are independently
reused across different codes (usually two disconnected pieces of the same
rural area, e.g. "Helper Area" appears under two different DSML codes in
Carbon County). The (code, name) *pair* is the true unique key. See
_add_display_names() for how this is resolved into a single unique display
name per real district (mirrors the disambiguation `_detect_name_collisions`
already does for Census place names in process_data.py).

Treated as a static, versionless geography — fetched once and cached under
data/cache/. Re-run with force=True (or delete the cache files) if WFRC
supplies an updated shapefile; there is no year-awareness.

Functions consumed by process_data.py:

  build_taz_lookup(xwalk_df)        -> dict[block_fips -> {level_name: str|None}]
  generate_planning_boundaries()    -> writes data/{level}_boundaries.geojson
  build_planning_meta(level)        -> list[{name, lat, lon}]
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

TAZ_SERVICE_URL = (
    "https://services.arcgis.com/pA2nEVnB6tquxgOW/ArcGIS/rest/services/"
    "USTM_TAZ_2021_09_22/FeatureServer/0/query"
)
TAZ_OUT_FIELDS = "TAZID,CO_FIPS,DSML,DSML_NAME,DISTMED,DMED_NAME,DISTLRG,DLRG_NAME,DISTSUPER,DSUP_NAME"
TAZ_PAGE_SIZE = 2000

TAZ_POLYGONS_CACHE     = CACHE_DIR / "taz_polygons.geojson"
TAZ_BLOCK_LOOKUP_CACHE = CACHE_DIR / "taz_block_lookup.json"

# Planning-district levels: internal key -> (TAZ code field, TAZ raw name field)
LEVELS = {
    "small":  ("DSML",      "DSML_NAME"),
    "medium": ("DISTMED",   "DMED_NAME"),
    "large":  ("DISTLRG",   "DLRG_NAME"),
    "super":  ("DISTSUPER", "DSUP_NAME"),
}


def fetch_taz_polygons(force=False):
    """Download (cached) the full USTM TAZ layer as a GeoDataFrame in WGS-84.

    Paginates the ArcGIS FeatureServer query endpoint (maxRecordCount=2000)
    until an empty page is returned, merges all pages, and caches the merged
    FeatureCollection to data/cache/taz_polygons.geojson.
    """
    if not force and TAZ_POLYGONS_CACHE.exists() and TAZ_POLYGONS_CACHE.stat().st_size > 0:
        print(f"  Using cached {TAZ_POLYGONS_CACHE.name}")
        return gpd.read_file(TAZ_POLYGONS_CACHE)

    print("  Fetching USTM TAZ polygons (paginated)...")
    features = []
    offset = 0
    while True:
        params = {
            "where": "1=1",
            "outFields": TAZ_OUT_FIELDS,
            "outSR": 4326,
            "f": "geojson",
            "resultOffset": offset,
            "resultRecordCount": TAZ_PAGE_SIZE,
        }
        r = requests.get(TAZ_SERVICE_URL, params=params, timeout=120)
        r.raise_for_status()
        page_features = r.json().get("features", [])
        if not page_features:
            break
        features.extend(page_features)
        print(f"    ...{len(features):,} features fetched")
        offset += TAZ_PAGE_SIZE

    geojson = {"type": "FeatureCollection", "features": features}
    CACHE_DIR.mkdir(exist_ok=True)
    TAZ_POLYGONS_CACHE.write_text(json.dumps(geojson))
    print(f"  Cached {len(features):,} TAZ polygons -> {TAZ_POLYGONS_CACHE.name}")

    return gpd.read_file(TAZ_POLYGONS_CACHE)


def _add_display_names(taz_gdf):
    """Add a disambiguated `{level}_disp` column per level to the TAZ GeoDataFrame.

    The (code, name) pair is the true unique key for a real district (see
    module docstring). This collapses that pair into a single display string
    that is unique on its own: the raw name, unless that name is shared by
    more than one distinct code, in which case the code is appended
    (e.g. two disconnected pieces of "Helper Area" in Carbon County become
    "Helper Area (238)" / "Helper Area (243)").
    """
    gdf = taz_gdf.copy()
    for level, (code_col, name_col) in LEVELS.items():
        pairs = gdf[[code_col, name_col]].drop_duplicates()
        dup_names = set(pairs[name_col][pairs[name_col].duplicated(keep=False)])
        if dup_names:
            gdf[f"{level}_disp"] = gdf.apply(
                lambda r, name_col=name_col, code_col=code_col: (
                    f"{r[name_col]} ({r[code_col]})" if r[name_col] in dup_names else r[name_col]
                ),
                axis=1,
            )
        else:
            gdf[f"{level}_disp"] = gdf[name_col]
    return gdf


def _taz_gdf_with_display_names():
    return _add_display_names(fetch_taz_polygons())


def _lookup_cache_valid():
    """Lookup cache covers all block geometries; invalidate only when the
    source TAZ polygons change (mirrors custom_places._cache_valid())."""
    if not TAZ_BLOCK_LOOKUP_CACHE.exists() or not TAZ_POLYGONS_CACHE.exists():
        return False
    return TAZ_POLYGONS_CACHE.stat().st_mtime <= TAZ_BLOCK_LOOKUP_CACHE.stat().st_mtime


def build_taz_lookup(xwalk_df: pd.DataFrame) -> dict:
    """Return {block_fips: {"small_name":..., "medium_name":..., "large_name":..., "super_name":...}}.

    Spatial-joins LEHD block centroids (blklatdd/blklondd) against the TAZ
    polygons via geopandas.sjoin — a vectorized, spatial-index join. This is
    deliberately NOT the per-polygon `.within()` loop custom_places.py uses;
    that loop only scales to a handful of custom places, not 9,815 TAZs.
    Uses the disambiguated display names (see _add_display_names) so the
    names stored here exactly match boundaries/meta.
    """
    if _lookup_cache_valid():
        print("  Using cached TAZ block lookup.")
        return json.loads(TAZ_BLOCK_LOOKUP_CACHE.read_text())

    print("  Building block -> TAZ planning-district lookup (spatial join)...")

    if "blklatdd" not in xwalk_df.columns or "blklondd" not in xwalk_df.columns:
        raise ValueError(
            "LEHD crosswalk is missing blklatdd/blklondd columns — "
            "cannot run spatial join for TAZ planning districts."
        )

    taz_gdf = _taz_gdf_with_display_names()

    valid = xwalk_df["blklatdd"].notna() & xwalk_df["blklondd"].notna()
    blocks_gdf = gpd.GeoDataFrame(
        xwalk_df.loc[valid, ["tabblk2020"]].copy(),
        geometry=[Point(lon, lat) for lat, lon in
                  zip(xwalk_df.loc[valid, "blklatdd"], xwalk_df.loc[valid, "blklondd"])],
        crs="EPSG:4326",
    )

    disp_cols = [f"{level}_disp" for level in LEVELS]
    joined = gpd.sjoin(blocks_gdf, taz_gdf[disp_cols + ["geometry"]], how="left", predicate="within")
    # A block centroid that lands exactly on a shared TAZ edge can match more
    # than one polygon; keep one match per block.
    joined = joined[~joined.index.duplicated(keep="first")]

    lookup = {}
    unmatched = 0
    for row in joined.itertuples(index=False):
        entry = {}
        for level in LEVELS:
            val = getattr(row, f"{level}_disp")
            entry[f"{level}_name"] = val if pd.notna(val) else None
        if entry["small_name"] is None:
            unmatched += 1
        lookup[row.tabblk2020] = entry

    print(f"  Matched {len(lookup) - unmatched:,}/{len(lookup):,} blocks to a TAZ polygon "
          f"({unmatched:,} unmatched)")

    CACHE_DIR.mkdir(exist_ok=True)
    TAZ_BLOCK_LOOKUP_CACHE.write_text(json.dumps(lookup))
    print(f"  Cached TAZ block lookup -> {TAZ_BLOCK_LOOKUP_CACHE.name}")

    return lookup


def generate_planning_boundaries(force=False):
    """Generate static boundary GeoJSON files for all four planning-district levels.

    Writes data/{small,medium,large,super}_boundaries.geojson. Skips if all
    four files already exist unless force=True.
    """
    out_paths = {level: DATA_DIR / f"{level}_boundaries.geojson" for level in LEVELS}

    if not force and all(p.exists() for p in out_paths.values()):
        print("  Planning boundary files already exist, skipping.")
        return

    taz_gdf  = _taz_gdf_with_display_names()
    taz_proj = taz_gdf.to_crs(epsg=26912)

    for level in LEVELS:
        disp_col = f"{level}_disp"
        dissolved = taz_proj[[disp_col, "geometry"]].dissolve(by=disp_col, as_index=False)
        dissolved = dissolved.rename(columns={disp_col: "name"})
        dissolved = topo_simplify(dissolved, tolerance=100)
        dissolved = dissolved.to_crs(epsg=4326)
        dissolved.to_file(out_paths[level], driver="GeoJSON")
        print(f"  Wrote {out_paths[level].name} ({len(dissolved)} {level} district polygons)")


def build_planning_meta(level: str) -> list:
    """Build metadata list [{name, lat, lon}] for one planning-district level.

    lat/lon come from representative_point() on the dissolved polygon —
    guaranteed to fall inside the shape, unlike geometry.centroid for
    irregular/multi-part polygons (same rationale as TIGER's INTPTLAT/LON
    used elsewhere in this pipeline).
    """
    disp_col  = f"{level}_disp"
    taz_gdf   = _taz_gdf_with_display_names()
    dissolved = taz_gdf[[disp_col, "geometry"]].dissolve(by=disp_col, as_index=False)

    meta = []
    for _, row in dissolved.iterrows():
        pt = row.geometry.representative_point()
        meta.append({
            "name": row[disp_col],
            "lat":  float(pt.y),
            "lon":  float(pt.x),
        })
    return sorted(meta, key=lambda x: x["name"])


if __name__ == "__main__":
    # Standalone verification — run directly (`uv run scripts/taz_districts.py`)
    # before wiring this module into process_data.py.
    xwalk_cache = CACHE_DIR / "ut_xwalk.csv.gz"
    if not xwalk_cache.exists():
        print("Downloading LEHD crosswalk for standalone verification...")
        CACHE_DIR.mkdir(exist_ok=True)
        r = requests.get(
            "https://lehd.ces.census.gov/data/lodes/LODES8/ut/ut_xwalk.csv.gz",
            stream=True, timeout=300,
        )
        r.raise_for_status()
        with open(xwalk_cache, "wb") as f:
            for chunk in r.iter_content(chunk_size=65536):
                f.write(chunk)

    xw = pd.read_csv(
        xwalk_cache,
        dtype={"tabblk2020": str, "stplc": str, "stplcname": str},
        usecols=["tabblk2020", "stplc", "stplcname", "blklatdd", "blklondd"],
    )

    lookup = build_taz_lookup(xw)

    print("\n=== Distinct display-name counts per level (ground truth via (code,name) pairs) ===")
    for level in LEVELS:
        names = {v[f"{level}_name"] for v in lookup.values() if v[f"{level}_name"] is not None}
        print(f"  {level:7s}: {len(names)} distinct display names")

    print("\n=== Spot check: Salt Lake City blocks ===")
    slc_blocks = xw.loc[xw["stplcname"].fillna("").str.startswith("Salt Lake City"), "tabblk2020"]
    slc_entries = [lookup[b] for b in slc_blocks if b in lookup and lookup[b]["small_name"]]
    if slc_entries:
        sample = slc_entries[0]
        print(f"  Sample block resolves to: {sample}")
        for level in LEVELS:
            names = {e[f"{level}_name"] for e in slc_entries}
            print(f"  {level:7s} names seen among SLC blocks: {sorted(names)[:5]}"
                  f"{' ...' if len(names) > 5 else ''}")
    else:
        print("  WARNING: no matched Salt Lake City blocks found.")
