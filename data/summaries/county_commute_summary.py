"""
county_commute_summary.py
Generates a county-level commute summary CSV for all 29 Utah counties.

Sources
-------
LEHD (county_flows.parquet)  — live/work, inflow, outflow, distance bands
ACS  (acs_county.json)       — travel-time minutes (residence side, B08303)

Columns
-------
county_fips      5-digit FIPS code
county_name      Full county name
live_work_pct    % of resident workers who also work in the same county
outflow_pct      % of resident workers who commute OUT of the county
inflow_pct       % of workers employed in the county who live OUTSIDE it
pct_under_20min  % of resident workers with < 20-min commute (ACS)
pct_under_30min  % of resident workers with < 30-min commute (ACS)
pct_under_10mi   % of resident workers commuting < 10 miles (LEHD bands, exact)
pct_under_25mi   % of resident workers commuting < 25 miles (LEHD bands, exact)

Usage
-----
  python county_commute_summary.py [--year YEAR]

  Defaults to the most recent year found under data/lehd/.
  Output CSV is written to the same folder as this script.
"""

import argparse
import json
from pathlib import Path

import pandas as pd
import pyarrow.parquet as pq

HERE     = Path(__file__).resolve().parent
ROOT     = HERE.parent.parent
LEHD_DIR = ROOT / "data" / "lehd"
ACS_DIR  = ROOT / "data" / "acs"


def _available_years(base: Path) -> list:
    return sorted(int(p.name) for p in base.iterdir() if p.is_dir() and p.name.isdigit())


def _load_county_meta(year: int) -> list:
    with open(LEHD_DIR / str(year) / "county_meta.json") as f:
        return json.load(f)  # list of {name, county_fips, lat, lon}


def _load_county_flows(year: int) -> pd.DataFrame:
    return pq.read_table(LEHD_DIR / str(year) / "county_flows.parquet").to_pandas()


def _load_acs(year: int) -> dict:
    path = ACS_DIR / str(year) / "acs_county.json"
    if not path.exists():
        return {}
    with open(path) as f:
        return json.load(f)


def build_summary(year: int) -> pd.DataFrame:
    meta  = _load_county_meta(year)       # list of {name, county_fips, ...}
    flows = _load_county_flows(year)
    acs   = _load_acs(year)

    # county_flows uses county names (not FIPS) as home_county / work_county keys
    band_cols = ["d0_5", "d5_10", "d10_25", "d25_50", "d50_100", "d100p"]
    has_bands = all(c in flows.columns for c in band_cols)

    def pct(num, den):
        return round(num / den * 100, 1) if den else None

    rows = []
    for county in sorted(meta, key=lambda c: c["name"]):
        name = county["name"]
        fips = county["county_fips"]

        res_rows  = flows[flows["home_county"] == name]   # residents of this county
        work_rows = flows[flows["work_county"] == name]   # workers employed here

        total_residents = int(res_rows["S000"].sum())
        total_workers   = int(work_rows["S000"].sum())
        self_flow       = int(res_rows[res_rows["work_county"] == name]["S000"].sum())

        live_work_pct = pct(self_flow, total_residents)
        outflow_pct   = pct(total_residents - self_flow, total_residents)
        inflow_pct    = pct(total_workers  - self_flow, total_workers)

        # Distance bands — residents commuting to any destination
        if has_bands:
            d0_5    = int(res_rows["d0_5"].sum())
            d5_10   = int(res_rows["d5_10"].sum())
            d10_25  = int(res_rows["d10_25"].sum())
            d25_50  = int(res_rows["d25_50"].sum())
            d50_100 = int(res_rows["d50_100"].sum())
            d100p   = int(res_rows["d100p"].sum())
            total_b = d0_5 + d5_10 + d10_25 + d25_50 + d50_100 + d100p

            pct_under_10mi = pct(d0_5 + d5_10, total_b)
            pct_under_25mi = pct(d0_5 + d5_10 + d10_25, total_b)
        else:
            pct_under_10mi = None
            pct_under_25mi = None

        # ACS travel time (residence-side: workers living in this county)
        time     = acs.get(fips, {}).get("res", {}).get("time", {})
        time_tot = time.get("total", 0)
        lt10     = time.get("lt10",   0)
        t10_19   = time.get("t10_19", 0)
        t20_29   = time.get("t20_29", 0)

        pct_under_20min = pct(lt10 + t10_19,          time_tot)
        pct_under_30min = pct(lt10 + t10_19 + t20_29, time_tot)

        rows.append({
            "county_fips":     fips,
            "county_name":     name,
            "live_work_pct":   live_work_pct,
            "outflow_pct":     outflow_pct,
            "inflow_pct":      inflow_pct,
            "pct_under_20min": pct_under_20min,
            "pct_under_30min": pct_under_30min,
            "pct_under_10mi":  pct_under_10mi,
            "pct_under_25mi":  pct_under_25mi,
        })

    return pd.DataFrame(rows)


def main():
    lehd_years = _available_years(LEHD_DIR)
    default    = max(lehd_years) if lehd_years else 2022

    ap = argparse.ArgumentParser(description="Generate Utah county commute summary CSV.")
    ap.add_argument("--year", type=int, default=default,
                    help=f"Data year (default: {default}; available: {lehd_years})")
    args = ap.parse_args()

    print(f"Building county commute summary for {args.year}...")
    df = build_summary(args.year)

    out = HERE / f"county_commute_summary_{args.year}.csv"
    df.to_csv(out, index=False)
    print(f"Saved {len(df)} rows -> {out}\n")
    print(df.to_string(index=False))


if __name__ == "__main__":
    main()
