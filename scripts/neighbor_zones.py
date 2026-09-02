# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "pandas>=2.0",
#   "pyarrow>=14.0",
#   "geopandas>=0.14",
#   "requests>=2.31",
#   "shapely>=2.0",
# ]
# ///
"""
Neighboring-State Zone Integration for WFRC Commute Patterns.

Handles the full pipeline for counties and cities in the 6 states surrounding
Utah (ID, WY, CO, NM, AZ, NV):

  1. build_neighbor_zones()   — downloads + caches all counties and cities for
                                the 6 states from TIGER shapefiles.
  2. get_border_zone_set()    — spatial filter: counties that touch Utah's
                                boundary, plus all cities within those counties.
  3. resolve_neighbor_blocks() — looks up non-Utah LEHD block FIPSes in each
                                 state's LEHD crosswalk (downloaded+cached).
  4. process_neighbor_flows() — extracts cross-state OD pairs and aggregates to
                                (utah_zone, neighbor_zone) level with distance
                                bands identical in schema to city_flows.parquet.
  5. export_*()               — writes neighbor_flows.parquet and
                                neighbor_meta.json to the year output directory.

Called from process_data.py; does not modify any existing Utah-only data files.

Display scope is controlled by NEIGHBOR_DISPLAY_FILTER:
  'border' — border counties + cities within them (default; ~20-30 counties)
  'all'    — all counties and cities in 6 states (future expansion)
"""

import json
import os
import time
from pathlib import Path

import numpy as np
import pandas as pd
import geopandas as gpd
import pyarrow as pa
import pyarrow.parquet as pq
import requests

# ── Configuration ──────────────────────────────────────────────────────────────
NEIGHBOR_DISPLAY_FILTER = "border"  # 'border' | 'all'

NEIGHBOR_STATES = {
    "16": ("Idaho",      "ID"),
    "56": ("Wyoming",    "WY"),
    "08": ("Colorado",   "CO"),
    "35": ("New Mexico", "NM"),
    "04": ("Arizona",    "AZ"),
    "32": ("Nevada",     "NV"),
}

TIGER_BASE = "https://www2.census.gov/geo/tiger/TIGER2024"
LODES_BASE = "https://lehd.ces.census.gov/data/lodes/LODES8"
COUNTIES_URL = f"{TIGER_BASE}/COUNTY/tl_2024_us_county.zip"

# Place LSAD codes representing standard incorporated places and CDPs
# 25=city, 43=town(civil), 44=town, 45=town, 47=CDP, 53=independent city
PLACE_LSAD_KEEP = {"25", "43", "44", "45", "47", "53"}

# Buffer distance (metres) applied to Utah's boundary before intersecting with
# neighboring-state counties.  A small buffer (5 km) corrects for sub-pixel
# rounding gaps in TIGER geometries at shared tripoints (e.g. UT/NV/AZ corner
# where Clark County, NV nearly touches Utah).  Increase to pull in more-distant
# counties; the current 80 km value includes Clark County, NV (Las Vegas) whose
# nearest edge is ~75 km from Utah's southwest corner.
BORDER_BUFFER_METERS = 80_000   # 80 km

AGG_COLS  = ["S000", "SA01", "SA02", "SA03", "SE01", "SE02", "SE03", "SI01", "SI02", "SI03"]
BAND_COLS = ["d0_5", "d5_10", "d10_25", "d25_50", "d50_100", "d100p", "dist_n"]
DIST_COLS = ["dist_wsum"]
ALL_FLOW_COLS = AGG_COLS + BAND_COLS + DIST_COLS


# ── Robust download helper ────────────────────────────────────────────────────

# Census TIGER servers enforce a ~256 KB per-TCP-connection transfer limit for
# some files (observed consistently on tl_2024_32_place.zip and occasionally on
# tl_2024_56_place.zip).  A single-connection GET always fails with IncompleteRead
# regardless of streaming mode.  The fix is HTTP Range requests: each chunk opens
# a fresh connection that never reaches the limit.
_RANGE_CHUNK = 200 * 1024  # 200 KB — safely under the ~256 KB server limit


