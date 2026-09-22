"""
wasatch_front_summary.py
Aggregate commute statistics for the Wasatch Front region (WFRC MPO + MAG MPO).

Geography
---------
WF boundary = dissolved WFRC MPO + MAG MPO polygons fetched from ArcGIS FeatureServer.

  Question (i)  — city_flows filtered to cities whose centroid falls inside the WF
                  polygon.  Unincorporated residents are excluded (intentionally: the
                  metric asks about commuting *outside the city you live in*).

  Questions (ii–iv) — distance via city_flows dist_wsum (default) or via raw LODES
                  block-level OD with block centroid spatial filter (--with-blocks).
                  Time via ACS county-level B08303 bins for counties that overlap WF.

Statistics
----------
out_of_city_n/pct   Workers living in a WF incorporated city who commute to a
                    different city (or to an unincorporated / out-of-state destination).
total_commute_dist  Σ(workers × one-way miles).  Exact from dist_wsum (city mode) or
                    haversine per block pair (block mode).
avg_commute_dist    total_dist / dist_n.
total_commute_time  Σ(ACS count × bin midpoint minutes) across WF counties.
avg_commute_time    total_time / total_acs_workers.

Binned-data estimation (ACS time only)
---------------------------------------
Bins lt10…t45_59 use midpoints 5, 14.5, 24.5, 37, 52 minutes.
t60plus uses a Pareto tail fit:
  α = log(N_≥45 / N_≥60) / log(60/45)
  E[T | T≥60] = 60·α/(α−1),  capped at 120 min if estimate is degenerate.

Usage
-----
  python wasatch_front_summary.py                    # latest LEHD year
  python wasatch_front_summary.py --year 2019
  python wasatch_front_summary.py --all-years
  python wasatch_front_summary.py --all-years --with-blocks
"""

import argparse
import json
import math
import time as _time
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow.parquet as pq
import requests
from shapely.geometry import shape, Point
from shapely.ops import unary_union

HERE      = Path(__file__).resolve().parent
ROOT      = HERE.parent.parent
LEHD_DIR  = ROOT / "data" / "lehd"
ACS_DIR   = ROOT / "data" / "acs"
CACHE_DIR = ROOT / "data" / "cache"
OUT_DIR   = HERE / "wasatch_front_summary"

ARCGIS_URL = (
    "https://services1.arcgis.com/taguadKoI1XFwivx/ArcGIS/rest/services"
    "/RegionalBoundaryComponents/FeatureServer/0/query"
)
WF_PLAN_ORGS   = ("WFRC MPO", "MAG MPO")
WF_COUNTY_FIPS = {"49003", "49011", "49035", "49049", "49057"}  # Box Elder, Davis, Salt Lake, Utah, Weber


# ── helpers ────────────────────────────────────────────────────────────────────

def _available_years() -> list[int]:
    return sorted(int(p.name) for p in LEHD_DIR.iterdir() if p.is_dir() and p.name.isdigit())


def pct(num, den, decimals=1):
    return round(num / den * 100, decimals) if den else None


# ── WF boundary ────────────────────────────────────────────────────────────────

def fetch_wf_boundary():
    """Fetch WFRC MPO + MAG MPO polygons from ArcGIS, dissolve to single geometry."""
    where = " OR ".join(f"PlanOrg='{org}'" for org in WF_PLAN_ORGS)
    geoms = []
    offset = 0
    while True:
        params = {
            "where": where,
            "outFields": "PlanOrg",
            "outSR": "4326",
            "f": "geojson",
            "resultOffset": offset,
            "resultRecordCount": 1000,
        }
        r = requests.get(ARCGIS_URL, params=params, timeout=30)
        r.raise_for_status()
        fc = r.json()
        features = fc.get("features", [])
        for feat in features:
            g = feat.get("geometry")
            if g:
                geoms.append(shape(g))
        if not fc.get("properties", {}).get("exceededTransferLimit"):
            break
        offset += len(features)
        _time.sleep(0.25)

    if not geoms:
        raise RuntimeError("No WF boundary features returned from ArcGIS.")
    dissolved = unary_union(geoms)
    print(f"  Fetched {len(geoms)} boundary polygons -> dissolved to {dissolved.geom_type}")
    return dissolved


# ── geography selection ────────────────────────────────────────────────────────

