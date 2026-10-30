# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "pandas>=2.0",
#   "geopandas>=0.14",
#   "shapely>=2.0",
# ]
# ///
"""
Verify LEHD OD coverage for all custom places in custom_places_config.json ("add")
and data/custom_places.gpkg. Reads the RAW crosswalk, so it also shows which Census
places a polygon currently overlaps (useful when choosing a "remove" list).

For each custom place, reports:
  - How many Census blocks fall within its boundary
  - How many unique OD work-location records exist in LEHD for those blocks
  - Total S000 job count
  - What Census place name those blocks currently map to (e.g. CDP name or unincorporated)

Run with:
    uv run scripts/verify_custom_places.py
    uv run scripts/verify_custom_places.py --year 2022
"""

import sys
import argparse
from pathlib import Path

import pandas as pd
import geopandas as gpd
from shapely.geometry import Point

import custom_places

DATA_DIR  = Path(__file__).parent.parent / "data"
CACHE_DIR = DATA_DIR / "cache"
CUSTOM_FILE = DATA_DIR / "custom_places.gpkg"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--year", type=int, default=2023)
    args = parser.parse_args()

    print(f"=== Custom Place LEHD Coverage Verification (year={args.year}) ===\n")

    # Load custom boundaries
    # All places from custom_places_config.json "add" (incl. UGRC-sourced) plus gpkg-only ones.
    custom_gdf = custom_places.load_places()
    print(f"Custom places found: {list(custom_gdf['name'])}\n")

    # Load crosswalk with lat/lon
    xwalk_path = CACHE_DIR / "ut_xwalk.csv.gz"
    if not xwalk_path.exists():
        sys.exit(f"ERROR: Crosswalk not cached at {xwalk_path}. Run process_data.py first.")
    print("Loading crosswalk...")
    xw = pd.read_csv(
        xwalk_path,
        dtype={"tabblk2020": str, "stplc": str, "cty": str},
        usecols=["tabblk2020", "stplcname", "cty", "blklatdd", "blklondd"],
    )
    print(f"  {len(xw):,} crosswalk rows\n")

    # Build block GeoDataFrame
    blocks_gdf = gpd.GeoDataFrame(
        xw,
        geometry=[Point(lon, lat) for lat, lon in zip(xw["blklatdd"], xw["blklondd"])],
        crs="EPSG:4326",
    )

    # Load OD data
    od_path = CACHE_DIR / f"ut_od_main_JT00_{args.year}.csv.gz"
    if not od_path.exists():
        sys.exit(f"ERROR: OD data not cached at {od_path}. Run process_data.py first.")
    print(f"Loading OD data for {args.year}...")
    od = pd.read_csv(od_path, dtype={"w_geocode": str, "h_geocode": str},
                     usecols=["w_geocode", "h_geocode", "S000"])
    print(f"  {len(od):,} OD records statewide\n")

    # Per-place report
    for _, place in custom_gdf.iterrows():
        name = place["name"]
        print(f"--- {name} ---")

        within_mask = blocks_gdf.within(place.geometry)
        place_blocks = set(blocks_gdf.loc[within_mask, "tabblk2020"])
        print(f"  Census blocks within boundary: {len(place_blocks)}")

        if not place_blocks:
            print("  WARNING: No blocks matched — check boundary CRS or geometry.\n")
            continue

        # Current Census place attribution for these blocks
        block_info = xw[xw["tabblk2020"].isin(place_blocks)]
        name_counts = block_info["stplcname"].value_counts(dropna=False)
        print(f"  Current Census place attribution:")
        for pname, cnt in name_counts.items():
            label = pname if pd.notna(pname) else "(unincorporated)"
            print(f"    {label}: {cnt} blocks")

        # LEHD work-location coverage
        od_work = od[od["w_geocode"].isin(place_blocks)]
        print(f"  LEHD work records: {len(od_work):,} OD pairs")
        print(f"  Total S000 jobs (work destination): {od_work['S000'].sum():,}")
        print(f"  Unique home blocks commuting here:  {od_work['h_geocode'].nunique():,}")

        # LEHD home-location coverage (how many residents on-site)
        od_home = od[od["h_geocode"].isin(place_blocks)]
        print(f"  LEHD home records: {len(od_home):,} OD pairs")
        print(f"  Total S000 jobs (home origin):      {od_home['S000'].sum():,}")
        print()


if __name__ == "__main__":
    main()