def _tmp_path(dest: Path) -> Path:
    """Return a unique temp path that won't collide with locked files from previous runs."""
    return dest.with_suffix(f".{os.getpid()}.tmp")


def _download_file(url: str, dest: Path, max_attempts: int = 5) -> Path:
    """Download url to dest.

    Tries a single-connection GET first (fast path for servers without limits),
    then falls back to Range-based chunked download if that fails.
    """
    if dest.exists() and dest.stat().st_size > 0:
        return dest

    tmp = _tmp_path(dest)

    # Fast path: single non-streaming request
    for attempt in range(2):
        # tmp uses PID-stamped name so it never collides with locked files from
        # previous runs; safe to unlink unconditionally here.
        if tmp.exists():
            try:
                tmp.unlink()
            except OSError:
                tmp = _tmp_path(dest)  # pick a fresh name if still locked
        if attempt:
            time.sleep(2)
        try:
            r = requests.get(url, timeout=120, stream=False)
            r.raise_for_status()
            tmp.write_bytes(r.content)
            tmp.rename(dest)
            size_mb = dest.stat().st_size / 1_048_576
            print(f"  Saved {dest.name} ({size_mb:.1f} MB)")
            return dest
        except Exception as exc:
            print(f"    Single-connection attempt {attempt + 1} failed: {exc}")

    # Slow path: Range requests (each chunk = new TCP connection)
    print(f"    Falling back to Range-based chunked download...")
    return _download_chunked(url, dest, max_attempts=max_attempts)


def _download_chunked(url: str, dest: Path, max_attempts: int = 5) -> Path:
    """Download using HTTP Range requests — each chunk opens a fresh TCP connection.

    Does NOT use HEAD (Census TIGER servers occasionally block it).  Instead the
    first Range request reveals the total size via the Content-Range response
    header.  Subsequent chunks are fetched sequentially until all bytes are
    collected.
    """
    tmp = _tmp_path(dest)
    # Clean up any stale temp from a previous run of this process
    if tmp.exists():
        tmp.unlink(missing_ok=True)

    total: int = 0
    offset: int = 0
    last_err: Exception = RuntimeError("not tried")

    with open(tmp, "wb") as f:
        while True:
            end = offset + _RANGE_CHUNK - 1
            # If we already know the total, clamp the end byte
            if total:
                if offset >= total:
                    break
                end = min(end, total - 1)

            for attempt in range(max_attempts):
                if attempt:
                    time.sleep(min(2 ** (attempt - 1), 30))
                try:
                    r = requests.get(
                        url,
                        headers={"Range": f"bytes={offset}-{end}"},
                        timeout=90,
                        stream=False,
                    )
                    # 206 = partial content (server supports ranges)
                    # 200 = server ignored Range header and returned full file
                    if r.status_code == 200 and offset == 0:
                        # Server doesn't support ranges — write whole body and exit
                        f.write(r.content)
                        tmp.rename(dest)
                        print(f"  Saved {dest.name} ({dest.stat().st_size / 1_048_576:.1f} MB)")
                        return dest
                    if r.status_code not in (200, 206):
                        raise ValueError(f"Unexpected HTTP {r.status_code}")
                    # Parse total from Content-Range: bytes 0-199999/838717
                    if not total:
                        cr = r.headers.get("Content-Range", "")
                        if "/" in cr:
                            total = int(cr.split("/")[-1])
                            n = (total + _RANGE_CHUNK - 1) // _RANGE_CHUNK
                            print(f"    {dest.name}: {total / 1024:.0f} KB "
                                  f"in {n} x {_RANGE_CHUNK // 1024} KB chunks")
                    f.write(r.content)
                    offset = end + 1
                    break
                except Exception as exc:
                    last_err = exc
            else:
                tmp.unlink(missing_ok=True)
                raise RuntimeError(
                    f"Chunk bytes={offset}-{end} failed after {max_attempts} attempts: {last_err}"
                )

            # Guard against infinite loop if server never sent Content-Range
            if not total and offset >= end + 1:
                break

    tmp.rename(dest)
    size_mb = dest.stat().st_size / 1_048_576
    print(f"  Saved {dest.name} ({size_mb:.1f} MB)")
    return dest