def wf_city_list(year: int, boundary) -> tuple[list[str], list[str]]:
    """
    Returns (city_names, county_fips_list) where each city's centroid is inside
    the WF boundary polygon.
    """
    with open(LEHD_DIR / str(year) / "city_meta.json") as f:
        meta = json.load(f)
    cities, fips_set = [], set()
    for city in meta:
        lat, lon = city.get("lat"), city.get("lon")
        if lat is None or lon is None:
            continue
        if city.get("county_fips") in WF_COUNTY_FIPS and boundary.contains(Point(lon, lat)):
            cities.append(city["name"])
            fips_set.add(city["county_fips"])
    return cities, sorted(fips_set)


# ── ACS time statistics ────────────────────────────────────────────────────────

_ACS_BINS = [
    ("lt10",   5.0),
    ("t10_19", 14.5),
    ("t20_29", 24.5),
    ("t30_44", 37.0),
    ("t45_59", 52.0),
]

def _pareto_tail_mean(n_prev_bin: float, n_tail: float,
                      x_prev: float, x_tail: float, cap: float) -> float:
    """
    Estimate the mean of the open-ended tail bin [x_tail, ∞) using a Pareto fit.

    Uses the ratio of survival-function values at x_prev and x_tail:
      P(X ≥ x_tail) / P(X ≥ x_prev) = (x_tail / x_prev)^(−α)
    Solving for α, then E[X | X ≥ x_tail] = x_tail · α / (α − 1).
    """
    n_at_prev = n_prev_bin + n_tail   # workers with value ≥ x_prev
    n_at_tail = n_tail                # workers with value ≥ x_tail
    fallback   = min(x_tail + (x_tail - x_prev), cap)

    if n_at_prev <= n_at_tail or n_at_tail <= 0:
        return fallback
    alpha = math.log(n_at_prev / n_at_tail) / math.log(x_tail / x_prev)
    if alpha <= 1:
        return fallback
    return min(x_tail * alpha / (alpha - 1), cap)


def acs_time_stats(year: int, county_fips: list[str]) -> dict:
    """
    Returns dict with total_workers, total_time_min, avg_time_min, t60plus_est_min.
    All values are None when ACS data is unavailable for the year.
    """
    path = ACS_DIR / str(year) / "acs_county.json"
    if not path.exists():
        return dict(acs_workers=None, total_commute_time_min=None,
                    avg_commute_time_min=None, t60plus_est_min=None)

    with open(path) as f:
        acs = json.load(f)

    total_workers = 0
    total_minutes = 0.0
    t60_ests = []

    for fips in county_fips:
        time_d = acs.get(fips, {}).get("res", {}).get("time", {})
        if not time_d:
            continue
        n45_59  = time_d.get("t45_59",  0)
        n60plus = time_d.get("t60plus", 0)
        t60_mid = _pareto_tail_mean(n45_59, n60plus, x_prev=45.0, x_tail=60.0, cap=120.0)
        t60_ests.append(t60_mid)

        for key, mid in _ACS_BINS:
            n = time_d.get(key, 0)
            total_workers += n
            total_minutes += n * mid
        total_workers += n60plus
        total_minutes += n60plus * t60_mid

    if total_workers == 0:
        return dict(acs_workers=None, total_commute_time_min=None,
                    avg_commute_time_min=None, t60plus_est_min=None)

    avg_t60 = round(sum(t60_ests) / len(t60_ests), 1) if t60_ests else None
    return dict(
        acs_workers          = total_workers,
        total_commute_time_min = round(total_minutes),
        avg_commute_time_min   = round(total_minutes / total_workers, 1),
        t60plus_est_min        = avg_t60,
    )


# ── distance statistics (city_flows) ──────────────────────────────────────────

def dist_stats_city(year: int, wf_cities: list[str]) -> dict:
    """
    Exact distance from precomputed dist_wsum / dist_n in city_flows.
    Covers incorporated WF city residents only.
    """
    df  = pq.read_table(LEHD_DIR / str(year) / "city_flows.parquet").to_pandas()
    res = df[df["home_name"].isin(set(wf_cities))]
    total_dist = float(res["dist_wsum"].sum())
    dist_n_val = int(res["dist_n"].sum())
    avg_dist   = round(total_dist / dist_n_val, 2) if dist_n_val > 0 else None
    return dict(
        total_commute_dist_mi = round(total_dist, 1),
        dist_n                = dist_n_val,
        avg_commute_dist_mi   = avg_dist,
        dist_source           = "city_flows",
    )


