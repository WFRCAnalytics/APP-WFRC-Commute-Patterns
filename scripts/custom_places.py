# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "numpy>=1.26",
#   "pandas>=2.0",
#   "geopandas>=0.14",
#   "shapely>=2.0",
# ]
# ///
"""
Custom Places — config-driven edits to the Census place geography.

Two independent operations, both configured in scripts/custom_places_config.json:

  "remove": [{"fips", "name", "reason"}, ...]
      Drop a Census place from the app (e.g. a CDP that has since been
      absorbed into a newly incorporated city). Its polygon is removed from
      city_boundaries.geojson and its blocks lose the place assignment, so
      they fall back to "<County> Unincorporated". Works on its own.

  "add": {"<display name>": {...}}
      Add a place that Census/LEHD don't have: Hill Air Force Base, or a
      city incorporated after the 2020 Census place geography. Blocks whose
      centroid lies inside the polygon are assigned to it.
        source       optional {"type": "ugrc_municipal", "name": "<UGRC NAME>"}.
                     UGRC polygons come from the cache written by
                     scripts/fetch_sources.py (the whole layer is cached; only
                     the named feature is used). Without `source`, the polygon
                     is read from data/custom_places.gpkg by name.
        place_fips   7-char FIPS (state+place), required when enable is true.
        enable       true  -> treated as a normal selectable city.
                     false -> info-only: polygon rendered with a click popup,
                              sidebar/Credits show a data-limitation note.

The two are deliberately not coupled. Removals run first, then additions; an
added polygon that covers a removed place's blocks simply claims them.

How it reaches the data: patch_xwalk() edits the *loaded* LEHD crosswalk
(process_data.load_xwalk), the single place the Utah crosswalk is read. No
block is ever dropped and the cached download is never modified; only the
block -> place columns change, in the copy the pipeline uses. Everything
downstream (names, FIPS, name-collision handling, metadata) then derives from
that one patched crosswalk.

Other merge points called by process_data.py:

  remove_census_places(places_gdf) -> TIGER places minus removed FIPS
  inject_custom_meta(meta_list)    -> extended list (centroid = representative point)
  append_custom_boundaries(gdf)    -> extended GeoDataFrame
  export_for_app(data_dir)         -> data/custom_places.geojson (info-only places)
"""

import json
from pathlib import Path

import numpy as np
import pandas as pd
import geopandas as gpd
import shapely

DATA_DIR    = Path(__file__).parent.parent / "data"
CACHE_DIR   = DATA_DIR / "cache"
CUSTOM_FILE = DATA_DIR / "custom_places.gpkg"
CONFIG_FILE = Path(__file__).parent / "custom_places_config.json"

UGRC_MUNICIPAL_URL = (
    "https://services1.arcgis.com/99lidPhWCzftIe9K/ArcGIS/rest/services/"
    "UtahMunicipalBoundaries/FeatureServer/0"
)
UGRC_CACHE = CACHE_DIR / "ugrc_municipal_boundaries.geojson"

# stplc the LEHD crosswalk uses for blocks outside any Census place.
UNINCORPORATED_FIPS = "9999999"

_CONFIG: dict = json.loads(CONFIG_FILE.read_text(encoding="utf-8")) if CONFIG_FILE.exists() else {}
_REMOVE: list = _CONFIG.get("remove", [])
_ADD: dict = _CONFIG.get("add", {})


def _place_cfg(name: str) -> dict:
    return _ADD.get(name, {})


def _is_enabled(name: str) -> bool:
    return _place_cfg(name).get("enable", False)


def removed_fips() -> list[str]:
    return [r["fips"] for r in _REMOVE]


def _load_ugrc(name: str) -> gpd.GeoDataFrame:
    if not UGRC_CACHE.exists():
        raise FileNotFoundError(
            f"{UGRC_CACHE} not found — run `uv run scripts/fetch_sources.py` first."
        )
    all_places = gpd.read_file(UGRC_CACHE).to_crs(epsg=4326)
    match = all_places[all_places["NAME"] == name]
    if len(match) != 1:
        raise ValueError(
            f"UGRC municipal layer has {len(match)} features named {name!r} (expected 1). "
            f"Re-run fetch_sources.py --refresh-ugrc, or fix `source.name` in the config."
        )
    return match[["geometry"]]


