"""
Derive ACS commute estimates for areas the Census does not publish.

The Census publishes ACS commute tables for places, counties and a few other
geographies. The app also shows areas it does not: places missing from a given
year's ACS, "<County> Unincorporated", custom places (Ogden Valley City), the
House / Senate districts, and the planning / workshop areas. For these, the
estimate is built bottom-up from the smallest published unit — block groups
(ACS 2013+) or tracts (ACS 2010-2012) — as

    estimate(area) = sum over units u of  share(area, u) * estimate(u)

where share(area, u) is the fraction of unit u's resident workers (LODES
residence-area counts, same year) who live in blocks assigned to the area.

Geography vintages (the unit IDs must match the crosswalk's block prefixes):
    ACS 2020+       2020 block groups  -> LODES8 crosswalk (2020 blocks)
    ACS 2013-2019   2010 block groups  -> LODES7 crosswalk (2010 blocks)
    ACS 2010-2012   2010 tracts        -> LODES7 crosswalk (2010 blocks)
    ACS 2009        2000 tracts        -> no usable crosswalk; nothing derived

Margins of error (90%)
    Sampling:   sqrt(sum (share * MOE_u)^2)
    Allocation: a unit straddling the area boundary is split by a proxy (resident
                workers), which adds uncertainty. Modelled as a binomial split of
                each unit's workers, inflated by THIN_K; calibrated by
                verify_acs_derive.py, which back-tests the method on every place
                the Census does publish.
    The two combine in quadrature.

Reliability tiers on MOE / estimate of the table total (see verify_acs_derive.py
for the back-test they come from; 0.20 is also the Census's own CV of ~12%):
    <= 0.20   "ok"        shown as an estimate
    <= 0.30   "low"       shown, flagged low reliability
    >  0.30   suppressed  derived values only; published values are never hidden
Tract-level years (ACS 2010-2012) are coarser: at a given MOE / estimate the
back-test error matches block-group error at twice that ratio, so the cutoffs
are halved there (TRACT_TIER_SCALE): 0.10 / 0.15.
"""

import json
from pathlib import Path

import geopandas as gpd
import numpy as np
import pandas as pd
from shapely.geometry import Point

import custom_places
import fetch_acs
import mag_workshop_areas
import taz_districts
import workshop_areas
from geo_utils import UTAH_COUNTIES, tiger_file

CACHE_DIR = Path(__file__).parent.parent / "data" / "cache"

FIRST_YEAR = 2010            # earliest ACS year with a matching 2010-geography crosswalk
LAST_LODES7_YEAR = 2019
BLOCK_GROUP_FROM = 2013      # ACS block-group tables exist from here; 2010-2012 are tract-only
Z90 = 1.645
THIN_K = 2.0
OK_REL = 0.20
LOW_REL = 0.30
TRACT_TIER_SCALE = 0.5
UNINC = custom_places.UNINCORPORATED_FIPS

TRANS_KEYS = ["total", "drove", "carpool", "transit", "bike", "walk", "other", "wfh"]
TIME_KEYS = ["total", "lt10", "t10_19", "t20_29", "t30_44", "t45_59", "t60plus"]
# planning / workshop display types derived straight from a polygon layer
POLYGON_TYPES = ["small", "medium", "large", "super", "workshop", "mag_workshop"]


def block_vintage(year: int) -> int:
    return 2020 if year >= 2020 else 2010


def unit_level(year: int) -> str:
    return "block group" if year >= BLOCK_GROUP_FROM else "tract"


def tier_scale(year: int) -> float:
    return 1.0 if year >= BLOCK_GROUP_FROM else TRACT_TIER_SCALE


def unit_len(year: int) -> int:
    return 12 if year >= BLOCK_GROUP_FROM else 11


# ── blocks and area assignment (once per vintage) ────────────────────────────

_BLOCKS: dict[int, pd.DataFrame] = {}
_AREAS: dict[int, dict[str, pd.Series]] = {}


def _blocks(vintage: int) -> pd.DataFrame:
    """Block table with the custom-places patch applied, so removed CDPs fall
    into 'Unincorporated' and Ogden Valley City exists in every vintage.
    The block id column is named tabblk2020 in both vintages because
    custom_places.patch_xwalk expects that name."""
    if vintage not in _BLOCKS:
        path, col = ((CACHE_DIR / "ut_xwalk.csv.gz", "tabblk2020") if vintage == 2020
                     else (CACHE_DIR / "ut_xwalk_lodes7.csv.gz", "tabblk2010"))
        if not path.exists():
            raise FileNotFoundError(f"{path} missing — run `uv run scripts/fetch_sources.py` first.")
        xw = pd.read_csv(path, dtype=str, usecols=[col, "stplc", "stplcname", "cty",
                                                   "stsldl", "stsldu", "blklatdd", "blklondd"])
        xw = xw.rename(columns={col: "tabblk2020"})
        xw["stplc"] = xw["stplc"].str.zfill(7)
        xw["cty"] = xw["cty"].str.zfill(5)
        xw["stsldl"] = xw["stsldl"].str.zfill(5)
        xw["stsldu"] = xw["stsldu"].str.zfill(5)
        print(f"  [{vintage} blocks] {len(xw):,}")
        _BLOCKS[vintage] = custom_places.patch_xwalk(xw).set_index("tabblk2020", drop=False)
    return _BLOCKS[vintage]


