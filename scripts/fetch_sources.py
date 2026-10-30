# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "pandas>=2.0",
#   "geopandas>=0.14",
#   "pyarrow>=14",
#   "requests>=2.31",
# ]
# ///
"""
Fetch every external source file the pipeline needs into data/cache/.

Safe to re-run: valid cached files are skipped, corrupt or rejected downloads
are deleted and retried. Nothing is parsed here — process_data.py reads from
the same cache and will also download lazily, but running this first gives one
clear report instead of a mid-pipeline failure.

Sources (all plain HTTPS GETs, no credentials):
  - Census TIGER/Line shapefiles, vintage set by geo_utils.TIGER_YEAR:
      Utah places, national counties, Utah State House / Senate districts,
      and the place files of the 6 neighboring states.
  - LEHD LODES8 geographic crosswalks (Utah + the 6 neighboring states).

Census's firewall occasionally answers a valid URL with an HTML "Request
Rejected" page (HTTP 200). Such responses are detected, discarded and retried
with backoff. If a file still can't be fetched, the report lists its URL and
the exact cache path so it can be saved by hand from a browser; re-running the
script then picks it up.

    uv run scripts/fetch_sources.py               # fetch whatever is missing
    uv run scripts/fetch_sources.py --only tiger  # tiger | xwalk
    uv run scripts/fetch_sources.py --refresh-xwalk  # re-download crosswalks if the
                                                     # server copy differs in size
    uv run scripts/fetch_sources.py --force       # re-download everything
"""

import argparse
import gzip
import sys
import time
import zipfile
from pathlib import Path

import requests

import neighbor_zones
from geo_utils import TIGER_YEAR, tiger_file

CACHE_DIR = Path(__file__).parent.parent / "data" / "cache"
LODES_BASE = "https://lehd.ces.census.gov/data/lodes/LODES8"
ATTEMPTS = 3
BACKOFF_SECONDS = 10


def tiger_sources() -> list[tuple[str, str]]:
    """[(url, cache_filename)] for every TIGER file the pipeline reads."""
    files = [
        tiger_file("PLACE", "49_place"),
        tiger_file("COUNTY", "us_county"),
        tiger_file("SLDL", "49_sldl"),
        tiger_file("SLDU", "49_sldu"),
    ]
    for fips in neighbor_zones.NEIGHBOR_STATES:
        files.append(tiger_file("PLACE", f"{fips}_place"))
    return files


def xwalk_sources() -> list[tuple[str, str]]:
    states = ["ut"] + [a.lower() for _, a in neighbor_zones.NEIGHBOR_STATES.values()]
    return [(f"{LODES_BASE}/{s}/{s}_xwalk.csv.gz", f"{s}_xwalk.csv.gz") for s in states]


def is_valid(path: Path) -> bool:
    """True if the file is a readable zip / gzip (catches HTML rejection pages)."""
    if not path.exists() or path.stat().st_size == 0:
        return False
    try:
        if path.suffix == ".zip":
            if not zipfile.is_zipfile(path):
                return False
            with zipfile.ZipFile(path) as z:
                return z.testzip() is None
        if path.name.endswith(".gz"):
            with gzip.open(path, "rb") as f:
                f.read(1024)
            return True
    except (OSError, EOFError, zipfile.BadZipFile):
        return False
    return True


def remote_size(url: str) -> int | None:
    try:
        r = requests.head(url, timeout=30, allow_redirects=True)
        n = r.headers.get("Content-Length")
        return int(n) if r.ok and n else None
    except (requests.RequestException, ValueError):
        return None


def fetch(url: str, name: str, force: bool, refresh: bool) -> str:
    """Returns 'cached' | 'downloaded' | 'FAILED'."""
    dest = CACHE_DIR / name
    stale = force
    if dest.exists() and is_valid(dest) and refresh and not force:
        rs = remote_size(url)
        stale = rs is not None and rs != dest.stat().st_size
        if stale:
            print(f"  {name}: server copy differs ({rs:,} B vs {dest.stat().st_size:,} B)")
    if dest.exists() and not stale and is_valid(dest):
        return "cached"

    for attempt in range(1, ATTEMPTS + 1):
        dest.unlink(missing_ok=True)
        print(f"  {name}: downloading (attempt {attempt}/{ATTEMPTS})")
        try:
            neighbor_zones._download_file(url, dest)
        except Exception as exc:
            print(f"    error: {exc}")
        if is_valid(dest):
            return "downloaded"
        print("    not a valid archive (request rejected?) — discarding")
        dest.unlink(missing_ok=True)
        if attempt < ATTEMPTS:
            time.sleep(BACKOFF_SECONDS * attempt)
    return "FAILED"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--only", choices=["tiger", "xwalk"])
    ap.add_argument("--force", action="store_true", help="re-download everything")
    ap.add_argument("--refresh-xwalk", action="store_true",
                    help="re-download a crosswalk if the server's size differs from the cache")
    args = ap.parse_args()

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    jobs = []
    if args.only in (None, "tiger"):
        jobs += [(u, n, False) for u, n in tiger_sources()]
    if args.only in (None, "xwalk"):
        jobs += [(u, n, args.refresh_xwalk) for u, n in xwalk_sources()]

    print(f"Fetching into {CACHE_DIR} (TIGER {TIGER_YEAR})")
    results = {n: (u, fetch(u, n, args.force, refresh)) for u, n, refresh in jobs}

    failed = {n: u for n, (u, status) in results.items() if status == "FAILED"}
    counts = {s: sum(1 for _, st in results.values() if st == s)
              for s in ("cached", "downloaded", "FAILED")}
    print(f"\n{counts['cached']} already cached, {counts['downloaded']} downloaded, "
          f"{counts['FAILED']} failed")
    if failed:
        print("\nCould not fetch these. Save each from a browser to the path shown, then re-run:")
        for n, u in failed.items():
            print(f"  {u}\n    -> {CACHE_DIR / n}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
