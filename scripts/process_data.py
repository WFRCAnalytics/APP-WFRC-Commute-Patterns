# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "pandas>=2.0",
#   "pyarrow>=14.0",
#   "geopandas>=0.14",
#   "requests>=2.31",
#   "shapely>=2.0",
#   "topojson>=1.10",
# ]
# ///
"""
Utah Commute Patterns — Offline Data Pipeline

Downloads LEHD LODES8 OD data for Utah, joins with the LEHD crosswalk to
get city/county names, computes block-centroid haversine distances and
buckets them into 4 distance bands, aggregates to city->city and
county->county flow pairs (with band counts), computes geographic centroids
from Census TIGER shapefiles, and exports Parquet + JSON files to
../data/lehd/{year}/.

Run once locally before committing data files:
    uv run scripts/process_data.py            # auto-detects latest available year
    uv run scripts/process_data.py --year 2021  # specific year
"""

import re
import sys
import json
import argparse
from pathlib import Path
import requests
import numpy as np
import pandas as pd
import geopandas as gpd
import pyarrow as pa
import pyarrow.parquet as pq
import custom_places
import fetch_acs
import neighbor_zones
import taz_districts
import workshop_areas
from geo_utils import topo_simplify

# ── Output directories ────────────────────────────────────────────────────────
DATA_DIR  = Path(__file__).parent.parent / "data"
CACHE_DIR = DATA_DIR / "cache"
DATA_DIR.mkdir(exist_ok=True)
CACHE_DIR.mkdir(exist_ok=True)


def download_cached(url, filename):
    """Download url to CACHE_DIR/filename if not already cached. Returns local path."""
    cache_path = CACHE_DIR / filename
    if cache_path.exists() and cache_path.stat().st_size > 0:
        print(f"  Using cached {filename}")
        return cache_path
    print(f"  Downloading {url}")
    r = requests.get(url, stream=True, timeout=300)
    r.raise_for_status()
    tmp = cache_path.with_suffix(cache_path.suffix + ".tmp")
    with open(tmp, "wb") as f:
        for chunk in r.iter_content(chunk_size=65536):
            f.write(chunk)
    tmp.rename(cache_path)
    size_mb = cache_path.stat().st_size / 1024 / 1024
    print(f"  Saved {filename} ({size_mb:.1f} MB)")
    return cache_path

# ── All Utah county FIPS codes ───────────────────────────────────────────────
UTAH_COUNTIES = {
    "49001": "Beaver County",
    "49003": "Box Elder County",
    "49005": "Cache County",
    "49007": "Carbon County",
    "49009": "Daggett County",
    "49011": "Davis County",
    "49013": "Duchesne County",
    "49015": "Emery County",
    "49017": "Garfield County",
    "49019": "Grand County",
    "49021": "Iron County",
    "49023": "Juab County",
    "49025": "Kane County",
    "49027": "Millard County",
    "49029": "Morgan County",
    "49031": "Piute County",
    "49033": "Rich County",
    "49035": "Salt Lake County",
    "49037": "San Juan County",
    "49039": "Sanpete County",
    "49041": "Sevier County",
    "49043": "Summit County",
    "49045": "Tooele County",
    "49047": "Uintah County",
    "49049": "Utah County",
    "49051": "Wasatch County",
    "49053": "Washington County",
    "49055": "Wayne County",
    "49057": "Weber County",
}

# ── LEHD LODES8 URLs ──────────────────────────────────────────────────────────
LODES_BASE = "https://lehd.ces.census.gov/data/lodes/LODES8/ut"
# LODES8 covers 2002-2023; try from newest downward when no --year given
LODES_YEARS_DEFAULT = [str(y) for y in range(2023, 2001, -1)]
OD_TEMPLATE  = LODES_BASE + "/od/ut_od_main_JT00_{year}.csv.gz"
AUX_TEMPLATE = LODES_BASE + "/od/ut_od_aux_JT00_{year}.csv.gz"
XWALK_URL = LODES_BASE + "/ut_xwalk.csv.gz"

# ── Census TIGER 2024 URLs (Utah state FIPS = 49) ────────────────────────────
TIGER_BASE = "https://www2.census.gov/geo/tiger/TIGER2024"
PLACES_URL   = f"{TIGER_BASE}/PLACE/tl_2024_49_place.zip"
COUNTIES_URL = f"{TIGER_BASE}/COUNTY/tl_2024_us_county.zip"  # counties file is national
SLDL_URL     = f"{TIGER_BASE}/SLDL/tl_2024_49_sldl.zip"    # state house districts
SLDU_URL     = f"{TIGER_BASE}/SLDU/tl_2024_49_sldu.zip"    # state senate districts

# ── LEHD OD columns to aggregate ─────────────────────────────────────────────
AGG_COLS  = ["S000", "SA01", "SA02", "SA03", "SE01", "SE02", "SE03", "SI01", "SI02", "SI03"]
# Distance-band worker counts added by add_distance_bands() before aggregation
BAND_COLS = ["d0_5", "d5_10", "d10_25", "d25_50", "d50_100", "d100p", "dist_n"]  # integer columns
DIST_COLS = ["dist_wsum"]                                        # float column