def _load_gpkg() -> gpd.GeoDataFrame:
    if not CUSTOM_FILE.exists():
        return gpd.GeoDataFrame(columns=["name", "geometry"], geometry="geometry", crs="EPSG:4326")
    gdf = gpd.read_file(CUSTOM_FILE, layer="custom_places")
    if "name" not in gdf.columns:
        raise ValueError(f"{CUSTOM_FILE} must have a 'name' column on each feature.")
    return gdf.to_crs(epsg=4326)


def load_places() -> gpd.GeoDataFrame:
    """Every custom place as (name, geometry) in WGS-84.

    Places listed in the config's "add" section use their `source` (or the gpkg
    polygon of the same name). gpkg features with no config entry are kept as
    info-only places, matching the original behaviour.
    """
    gpkg = _load_gpkg().set_index("name")
    rows = []
    for name, cfg in _ADD.items():
        src = cfg.get("source")
        if src:
            if src.get("type") != "ugrc_municipal":
                raise ValueError(f"{name}: unknown source type {src.get('type')!r}")
            geom = _load_ugrc(src["name"]).geometry.iloc[0]
        elif name in gpkg.index:
            geom = gpkg.loc[name, "geometry"]
        else:
            raise ValueError(f"{name}: no `source` in config and no feature of that name in {CUSTOM_FILE.name}")
        rows.append({"name": name, "geometry": geom})
    for name in gpkg.index.difference(list(_ADD)):
        rows.append({"name": name, "geometry": gpkg.loc[name, "geometry"]})
    gdf = gpd.GeoDataFrame(rows, geometry="geometry", crs="EPSG:4326")
    bad = gdf[~gdf.geometry.is_valid | gdf.geometry.is_empty]
    if len(bad):
        raise ValueError(f"Invalid/empty custom place geometry: {list(bad['name'])}")
    return gdf


def _enabled_places() -> gpd.GeoDataFrame:
    gdf = load_places()
    return gdf[gdf["name"].apply(_is_enabled)].reset_index(drop=True)


def patch_xwalk(xw: pd.DataFrame) -> pd.DataFrame:
    """Apply "remove" then "add" to the block -> place columns of the crosswalk.

    Returns a patched copy; raises if the config is inconsistent with the data.
    Only stplc / stplcname are ever modified and no row is added or dropped.
    """
    enabled = _enabled_places()
    if not _REMOVE and enabled.empty:
        return xw

    out = xw.copy()
    before = xw[["tabblk2020", "stplc"]].copy()

    # ── remove ───────────────────────────────────────────────────────────────
    for r in _REMOVE:
        fips, name = r["fips"], r["name"]
        mask = out["stplc"] == fips
        n = int(mask.sum())
        if n == 0:
            raise ValueError(f"remove: FIPS {fips} ({name}) has no blocks in the crosswalk — "
                             f"stale config entry or typo.")
        out.loc[mask, "stplc"] = UNINCORPORATED_FIPS
        out.loc[mask, "stplcname"] = np.nan
        print(f"  Removed Census place {name} ({fips}): {n} blocks -> unincorporated")

    # ── add ──────────────────────────────────────────────────────────────────
    lon = pd.to_numeric(out["blklondd"], errors="coerce").to_numpy()
    lat = pd.to_numeric(out["blklatdd"], errors="coerce").to_numpy()
    for _, place in enabled.iterrows():
        name = place["name"]
        fips = str(_place_cfg(name).get("place_fips", ""))
        if len(fips) != 7 or not fips.isdigit():
            raise ValueError(f"add: {name} needs a 7-digit `place_fips` in the config (got {fips!r}).")
        if (out["stplc"] == fips).any():
            raise ValueError(f"add: {name} place_fips {fips} already belongs to another place.")

        inside = shapely.contains_xy(place.geometry, lon, lat)
        n = int(inside.sum())
        if n == 0:
            raise ValueError(f"add: {name} polygon contains no crosswalk blocks.")

        taken = out.loc[inside & (out["stplc"] != UNINCORPORATED_FIPS)]
        if len(taken):
            by_place = taken.groupby(["stplc", "stplcname"], dropna=False).size().to_dict()
            raise ValueError(
                f"add: {name} polygon would take blocks from places that are not in "
                f"\"remove\": {by_place}. Add them to \"remove\" if the merge is intended, "
                f"or fix the polygon."
            )

        out.loc[inside, "stplc"] = fips
        # Census-style "<NAME> <type>, UT". The trailing type word is stripped by the
        # pipeline's name cleaning, so a name that itself ends in "City" needs it.
        out.loc[inside, "stplcname"] = f"{name} city, UT"
        print(f"  Added {name} ({fips}): {n} blocks assigned")

    # ── integrity: only the place columns of reassigned blocks may differ ────
    if len(out) != len(xw) or not out["tabblk2020"].equals(xw["tabblk2020"]):
        raise AssertionError("patch_xwalk changed the block set — this must never happen.")
    changed = int((out["stplc"].to_numpy() != before["stplc"].to_numpy()).sum())
    print(f"  Crosswalk patch: {changed:,} of {len(out):,} blocks reassigned; none dropped.")
    return out