# ── String helpers ─────────────────────────────────────────────────────────────

def _clean_place_name(name, namelsad=None):
    """Return a clean city name. Prefers NAME over NAMELSAD."""
    if pd.notna(name) and str(name).strip():
        return str(name).strip()
    if not pd.notna(namelsad) or not str(namelsad).strip():
        return None
    s = str(namelsad).split(",")[0].strip()
    parts = s.rsplit(" ", 1)
    if len(parts) == 2 and parts[1].lower() in (
        "city", "town", "village", "borough", "cdp", "township", "municipality"
    ):
        return parts[0].strip()
    return s


def _clean_stplcname(raw):
    """'Paris city, Idaho' -> 'Paris'  (LEHD crosswalk stplcname format)."""
    if not pd.notna(raw) or not raw:
        return None
    s = str(raw).split(",")[0].strip()
    parts = s.rsplit(" ", 1)
    if len(parts) == 2 and parts[1].lower() in (
        "city", "town", "village", "borough", "cdp", "township", "municipality"
    ):
        return parts[0].strip()
    return s


def _clean_county_name(ctyname):
    """'Bear Lake County, Idaho' -> 'Bear Lake County'."""
    if not pd.notna(ctyname) or not ctyname:
        return None
    return str(ctyname).split(",")[0].strip()


# ── Step 1: build zone database ────────────────────────────────────────────────