def app_place_fips() -> set[str]:
    """Places the app shows: every place in the current (2020) crosswalk."""
    b = _blocks(2020)
    return set(b.loc[b["stplc"] != UNINC, "stplc"])


def _points(blocks: pd.DataFrame) -> gpd.GeoDataFrame:
    lat = pd.to_numeric(blocks["blklatdd"], errors="coerce")
    lon = pd.to_numeric(blocks["blklondd"], errors="coerce")
    ok = lat.notna() & lon.notna()
    return gpd.GeoDataFrame(
        {"block": blocks.index[ok]},
        geometry=[Point(x, y) for x, y in zip(lon[ok], lat[ok])],
        crs="EPSG:4326",
    )


def _assign(points: gpd.GeoDataFrame, polys: gpd.GeoDataFrame, col: str) -> pd.Series:
    """block id -> value of `col` of the polygon containing the block centroid."""
    j = gpd.sjoin(points, polys[[col, "geometry"]].to_crs(epsg=4326), how="left", predicate="within")
    j = j[~j.index.duplicated(keep="first")]
    return j.set_index("block")[col].dropna()


def _tiger_districts(layer: str) -> gpd.GeoDataFrame:
    _, name = tiger_file(layer, f"49_{layer.lower()}")
    return gpd.read_file(CACHE_DIR / name)


def _areas(vintage: int) -> dict[str, pd.Series]:
    """{display type -> Series(block id -> area key)} for one block vintage.

    Keys: place FIPS ('place'), '<County> Unincorporated' ('unincorporated'),
    TAZ / workshop display names, and House / Senate FIPS. The 2020 vintage
    takes House / Senate from the crosswalk — the same source the flow data
    uses — and the 2010 vintage locates block centroids in the current
    districts, since the app draws one set of district boundaries for all years.
    """
    if vintage in _AREAS:
        return _AREAS[vintage]
    b = _blocks(vintage)
    pts = _points(b)
    out: dict[str, pd.Series] = {}

    inc = b["stplc"] != UNINC
    out["place"] = b.loc[inc, "stplc"]
    # County from the block id (state + county): a handful of LODES7 border blocks
    # carry a neighbouring state's county in the `cty` column.
    cty = pd.Series(b.index.str[:5], index=b.index)[~inc]
    out["unincorporated"] = cty[cty.isin(UTAH_COUNTIES)].map(lambda c: f"{UTAH_COUNTIES[c]} Unincorporated")

    taz = taz_districts._taz_gdf_with_display_names()
    for level in taz_districts.LEVELS:
        out[level] = _assign(pts, taz, f"{level}_disp")
    out["workshop"] = _assign(pts, workshop_areas.fetch_workshop_polygons(), "BoundaryName")
    out["mag_workshop"] = _assign(pts, mag_workshop_areas.fetch_mag_workshop_polygons(), "Subregion")

    if vintage == 2020:
        out["house"] = b["stsldl"].dropna()
        out["senate"] = b["stsldu"].dropna()
    else:
        out["house"] = _assign(pts, _tiger_districts("SLDL"), "GEOID")
        out["senate"] = _assign(pts, _tiger_districts("SLDU"), "GEOID")

    for name, s in out.items():
        print(f"  [{vintage}] {name}: {s.nunique()} areas, {len(s):,} blocks")
    _AREAS[vintage] = out
    return out


# ── worker weights and ACS unit data (per year) ──────────────────────────────

def _rac(year: int) -> pd.Series:
    """Resident workers per block for one year. Downloaded on first use, so a new
    LODES year needs no extra step (fetch_sources.py --only rac fetches them all)."""
    import fetch_sources
    url, name = fetch_sources.rac_source(year)
    path = CACHE_DIR / name
    if fetch_sources.fetch(url, name, force=False, refresh=False) == "FAILED":
        raise FileNotFoundError(f"could not fetch {url} -> {path}")
    r = pd.read_csv(path, dtype={"h_geocode": str}, usecols=["h_geocode", "C000"])
    return r.set_index("h_geocode")["C000"]