def load_od(years=LODES_YEARS_DEFAULT):
    """Download main + aux OD CSV.GZ files (cached), trying each year until one succeeds.

    Main file: home AND work both in Utah.
    Aux  file: home in Utah, work OUTSIDE Utah (captures Utah residents commuting
               out of state, closing the outflow gap vs Census OnTheMap).
    """
    for year in years:
        main_url  = OD_TEMPLATE.format(year=year)
        aux_url   = AUX_TEMPLATE.format(year=year)
        main_file = f"ut_od_main_JT00_{year}.csv.gz"
        aux_file  = f"ut_od_aux_JT00_{year}.csv.gz"
        print(f"  Trying OD data for {year}...")
        try:
            main_local = download_cached(main_url, main_file)
            main_df = pd.read_csv(
                main_local,
                dtype={"w_geocode": str, "h_geocode": str},
                usecols=["w_geocode", "h_geocode"] + AGG_COLS,
            )
            try:
                aux_local = download_cached(aux_url, aux_file)
                aux_df = pd.read_csv(
                    aux_local,
                    dtype={"w_geocode": str, "h_geocode": str},
                    usecols=["w_geocode", "h_geocode"] + AGG_COLS,
                )
                df = pd.concat([main_df, aux_df], ignore_index=True)
                print(f"  Loaded {len(main_df):,} main + {len(aux_df):,} aux = {len(df):,} OD records for {year}")
            except Exception as aux_err:
                print(f"  Aux file unavailable ({aux_err}), using main only.")
                df = main_df
                print(f"  Loaded {len(df):,} OD records for {year}")
            return df, year
        except Exception as e:
            bad = CACHE_DIR / main_file
            if bad.exists():
                bad.unlink()
            print(f"  Failed ({e}), trying next year...")
    sys.exit("ERROR: Could not download OD data for any year.")


def load_xwalk():
    """Download (cached) and slim the LEHD geographic crosswalk."""
    local = download_cached(XWALK_URL, "ut_xwalk.csv.gz")
    xw = pd.read_csv(
        local,
        dtype={"tabblk2020": str, "stplc": str, "cty": str,
               "stsldl": str, "stsldu": str, "trct": str},
        usecols=["tabblk2020", "stplc", "stplcname", "cty", "ctyname",
                 "stsldl", "stsldlname", "stsldu", "stslduname", "trct",
                 "blklatdd", "blklondd"],
    )
    # County FIPS is 5 chars (state+county); place FIPS is 7 chars (state+place)
    xw["cty"]    = xw["cty"].str.zfill(5)
    xw["stplc"]  = xw["stplc"].str.zfill(7)
    xw["stsldl"] = xw["stsldl"].str.zfill(5)
    xw["stsldu"] = xw["stsldu"].str.zfill(5)
    print(f"  Crosswalk rows: {len(xw):,}")
    return xw


def _get_type_label(stplcname):
    """Extract place type label from raw Census stplcname. Returns 'CDP', 'City', 'Town', etc."""
    if not pd.notna(stplcname) or not stplcname:
        return "City"
    s = stplcname.split(",")[0].strip()
    parts = s.rsplit(" ", 1)
    if len(parts) == 2:
        t = parts[1].lower()
        if t == "cdp":
            return "CDP"
        if t in ("city", "town", "village", "borough", "township", "municipality"):
            return t.capitalize()
    return "City"


def _clean_distname(s):
    """'State House District 1, UT' -> 'House District 1'
       'State Senate District 28, UT' -> 'Senate District 28'"""
    if not pd.notna(s) or not s:
        return s
    return s.split(",")[0].strip().replace("State ", "", 1)


def _detect_name_collisions(xw):
    """Return {place_fips: disambiguated_name} for Census places whose cleaned name
    collides with another place in a different county.

    e.g. "Enterprise CDP" (Morgan Co.) and "Enterprise city" (Washington Co.) both
    clean to "Enterprise" — this returns:
      {"4923310": "Enterprise (CDP)", "4923420": "Enterprise (City)"}
    """
    xw_valid = xw[xw["stplcname"].notna() & xw["stplc"].notna()].copy()
    xw_valid["clean_name"] = xw_valid["stplcname"].apply(_clean_stplcname)
    # One row per (clean_name, place_fips) pair; keep stplcname for type label
    pairs = xw_valid.drop_duplicates(["clean_name", "stplc"])[["clean_name", "stplc", "cty", "stplcname"]]
    # Names that map to more than one place FIPS are ambiguous
    ambiguous = pairs.groupby("clean_name")["stplc"].nunique()
    ambiguous = set(ambiguous[ambiguous > 1].index)
    if not ambiguous:
        return {}
    result = {}
    for _, row in pairs[pairs["clean_name"].isin(ambiguous)].iterrows():
        type_label = _get_type_label(row["stplcname"])
        result[row["stplc"]] = f"{row['clean_name']} ({type_label})"
    print(f"  Name collisions resolved: {sorted(ambiguous)}")
    return result


def build_lookup(xw, disambig=None):
    """Return a dict: block_fips -> {city_name, county_name, county_fips, place_fips, lat, lon}"""
    lookup = {}
    for row in xw.itertuples(index=False):
        # Unincorporated blocks have no place; use county label
        city = row.stplcname if pd.notna(row.stplcname) and row.stplcname else None
        if city:
            city = disambig.get(row.stplc) or _clean_stplcname(city)
        # Use canonical Utah county name if available, otherwise fall back to raw xwalk ctyname
        raw_county = row.ctyname if pd.notna(row.ctyname) else None
        county = UTAH_COUNTIES.get(row.cty, raw_county)
        house  = _clean_distname(row.stsldlname) if pd.notna(row.stsldlname) else None
        senate = _clean_distname(row.stslduname) if pd.notna(row.stslduname) else None
        lookup[row.tabblk2020] = {
            "city_name":    city,
            "county_name":  county,
            "county_fips":  row.cty,
            "place_fips":   row.stplc,
            "house_name":   house,
            "house_fips":   row.stsldl if pd.notna(row.stsldl) else None,
            "senate_name":  senate,
            "senate_fips":  row.stsldu if pd.notna(row.stsldu) else None,
            "lat": float(row.blklatdd) if pd.notna(row.blklatdd) else None,
            "lon": float(row.blklondd) if pd.notna(row.blklondd) else None,
        }
    return lookup