def remove_census_places(places: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    """Drop removed places (by FIPS) from the TIGER places GeoDataFrame."""
    fips = removed_fips()
    if not fips:
        return places
    missing = set(fips) - set(places["FULL_PLACEFP"])
    if missing:
        print(f"  WARNING: removed FIPS not in TIGER places (already gone upstream?): {sorted(missing)}")
    kept = places[~places["FULL_PLACEFP"].isin(fips)].copy()
    print(f"  Removed {len(places) - len(kept)} Census place polygon(s) per config.")
    return kept


def inject_custom_meta(meta_list: list) -> list:
    """Complete the metadata entry of each enabled custom place.

    The entry normally already exists (build_city_meta derives it from the
    flows, which carry the patched crosswalk's name) but has no centroid because
    the place is not in TIGER; fill it from the polygon's representative point,
    which is guaranteed to lie inside the boundary (a centroid can fall outside
    an irregular or multi-part polygon). Appends an entry if none exists.
    """
    custom_gdf = _enabled_places()
    if custom_gdf.empty:
        return meta_list

    name_to_idx = {m["name"]: i for i, m in enumerate(meta_list)}

    for _, row in custom_gdf.iterrows():
        name = row["name"]
        cfg = _place_cfg(name)
        pt = row.geometry.representative_point()
        entry = meta_list[name_to_idx[name]] if name in name_to_idx else None
        if entry is None:
            entry = {"name": name}
            meta_list.append(entry)
        entry.setdefault("county", cfg.get("county", ""))
        entry.setdefault("county_fips", cfg.get("county_fips", ""))
        entry["lat"] = round(pt.y, 6)
        entry["lon"] = round(pt.x, 6)
        entry["place_fips"] = cfg.get("place_fips", entry.get("place_fips", ""))
        entry["place_type"] = "city"
        print(f"  Custom place metadata: {name} ({pt.y:.4f}, {pt.x:.4f})")

    return meta_list


def append_custom_boundaries(city_gdf: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    """Append enabled custom place polygons to the city boundaries GeoDataFrame.

    Reprojects and simplifies to match city_gdf (already in EPSG:26912, 100 m tolerance).
    Called after TIGER city boundary processing.
    """
    custom_gdf = _enabled_places()
    if custom_gdf.empty:
        return city_gdf

    custom_proj = custom_gdf[["name", "geometry"]].copy()
    custom_proj = custom_proj.to_crs(city_gdf.crs)
    custom_proj["geometry"] = custom_proj["geometry"].simplify(100, preserve_topology=True)

    result = pd.concat([city_gdf, custom_proj], ignore_index=True)
    print(f"  Appended {len(custom_proj)} custom place boundary/ies to city GeoDataFrame.")
    return gpd.GeoDataFrame(result, crs=city_gdf.crs)


def export_for_app(data_dir: Path) -> None:
    """Export data/custom_places.geojson: the info-only (enable=false) places.

    Enabled places are normal cities served from city_boundaries.geojson, so
    they are not duplicated here (the app also hides any polygon whose name is
    already a city).
    """
    custom_gdf = load_places()
    custom_gdf = custom_gdf[~custom_gdf["name"].apply(_is_enabled)]
    if custom_gdf.empty:
        return

    features = []
    for _, row in custom_gdf.iterrows():
        name = row["name"]
        cfg = _place_cfg(name)
        geom = row.geometry.simplify(0.0001, preserve_topology=True)
        features.append({
            "type": "Feature",
            "geometry": geom.__geo_interface__,
            "properties": {
                "name": name,
                "county": cfg.get("county", ""),
                "county_fips": cfg.get("county_fips", ""),
                "employees_approx": cfg.get("employees_approx", ""),
                "enable": cfg.get("enable", False),
                "note": cfg.get("note", ""),
            },
        })

    out_path = data_dir / "custom_places.geojson"
    out_path.write_text(json.dumps({"type": "FeatureCollection", "features": features}))
    print(f"  Exported {out_path.name} ({len(features)} feature(s))")
