#!/usr/bin/env python3
"""Fetch and fully parse NOAA/NWS hurricane recon data for the static site.

This replaces the old client-side JS fetch/parse pipeline: every network call
(NHC storm feed, NWS mission list, TGFTP fallback) and every parsing step
(HDOB decode, phase detection, storm/mission matching, category classification)
happens here, server-side, where NOAA's lack of CORS headers doesn't matter.

Run by .github/workflows/recon-data-mirror.yml every ~5 minutes. Writes one
ready-to-render JSON file that tools/liveRecon.js only has to display.
"""
import json
import re
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from math import asin, cos, radians, sin, sqrt
from pathlib import Path

import recon_plot

UA = "sabr3wx-recon-mirror/1.0 (+https://sabr3wx.com)"
TIMEOUT = 20

NHC_STORMS_URL = "https://www.nhc.noaa.gov/CurrentStorms.json"
TGFTP_URLS = [
    # Atlantic — NOAA WP-3D (KNHC) and USAF WC-130J (KUAS / KWBC)
    "https://tgftp.nws.noaa.gov/data/raw/ur/urnt15.knhc..txt",
    "https://tgftp.nws.noaa.gov/data/raw/ur/urnt15.kuas..txt",
    "https://tgftp.nws.noaa.gov/data/raw/ur/urnt15.kwbc..txt",
    # East Pacific — NOAA (KNHC) and USAF (KBIX)
    "https://tgftp.nws.noaa.gov/data/raw/ur/urpn15.knhc..txt",
    "https://tgftp.nws.noaa.gov/data/raw/ur/urpn15.kbix..txt",
]
NWS_OFFICES = ["KNHC", "KWBC", "KBIX", "KUAS"]
OFFICE_ORG = {"KNHC": "NOAA", "KWBC": "USAF", "KBIX": "USAF", "KUAS": "USAF"}
BASIN_NAME = {"AL": "Atlantic", "EP": "East Pacific", "CP": "Central Pacific"}
COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
           "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"]

MISSION_LOOKBACK_HOURS  = 24
MAX_MISSIONS_PER_OFFICE = 30  # per-office cap on the NWS product list fetch
MAX_TOTAL_MISSIONS      = 60  # cap on how many bulletins we fully fetch + parse
IN_STORM_NM             = 100

OUT_PATH = Path(__file__).resolve().parent.parent / "data" / "recon.json"


def http_get(url, as_json=False):
    req = urllib.request.Request(
        url, headers={"User-Agent": UA, "Accept": "application/json" if as_json else "*/*"}
    )
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        body = resp.read()
    return json.loads(body) if as_json else body.decode("utf-8", errors="replace")


# ── Storm feed ───────────────────────────────────────────────────────────────

def num(s, scale=None):
    if s is None:
        return None
    s = str(s).strip()
    if not s or re.fullmatch(r"[+\-]?/+", s):
        return None
    try:
        v = float(re.sub(r"[^0-9.\-+]", "", s))
    except ValueError:
        return None
    return v / scale if scale else v


def storm_category(classification, intensity):
    if classification == "HU" and intensity is not None:
        if intensity >= 137: return {"label": "CAT 5", "cls": "lr-cat-5"}
        if intensity >= 113: return {"label": "CAT 4", "cls": "lr-cat-4"}
        if intensity >= 96:  return {"label": "CAT 3", "cls": "lr-cat-3"}
        if intensity >= 83:  return {"label": "CAT 2", "cls": "lr-cat-2"}
        return {"label": "CAT 1", "cls": "lr-cat-1"}
    names = {
        "TS": "TROPICAL STORM", "TD": "TROPICAL DEPRESSION", "SS": "SUBTROPICAL STORM",
        "SD": "SUBTROPICAL DEPRESSION", "PTC": "POTENTIAL TC", "EX": "POST-TROPICAL",
    }
    return {"label": names.get(classification, classification or "ACTIVE"), "cls": ""}


def basin_from_id(storm_id):
    if not storm_id:
        return ""
    return BASIN_NAME.get(storm_id[:2].upper(), "")


def compass_dir(deg):
    if deg is None:
        return ""
    return COMPASS[round(deg / 22.5) % 16]


def parse_latlon(raw, negative_hemi):
    s = str(raw)
    try:
        return float(s[:-1]) * (-1 if s[-1] == negative_hemi else 1)
    except (ValueError, IndexError):
        return 0.0