def build_neighbor_zones(cache_dir: Path, download_fn) -> list:
    """Download + cache all counties and cities for the 6 neighboring states.

    Downloads:
    - National county shapefile (shared with Utah pipeline, already cached)
    - Per-state Census place shapefiles for the 6 neighboring states

    Returns: list of zone dicts, each with keys:
      display_name, name, type, state, state_abbr, county, county_fips, lat, lon

    Cached at cache_dir/neighbor_zones.json; re-runs only if cache is absent.
    """
    cache_path = cache_dir / "neighbor_zones.json"
    if cache_path.exists() and cache_path.stat().st_size > 0:
        print("  Using cached neighbor_zones.json")
        return json.loads(cache_path.read_text())

    print("  Building neighbor zone database (one-time download)...")
    zones = []

    # ── Counties ──────────────────────────────────────────────────────────────
    counties_local = download_fn(COUNTIES_URL, "tl_2024_us_county.zip")
    all_counties = gpd.read_file(counties_local)
    neighbor_counties = all_counties[all_counties["STATEFP"].isin(NEIGHBOR_STATES)].copy()
    # Build county_fips -> name lookup for the city spatial join below
    county_fips_to_name = {}

    for _, row in neighbor_counties.iterrows():
        state_fips = row["STATEFP"]
        state_name, state_abbr = NEIGHBOR_STATES[state_fips]
        county_fips = state_fips + row["COUNTYFP"]
        county_name = row["NAMELSAD"]  # e.g. "Bear Lake County"
        county_fips_to_name[county_fips] = county_name
        zones.append({
            "display_name": f"{county_name}, {state_abbr}",
            "name":         county_name,
            "type":         "county",
            "state":        state_name,
            "state_abbr":   state_abbr,
            "county":       county_name,
            "county_fips":  county_fips,
            "lat":          float(row["INTPTLAT"]),
            "lon":          float(row["INTPTLON"]),
        })

    county_count = len(zones)
    print(f"    Counties: {county_count}")

    # ── Cities (per-state TIGER place shapefiles) ─────────────────────────────
    for state_fips, (state_name, state_abbr) in NEIGHBOR_STATES.items():
        state_2 = state_fips.zfill(2)
        url   = f"{TIGER_BASE}/PLACE/tl_2024_{state_2}_place.zip"
        fname = f"tl_2024_{state_2}_place.zip"
        # Use the robust (non-streaming) downloader; the shared download_fn uses
        # iter_content which Census TIGER servers sometimes cut off at 262 KB.
        try:
            local = _download_file(url, cache_dir / fname)
        except Exception as dl_err:
            print(f"    WARNING: could not download {fname}: {dl_err}")
            print(f"    Skipping {state_abbr} cities (counties still included).")
            continue
        places = gpd.read_file(local)

        # Filter to standard incorporated place and CDP types
        if "LSAD" in places.columns:
            places = places[places["LSAD"].isin(PLACE_LSAD_KEEP)].copy()

        if places.empty:
            continue

        # Build point GDF from internal points (INTPTLAT/INTPTLON)
        pts = gpd.GeoDataFrame(
            places.copy(),
            geometry=gpd.points_from_xy(
                places["INTPTLON"].astype(float),
                places["INTPTLAT"].astype(float),
            ),
            crs=4326,
        )

        # Spatial join: which county contains each place centroid?
        state_counties = neighbor_counties[
            neighbor_counties["STATEFP"] == state_fips
        ][["STATEFP", "COUNTYFP", "geometry"]].copy()
        state_counties["county_fips"] = state_counties["STATEFP"] + state_counties["COUNTYFP"]
        # Reproject county polygons to match place point CRS (4326 vs TIGER default 4269)
        state_counties = state_counties.to_crs(epsg=4326)

        joined = gpd.sjoin(
            pts[["NAME", "NAMELSAD", "INTPTLAT", "INTPTLON", "geometry"]],
            state_counties[["county_fips", "geometry"]],
            how="left",
            predicate="within",
        )
        # Deduplicate (sjoin may produce multiple rows for places on county borders)
        joined = joined.drop_duplicates(subset=["NAME", "INTPTLAT", "INTPTLON"], keep="first")

        added = 0
        for _, row in joined.iterrows():
            county_fips = row.get("county_fips")
            if not pd.notna(county_fips):
                continue
            county_fips = str(county_fips)
            place_name = _clean_place_name(row.get("NAME"), row.get("NAMELSAD"))
            if not place_name:
                continue
            county_name = county_fips_to_name.get(county_fips, "")
            zones.append({
                "display_name": f"{place_name}, {state_abbr}",
                "name":         place_name,
                "type":         "city",
                "state":        state_name,
                "state_abbr":   state_abbr,
                "county":       county_name,
                "county_fips":  county_fips,
                "lat":          float(row["INTPTLAT"]),
                "lon":          float(row["INTPTLON"]),
            })
            added += 1
        print(f"    {state_abbr} cities: {added}")

    cache_path.write_text(json.dumps(zones, indent=2))
    city_count = len(zones) - county_count
    print(f"  Cached neighbor_zones.json ({county_count} counties + {city_count} cities = {len(zones)} total)")
    return zones


# ── Step 2: compute border zone set ───────────────────────────────────────────