# ── distance statistics (block-level, --with-blocks) ──────────────────────────

def _load_xwalk_coords() -> tuple[dict, dict, dict]:
    """
    Returns (lat_map, lon_map, county_map) for ALL Utah blocks with valid coordinates.
    All Utah blocks are loaded so work destinations outside the WF counties are not
    skipped when computing distances — the county filter applies to the home side only.
    """
    path = CACHE_DIR / "ut_xwalk.csv.gz"
    if not path.exists():
        raise FileNotFoundError(
            f"Xwalk not cached at {path}. Run scripts/process_data.py first."
        )
    print("  Loading block centroids from xwalk...")
    xw = pd.read_csv(
        path, dtype={"tabblk2020": str, "cty": str},
        usecols=["tabblk2020", "cty", "blklatdd", "blklondd"],
        compression="gzip",
    )
    xw         = xw.dropna(subset=["blklatdd", "blklondd"])
    lat_map    = dict(zip(xw["tabblk2020"], xw["blklatdd"]))
    lon_map    = dict(zip(xw["tabblk2020"], xw["blklondd"]))
    county_map = dict(zip(xw["tabblk2020"], xw["cty"]))
    print(f"  {len(lat_map):,} blocks with coordinates")
    return lat_map, lon_map, county_map


def _wf_block_set(lat_map: dict, lon_map: dict, county_map: dict, boundary) -> set:
    """
    Return home block FIPS that are within the WF boundary AND in the 5 WF counties.
    Pre-filtering to WF counties before the spatial test limits the polygon work to
    ~34k candidates instead of ~71k.
    """
    import shapely
    candidates = [b for b, c in county_map.items() if c in WF_COUNTY_FIPS]
    block_ids  = np.array(candidates)
    lats = np.array([lat_map[b] for b in block_ids])
    lons = np.array([lon_map[b] for b in block_ids])
    pts  = shapely.points(lons, lats)
    mask = shapely.contains(boundary, pts)
    wf_blocks = set(block_ids[mask])
    print(f"  {len(wf_blocks):,} home blocks within WF boundary")
    return wf_blocks


def _haversine_miles(lat1, lon1, lat2, lon2):
    """Vectorized haversine distance in miles."""
    R   = 3958.8
    φ1, φ2 = np.radians(lat1), np.radians(lat2)
    dφ  = φ2 - φ1
    dλ  = np.radians(lon2 - lon1)
    a   = np.sin(dφ / 2) ** 2 + np.cos(φ1) * np.cos(φ2) * np.sin(dλ / 2) ** 2
    return R * 2 * np.arctan2(np.sqrt(a), np.sqrt(1.0 - a))


def dist_stats_blocks(year: int, boundary) -> dict:
    """
    Distance stats from raw LODES OD filtered by home-block centroid.
    Covers all WF residents including unincorporated.
    Out-of-state work destinations are excluded (xwalk covers Utah only).
    """
    lat_map, lon_map, county_map = _load_xwalk_coords()
    wf_blocks = _wf_block_set(lat_map, lon_map, county_map, boundary)

    od_path = CACHE_DIR / f"ut_od_main_JT00_{year}.csv.gz"
    if not od_path.exists():
        raise FileNotFoundError(f"OD file not cached: {od_path}")
    print(f"  Loading {od_path.name}...")
    od = pd.read_csv(
        od_path,
        dtype={"w_geocode": str, "h_geocode": str},
        usecols=["w_geocode", "h_geocode", "S000"],
        compression="gzip",
    )

    od = od[od["h_geocode"].isin(wf_blocks)].copy()
    total_wf_workers = int(od["S000"].sum())
    print(f"  {len(od):,} OD pairs, {total_wf_workers:,} WF resident workers")

    od["h_lat"] = od["h_geocode"].map(lat_map)
    od["h_lon"] = od["h_geocode"].map(lon_map)
    od["w_lat"] = od["w_geocode"].map(lat_map)
    od["w_lon"] = od["w_geocode"].map(lon_map)

    valid   = od.dropna(subset=["h_lat", "h_lon", "w_lat", "w_lon"])
    skipped = total_wf_workers - int(valid["S000"].sum())
    if skipped > 0:
        print(f"  Skipping {skipped:,} workers with no work coordinates (out-of-state)")

    if valid.empty:
        return dict(total_commute_dist_mi=None, dist_n=None,
                    avg_commute_dist_mi=None, dist_source="block_centroid")

    dist       = _haversine_miles(valid["h_lat"].values, valid["h_lon"].values,
                                  valid["w_lat"].values, valid["w_lon"].values)
    total_dist = float((dist * valid["S000"].values).sum())
    dist_n_val = int(valid["S000"].sum())
    avg_dist   = round(total_dist / dist_n_val, 2) if dist_n_val > 0 else None
    return dict(
        total_commute_dist_mi = round(total_dist, 1),
        dist_n                = dist_n_val,
        avg_commute_dist_mi   = avg_dist,
        dist_source           = "block_centroid",
    )