def merge_taz_lookup(lookup, taz_lookup):
    """Merge TAZ planning-district fields (small/medium/large/super_name) onto
    the block lookup dict produced by build_lookup(). Mutates and returns lookup.
    Blocks with no TAZ match (see taz_districts.build_taz_lookup) are left with
    the keys absent, and join_od_with_lookup's .get() calls fall back to None."""
    for block, entry in taz_lookup.items():
        if block in lookup:
            lookup[block].update(entry)
    return lookup


def merge_workshop_lookup(lookup, workshop_lookup):
    """Merge the Wasatch Front Workshop Area name onto the block lookup dict.
    Most blocks won't match (Workshop Areas only cover the Wasatch Front, not
    statewide) — those are left with the key absent, same fallback-to-None
    pattern as merge_taz_lookup."""
    for block, name in workshop_lookup.items():
        if block in lookup:
            lookup[block]["workshop_name"] = name
    return lookup


def join_od_with_lookup(od, lookup):
    """Add home/work city, county, and block centroid columns to OD dataframe."""
    print("  Joining OD with crosswalk...")
    od["h_city"]     = od["h_geocode"].map(lambda g: lookup.get(g, {}).get("city_name"))
    od["h_county"]   = od["h_geocode"].map(lambda g: lookup.get(g, {}).get("county_name"))
    od["h_cty"]      = od["h_geocode"].map(lambda g: lookup.get(g, {}).get("county_fips"))
    od["h_plc"]      = od["h_geocode"].map(lambda g: lookup.get(g, {}).get("place_fips"))
    od["h_blk_lat"]  = od["h_geocode"].map(lambda g: lookup.get(g, {}).get("lat"))
    od["h_blk_lon"]  = od["h_geocode"].map(lambda g: lookup.get(g, {}).get("lon"))

    od["w_city"]     = od["w_geocode"].map(lambda g: lookup.get(g, {}).get("city_name"))
    od["w_county"]   = od["w_geocode"].map(lambda g: lookup.get(g, {}).get("county_name"))
    od["w_cty"]      = od["w_geocode"].map(lambda g: lookup.get(g, {}).get("county_fips"))
    od["w_blk_lat"]  = od["w_geocode"].map(lambda g: lookup.get(g, {}).get("lat"))
    od["w_blk_lon"]  = od["w_geocode"].map(lambda g: lookup.get(g, {}).get("lon"))

    od["h_house"]    = od["h_geocode"].map(lambda g: lookup.get(g, {}).get("house_name"))
    od["w_house"]    = od["w_geocode"].map(lambda g: lookup.get(g, {}).get("house_name"))
    od["h_senate"]   = od["h_geocode"].map(lambda g: lookup.get(g, {}).get("senate_name"))
    od["w_senate"]   = od["w_geocode"].map(lambda g: lookup.get(g, {}).get("senate_name"))

    # Planning Boundaries geography (TAZ-derived), merged onto lookup by merge_taz_lookup()
    for level in taz_districts.LEVELS:
        key = f"{level}_name"
        od[f"h_{level}"] = od["h_geocode"].map(lambda g: lookup.get(g, {}).get(key))
        od[f"w_{level}"] = od["w_geocode"].map(lambda g: lookup.get(g, {}).get(key))

    # Wasatch Front Workshop Areas (hidden geography), merged onto lookup by merge_workshop_lookup()
    od["h_workshop"] = od["h_geocode"].map(lambda g: lookup.get(g, {}).get("workshop_name"))
    od["w_workshop"] = od["w_geocode"].map(lambda g: lookup.get(g, {}).get("workshop_name"))

    return od


def mark_out_of_state(od):
    """Label home/work geocodes outside Utah (non-49 FIPS prefix) as 'Out of State'.

    Aux file rows have work in Utah but home in another state — the Utah crosswalk
    leaves those h_geocode lookups as NaN, and pandas groupby silently drops NaN
    keys, so we must assign a concrete label before aggregation.
    Main file rows are all Utah–Utah; this is a no-op for them.
    """
    oos_home = ~od["h_geocode"].str.startswith("49")
    nh = oos_home.sum()
    if nh:
        od.loc[oos_home, "h_city"]   = "Out of State"
        od.loc[oos_home, "h_county"] = "Out of State"
        od.loc[oos_home, "h_cty"]    = "00000"
        od.loc[oos_home, "h_house"]  = "Out of State"
        od.loc[oos_home, "h_senate"] = "Out of State"
        for level in taz_districts.LEVELS:
            od.loc[oos_home, f"h_{level}"] = "Out of State"
        od.loc[oos_home, "h_workshop"] = "Out of State"
        print(f"  Out-of-state home records: {nh:,}")

    oos_work = ~od["w_geocode"].str.startswith("49")
    nw = oos_work.sum()
    if nw:
        od.loc[oos_work, "w_city"]   = "Out of State"
        od.loc[oos_work, "w_county"] = "Out of State"
        od.loc[oos_work, "w_cty"]    = "00000"
        od.loc[oos_work, "w_house"]  = "Out of State"
        od.loc[oos_work, "w_senate"] = "Out of State"
        for level in taz_districts.LEVELS:
            od.loc[oos_work, f"w_{level}"] = "Out of State"
        od.loc[oos_work, "w_workshop"] = "Out of State"
        print(f"  Out-of-state work records: {nw:,}")

    return od


def filter_utah(od):
    """Keep all rows — LODES files are already Utah-specific (main: both sides Utah;
    aux: work in Utah, home out-of-state), so no county-level filtering is needed."""
    print(f"  Utah OD rows: {len(od):,}")
    return od


