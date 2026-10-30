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
Back-test acs_derive.py against the places the Census does publish.

Derives every app place from block groups / tracts, as if the Census had not
published it, and compares with the published value. The tier cutoffs and the
allocation-uncertainty factor in acs_derive.py come from this comparison; re-run
it after changing the method or when adding a vintage.

    uv run scripts/verify_acs_derive.py            # 2013, 2015, 2019, 2023 + one tract year (2012)
    uv run scripts/verify_acs_derive.py 2015 2023

Also checks that, for each year, the derived House and Senate districts add up
to the statewide worker count (the old tract matching lost 27-48% before 2020).
"""

import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

import acs_derive

DATA_DIR = Path(__file__).parent.parent / "data"
TIERS = [(0, 0.10), (0.10, 0.20), (0.20, 0.30), (0.30, 99)]  # block-group scale; x tier_scale(year)


def backtest(year: int) -> None:
    native_all = json.loads((DATA_DIR / "acs" / str(year) / "acs_city.json").read_text())
    native = {f: v for f, v in native_all.items()
              if v.get("res") and v["res"].get("trans") and v["res"]["trans"].get("src", "native") == "native"}
    der = acs_derive.derive_year(year, only_types=["place"]).get("place", {})
    rows = []
    for f, n in native.items():
        d = der.get(f)
        nt = n["res"]["trans"]
        rec = {"fips": f, "nat": nt["total"], "shown": bool(d and d.get("res") and d["res"].get("trans"))}
        if rec["shown"]:
            dt = d["res"]["trans"]
            rec.update(der=dt["total"], moe=dt["moe"]["total"], q=dt["q"],
                       sh_err=abs((dt["drove"] or 0) / dt["total"] - (nt["drove"] or 0) / nt["total"]) if dt["total"] else np.nan)
        rows.append(rec)
    df = pd.DataFrame(rows)
    shown = df[df["shown"]].copy()
    print(f"\n=== {year} ({acs_derive.unit_level(year)}s, {acs_derive.block_vintage(year)} blocks) ===")
    print(f"published places: {len(df)} | derived and shown: {len(shown)} | suppressed or absent: {len(df) - len(shown)}")
    if shown.empty:
        return
    shown["err"] = (shown.der / shown.nat - 1).abs()
    shown["rel"] = shown.moe / shown.der
    shown["in_moe"] = (shown.der - shown.nat).abs() <= shown.moe
    print(f"median derived/published: {np.median(shown.der / shown.nat):.3f} | published within derived MOE: {100 * shown.in_moe.mean():.0f}%")
    print("tier (MOE/estimate)   n   median err   p90 err   within MOE   drove-share err (median / p90)")
    sc = acs_derive.tier_scale(year)
    for lo, hi in TIERS:
        lo, hi = lo * sc, hi * sc
        s = shown[(shown.rel >= lo) & (shown.rel < hi)]
        if len(s):
            print(f"  {lo:.2f}-{min(hi, 1):.2f} {'(shown)' if hi <= 0.30 * sc + 1e-9 else '(suppressed)':>14s} {len(s):4d}   {s.err.median():9.3f}  {s.err.quantile(.9):8.3f}   {100 * s.in_moe.mean():8.0f}%   "
                  f"{s.sh_err.median():.3f} / {s.sh_err.quantile(.9):.3f}")
    gone = df[~df["shown"]]
    if len(gone):
        print(f"  suppressed/absent places have a median published size of {int(gone.nat.median())} workers")


def district_totals(year: int) -> None:
    county = json.loads((DATA_DIR / "acs" / str(year) / "acs_county.json").read_text())
    c = sum(v["res"]["trans"]["total"] for v in county.values() if v.get("res") and v["res"].get("trans"))
    d = acs_derive.derive_year(year, only_types=["house", "senate"])
    for typ in ("house", "senate"):
        t = sum(v["res"]["trans"]["total"] for v in d.get(typ, {}).values() if v.get("res") and v["res"].get("trans"))
        print(f"  {year} {typ}: {t:,} of {c:,} statewide workers ({100 * t / c:.1f}%)")


if __name__ == "__main__":
    years = [int(a) for a in sys.argv[1:]] or [2012, 2013, 2015, 2019, 2023]
    for y in years:
        backtest(y)
    print("\nDistrict conservation:")
    for y in years:
        district_totals(y)