def get_border_zone_set(cache_dir: Path, download_fn, all_zones: list) -> tuple:
    """Return (border_county_fips_set, border_zone_display_names_set).

    Border counties = neighbor-state counties that intersect a buffered Utah
    boundary.  The buffer (BORDER_BUFFER_METERS) corrects for sub-pixel rounding
    gaps in TIGER geometries at tripoints AND pulls in important commute
    destinations (e.g. Clark County, NV) whose edge falls just outside strict
    adjacency.

    Cached at cache_dir/border_county_fips.json.
    """
    fips_cache = cache_dir / "border_county_fips.json"
    if fips_cache.exists() and fips_cache.stat().st_size > 0:
        border_fips = set(json.loads(fips_cache.read_text()))
        print(f"  Using cached border county list ({len(border_fips)} counties)")
    else:
        print(f"  Computing border counties "
              f"(Utah boundary + {BORDER_BUFFER_METERS/1000:.0f} km buffer)...")

        counties_local = download_fn(COUNTIES_URL, "tl_2024_us_county.zip")
        all_counties = gpd.read_file(counties_local)

        # Project to Conus Albers (EPSG:5070) — metre-based, accurate for CONUS
        utah_counties = all_counties[all_counties["STATEFP"] == "49"].to_crs(epsg=5070)
        utah_buffered = utah_counties.union_all().buffer(BORDER_BUFFER_METERS)

        neighbor_counties = all_counties[all_counties["STATEFP"].isin(NEIGHBOR_STATES)].to_crs(epsg=5070).copy()
        neighbor_counties["county_fips"] = (
            neighbor_counties["STATEFP"] + neighbor_counties["COUNTYFP"]
        )

        is_border = neighbor_counties.geometry.intersects(utah_buffered)
        border_fips = set(neighbor_counties.loc[is_border, "county_fips"].tolist())

        fips_cache.write_text(json.dumps(sorted(border_fips), indent=2))
        print(f"  Found {len(border_fips)} border counties "
              f"-> cached border_county_fips.json")

    border_zone_names = {
        z["display_name"]
        for z in all_zones
        if z["county_fips"] in border_fips
    }
    print(f"  Border display zones: {len(border_zone_names)} "
          f"(including cities and counties within border counties)")
    return border_fips, border_zone_names


# ── Step 2b: load outflow OD from neighboring states ─────────────────────────

def load_outflow_od(year: str | int, cache_dir: Path, download_fn) -> pd.DataFrame:
    """Download neighboring-state LEHD aux files and return Utah-resident outflow rows.

    Each neighboring state's aux file (home ≠ that state, work = that state)
    contains records where Utah residents (h_geocode starting with '49') commute
    into that state.  The returned DataFrame has the same columns as the Utah main
    OD file so it can be concatenated before join_od_with_lookup runs.

    Records are cached per-state; returns an empty DataFrame when no aux file is
    available for a given state/year.
    """
    year = str(year)
    AGG_COLS_LOCAL = [
        "S000", "SA01", "SA02", "SA03",
        "SE01", "SE02", "SE03",
        "SI01", "SI02", "SI03",
    ]
    frames = []
    for state_fips, (state_name, state_abbr) in NEIGHBOR_STATES.items():
        state_code = state_abbr.lower()
        aux_url  = f"{LODES_BASE}/{state_code}/od/{state_code}_od_aux_JT00_{year}.csv.gz"
        filename = f"{state_code}_od_aux_JT00_{year}.csv.gz"
        try:
            local = download_fn(aux_url, filename)
            df = pd.read_csv(
                local,
                dtype={"w_geocode": str, "h_geocode": str},
                usecols=["w_geocode", "h_geocode"] + AGG_COLS_LOCAL,
                encoding="utf-8",
            )
            # Keep only records where the home block is in Utah (FIPS prefix 49)
            utah_home_mask = df["h_geocode"].str.startswith("49")
            df = df[utah_home_mask].copy()
            if not df.empty:
                print(f"    {state_abbr}: {len(df):,} outflow records (UT residents -> {state_name})")
                frames.append(df)
        except Exception as exc:
            print(f"    {state_abbr}: aux OD file unavailable for {year} ({exc}), skipping.")
    if frames:
        combined = pd.concat(frames, ignore_index=True)
        print(f"  Total outflow OD records (UT -> neighbors): {len(combined):,}")
        return combined
    print("  No neighboring-state outflow OD records found.")
    return pd.DataFrame(columns=["w_geocode", "h_geocode"] + AGG_COLS_LOCAL)


# ── Step 3: resolve non-Utah blocks from LEHD crosswalks ─────────────────────