def _unit_table(year: int) -> pd.DataFrame | None:
    """ACS values of every block group / tract: one row per unit, columns
    '<table>.<key>.e' and '.m' (estimate and margin of error)."""
    level = unit_level(year)
    cache = CACHE_DIR / f"acs_units_{year}_{level.replace(' ', '_')}.json"
    if cache.exists():
        headers, rows = json.loads(cache.read_text(encoding="utf-8"))
    else:
        headers, rows = fetch_acs._fetch(
            year, fetch_acs.RES_VARS + fetch_acs.moe_vars(fetch_acs.RES_VARS),
            f"{level}:*", f"state:{fetch_acs.STATE} county:*")
        if not headers:
            print(f"    ACS {level} tables unavailable for {year}")
            return None
        cache.write_text(json.dumps([headers, rows]), encoding="utf-8")
    ix = {h: i for i, h in enumerate(headers)}
    ids, recs = [], []
    for row in rows:
        uid = row[ix["state"]] + row[ix["county"]] + row[ix["tract"]]
        if level == "block group":
            uid += row[ix["block group"]]
        rec = {}
        for table, prefix, keys in (("trans", "B08301", TRANS_KEYS), ("time", "B08303", TIME_KEYS)):
            parsed = fetch_acs.parse_table(row, headers, prefix, table) or {}
            for k in keys:
                e, m = parsed.get(k, (None, 0.0))
                rec[f"{table}.{k}.e"] = 0.0 if e is None else float(e)
                rec[f"{table}.{k}.m"] = float(m)
        ids.append(uid)
        recs.append(rec)
    return pd.DataFrame(recs, index=ids)


def _shares(blocks: pd.DataFrame, rac: pd.Series, keys: pd.Series, ulen: int) -> pd.DataFrame:
    """share of each unit's resident workers living in each area: [key, unit, share].
    Falls back to block counts for a unit with no LODES workers. The denominator
    covers every block of the unit, including blocks outside any area."""
    df = pd.DataFrame({"unit": blocks.index.str[:ulen], "w": rac.reindex(blocks.index).fillna(0).to_numpy()},
                      index=blocks.index)
    tot_w = df.groupby("unit")["w"].sum()
    tot_n = df.groupby("unit").size()
    df["key"] = keys.reindex(df.index)
    part = df.dropna(subset=["key"]).groupby(["key", "unit"]).agg(w=("w", "sum"), n=("w", "size")).reset_index()
    tw = part["unit"].map(tot_w).to_numpy()
    tn = part["unit"].map(tot_n).to_numpy()
    part["share"] = np.where(tw > 0, part["w"] / np.where(tw > 0, tw, 1), part["n"] / tn)
    return part[["key", "unit", "share"]]


def _aggregate(units: pd.DataFrame, shares: pd.DataFrame) -> pd.DataFrame:
    """One row per area key; columns '<table>.<key>.e' / '.m' (float)."""
    j = shares.join(units, on="unit", how="inner")
    s = j["share"].to_numpy()
    est, var = {}, {}
    for col in units.columns:
        if not col.endswith(".e"):
            continue
        e = j[col].to_numpy()
        m = j[col[:-2] + ".m"].to_numpy()
        est[col] = e * s
        var[col[:-2] + ".m"] = (m * s) ** 2 + (Z90 ** 2) * THIN_K * e * s * (1 - s)
    out_e = pd.DataFrame(est, index=j.index).groupby(j["key"]).sum()
    out_v = pd.DataFrame(var, index=j.index).groupby(j["key"]).sum()
    return pd.concat([out_e, np.sqrt(out_v)], axis=1)


def _entries(agg: pd.DataFrame, scale: float = 1.0) -> dict:
    """{key: {"res": {"trans": entry|None, "time": entry|None}, "wrk": None}}
    or a suppressed marker when neither table is reliable enough to show."""
    out = {}
    for key, row in agg.iterrows():
        res = {}
        for table, keys in (("trans", TRANS_KEYS), ("time", TIME_KEYS)):
            parsed = {k: (row[f"{table}.{k}.e"], row[f"{table}.{k}.m"]) for k in keys}
            res[table] = fetch_acs.make_entry(parsed, "derived", ok_rel=OK_REL * scale,
                                              suppress_above=LOW_REL * scale)
        if res["trans"] is None and res["time"] is None:
            out[key] = {"res": None, "wrk": None, "suppressed": True}
        else:
            out[key] = {"res": res, "wrk": None}
    return out


# ── public entry point ───────────────────────────────────────────────────────

def derive_year(year: int, skip_places: set[str] | None = None, only_types: list[str] | None = None) -> dict:
    """Derived ACS entries for one year.

    Returns {"place": {fips: entry}, "unincorporated": {name: entry},
             "house": {...}, "senate": {...}, "small": {name: entry}, ...}
    ('place' omits skip_places — the places the Census already publishes —
    and any place not in the app). Empty dict for years with no usable geography.
    """
    if year < FIRST_YEAR:
        return {}
    units = _unit_table(year)
    if units is None:
        return {}
    vintage = block_vintage(year)
    blocks = _blocks(vintage)
    rac = _rac(year)
    areas = _areas(vintage)
    ulen = unit_len(year)

    out = {}
    for typ, keys in areas.items():
        if only_types and typ not in only_types:
            continue
        if typ == "place":
            keep = app_place_fips() - (skip_places or set())
            keys = keys[keys.isin(keep)]
        out[typ] = _entries(_aggregate(units, _shares(blocks, rac, keys, ulen)), tier_scale(year))
    return out
