#!/usr/bin/env python3
"""Render U.S. upper-air soundings for the static site with SounderPy/MetPy.

Raw observations come from the University of Wyoming upper-air archive
(via Siphon's WyomingUpperAir). Each profile is converted to SounderPy's
``clean_data`` format and rendered with ``sounderpy.build_sounding``. The
images plus a ``index.json`` manifest are written to data/soundings/, which
tools/sounding.js only has to display.

Run by .github/workflows/sounding-data.yml a few times after each 00Z/12Z
launch (06Z/18Z supplemental launches are checked too). Keeps a rolling
archive (RETENTION_DAYS); stations that haven't
reported yet are retried on later runs until the cycle ages out of the
retry window.

    python scripts/sounding_data.py [--out data/soundings] [--stations 72357,70273]
"""
import argparse
import io
import json
import os
import shutil
import sys
import tempfile
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
from sounding_stations import STATIONS  # noqa: E402

RETENTION_DAYS = 7
RETRY_WINDOW_H = 12          # keep retrying a cycle's missing stations this long
MIN_AGE_MIN = 75             # UWyo usually has the data ~1-2 h after nominal time
REQUEST_SPACING_S = 2.0      # UWyo throttles parallel/rapid requests — stay polite
CONN_RETRIES = 3
TOP_HPA = 98.0
WEBP_QUALITY = 80
UWYO_TEXT_URL = ("https://weather.uwyo.edu/wsgi/sounding?datetime={date}%20{hh}:00:00"
                 "&id={wmo}&type=TEXT:LIST&src=UNKNOWN")


def cycle_key(dt):
    return dt.strftime("%Y%m%d%H")


def parse_cycle(key):
    return datetime.strptime(key, "%Y%m%d%H").replace(tzinfo=timezone.utc)


