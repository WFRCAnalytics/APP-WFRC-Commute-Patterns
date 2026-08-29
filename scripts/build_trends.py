"""
build_trends.py
Builds data/trends.json — a per-area historical time series (every year
found under data/lehd/) of three headline commute metrics, for every
selectable geography type in the app:

  out   Total workers who LIVE in the area (residents), any destination.
  in    Total workers who WORK in the area (jobs), any origin.
  self  Workers who both live AND work in the area.

These are exactly the three numbers src/db.js's queryTotal()/querySelfFlow()
already compute live, one year at a time, per selected area (and exactly
what map.js's setSelfFlow(selfCount, totalOut, totalIn) feeds the Commute
Balance panel's Overview/Venn tabs). This script runs that same
SUM(S000) GROUP BY aggregation across every already-generated year of
Parquet data at once, offline, so the frontend's "Trend" tab can plot 20+
years of history without shipping 20+ years of flow Parquet to the browser
(a single year's flow files alone run ~2.5-4.5 MB; this script's entire
output is on the order of a few hundred KB).

The frontend derives "net" in/out (out - self, in - self) itself, the same
subtraction _applyFilter() in src/main.js already does — so this script
stores the three raw totals rather than pre-subtracting, which also keeps
the door open for a future percent-of-total view without a schema change.

Source of truth for which Parquet file + column pair backs each geography
type: mirrors _COLS / _table(type, type) in src/db.js exactly. If that
mapping changes, update TYPE_SOURCES below to match.

Usage
-----
  uv run scripts/build_trends.py

Reads only already-generated data/lehd/{year}/*.parquet + *_meta.json --
no network access, no LODES re-download. Safe to re-run any time (e.g.
after adding a new year with process_data.py); always rebuilds the full
file from scratch, which is cheap (a few seconds).
"""

import json
from pathlib import Path

import pandas as pd
import pyarrow.parquet as pq

HERE     = Path(__file__).resolve().parent
ROOT     = HERE.parent
LEHD_DIR = ROOT / "data" / "lehd"
OUT_PATH = ROOT / "data" / "trends.json"

# area_type -> (flow parquet filename, meta json filename, home column, work column)
#
# Mirrors db.js: city/county are read from city_flows.parquet (the _table()
# default); house/senate/workshop/mag_workshop -- the "district" types --
# from district_flows.parquet; small/medium/large/super -- the "planning"
# types -- from planning_flows.parquet.
TYPE_SOURCES = {
    "city":         ("city_flows.parquet",     "city_meta.json",         "home_name",         "work_name"),
    "county":       ("city_flows.parquet",     "county_meta.json",       "home_county",       "work_county"),
    "house":        ("district_flows.parquet", "house_meta.json",        "home_house",        "work_house"),
    "senate":       ("district_flows.parquet", "senate_meta.json",       "home_senate",       "work_senate"),
    "workshop":     ("district_flows.parquet", "workshop_meta.json",     "home_workshop",     "work_workshop"),
    "mag_workshop": ("district_flows.parquet", "mag_workshop_meta.json", "home_mag_workshop", "work_mag_workshop"),
    "small":        ("planning_flows.parquet", "small_meta.json",        "home_small",        "work_small"),
    "medium":       ("planning_flows.parquet", "medium_meta.json",       "home_medium",       "work_medium"),
    "large":        ("planning_flows.parquet", "large_meta.json",        "home_large",        "work_large"),
    "super":        ("planning_flows.parquet", "super_meta.json",        "home_super",        "work_super"),
}


def _available_years() -> list[int]:
    return sorted(int(p.name) for p in LEHD_DIR.iterdir() if p.is_dir() and p.name.isdigit())


def _meta_names(year: int, meta_file: str) -> set[str]:
    """Area names selectable for this type in this year. Excludes 'Out of
    State', same as build_city_meta() in process_data.py -- it isn't a real
    subject area, just a bucket other areas' flows land in."""
    path = LEHD_DIR / str(year) / meta_file
    if not path.exists():
        return set()
    with open(path, encoding="utf-8") as f:
        entries = json.load(f)
    return {e["name"] for e in entries if e.get("name") and e["name"] != "Out of State"}


def _year_aggregates(year: int, parquet_file: str, home_col: str, work_col: str):
    """Return (total_out, total_in, self_flow) dicts -- area name -> summed
    S000 -- for one year's flow parquet. Empty dicts if the parquet or the
    requested columns are missing (e.g. a geography not yet backfilled for
    that year), so the caller can fall back to null for that (area, year)."""
    path = LEHD_DIR / str(year) / parquet_file
    if not path.exists():
        return {}, {}, {}
    schema_cols = set(pq.ParquetFile(path).schema.names)
    if home_col not in schema_cols or work_col not in schema_cols:
        return {}, {}, {}

    df = pd.read_parquet(path, columns=[home_col, work_col, "S000"])
    # groupby drops NaN keys by default -- exactly right here: NaN in
    # home_col/work_col means "outside this geography's coverage footprint"
    # (e.g. workshop/mag_workshop rows outside the Wasatch Front / Utah
    # County), not a real area, so those rows should vanish rather than
    # aggregate into a bogus catch-all group.
    total_out = df.groupby(home_col)["S000"].sum()
    total_in  = df.groupby(work_col)["S000"].sum()
    # NaN == NaN is False in pandas, so home/work pairs that are both
    # uncovered (both NaN) are correctly excluded from self-flow too.
    self_flow = df[df[home_col] == df[work_col]].groupby(home_col)["S000"].sum()

    return total_out.to_dict(), total_in.to_dict(), self_flow.to_dict()


def build_type_trend(area_type: str, years: list[int]) -> dict:
    parquet_file, meta_file, home_col, work_col = TYPE_SOURCES[area_type]

    # Union of every area ever selectable for this type, across all years --
    # so an area that only exists for part of the range (e.g. a newly
    # incorporated city) still gets a series (null-padded outside its
    # years) if a user selects it, rather than being silently dropped.
    all_areas = set()
    for year in years:
        all_areas |= _meta_names(year, meta_file)
    if not all_areas:
        return {}

    per_year = [_year_aggregates(y, parquet_file, home_col, work_col) for y in years]

    result = {}
    for area in sorted(all_areas):
        out_series, in_series, self_series = [], [], []
        for total_out, total_in, self_flow in per_year:
            existed = area in total_out or area in total_in
            if not existed:
                out_series.append(None)
                in_series.append(None)
                self_series.append(None)
            else:
                out_series.append(int(total_out.get(area, 0)))
                in_series.append(int(total_in.get(area, 0)))
                self_series.append(int(self_flow.get(area, 0)))
        result[area] = {"out": out_series, "in": in_series, "self": self_series}
    return result


def main():
    years = _available_years()
    if not years:
        raise SystemExit(f"No year data found under {LEHD_DIR}")

    print(f"Building trends for {len(years)} years ({years[0]}–{years[-1]})...")

    types = {}
    for area_type in TYPE_SOURCES:
        print(f"  {area_type}...")
        types[area_type] = build_type_trend(area_type, years)
        print(f"    {len(types[area_type])} areas")

    payload = {"years": years, "types": types}
    OUT_PATH.write_text(json.dumps(payload, separators=(",", ":")))
    size_kb = OUT_PATH.stat().st_size / 1024
    print(f"\nWrote {OUT_PATH.relative_to(ROOT)} ({size_kb:.1f} KB)")


if __name__ == "__main__":
    main()