def fill_unincorporated(od):
    """Blocks with no place name get '[County] Unincorporated' as city label."""
    h_mask = od["h_city"].isna()
    od.loc[h_mask, "h_city"] = od.loc[h_mask, "h_county"].apply(
        lambda c: f"{c} Unincorporated" if pd.notna(c) else "Unincorporated"
    )
    w_mask = od["w_city"].isna()
    od.loc[w_mask, "w_city"] = od.loc[w_mask, "w_county"].apply(
        lambda c: f"{c} Unincorporated" if pd.notna(c) else "Unincorporated"
    )
    return od


def _haversine_miles_vec(lat1, lon1, lat2, lon2):
    """Vectorized haversine distance in miles. Inputs are pandas Series or numpy arrays."""
    R    = 3958.8
    rlat1 = np.radians(lat1)
    rlat2 = np.radians(lat2)
    dlat  = np.radians(lat2 - lat1)
    dlon  = np.radians(lon2 - lon1)
    a = np.sin(dlat / 2) ** 2 + np.cos(rlat1) * np.cos(rlat2) * np.sin(dlon / 2) ** 2
    return R * 2 * np.arctan2(np.sqrt(a), np.sqrt(1 - a))


def add_distance_bands(od):
    """Add distance-band count columns and block-level weighted-distance aggregates.

    Band thresholds match the frontend REACH_BANDS: <5, 5-10, 10-25, 25-50, 50-100, 100+ miles.
    Rows missing either block coordinate contribute 0 to all band/distance columns.

    New columns:
      dist_wsum — Σ(S000 × miles) per block pair; sum across pairs gives weighted total
      dist_n    — Σ(S000) for pairs with valid block coordinates; use as denominator
    """
    valid = od["h_blk_lat"].notna() & od["w_blk_lat"].notna()
    miles = pd.Series(np.nan, index=od.index, dtype="float64")
    if valid.any():
        miles.loc[valid] = _haversine_miles_vec(
            od.loc[valid, "h_blk_lat"].values,
            od.loc[valid, "h_blk_lon"].values,
            od.loc[valid, "w_blk_lat"].values,
            od.loc[valid, "w_blk_lon"].values,
        )
    s = od["S000"].fillna(0)
    # NaN comparisons return False, so missing-coord rows fall through to 0
    od["d0_5"]    = s.where(miles <   5,                        0)
    od["d5_10"]   = s.where((miles >=   5) & (miles <  10),     0)
    od["d10_25"]  = s.where((miles >=  10) & (miles <  25),     0)
    od["d25_50"]  = s.where((miles >=  25) & (miles <  50),     0)
    od["d50_100"] = s.where((miles >=  50) & (miles < 100),     0)
    od["d100p"]   = s.where(miles >= 100,                       0)
    # Weighted-distance aggregates for exact avg/median in the frontend
    od["dist_wsum"] = (s * miles).fillna(0).astype("float32")
    od["dist_n"]    = s.where(valid, 0)
    pct = valid.mean() * 100
    print(f"  Block-level distance coverage: {valid.sum():,}/{len(od):,} pairs ({pct:.1f}%)")
    return od


def aggregate_city_flows(od):
    cols = AGG_COLS + BAND_COLS + DIST_COLS
    grouped = (
        od.groupby(["h_city", "w_city", "h_county", "w_county"])[cols]
        .sum()
        .reset_index()
    )
    grouped.columns = ["home_name", "work_name", "home_county", "work_county"] + cols
    grouped = grouped[grouped["S000"] > 0]
    print(f"  City flow pairs: {len(grouped):,}")
    return grouped


def aggregate_county_flows(od):
    cols = AGG_COLS + BAND_COLS + DIST_COLS
    grouped = (
        od.groupby(["h_county", "w_county"])[cols]
        .sum()
        .reset_index()
    )
    grouped.columns = ["home_county", "work_county"] + cols
    grouped = grouped[grouped["S000"] > 0]
    print(f"  County flow pairs: {len(grouped):,}")
    return grouped


def aggregate_district_flows(od):
    """Aggregate OD flows by all geographic levels (house, senate, city, county,
    plus the hidden Wasatch Front Workshop Area geography).

    A single parquet supports every cross-level district query:
    house↔house, house↔senate, senate↔senate, house↔city, house↔county,
    senate↔city, senate↔county, workshop↔{house,senate,city,county}, and
    the reverses. Rows with null district assignments (rare for house/senate/
    city/county; the norm for workshop, which only covers the Wasatch Front)
    are kept via dropna=False.
    """
    cols = AGG_COLS + BAND_COLS + DIST_COLS
    grouped = (
        od.groupby(
            ["h_house", "w_house", "h_senate", "w_senate",
             "h_city",  "w_city",  "h_county", "w_county",
             "h_workshop", "w_workshop"],
            dropna=False,
        )[cols]
        .sum()
        .reset_index()
    )
    grouped.columns = [
        "home_house", "work_house", "home_senate", "work_senate",
        "home_name",  "work_name",  "home_county", "work_county",
        "home_workshop", "work_workshop",
    ] + cols
    grouped = grouped[grouped["S000"] > 0]
    print(f"  District flow pairs: {len(grouped):,}")
    return grouped


def aggregate_planning_flows(od):
    """Aggregate OD flows by all four Planning Boundaries levels (small, medium,
    large, super district) — the Planning Boundaries mode's equivalent of
    aggregate_district_flows(). A single parquet supports every cross-level
    query within the mode (small↔medium, small↔large, ..., super↔super).
    Rows with null TAZ assignments (rare) are kept via dropna=False.
    """
    cols = AGG_COLS + BAND_COLS + DIST_COLS
    grouped = (
        od.groupby(
            ["h_small",  "w_small",  "h_medium", "w_medium",
             "h_large",  "w_large",  "h_super",  "w_super"],
            dropna=False,
        )[cols]
        .sum()
        .reset_index()
    )
    grouped.columns = [
        "home_small",  "work_small",  "home_medium", "work_medium",
        "home_large",  "work_large",  "home_super",  "work_super",
    ] + cols
    grouped = grouped[grouped["S000"] > 0]
    print(f"  Planning district flow pairs: {len(grouped):,}")
    return grouped


