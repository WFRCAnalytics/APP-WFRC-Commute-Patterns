# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "pandas>=2.0",
#   "geopandas>=0.14",
#   "pyarrow>=14",
#   "requests>=2.31",
#   "shapely>=2.0",
# ]
# ///
"""
ACS 5-year commute data fetcher.

Downloads Means of Transportation (B08301/B08601) and Travel Time to Work
(B08303/B08603) from the Census ACS 5-year API for all Utah places and
all Utah counties.

Output per year:
  data/acs/{year}/acs_city.json    — keyed by 7-digit place FIPS ("4967000")
  data/acs/{year}/acs_county.json  — keyed by 5-digit county FIPS ("49035")
  data/acs/{year}/acs_house.json   — keyed by 5-digit House district FIPS
  data/acs/{year}/acs_senate.json  — keyed by 5-digit Senate district FIPS
  data/acs/{year}/acs_area.json    — keyed by display type then area name:
                                     "city" (<County> Unincorporated), small,
                                     medium, large, super, workshop, mag_workshop

Every table entry carries its margins of error and provenance:
  {"total": 1234, "drove": ..., "moe": {"total": 80, ...},
   "src": "native" | "derived", "q": "ok" | "low"}
"native" values are the Census's own; "derived" values are built from block
groups / tracts by acs_derive.py for areas the Census does not publish
(places missing from a year, Unincorporated, custom places, districts,
planning and workshop areas). Derived values too imprecise to show are
replaced by {"res": null, "wrk": null, "suppressed": true}.

ACS 5-year is available from 2009 onward; earlier years produce no output and
the app shows blank/NA charts for those.

Residence geography (B083xx): commute characteristics of workers who LIVE in
  each place/county.
Workplace geography (B086xx): commute characteristics of workers who WORK in
  each place/county. Not all places have sufficient sample; those return null.
"""

import json
import os
import time
import requests
from pathlib import Path

ACS_START_YEAR = 2009
ACS_BASE = "https://api.census.gov/data"
STATE = "49"  # Utah FIPS

# Load Census API key from .env in the project root (two levels up from scripts/)
_ENV_FILE = Path(__file__).parent.parent / ".env"
_CENSUS_KEY = None
if _ENV_FILE.exists():
    for line in _ENV_FILE.read_text().splitlines():
        if "CENSUS_API_KEY" in line:
            _CENSUS_KEY = line.split("=", 1)[1].strip().strip("'\"")
            break
if not _CENSUS_KEY:
    _CENSUS_KEY = os.environ.get("CENSUS_API_KEY")


# Residence transportation + travel time (B08301 + B08303)
RES_VARS = [
    "B08301_001E", "B08301_003E", "B08301_004E", "B08301_010E",
    "B08301_018E", "B08301_019E", "B08301_020E", "B08301_021E",
] + [f"B08303_{i:03d}E" for i in range(1, 14)]

# Workplace transportation + travel time (B08601 + B08603)
WRK_VARS = [
    "B08601_001E", "B08601_003E", "B08601_004E", "B08601_010E",
    "B08601_018E", "B08601_019E", "B08601_020E", "B08601_021E",
] + [f"B08603_{i:03d}E" for i in range(1, 14)]


def moe_vars(variables):
    """Margin-of-error variable names ('B08301_001E' -> 'B08301_001M')."""
    return [v[:-1] + "M" for v in variables]


def _num(val, moe=False):
    """Census value -> number. Negative values are annotations: an estimate
    becomes None, a margin of error (e.g. -555555555, 'controlled') becomes 0."""
    try:
        v = float(val)
    except (TypeError, ValueError):
        return 0.0 if moe else None
    if v < 0:
        return 0.0 if moe else None
    return v


# key -> ACS variable numbers summed into it
_TRANS_PARTS = {"total": [1], "drove": [3], "carpool": [4], "transit": [10],
                "bike": [18], "walk": [19], "other": [20], "wfh": [21]}