def resolve_neighbor_blocks(od: pd.DataFrame, cache_dir: Path, download_fn) -> dict:
    """Build a lookup dict for all non-Utah LEHD blocks found in the OD data.

    For each neighbor-state block FIPS that appears as h_geocode or w_geocode,
    downloads (and caches) that state's LEHD crosswalk and extracts:
      display_name — "City, ST" or "County Unincorporated, ST"
      county_fips  — 5-char county FIPS
      state_abbr   — e.g. "ID"
      lat, lon     — block-level centroid from LEHD crosswalk

    Returns: dict { block_fips_str -> {display_name, county_fips, state_abbr, lat, lon} }
    """
    # Collect all non-Utah geocodes that belong to a neighbor state
    oos_h = od.loc[~od["h_geocode"].str.startswith("49"), "h_geocode"]
    oos_w = od.loc[~od["w_geocode"].str.startswith("49"), "w_geocode"]
    all_oos = set(oos_h.unique()) | set(oos_w.unique())

    # Group by state FIPS prefix
    state_blocks: dict[str, set] = {}
    for fips in all_oos:
        prefix = str(fips)[:2]
        if prefix in NEIGHBOR_STATES:
            state_blocks.setdefault(prefix, set()).add(str(fips))

    if not state_blocks:
        print("  No neighbor-state blocks found in OD data.")
        return {}

    result = {}
    for state_fips, block_set in state_blocks.items():
        _, state_abbr = NEIGHBOR_STATES[state_fips]
        state_code = state_abbr.lower()
        xwalk_url = f"{LODES_BASE}/{state_code}/{state_code}_xwalk.csv.gz"
        local = download_fn(xwalk_url, f"{state_code}_xwalk.csv.gz")

        xw = pd.read_csv(
            local,
            dtype={"tabblk2020": str, "stplc": str, "cty": str},
            usecols=["tabblk2020", "stplcname", "cty", "ctyname", "blklatdd", "blklondd"],
            encoding="utf-8",
        )
        xw = xw[xw["tabblk2020"].isin(block_set)].copy()
        xw["cty"] = xw["cty"].fillna("").apply(lambda c: str(c).zfill(5) if c else "")

        for row in xw.itertuples(index=False):
            place_name = _clean_stplcname(row.stplcname) if pd.notna(row.stplcname) else None
            county_name = _clean_county_name(row.ctyname) if pd.notna(row.ctyname) else None
            county_fips = str(row.cty).zfill(5) if row.cty else None

            if place_name:
                display_name = f"{place_name}, {state_abbr}"
            elif county_name:
                display_name = f"{county_name} Unincorporated, {state_abbr}"
            else:
                continue

            lat = float(row.blklatdd) if pd.notna(row.blklatdd) else None
            lon = float(row.blklondd) if pd.notna(row.blklondd) else None

            county_display_name = (
                f"{county_name}, {state_abbr}" if county_name else None
            )
            result[str(row.tabblk2020)] = {
                "display_name":        display_name,
                "county_display_name": county_display_name,
                "county_fips":         county_fips,
                "state_abbr":          state_abbr,
                "lat":                 lat,
                "lon":                 lon,
            }

        print(f"  Resolved {len(xw):,} {state_abbr} blocks "
              f"({len(block_set) - len(xw):,} unmatched in crosswalk)")

    return result


# ── Step 4: aggregate cross-state flows ───────────────────────────────────────