def load_tiger_places():
    local = download_cached(PLACES_URL, "tl_2024_49_place.zip")
    places = gpd.read_file(local)
    places = places.to_crs(epsg=4326)
    # Use Census internal point (hand-designated, always inside the place boundary)
    # instead of geometry.centroid, which breaks for irregular/multi-part polygons.
    places["lat"] = places["INTPTLAT"].astype(float)
    places["lon"] = places["INTPTLON"].astype(float)
    # Build a 7-char full FIPS (state + place) to match xwalk stplc format
    places["FULL_PLACEFP"] = places["STATEFP"] + places["PLACEFP"]
    return places


def load_tiger_counties():
    local = download_cached(COUNTIES_URL, "tl_2024_us_county.zip")
    counties = gpd.read_file(local)
    # Filter to Utah (STATEFP = 49) before extracting centroids
    counties = counties[counties["STATEFP"] == "49"].copy()
    counties = counties.to_crs(epsg=4326)
    # Use Census internal point (hand-designated, always inside the county boundary)
    counties["lat"] = counties["INTPTLAT"].astype(float)
    counties["lon"] = counties["INTPTLON"].astype(float)
    counties["COUNTYFP_full"] = counties["STATEFP"] + counties["COUNTYFP"]
    return counties


def _clean_stplcname(s):
    """'Salt Lake City city, Utah' -> 'Salt Lake City'"""
    if not pd.notna(s) or not s:
        return s
    s = s.split(",")[0].strip()  # drop ', Utah'
    parts = s.rsplit(" ", 1)
    if len(parts) == 2 and parts[1].lower() in (
        "city", "town", "village", "borough", "cdp", "township", "municipality"
    ):
        return parts[0].strip()
    return s


# Manual centroid overrides for places where the Census boundary produces a
# misleading centroid (e.g. large uninhabited annexations skewing the point).
# Keyed by city name as it appears in the flow data.
CENTROID_OVERRIDES = {
    # Census boundary includes a large Great Salt Lake arm; true population
    # center is ~15 mi east of the TIGER internal point.
    "Hooper": (41.178632, -112.142319),
}


def load_tiger_sldl():
    """Download (cached) Utah State House (Lower) district TIGER shapefile."""
    local = download_cached(SLDL_URL, "tl_2024_49_sldl.zip")
    sldl = gpd.read_file(local).to_crs(epsg=4326)
    sldl["lat"] = sldl["INTPTLAT"].astype(float)
    sldl["lon"] = sldl["INTPTLON"].astype(float)
    # 5-char FIPS = state(2) + district(3), matches crosswalk stsldl after zfill(5)
    sldl["FULL_SLDLFP"] = sldl["STATEFP"] + sldl["SLDLST"].str.zfill(3)
    return sldl


def load_tiger_sldu():
    """Download (cached) Utah State Senate (Upper) district TIGER shapefile."""
    local = download_cached(SLDU_URL, "tl_2024_49_sldu.zip")
    sldu = gpd.read_file(local).to_crs(epsg=4326)
    sldu["lat"] = sldu["INTPTLAT"].astype(float)
    sldu["lon"] = sldu["INTPTLON"].astype(float)
    sldu["FULL_SLDUFP"] = sldu["STATEFP"] + sldu["SLDUST"].str.zfill(3)
    return sldu


def build_house_meta(sldl):
    """Build metadata list for all 75 Utah House districts from TIGER SLDL."""
    meta = []
    for _, row in sldl.iterrows():
        name = _clean_distname(row["NAMELSAD"])
        meta.append({
            "name":       name,
            "house_fips": row["FULL_SLDLFP"],
            "lat":        float(row["lat"]),
            "lon":        float(row["lon"]),
        })
    return sorted(meta, key=lambda x: x["name"])


def build_senate_meta(sldu):
    """Build metadata list for all 29 Utah Senate districts from TIGER SLDU."""
    meta = []
    for _, row in sldu.iterrows():
        name = _clean_distname(row["NAMELSAD"])
        meta.append({
            "name":        name,
            "senate_fips": row["FULL_SLDUFP"],
            "lat":         float(row["lat"]),
            "lon":         float(row["lon"]),
        })
    return sorted(meta, key=lambda x: x["name"])