_TIME_PARTS = {
    "total":   [1],
    "lt10":    [2, 3],         # <5 + 5-9 min
    "t10_19":  [4, 5],         # 10-14 + 15-19
    "t20_29":  [6, 7],         # 20-24 + 25-29
    "t30_44":  [8, 9, 10],     # 30-34 + 35-39 + 40-44
    "t45_59":  [11],           # 45-59
    "t60plus": [12, 13],       # 60-89 + 90+
}


def parse_table(row, headers, prefix, table):
    """One ACS table of one row -> {key: (estimate|None, moe)}, or None when the
    table has no total. Grouped keys sum their parts' estimates; their margin
    of error is the root of the summed squares (Census guidance for sums)."""
    parts_map = _TRANS_PARTS if table == "trans" else _TIME_PARTS
    out = {}
    for key, nums in parts_map.items():
        ests, moes = [], []
        for n in nums:
            try:
                e = _num(row[headers.index(f"{prefix}_{n:03d}E")])
                m = _num(row[headers.index(f"{prefix}_{n:03d}M")], moe=True)
            except ValueError:
                continue
            if e is not None:
                ests.append(e)
                moes.append(m)
        out[key] = (sum(ests), sum(m * m for m in moes) ** 0.5) if ests else (None, 0.0)
    total = out["total"][0]
    return out if total else None


def make_entry(parsed, src, ok_rel=0.20, suppress_above=None):
    """parsed {key: (est, moe)} -> app entry, or None.

    q is 'ok' when MOE/estimate of the total is <= ok_rel (default 0.20, the
    Census's own ~12% CV) and 'low' above it. With suppress_above, an entry whose
    total's MOE/estimate exceeds that value is dropped (None) - used for derived
    values only; published Census values are always kept and just flagged.
    """
    if not parsed:
        return None
    total, total_moe = parsed["total"]
    if not total or total < 0.5:
        return None
    rel = total_moe / total
    if suppress_above is not None and rel > suppress_above:
        return None
    entry = {k: (None if e is None else int(round(e))) for k, (e, _) in parsed.items()}
    entry["moe"] = {k: int(round(m)) for k, (e, m) in parsed.items() if e is not None}
    entry["src"] = src
    entry["q"] = "ok" if rel <= ok_rel else "low"
    return entry


def _fetch(year, variables, geo_for, geo_in=None):
    """Call Census ACS API. Returns (headers, rows) or (None, None) on failure."""
    url = f"{ACS_BASE}/{year}/acs/acs5"
    params = {"get": ",".join(variables), "for": geo_for}
    if geo_in:
        params["in"] = geo_in
    if _CENSUS_KEY:
        params["key"] = _CENSUS_KEY

    for attempt in range(3):
        try:
            r = requests.get(url, params=params, timeout=60, allow_redirects=False)
            if r.status_code in (204, 302, 400, 404):
                return None, None
            r.raise_for_status()
            data = r.json()
            return (data[0], data[1:]) if len(data) >= 2 else (None, None)
        except Exception as e:
            if attempt < 2:
                time.sleep(2 ** attempt)
            else:
                print(f"    ACS fetch failed ({geo_for}, {year}): {e}")
                return None, None