def process_neighbor_flows(
    od: pd.DataFrame,
    block_lookup: dict,
    border_fips: set,
    haversine_fn,
) -> pd.DataFrame:
    """Extract cross-state OD records and aggregate to neighbor flow pairs.

    Must be called AFTER fill_unincorporated() so Utah zone names are
    fully resolved. Handles both inflow and outflow directions:

    Inflow  — h_geocode is non-Utah, w_geocode is Utah:
              neighbor is home (h_geocode), utah_zone is work city (w_city)
    Outflow — h_geocode is Utah, w_geocode is non-Utah:
              neighbor is work (w_geocode), utah_zone is home city (h_city)

    Produces BOTH city-level and county-level aggregation columns so the
    frontend can switch between granularities without a separate query:
      utah_zone / utah_county  — subject area at city or county level
      utah_small / utah_medium / utah_large / utah_super — subject area at each
        Planning Boundaries level (so Planning-mode subjects also see their
        cross-state commuters in the flow / distance stats)
      neighbor_zone / neighbor_county — destination at city or county level
    """
    if not block_lookup:
        print("  Skipping neighbor flow processing (empty block lookup).")
        return _empty_flows()

    h_utah = od["h_geocode"].str.startswith("49")
    w_utah = od["w_geocode"].str.startswith("49")

    # Planning Boundaries levels carried through from join_od_with_lookup(). The
    # Utah side of a cross-state pair is the work block for inflow, the home
    # block for outflow — mirror the utah_zone / utah_county assignment below.
    PLANNING_LEVELS = ("small", "medium", "large", "super")

    segments = []

    # Inflow: home out-of-state, work in Utah
    inflow_mask = ~h_utah & w_utah
    if inflow_mask.any():
        inflow = od[inflow_mask].copy()
        inflow["neighbor_block"] = inflow["h_geocode"]
        inflow["direction"]      = "in"
        inflow["utah_zone"]      = inflow["w_city"]
        inflow["utah_county"]    = inflow["w_county"]
        inflow["utah_blk_lat"]   = inflow["w_blk_lat"]
        inflow["utah_blk_lon"]   = inflow["w_blk_lon"]
        for lvl in PLANNING_LEVELS:
            inflow[f"utah_{lvl}"] = inflow[f"w_{lvl}"]
        segments.append(inflow)
        print(f"  Inflow records (home OOS, work UT): {inflow_mask.sum():,}")

    # Outflow: home in Utah, work out-of-state
    outflow_mask = h_utah & ~w_utah
    if outflow_mask.any():
        outflow = od[outflow_mask].copy()
        outflow["neighbor_block"] = outflow["w_geocode"]
        outflow["direction"]      = "out"
        outflow["utah_zone"]      = outflow["h_city"]
        outflow["utah_county"]    = outflow["h_county"]
        outflow["utah_blk_lat"]   = outflow["h_blk_lat"]
        outflow["utah_blk_lon"]   = outflow["h_blk_lon"]
        for lvl in PLANNING_LEVELS:
            outflow[f"utah_{lvl}"] = outflow[f"h_{lvl}"]
        segments.append(outflow)
        print(f"  Outflow records (home UT, work OOS): {outflow_mask.sum():,}")

    if not segments:
        print("  No cross-state OD records found.")
        return _empty_flows()

    cross = pd.concat(segments, ignore_index=True)

    # Resolve neighbor blocks -> display_name + coords
    cross["neighbor_info"] = cross["neighbor_block"].map(block_lookup)
    cross = cross[cross["neighbor_info"].notna()].copy()

    if cross.empty:
        print("  No cross-state records matched the neighbor block lookup.")
        return _empty_flows()

    cross["neighbor_zone"]   = cross["neighbor_info"].map(lambda x: x["display_name"])
    cross["neighbor_county"] = cross["neighbor_info"].map(lambda x: x.get("county_display_name"))
    cross["state_abbr"]      = cross["neighbor_info"].map(lambda x: x["state_abbr"])
    cross["n_county_fips"]   = cross["neighbor_info"].map(lambda x: x.get("county_fips"))
    cross["n_blk_lat"]       = cross["neighbor_info"].map(lambda x: x.get("lat"))
    cross["n_blk_lon"]       = cross["neighbor_info"].map(lambda x: x.get("lon"))

    # Filter to border counties using county_fips (handles unincorporated blocks
    # that would otherwise be missed by a display_name string match)
    cross = cross[cross["n_county_fips"].isin(border_fips)].copy()
    if cross.empty:
        print("  No cross-state records within border zone filter.")
        return _empty_flows()

    # Compute haversine distances (vectorized)
    valid = (
        cross["utah_blk_lat"].notna() & cross["utah_blk_lon"].notna() &
        cross["n_blk_lat"].notna()    & cross["n_blk_lon"].notna()
    )
    miles = pd.Series(np.nan, index=cross.index, dtype="float64")
    if valid.any():
        miles.loc[valid] = haversine_fn(
            cross.loc[valid, "utah_blk_lat"].values,
            cross.loc[valid, "utah_blk_lon"].values,
            cross.loc[valid, "n_blk_lat"].values,
            cross.loc[valid, "n_blk_lon"].values,
        )

    # Add distance-band columns (same schema as process_data.add_distance_bands)
    s = cross["S000"].fillna(0)
    cross["d0_5"]    = s.where(miles <   5,                       0)
    cross["d5_10"]   = s.where((miles >=   5) & (miles <  10),    0)
    cross["d10_25"]  = s.where((miles >=  10) & (miles <  25),    0)
    cross["d25_50"]  = s.where((miles >=  25) & (miles <  50),    0)
    cross["d50_100"] = s.where((miles >=  50) & (miles < 100),    0)
    cross["d100p"]   = s.where(miles >= 100,                      0)
    cross["dist_wsum"] = (s * miles).fillna(0).astype("float32")
    cross["dist_n"]    = s.where(valid, 0)

    pct = valid.mean() * 100
    print(f"  Neighbor block-level distance coverage: "
          f"{valid.sum():,}/{len(cross):,} ({pct:.1f}%)")

    # Aggregate — keep both city and county columns so the frontend can switch
    # between granularities (city/county map zone) without re-running the pipeline.
    group_cols = [
        "utah_zone", "utah_county",
        "utah_small", "utah_medium", "utah_large", "utah_super",
        "neighbor_zone", "neighbor_county",
        "state_abbr", "direction",
    ]
    grouped = (
        cross.groupby(group_cols, dropna=False)[ALL_FLOW_COLS]
        .sum()
        .reset_index()
    )
    grouped = grouped[grouped["S000"] > 0]
    print(f"  Neighbor flow pairs: {len(grouped):,}")
    return grouped