def recent_cycles(now, days):
    """All 6-hourly cycles within ``days`` that are old enough to be available.

    Routine launches are 00Z/12Z; 06Z/18Z are supplemental (severe weather,
    hurricane support) and simply come back as "no data" at most stations.
    """
    latest = now.replace(minute=0, second=0, microsecond=0)
    latest = latest.replace(hour=(latest.hour // 6) * 6)
    out = []
    t = latest
    while t >= now - timedelta(days=days):
        if now - t >= timedelta(minutes=MIN_AGE_MIN):
            out.append(t)
        t -= timedelta(hours=6)
    return out


# ── UWyo fetch (sequential, one request per station) ────────────────────────
class NoData(Exception):
    pass


def fetch_uwyo(wmo, when):
    """Return the UWyo observation as a pandas DataFrame (+ units)."""
    from siphon.simplewebservice.wyoming import WyomingUpperAir

    last = None
    for attempt in range(CONN_RETRIES):
        try:
            return WyomingUpperAir.request_data(when.replace(tzinfo=None), wmo)
        except ValueError as e:          # Siphon raises ValueError when UWyo has no profile
            raise NoData(str(e) or "no data") from e
        except Exception as e:           # connection reset / throttled — back off and retry
            last = e
            time.sleep(REQUEST_SPACING_S * (attempt + 2) * 2)
    raise ConnectionError(f"UWyo unreachable for {wmo}: {last}")


def to_clean_data(df, station, when):
    """Convert a Siphon DataFrame into SounderPy's ``clean_data`` dict.

    Mirrors sounderpy.obs_data.fetch_obs so build_sounding gets the exact
    structure it expects, without SounderPy's rapid-fire retry loop.
    """
    import numpy as np
    from metpy.units import units
    from sounderpy.obs_data import _choose_profile_stride

    wmo, icao, name, state = station
    df = df.dropna(subset=["pressure", "height", "temperature"])
    p = df["pressure"].to_numpy(dtype=float)
    keep = np.concatenate(([True], np.diff(p) != 0))
    df = df[keep]
    if len(df) < 10:
        raise NoData("too few levels")
    stride = _choose_profile_stride(df["pressure"].to_numpy(dtype=float))
    src_units = getattr(df, "units", {}) or {}

    def col(name, unit):
        q = df[name].to_numpy(dtype=float)[::stride] * units(src_units.get(name, unit))
        return q.to(unit)

    data = {
        "p": col("pressure", "hPa"),
        "z": col("height", "meter"),
        "T": col("temperature", "degC"),
        "Td": col("dewpoint", "degC"),
        "u": col("u_wind", "kt"),
        "v": col("v_wind", "kt"),
    }
    above = np.where(data["p"].m <= TOP_HPA)[0]
    if above.size:
        cut = above[0]
        for k in data:
            data[k] = data[k][:cut]

    lat = float(df["latitude"].iloc[0]) if "latitude" in df else None
    lon = float(df["longitude"].iloc[0]) if "longitude" in df else None
    elev = float(df["elevation"].iloc[0]) if "elevation" in df else float(data["z"][0].m)
    data["site_info"] = {
        "site-id": icao,
        "site-name": name.upper(),
        "site-lctn": f"{state} US",
        "site-latlon": [lat, lon],
        "site-elv": elev,
        "source": "RAOB OBSERVED PROFILE",
        "model": "no-model",
        "fcst-hour": "no-fcst-hour",
        "run-time": ["none", "none", "none", "none"],
        "valid-time": [when.strftime("%Y"), when.strftime("%m"), when.strftime("%d"), when.strftime("%H")],
    }
    data["titles"] = {
        "top_title": "RAOB OBSERVED VERTICAL PROFILE",
        "left_title": f"VALID: {when:%m-%d-%Y %H}Z",
        "right_title": f"{icao} - {name.upper()}, {state} US | "
                       f"{lat if lat is None else round(lat, 2)}, {lon if lon is None else round(lon, 2)}    ",
    }
    return data


# ── Rendering (CPU-bound — runs in worker processes) ─────────────────────────
def render(clean_data, out_path):
    os.environ.setdefault("MPLBACKEND", "Agg")
    import contextlib
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    import sounderpy as spy
    from PIL import Image, ImageDraw, ImageFont

    with tempfile.TemporaryDirectory() as tmp:
        png = Path(tmp) / "s"
        with contextlib.redirect_stdout(io.StringIO()):
            spy.build_sounding(clean_data, dark_mode=True, save=True, filename=str(png))
        plt.close("all")
        produced = png.with_suffix(".png") if png.with_suffix(".png").exists() else png
        out_path.parent.mkdir(parents=True, exist_ok=True)
        with Image.open(produced) as im:
            im = im.convert("RGB")
            # Append a credit strip that matches the background color
            strip = max(36, im.height // 36)
            bg = im.getpixel((5, im.height - 3))
            canvas = Image.new("RGB", (im.width, im.height + strip), bg)
            canvas.paste(im, (0, 0))
            font = ImageFont.truetype(
                str(Path(matplotlib.get_data_path()) / "fonts" / "ttf" / "DejaVuSans-Bold.ttf"),
                int(strip * 0.55))
            draw = ImageDraw.Draw(canvas)
            text = "Soundings Generated by Sabr3Wx"
            tw = draw.textlength(text, font=font)
            draw.text(((im.width - tw) / 2, im.height + strip * 0.12), text,
                      fill=(154, 163, 173), font=font)
            canvas.save(out_path, "WEBP", quality=WEBP_QUALITY, method=6)
    return out_path.stat().st_size


# ── Manifest ─────────────────────────────────────────────────────────────────
def load_index(out):
    f = out / "index.json"
    if f.exists():
        try:
            return json.loads(f.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            pass
    return {}


def build_index(out, now):
    available = {}
    for cdir in sorted((d for d in out.iterdir() if d.is_dir()), reverse=True):
        for img in cdir.glob("*.webp"):
            available.setdefault(img.stem, []).append(cdir.name)
    stations = [
        {"wmo": w, "id": i, "name": n, "state": s}
        for (w, i, n, s) in STATIONS if w in available
    ]
    return {
        "generated": now.strftime("%Y-%m-%dT%H:%MZ"),
        "source": "University of Wyoming Upper Air Archive",
        "renderer": "SounderPy / MetPy",
        "retention_days": RETENTION_DAYS,
        "raw_url": UWYO_TEXT_URL,
        "stations": stations,
        "available": {w: sorted(c, reverse=True) for w, c in available.items()},
    }


def prune(out, now):
    cutoff = now - timedelta(days=RETENTION_DAYS)
    for d in out.iterdir():
        if d.is_dir():
            try:
                if parse_cycle(d.name) < cutoff:
                    shutil.rmtree(d)
                    print(f"pruned {d.name}")
            except ValueError:
                pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(ROOT / "data" / "soundings"))
    ap.add_argument("--stations", help="comma-separated WMO ids (default: all)")
    ap.add_argument("--workers", type=int, default=max(1, min(4, os.cpu_count() or 1)))
    ap.add_argument("--backfill", action="store_true",
                    help="also try cycles older than the retry window (whole retention period)")
    args = ap.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    now = datetime.now(timezone.utc)
    stations = STATIONS
    if args.stations:
        wanted = set(args.stations.split(","))
        stations = [s for s in STATIONS if s[0] in wanted]

    prune(out, now)

    window = RETENTION_DAYS * 24 if args.backfill else RETRY_WINDOW_H
    cycles = [c for c in recent_cycles(now, RETENTION_DAYS) if now - c <= timedelta(hours=window)]
    jobs = [(c, s) for c in cycles for s in stations
            if not (out / cycle_key(c) / f"{s[0]}.webp").exists()]
    print(f"{len(cycles)} cycle(s) in window, {len(jobs)} station-cycle(s) to fetch")

    ok = nodata = failed = 0
    with ProcessPoolExecutor(max_workers=args.workers) as pool:
        futures = {}
        for when, station in jobs:
            tag = f"{station[1]} ({station[0]}) {cycle_key(when)}"
            try:
                df = fetch_uwyo(station[0], when)
                clean = to_clean_data(df, station, when)
            except NoData:
                nodata += 1
                print(f"  -- {tag}: not available")
                time.sleep(REQUEST_SPACING_S)
                continue
            except Exception as e:
                failed += 1
                print(f"  !! {tag}: {e}")
                time.sleep(REQUEST_SPACING_S)
                continue
            dest = out / cycle_key(when) / f"{station[0]}.webp"
            futures[pool.submit(render, clean, dest)] = tag
            time.sleep(REQUEST_SPACING_S)

        for fut in as_completed(futures):
            tag = futures[fut]
            try:
                size = fut.result()
                ok += 1
                print(f"  ok {tag}: {size // 1024} KB")
            except Exception as e:
                failed += 1
                print(f"  !! {tag}: render failed: {e}")

    index = build_index(out, now)
    (out / "index.json").write_text(json.dumps(index, separators=(",", ":")), encoding="utf-8")
    print(f"done: {ok} rendered, {nodata} not yet available, {failed} failed; "
          f"{len(index['stations'])} stations in archive")


if __name__ == "__main__":
    main()