def _build_geo_data(year, geo_for, geo_in, fips_col, fips_prefix, filter_set=None):
    """Fetch and merge residence + workplace ACS data for a geography level.

    Returns: {full_fips: {"res": {...}, "wrk": {...} or None}}
    """
    pad = 5 if fips_col == "place" else 3

    # ── Residence data (always fetched) ──────────────────────────────────────
    rh, rr = _fetch(year, RES_VARS + moe_vars(RES_VARS), geo_for, geo_in)
    if not rh or not rr:
        return {}
    try:
        fi = rh.index(fips_col)
    except ValueError:
        return {}

    res_map = {}
    for row in rr:
        code = row[fi].zfill(pad)
        if filter_set and code not in filter_set:
            continue
        res_map[code] = row

    time.sleep(0.25)

    # ── Workplace data (graceful failure → wrk stays None) ───────────────────
    wrk_map = {}
    wh, wr = _fetch(year, WRK_VARS + moe_vars(WRK_VARS), geo_for, geo_in)
    if wh and wr:
        try:
            wfi = wh.index(fips_col)
            for row in wr:
                code = row[wfi].zfill(pad)
                if filter_set and code not in filter_set:
                    continue
                wrk_map[code] = row
        except ValueError:
            pass

    # ── Merge ─────────────────────────────────────────────────────────────────
    out = {}
    for code, rrow in res_map.items():
        rt    = make_entry(parse_table(rrow, rh, "B08301", "trans"), "native")
        rtime = make_entry(parse_table(rrow, rh, "B08303", "time"), "native")
        res = {"trans": rt, "time": rtime} if (rt or rtime) else None
        if res is None:
            continue

        wrk = None
        if code in wrk_map:
            wrow  = wrk_map[code]
            wt    = make_entry(parse_table(wrow, wh, "B08601", "trans"), "native")
            wtime = make_entry(parse_table(wrow, wh, "B08603", "time"), "native")
            if wt or wtime:
                wrk = {"trans": wt, "time": wtime}

        out[fips_prefix + code] = {"res": res, "wrk": wrk}

    return out


def fetch_acs_year(year: int, data_dir: Path, force: bool = False, xw=None) -> None:
    """Fetch and save ACS commute data for one year.

    Writes data_dir/acs/{year}/acs_{city,county,house,senate,area}.json
    (see the module docstring). Skips if all five already exist (pass
    force=True to re-fetch). `xw` is accepted for backward compatibility and
    unused: acs_derive reads its own crosswalks.
    """
    if year < ACS_START_YEAR:
        print(f"  ACS data not available before {ACS_START_YEAR}, skipping {year}.")
        return

    out_dir = data_dir / "acs" / str(year)
    names = ["city", "county", "house", "senate", "area"]
    paths = {n: out_dir / f"acs_{n}.json" for n in names}

    if not force and all(p.exists() for p in paths.values()):
        print(f"  {year}: ACS already cached, skipping.")
        return

    out_dir.mkdir(parents=True, exist_ok=True)
    print(f"  Fetching ACS 5-year for {year}...")

    city_data = _build_geo_data(year, "place:*", f"state:{STATE}", "place", STATE)
    time.sleep(0.5)
    county_data = _build_geo_data(year, "county:*", f"state:{STATE}", "county", STATE)
    time.sleep(0.5)

    # Derived estimates: places the Census doesn't publish this year, districts,
    # Unincorporated, planning and workshop areas.
    import acs_derive
    derived = acs_derive.derive_year(year, skip_places=set(city_data))
    for fips, entry in derived.get("place", {}).items():
        city_data[fips] = entry
    house_data = derived.get("house", {})
    senate_data = derived.get("senate", {})
    area_data = {"city": derived.get("unincorporated", {})}
    for typ in acs_derive.POLYGON_TYPES:
        area_data[typ] = derived.get(typ, {})

    for n, d in (("city", city_data), ("county", county_data), ("house", house_data),
                 ("senate", senate_data), ("area", area_data)):
        paths[n].write_text(json.dumps(d, separators=(",", ":")))

    def shown(d):
        return sum(1 for v in d.values() if v.get("res"))

    placed = derived.get("place", {})
    print(f"    acs_city.json: {len(city_data)} places ({shown(placed)} derived shown, "
          f"{len(placed) - shown(placed)} suppressed)")
    print(f"    acs_county.json: {len(county_data)} counties")
    print(f"    acs_house.json: {shown(house_data)}/{len(house_data)} districts shown")
    print(f"    acs_senate.json: {shown(senate_data)}/{len(senate_data)} districts shown")
    for typ, d in area_data.items():
        print(f"    acs_area.json [{typ}]: {shown(d)}/{len(d)} areas shown")


if __name__ == "__main__":
    import sys
    data_dir = Path(__file__).parent.parent / "data"
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    years = [int(a) for a in args] if args else list(range(ACS_START_YEAR, 2024))
    for y in years:
        fetch_acs_year(y, data_dir, force="--force" in sys.argv)