def _empty_flows() -> pd.DataFrame:
    """Return empty DataFrame with the correct neighbor_flows schema."""
    cols = [
        "utah_zone", "utah_county",
        "utah_small", "utah_medium", "utah_large", "utah_super",
        "neighbor_zone", "neighbor_county",
        "state_abbr", "direction",
    ] + ALL_FLOW_COLS
    return pd.DataFrame(columns=cols)


# ── Step 5: export ────────────────────────────────────────────────────────────

def export_neighbor_flows(year_dir: Path, flow_df: pd.DataFrame) -> None:
    """Write neighbor_flows.parquet (Snappy) to year_dir."""
    out = year_dir / "neighbor_flows.parquet"
    int_cols = BAND_COLS + AGG_COLS
    for col in int_cols:
        if col in flow_df.columns:
            flow_df[col] = flow_df[col].fillna(0).astype("int32")
    table = pa.Table.from_pandas(flow_df, preserve_index=False)
    pq.write_table(table, out, compression="snappy")
    size_kb = out.stat().st_size / 1024
    print(f"  Wrote neighbor_flows.parquet ({len(flow_df):,} rows, {size_kb:.1f} KB)")


def build_and_export_meta(year_dir: Path, all_zones: list, border_zone_names: set) -> None:
    """Write neighbor_meta.json (border-filtered zones) to year_dir.

    The frontend loads this to render point dots and tooltips for border zones.
    """
    if NEIGHBOR_DISPLAY_FILTER == "all":
        display_zones = all_zones
    else:
        display_zones = [z for z in all_zones if z["display_name"] in border_zone_names]

    out = year_dir / "neighbor_meta.json"
    out.write_text(json.dumps(display_zones, indent=2))
    print(f"  Wrote neighbor_meta.json ({len(display_zones)} display zones)")