def build_city_meta(city_flows, xw, places):
    """Build city metadata: name, county, county_fips, lat, lon, place_fips."""
    city_county_pairs = set(
        zip(city_flows["home_name"], city_flows["home_county"])
    ) | set(
        zip(city_flows["work_name"], city_flows["work_county"])
    )

    # Build name → full 7-char place FIPS using the SAME cleaning logic as build_lookup
    # xwalk stplc is already 7 chars (state+place); TIGER FULL_PLACEFP matches this
    xw_clean = xw[xw["stplcname"].notna() & xw["stplc"].notna()].copy()
    xw_clean["clean_name"] = xw_clean["stplcname"].apply(_clean_stplcname)
    # Primary lookup keyed by (name, county_fips) — handles same name in different
    # counties (e.g. "Enterprise CDP" in Morgan Co. vs "Enterprise city" in Washington Co.)
    name_county_to_plc = (
        xw_clean.drop_duplicates(["clean_name", "cty"])
        .set_index(["clean_name", "cty"])["stplc"]
        .to_dict()
    )
    # Fallback: name-only for places with no county ambiguity
    name_to_plc = (
        xw_clean.drop_duplicates("clean_name")
        .set_index("clean_name")["stplc"]
        .to_dict()
    )

    cty_name_to_fips = {v: k for k, v in UTAH_COUNTIES.items()}
    places_idx = places.set_index("FULL_PLACEFP")

    # Build place_fips → place_type mapping ("cdp" or "city")
    plc_to_type = (
        xw_clean.drop_duplicates("stplc")
        .assign(type_label=lambda df: df["stplcname"].apply(
            lambda s: "cdp" if _get_type_label(s) == "CDP" else "city"
        ))
        .set_index("stplc")["type_label"]
        .to_dict()
    )

    meta = []
    unmatched = []

    for city_name, county_name in sorted(city_county_pairs):
        if city_name == "Out of State":
            continue
        county_fips = cty_name_to_fips.get(county_name, "")
        # Strip any parenthetical disambiguation suffix before FIPS lookup
        # e.g. "Enterprise (CDP)" -> "Enterprise", "Enterprise (City)" -> "Enterprise"
        base_name = re.sub(r'\s*\([^)]+\)\s*$', '', city_name)
        place_fips = name_county_to_plc.get((base_name, county_fips)) or name_to_plc.get(base_name)
        lat, lon = None, None

        if city_name in CENTROID_OVERRIDES:
            lat, lon = CENTROID_OVERRIDES[city_name]
        elif place_fips and place_fips in places_idx.index:
            row = places_idx.loc[place_fips]
            if isinstance(row, pd.DataFrame):
                row = row.iloc[0]
            lat = float(row["lat"])
            lon = float(row["lon"])
        else:
            unmatched.append(city_name)

        meta.append({
            "name": city_name,
            "county": county_name,
            "county_fips": county_fips,
            "lat": lat,
            "lon": lon,
            "place_fips": place_fips or "",
            "place_type": plc_to_type.get(place_fips, "city") if place_fips else "city",
        })

    if unmatched:
        print(f"  WARNING: {len(unmatched)} cities without centroid (likely unincorporated areas): {sorted(set(unmatched))[:10]}")

    return meta


def build_county_meta(counties):
    """Build county metadata for all 29 Utah counties."""
    counties_idx = counties.set_index("COUNTYFP_full")
    meta = []
    for fips, name in UTAH_COUNTIES.items():
        if fips in counties_idx.index:
            row = counties_idx.loc[fips]
            # loc returns a Series for a single match, DataFrame for multiple
            if isinstance(row, pd.DataFrame):
                row = row.iloc[0]
            meta.append({
                "name": name,
                "county_fips": fips,
                "lat": float(row["lat"]),
                "lon": float(row["lon"]),
            })
        else:
            print(f"  WARNING: County FIPS {fips} ({name}) not found in TIGER")
    return meta


def export_parquet(df, path, int_cols):
    """Write DataFrame to Parquet with Snappy compression."""
    for col in int_cols:
        if col in df.columns:
            df[col] = df[col].fillna(0).astype("int32")
    table = pa.Table.from_pandas(df, preserve_index=False)
    pq.write_table(table, path, compression="snappy")
    size_kb = Path(path).stat().st_size / 1024
    print(f"  Wrote {path.name} ({len(df):,} rows, {size_kb:.1f} KB)")


def generate_boundaries(places=None, counties=None, sldl=None, sldu=None,
                        force=False, disambig=None):
    """Generate static boundary GeoJSON files for county, city, house, and senate districts.

    Writes to data/{county,city,house,senate}_boundaries.geojson.
    Skips if all four files already exist unless force=True.
    disambig: optional {place_fips: disambiguated_name} from _detect_name_collisions.
    """
    county_out = DATA_DIR / "county_boundaries.geojson"
    city_out   = DATA_DIR / "city_boundaries.geojson"
    house_out  = DATA_DIR / "house_boundaries.geojson"
    senate_out = DATA_DIR / "senate_boundaries.geojson"

    if not force and all(p.exists() for p in [county_out, city_out, house_out, senate_out]):
        print("  Boundary files already exist, skipping.")
        return

    if places is None:
        print("  Loading TIGER places for boundaries...")
        places = load_tiger_places()
    if counties is None:
        print("  Loading TIGER counties for boundaries...")
        counties = load_tiger_counties()
    if sldl is None:
        print("  Loading TIGER SLDL for boundaries...")
        sldl = load_tiger_sldl()
    if sldu is None:
        print("  Loading TIGER SLDU for boundaries...")
        sldu = load_tiger_sldu()

    # ── County boundaries ─────────────────────────────────────────────────────
    ut_gdf = counties[counties["COUNTYFP_full"].isin(UTAH_COUNTIES)].copy()
    ut_gdf["name"] = ut_gdf["COUNTYFP_full"].map(UTAH_COUNTIES)
    county_gdf = ut_gdf[["name", "geometry"]].copy()
    county_gdf = county_gdf.to_crs(epsg=26912)
    county_gdf = topo_simplify(county_gdf, tolerance=150)
    county_gdf = county_gdf.to_crs(epsg=4326)
    county_gdf.to_file(county_out, driver="GeoJSON")
    print(f"  Wrote {county_out.name} ({len(county_gdf)} county polygons)")

    # ── City/place boundaries ─────────────────────────────────────────────────
    places_in = places.copy()
    if disambig:
        places_in["name"] = places_in.apply(
            lambda r: disambig.get(r["FULL_PLACEFP"]) or _clean_stplcname(r["NAMELSAD"]),
            axis=1,
        )
    else:
        places_in["name"] = places_in["NAMELSAD"].apply(_clean_stplcname)
    city_gdf = places_in[["name", "geometry"]].copy()
    city_gdf = city_gdf.to_crs(epsg=26912)
    city_gdf = topo_simplify(city_gdf, tolerance=80)
    city_gdf = custom_places.append_custom_boundaries(city_gdf)
    city_gdf = city_gdf.to_crs(epsg=4326)
    city_gdf.to_file(city_out, driver="GeoJSON")
    print(f"  Wrote {city_out.name} ({len(city_gdf)} city polygons)")

    # ── House district boundaries ─────────────────────────────────────────────
    # Use topology-preserving simplification so shared edges between adjacent
    # districts are simplified identically, preventing gaps/holes.
    house_gdf = sldl[["NAMELSAD", "geometry"]].copy()
    house_gdf["name"] = house_gdf["NAMELSAD"].apply(_clean_distname)
    house_gdf = house_gdf[["name", "geometry"]].to_crs(epsg=26912)
    house_gdf = topo_simplify(house_gdf, tolerance=150)
    house_gdf = house_gdf.to_crs(epsg=4326)
    house_gdf.to_file(house_out, driver="GeoJSON")
    print(f"  Wrote {house_out.name} ({len(house_gdf)} house district polygons)")

    # ── Senate district boundaries ────────────────────────────────────────────
    senate_gdf = sldu[["NAMELSAD", "geometry"]].copy()
    senate_gdf["name"] = senate_gdf["NAMELSAD"].apply(_clean_distname)
    senate_gdf = senate_gdf[["name", "geometry"]].to_crs(epsg=26912)
    senate_gdf = topo_simplify(senate_gdf, tolerance=150)
    senate_gdf = senate_gdf.to_crs(epsg=4326)
    senate_gdf.to_file(senate_out, driver="GeoJSON")
    print(f"  Wrote {senate_out.name} ({len(senate_gdf)} senate district polygons)")


