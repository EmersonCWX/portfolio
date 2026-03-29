"""
mrms_fetch.py — Vermont MRMS Data Fetcher
==========================================
Downloads real-time MRMS (Multi-Radar/Multi-Sensor) GRIB2 products
from the NOAA AWS S3 public bucket and saves them locally for
processing by mrms_proc.cpp.

Data source:
  s3://noaa-mrms-pds/   (public, no credentials required)
  https://mrms.ncep.noaa.gov/data/  (HTTP fallback)

Products fetched:
  - MRMS_MergedReflectivityQCComposite  (SeamlessHSR, ~1 km / 2 min)
  - MRMS_EchoTop_18                     (18 dBZ echo tops)
  - MRMS_PrecipRate                     (instantaneous precip rate)
  - MRMS_MultiSensor_QPE_01H_Pass2      (1-hour QPE)

Usage:
  python mrms_fetch.py [--output ./data] [--product reflect] [--loop]

Requirements:
  pip install boto3 requests pygrib numpy
"""

import argparse
import datetime
import os
import sys
import time

import boto3
from botocore import UNSIGNED
from botocore.config import Config
import requests

# ── Constants ─────────────────────────────────────────────────────────────────
S3_BUCKET = "noaa-mrms-pds"
S3_BASE   = "CONUS"
HTTP_BASE = "https://mrms.ncep.noaa.gov/data/2D"

PRODUCTS = {
    "reflect":   "MergedReflectivityQCComposite",
    "echotops":  "EchoTop_18",
    "preciprate":"PrecipRate",
    "qpe1h":     "MultiSensor_QPE_01H_Pass2",
}

# Northeast CONUS bounding box (lat/lon)
NE_BBOX = {
    "lat_min": 40.5,
    "lat_max": 47.5,
    "lon_min": -76.5,
    "lon_max": -66.5,
}


def get_s3_client():
    """Return an anonymous S3 client for the public NOAA bucket."""
    return boto3.client(
        "s3",
        region_name="us-east-1",
        config=Config(signature_version=UNSIGNED),
    )


def latest_s3_key(s3, product_key: str) -> str:
    """Find the most recent GRIB2 file key for a given product."""
    prefix = f"{S3_BASE}/{PRODUCTS[product_key]}/"
    paginator = s3.get_paginator("list_objects_v2")
    pages = paginator.paginate(Bucket=S3_BUCKET, Prefix=prefix)

    latest_key = None
    latest_dt  = None

    for page in pages:
        for obj in page.get("Contents", []):
            key = obj["Key"]
            if not key.endswith(".grib2.gz"):
                continue
            # Key format: CONUS/<Product>/00.00/<Product>_00.00_<YYYYMMDD-HHmmss>.grib2.gz
            try:
                fname = key.split("/")[-1]
                ts_str = fname.split("_")[-1].replace(".grib2.gz", "")
                dt = datetime.datetime.strptime(ts_str, "%Y%m%d-%H%M%S")
                if latest_dt is None or dt > latest_dt:
                    latest_dt = dt
                    latest_key = key
            except ValueError:
                continue

    if latest_key is None:
        raise RuntimeError(f"No GRIB2 files found for product '{product_key}'")
    return latest_key


def fetch_via_s3(s3, key: str, output_dir: str) -> str:
    """Download a GRIB2 file from S3 and return the local path."""
    fname = key.split("/")[-1]
    local_path = os.path.join(output_dir, fname)
    if os.path.exists(local_path):
        print(f"  [cache] {fname} already exists, skipping download.")
        return local_path
    print(f"  [s3] downloading s3://{S3_BUCKET}/{key} ...")
    s3.download_file(S3_BUCKET, key, local_path)
    print(f"  [s3] saved to {local_path}")
    return local_path


def fetch_via_http(product_key: str, output_dir: str) -> str:
    """HTTP fallback from mrms.ncep.noaa.gov."""
    url = f"{HTTP_BASE}/{PRODUCTS[product_key]}/latest.grib2.gz"
    fname = f"{PRODUCTS[product_key]}_latest.grib2.gz"
    local_path = os.path.join(output_dir, fname)
    print(f"  [http] fetching {url} ...")
    resp = requests.get(url, timeout=30, stream=True)
    resp.raise_for_status()
    with open(local_path, "wb") as fh:
        for chunk in resp.iter_content(chunk_size=65536):
            fh.write(chunk)
    print(f"  [http] saved to {local_path}")
    return local_path


def subset_northeast(grib_path: str) -> None:
    """
    Optionally open the GRIB2 with pygrib and extract the
    Northeast CONUS subdomain. Writes a trimmed .grib2 alongside.
    Requires: pip install pygrib
    """
    try:
        import pygrib
        import numpy as np
    except ImportError:
        print("  [subset] pygrib not available, skipping NE subset.")
        return

    msgs = pygrib.open(grib_path)
    out_path = grib_path.replace(".grib2.gz", "_NE.grib2")

    with open(out_path, "wb") as fh:
        for msg in msgs:
            try:
                lats, lons = msg.latlons()
                mask = (
                    (lats >= NE_BBOX["lat_min"]) & (lats <= NE_BBOX["lat_max"]) &
                    (lons >= NE_BBOX["lon_min"]) & (lons <= NE_BBOX["lon_max"])
                )
                if not mask.any():
                    continue
                fh.write(msg.tostring())
            except Exception:
                pass

    msgs.close()
    size_kb = os.path.getsize(out_path) / 1024
    print(f"  [subset] Northeast extract: {out_path}  ({size_kb:.0f} KB)")


def run(product_key: str, output_dir: str, loop: bool, interval_s: int) -> None:
    os.makedirs(output_dir, exist_ok=True)
    s3 = get_s3_client()

    while True:
        print(f"\n[{datetime.datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ')}] "
              f"Fetching product: {product_key}")
        try:
            key = latest_s3_key(s3, product_key)
            path = fetch_via_s3(s3, key, output_dir)
        except Exception as exc:
            print(f"  [warn] S3 failed ({exc}), trying HTTP fallback ...")
            try:
                path = fetch_via_http(product_key, output_dir)
            except Exception as exc2:
                print(f"  [error] HTTP also failed: {exc2}")
                if not loop:
                    sys.exit(1)
                time.sleep(interval_s)
                continue

        subset_northeast(path)

        if not loop:
            break
        print(f"  [loop] sleeping {interval_s}s ...")
        time.sleep(interval_s)


def main():
    parser = argparse.ArgumentParser(description="Fetch NOAA MRMS GRIB2 data")
    parser.add_argument("--output",   default="./data",    help="Output directory")
    parser.add_argument("--product",  default="reflect",
                        choices=list(PRODUCTS.keys()),     help="MRMS product to fetch")
    parser.add_argument("--loop",     action="store_true", help="Continuously fetch (live mode)")
    parser.add_argument("--interval", type=int, default=120,
                        help="Loop interval in seconds (default 120 = MRMS update rate)")
    args = parser.parse_args()
    run(args.product, args.output, args.loop, args.interval)


if __name__ == "__main__":
    main()