def fetch_storms():
    try:
        data = http_get(NHC_STORMS_URL, as_json=True)
    except Exception as e:
        print(f"[storms] fetch failed: {e}")
        return []

    storms = []
    for s in data.get("activeStorms", []):
        lat = parse_latlon(s.get("latitude") or s.get("latitudeNumeric") or "0", "S")
        lon = parse_latlon(s.get("longitude") or s.get("longitudeNumeric") or "0", "W")
        if lat == 0 and lon == 0:
            continue
        intensity = num(s.get("intensity"))
        movement_dir = num(s.get("movementDir"))
        classification = s.get("classification")
        storms.append({
            "id": s.get("id"),
            "name": s.get("name") or "Unknown Storm",
            "binNumber": s.get("binNumber"),
            "classification": classification,
            "intensity": intensity,
            "pressure": num(s.get("pressure")),
            "movementDir": movement_dir,
            "movementSpeed": num(s.get("movementSpeed")),
            "lastUpdate": s.get("lastUpdate"),
            "advNum": (s.get("publicAdvisory") or {}).get("advNum"),
            "latDisplay": s.get("latitude"),
            "lonDisplay": s.get("longitude"),
            "lat": lat, "lon": lon,
            "category": storm_category(classification, intensity),
            "basin": basin_from_id(s.get("id")),
            "windMph": round(intensity * 1.15078) if intensity is not None else None,
            "movementCompass": compass_dir(movement_dir),
        })
    return storms


# ── HDOB parsing ─────────────────────────────────────────────────────────────

# HDOB 30-second obs format (NHOP Appendix G):
#   HHMMSS DDMM[NS] DDDMM[EW] AAAA BBBBB CCCC ±TTT ±TTT DDDSSS PPP [SSS]
#   1:time 2:lat    3:lon     4:alt 5:skip 6:skip 7:temp 8:dew 9:wind 10:pk 11:sfmr
HDOB_OBS_RE = re.compile(
    r"(\d{6})\s+(\d{2,4}[NS])\s+(\d{3,5}[EW])\s+([\d/]{4,5})\s+([\d/]{4,5})\s+([\d/]{4,5})\s+"
    r"([+\-]?[\d/]{3,5})\s+([+\-]?[\d/]{3,5})\s+([\d/]{6})\s+([\d/]{3})(?:\s+([\d/]{3}))?"
)
AC_ID_PATTERNS = [
    re.compile(r"Aircraft:\s*([A-Z0-9]+)", re.I),
    re.compile(r"\bHDOB\s+\d+\s+\d+\s+([A-Z]{2,6}\d+)", re.I),
    re.compile(r"\b(NOAA\d+|AF\d{3}|N\d{2}RF)\b"),
]
HAS_OBS_RE = re.compile(r"\d{6}\s+\d{2,4}[NS]\s+\d{3,5}[EW]", re.I)


def parse_lat(raw):
    direction, body = raw[-1], raw[:-1]
    deg = int(body[:2])
    minutes = float(body[2:]) if body[2:] else 0.0
    return (deg + minutes / 60) * (-1 if direction == "S" else 1)


def parse_lon(raw):
    direction, body = raw[-1], raw[:-1]
    deg = int(body[:3])
    minutes = float(body[3:]) if body[3:] else 0.0
    return (deg + minutes / 60) * (-1 if direction == "W" else 1)


def parse_hdob(text):
    ac_id = "HH"
    for pat in AC_ID_PATTERNS:
        m = pat.search(text)
        if m:
            ac_id = m.group(1)
            break

    obs = []
    for m in HDOB_OBS_RE.finditer(text):
        ts, lat_raw, lon_raw, alt_raw, _, _, temp_raw, dew_raw, wind_raw, pk_raw, sfmr_raw = m.groups()
        try:
            lat, lon = parse_lat(lat_raw), parse_lon(lon_raw)
        except ValueError:
            continue
        obs.append({
            "acId": ac_id,
            "timeStr": ts,
            "hh": int(ts[0:2]), "mm": int(ts[2:4]), "ss": int(ts[4:6]),
            "lat": lat, "lon": lon,
            "alt": num(alt_raw),                # feet (pressure altitude)
            "temp": num(temp_raw, 10),          # °C (field x10)
            "dew": num(dew_raw, 10),            # °C (field x10, or null)
            "wdir": num(wind_raw[0:3]),         # degrees
            "wspd": num(wind_raw[3:6]),         # knots
            "pkWind": num(pk_raw),              # knots (peak surface wind)
            "sfmrWind": num(sfmr_raw) if sfmr_raw else None,
        })
    return ac_id, obs


# ── Phase assignment (haversine, nm) ─────────────────────────────────────────

def nm(lat1, lon1, lat2, lon2):
    r = 3440.065
    dlat, dlon = radians(lat2 - lat1), radians(lon2 - lon1)
    a = sin(dlat / 2) ** 2 + cos(radians(lat1)) * cos(radians(lat2)) * sin(dlon / 2) ** 2
    return r * 2 * asin(sqrt(min(1, a)))