def update_manifest(year_int):
    """Add year to data/manifest.json; create the file if it doesn't exist."""
    manifest_path = DATA_DIR / "manifest.json"
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text())
    else:
        manifest = {"years": [], "default": None}

    if year_int not in manifest["years"]:
        manifest["years"].append(year_int)
        manifest["years"].sort()
    manifest["default"] = max(manifest["years"])

    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"  Updated manifest.json: years={manifest['years']}, default={manifest['default']}")


def main():
    parser = argparse.ArgumentParser(description="Utah Commute Patterns Data Pipeline")
    parser.add_argument(
        "--year", type=int, metavar="YYYY",
        help="LODES year to process (default: auto-detect latest available, 2002-2023)"
    )
    parser.add_argument(
        "--boundaries", action="store_true",
        help="Generate/regenerate boundary GeoJSON files only (year-independent)"
    )
    parser.add_argument(
        "--skip-acs", action="store_true",
        help="Skip ACS data fetch (useful when Census API is unavailable)"
    )
    args = parser.parse_args()

    if args.boundaries:
        print("=== Generating Boundary Files ===\n")
        xw = load_xwalk()
        disambig = _detect_name_collisions(xw)
        sldl = load_tiger_sldl()
        sldu = load_tiger_sldu()
        generate_boundaries(sldl=sldl, sldu=sldu, force=True, disambig=disambig)
        taz_districts.generate_planning_boundaries(force=True)
        workshop_areas.generate_workshop_boundaries(force=True)
        custom_places.export_for_app(DATA_DIR)
        print("\nDone!")
        return

    print("=== Utah Commute Patterns Data Pipeline ===\n")

    # 1. Load OD data
    print("1. Loading LEHD OD data...")
    od_years = [str(args.year)] if args.year else LODES_YEARS_DEFAULT
    od, year = load_od(od_years)

    # 1b. Load outflow OD from neighboring states (their aux files, filtered for
    #     Utah home blocks).  Concatenated before crosswalk join so h_city gets
    #     resolved by the normal Utah lookup pipeline.
    print("\n1b. Loading outflow OD data from neighboring states...")
    nb_outflow = neighbor_zones.load_outflow_od(year, CACHE_DIR, download_cached)
    if not nb_outflow.empty:
        od = pd.concat([od, nb_outflow], ignore_index=True)
        print(f"  Combined OD records (main + aux + outflow): {len(od):,}")

    # 2. Set up year-specific output directory
    year_dir = DATA_DIR / "lehd" / str(year)
    year_dir.mkdir(parents=True, exist_ok=True)
    print(f"  Output directory: {year_dir}")

    # 3. Load crosswalk
    print("\n2. Loading LEHD crosswalk...")
    xw = load_xwalk()

    # 3b. Build neighbor zone database (one-time download + cache)
    print("\n2b. Building neighboring-state zone database...")
    nb_all_zones = neighbor_zones.build_neighbor_zones(CACHE_DIR, download_cached)
    nb_border_fips, nb_border_zone_names = neighbor_zones.get_border_zone_set(
        CACHE_DIR, download_cached, nb_all_zones
    )

    # 4. Build block-level lookup (compute name collision map once; reused by boundaries)
    print("\n3. Building block -> city/county lookup...")
    disambig = _detect_name_collisions(xw)
    lookup = build_lookup(xw, disambig)
    block_map = custom_places.get_custom_block_map(xw)
    lookup = custom_places.apply_custom_places(lookup, block_map)
    print(f"  Lookup entries: {len(lookup):,}")

    # 4b. Merge TAZ planning-district fields (small/medium/large/super) onto lookup
    print("\n3b. Building block -> TAZ planning-district lookup...")
    taz_lookup = taz_districts.build_taz_lookup(xw)
    lookup = merge_taz_lookup(lookup, taz_lookup)

    # 4c. Merge Wasatch Front Workshop Area field onto lookup (hidden geography)
    print("\n3c. Building block -> workshop area lookup...")
    workshop_lookup = workshop_areas.build_workshop_lookup(xw)
    lookup = merge_workshop_lookup(lookup, workshop_lookup)

    # 5. Join OD with lookup
    print("\n4. Joining OD with crosswalk...")
    od = join_od_with_lookup(od, lookup)
    od = mark_out_of_state(od)

    # 6. Use all Utah rows (LODES files are already Utah-specific)
    print("\n5. Using statewide Utah OD data...")
    od_wfrc = filter_utah(od)

    # 7. Fill unincorporated areas
    print("\n6. Filling unincorporated area names...")
    od_wfrc = fill_unincorporated(od_wfrc)

    # 6b. Process cross-state commute flows (before distance bands; Utah city names
    #     are now fully resolved via fill_unincorporated above)
    print("\n6b. Processing cross-state commute flows...")
    nb_block_lookup = neighbor_zones.resolve_neighbor_blocks(
        od_wfrc, CACHE_DIR, download_cached
    )
    nb_flows = neighbor_zones.process_neighbor_flows(
        od_wfrc, nb_block_lookup, nb_border_fips, _haversine_miles_vec
    )

    # 8. Compute block-level distance bands, then aggregate
    print("\n7. Computing distance bands...")
    od_wfrc = add_distance_bands(od_wfrc)

    print("\n8. Aggregating flows...")
    city_flows     = aggregate_city_flows(od_wfrc)
    county_flows   = aggregate_county_flows(od_wfrc)
    district_flows = aggregate_district_flows(od_wfrc)
    planning_flows = aggregate_planning_flows(od_wfrc)

    # 9. Load TIGER shapefiles
    print("\n9. Loading TIGER shapefiles for centroids and boundaries...")
    places   = load_tiger_places()
    counties = load_tiger_counties()
    sldl     = load_tiger_sldl()
    sldu     = load_tiger_sldu()

    # 10. Generate boundary GeoJSON files if needed (uses already-loaded TIGER data)
    print("\n10. Generating boundary files (if needed)...")
    generate_boundaries(places, counties, sldl, sldu, disambig=disambig)
    taz_districts.generate_planning_boundaries()
    workshop_areas.generate_workshop_boundaries()
    print("\n10b. Exporting custom place info for app display...")
    custom_places.export_for_app(DATA_DIR)

    # 11. Build metadata
    print("\n11. Building metadata...")
    city_meta     = build_city_meta(city_flows, xw, places)
    city_meta     = custom_places.inject_custom_meta(city_meta)
    county_meta   = build_county_meta(counties)
    house_meta    = build_house_meta(sldl)
    senate_meta   = build_senate_meta(sldu)
    planning_meta = {level: taz_districts.build_planning_meta(level) for level in taz_districts.LEVELS}
    workshop_meta = workshop_areas.build_workshop_meta()
    print(f"  City metadata entries: {len(city_meta)}")
    print(f"  County metadata entries: {len(county_meta)}")
    print(f"  House district entries: {len(house_meta)}")
    print(f"  Senate district entries: {len(senate_meta)}")
    for level, meta in planning_meta.items():
        print(f"  {level.capitalize()} district entries: {len(meta)}")
    print(f"  Workshop area entries: {len(workshop_meta)}")

    # 12. Export Parquet files
    print("\n12. Exporting data files...")
    # int_cols excludes dist_wsum (float) — it is written as-is from the DataFrame
    export_parquet(city_flows,     year_dir / "city_flows.parquet",     AGG_COLS + BAND_COLS)
    export_parquet(county_flows,   year_dir / "county_flows.parquet",   AGG_COLS + BAND_COLS)
    export_parquet(district_flows, year_dir / "district_flows.parquet", AGG_COLS + BAND_COLS)
    export_parquet(planning_flows, year_dir / "planning_flows.parquet", AGG_COLS + BAND_COLS)
    neighbor_zones.export_neighbor_flows(year_dir, nb_flows)
    neighbor_zones.build_and_export_meta(year_dir, nb_all_zones, nb_border_zone_names)

    # 13. Export JSON metadata
    with open(year_dir / "city_meta.json", "w") as f:
        json.dump(city_meta, f, indent=2)
    print(f"  Wrote city_meta.json ({len(city_meta)} entries)")

    with open(year_dir / "county_meta.json", "w") as f:
        json.dump(county_meta, f, indent=2)
    print(f"  Wrote county_meta.json ({len(county_meta)} entries)")

    with open(year_dir / "house_meta.json", "w") as f:
        json.dump(house_meta, f, indent=2)
    print(f"  Wrote house_meta.json ({len(house_meta)} entries)")

    with open(year_dir / "senate_meta.json", "w") as f:
        json.dump(senate_meta, f, indent=2)
    print(f"  Wrote senate_meta.json ({len(senate_meta)} entries)")

    for level, meta in planning_meta.items():
        with open(year_dir / f"{level}_meta.json", "w") as f:
            json.dump(meta, f, indent=2)
        print(f"  Wrote {level}_meta.json ({len(meta)} entries)")

    with open(year_dir / "workshop_meta.json", "w") as f:
        json.dump(workshop_meta, f, indent=2)
    print(f"  Wrote workshop_meta.json ({len(workshop_meta)} entries)")

    # 14. Update manifest
    print("\n13. Updating manifest...")
    update_manifest(int(year))

    # 15. Fetch ACS commute data
    if not args.skip_acs:
        print("\n14. Fetching ACS commute data...")
        fetch_acs.fetch_acs_year(int(year), DATA_DIR, xw=xw)
    else:
        print("\n14. ACS fetch skipped (--skip-acs).")

    print(f"\n=== Done! Data year: {year}. Files in {year_dir} ===")


if __name__ == "__main__":
    main()