# ── out-of-city metric ─────────────────────────────────────────────────────────

def out_of_city_stats(year: int, wf_cities: list[str]) -> dict:
    df        = pq.read_table(LEHD_DIR / str(year) / "city_flows.parquet").to_pandas()
    res       = df[df["home_name"].isin(set(wf_cities))]
    total     = int(res["S000"].sum())
    self_flow = int(res[res["home_name"] == res["work_name"]]["S000"].sum())
    out_n     = total - self_flow
    return dict(
        city_resident_workers = total,
        out_of_city_n         = out_n,
        out_of_city_pct       = pct(out_n, total),
    )


# ── build one row ──────────────────────────────────────────────────────────────

def build_row(year: int, boundary, with_blocks: bool) -> dict:
    print(f"\n-- {year} --")
    cities, county_fips = wf_city_list(year, boundary)
    print(f"  {len(cities)} WF cities across {len(county_fips)} counties")

    row = {
        "year":            year,
        "wf_city_count":   len(cities),
        "wf_county_fips":  "|".join(county_fips),
    }
    row.update(out_of_city_stats(year, cities))
    row.update(dist_stats_blocks(year, boundary) if with_blocks
               else dist_stats_city(year, cities))
    row.update(acs_time_stats(year, county_fips))
    return row


def _save(row: dict, year: int) -> Path:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out = OUT_DIR / f"{year}.csv"
    pd.DataFrame([row]).to_csv(out, index=False)
    return out


def _write_combined() -> Path:
    """Read all per-year CSVs and write a single all_years.csv sorted by year."""
    parts = sorted(OUT_DIR.glob("[0-9][0-9][0-9][0-9].csv"))
    if not parts:
        return None
    combined = pd.concat([pd.read_csv(p) for p in parts]).sort_values("year")
    out = OUT_DIR / "all_years.csv"
    combined.to_csv(out, index=False)
    return out


# ── entry point ────────────────────────────────────────────────────────────────

def main():
    lehd_years = _available_years()
    default    = max(lehd_years) if lehd_years else 2022

    ap = argparse.ArgumentParser(
        description="Generate Wasatch Front commute summary statistics."
    )
    ap.add_argument(
        "--year", type=int, default=default,
        help=f"Data year to process (default: {default}; available: {lehd_years})",
    )
    ap.add_argument(
        "--all-years", action="store_true",
        help="Run for every available LEHD year and write one CSV per year.",
    )
    ap.add_argument(
        "--with-blocks", action="store_true",
        help=(
            "Use raw LODES block-level OD for distance stats (slower). "
            "Includes unincorporated WF residents; excludes out-of-state work destinations."
        ),
    )
    ap.add_argument(
        "--combine-only", action="store_true",
        help="Skip processing; just rebuild all_years.csv from existing per-year CSVs.",
    )
    args = ap.parse_args()

    if args.combine_only:
        combined = _write_combined()
        print(f"Combined -> {combined}")
        return

    years = lehd_years if args.all_years else [args.year]

    print("Fetching Wasatch Front boundary from ArcGIS...")
    boundary = fetch_wf_boundary()

    for year in years:
        row = build_row(year, boundary, args.with_blocks)
        out = _save(row, year)
        print(f"  Saved -> {out}")

    combined = _write_combined()
    if combined:
        print(f"\nCombined -> {combined}")


if __name__ == "__main__":
    main()