def assign_phases(obs, storms):
    """Mutates obs in place with phase + distToStorm; returns target storm id."""
    if not obs:
        return None

    target = None
    if storms:
        mid = obs[len(obs) // 2]
        best = float("inf")
        for s in storms:
            d = nm(mid["lat"], mid["lon"], s["lat"], s["lon"])
            if d < best:
                best, target = d, s

    if not target:
        for o in obs:
            o["phase"] = "IN STORM" if (o.get("wspd") or 0) >= 80 else "ENROUTE"
            o["distToStorm"] = None
        return None

    dists = [nm(o["lat"], o["lon"], target["lat"], target["lon"]) for o in obs]
    min_idx = dists.index(min(dists))
    for i, o in enumerate(obs):
        o["distToStorm"] = dists[i]
        if dists[i] <= IN_STORM_NM:
            o["phase"] = "IN STORM"
        elif i <= min_idx:
            o["phase"] = "ENROUTE"
        else:
            o["phase"] = "RETURNING"
    return target["id"]


# ── Mission list (NWS API, last N hours) ─────────────────────────────────────

def fetch_mission_items(office):
    # Note: this endpoint does not accept a "limit" query param (returns 400
    # "Query parameter \"limit\" is not recognized" if present) — it already
    # returns a bounded, most-recent-first list on its own.
    url = f"https://api.weather.gov/products/types/HDOB/locations/{office}"
    try:
        data = http_get(url, as_json=True)
    except Exception as e:
        print(f"[missions:{office}] list fetch failed: {e}")
        return []

    cutoff = datetime.now(timezone.utc) - timedelta(hours=MISSION_LOOKBACK_HOURS)
    items = []
    for item in data.get("@graph", []):
        t = datetime.fromisoformat(item["issuanceTime"].replace("Z", "+00:00"))
        if t >= cutoff:
            items.append({"id": item["@id"], "time": t, "office": office})
    items.sort(key=lambda x: x["time"], reverse=True)
    return items[:MAX_MISSIONS_PER_OFFICE]


def fetch_product_text(product_url):
    try:
        data = http_get(product_url, as_json=True)
        return data.get("productText") or ""
    except Exception as e:
        print(f"[mission] product fetch failed: {e}")
        return ""


def build_mission(item, storms):
    text = fetch_product_text(item["id"])
    ac_id, obs = parse_hdob(text)
    target_id = assign_phases(obs, storms)

    slug = recon_plot.slugify(item["id"].rsplit("/", 1)[-1])
    img_latest, img_full = recon_plot.render_mission_images(slug, obs, storms)
    csv_path = recon_plot.render_mission_csv(slug, obs)

    return {
        "id": item["id"],
        "time": item["time"].isoformat(),
        "office": item["office"],
        "org": OFFICE_ORG.get(item["office"], item["office"]),
        "acId": ac_id if ac_id != "HH" else None,
        "source": "nws_api",
        "targetStormId": target_id,
        "imageLatest": img_latest,
        "imageFull": img_full,
        "csv": csv_path,
        "obs": obs,
    }


def fetch_missions(storms):
    all_items = []
    with ThreadPoolExecutor(max_workers=len(NWS_OFFICES)) as pool:
        for items in pool.map(fetch_mission_items, NWS_OFFICES):
            all_items.extend(items)

    all_items.sort(key=lambda x: x["time"], reverse=True)
    all_items = all_items[:MAX_TOTAL_MISSIONS]

    missions = []
    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = [pool.submit(build_mission, item, storms) for item in all_items]
        for f in as_completed(futures):
            m = f.result()
            if m["obs"]:
                missions.append(m)

    missions.sort(key=lambda m: m["time"], reverse=True)
    return missions


# ── TGFTP fallback (off-season / NWS API empty) ──────────────────────────────

HDOB_HEADER_RE = re.compile(r"HDOB\s+\d+\s+(\d{4})(\d{2})(\d{2})", re.I)


def fetch_tgftp_fallback(storms):
    for url in TGFTP_URLS:
        try:
            text = http_get(url)
        except Exception:
            continue
        if not HAS_OBS_RE.search(text):
            continue

        ac_id, obs = parse_hdob(text)
        if not obs:
            continue
        target_id = assign_phases(obs, storms)

        last = obs[-1]
        header = HDOB_HEADER_RE.search(text)
        if header:
            year, month, day = (int(x) for x in header.groups())
            mission_time = datetime(year, month, day, last["hh"], last["mm"], last["ss"], tzinfo=timezone.utc)
        else:
            now = datetime.now(timezone.utc)
            mission_time = now.replace(hour=last["hh"], minute=last["mm"], second=last["ss"], microsecond=0)

        slug = recon_plot.slugify(f"tgftp_{ac_id}_{mission_time.strftime('%Y%m%d%H%M%S')}")
        img_latest, img_full = recon_plot.render_mission_images(slug, obs, storms)
        csv_path = recon_plot.render_mission_csv(slug, obs)

        return [{
            "id": None,
            "time": mission_time.isoformat(),
            "office": "TGFTP",
            "org": "TGFTP",
            "acId": ac_id if ac_id != "HH" else None,
            "source": "tgftp",
            "targetStormId": target_id,
            "imageLatest": img_latest,
            "imageFull": img_full,
            "csv": csv_path,
            "obs": obs,
        }]
    return []


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    storms = fetch_storms()

    missions = fetch_missions(storms)
    if not missions:
        print("[main] NWS API returned no missions — trying TGFTP fallback")
        missions = fetch_tgftp_fallback(storms)

    output = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "storms": storms,
        "missions": missions,
    }

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(output, separators=(",", ":")), encoding="utf-8")
    print(f"[main] wrote {OUT_PATH} — {len(storms)} storm(s), {len(missions)} mission(s)")


if __name__ == "__main__":
    main()
