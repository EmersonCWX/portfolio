"""
dsa_fetch.py — Dropsonde Sounding Analyzer / Fetcher
======================================================
Fetches and decodes real-time NHC TEMP DROP messages (WMO FM-36)
from NOAA and USAF Hurricane Reconnaissance flights.

Data Sources:
  Atlantic (NOAA + USAF):   https://www.nhc.noaa.gov/text/MIAREPNT3.shtml
  E. Pacific (NOAA + USAF): https://www.nhc.noaa.gov/text/MIAREPPN3.shtml

Decodes WMO FM-36 TEMP DROP alphanumeric messages:
  - XXAA: mandatory pressure levels (surface → 100 hPa)
  - XXBB: significant temperature/humidity levels
  - 61616: recon extension (aircraft ID, mission, obs number)
  - 62626: boundary layer statistics
  - REL/SPG: release and surface coordinates + times

Optionally calls dsa_proc (C++ kernel) for thermodynamic parameters.

Usage:
  python dsa_fetch.py [--basin at|epac|both] [--output ./sondes.json] [--quiet]

Requirements:
  pip install requests
  (Optional) pip install pymetdecoder     ← enhanced WMO decode
  (Optional) compile dsa_proc.cpp        ← thermodynamic kernel

Build dsa_proc kernel:
  Windows:  cl /O2 /EHsc /Fe:dsa_proc.exe dsa_proc.cpp
  Linux:    g++ -O2 -std=c++17 -o dsa_proc dsa_proc.cpp
"""

from __future__ import annotations

import argparse
import json
import math
import os
import platform
import re
import subprocess
import sys
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Optional

import requests

# ── Constants ─────────────────────────────────────────────────────────────────

NHC_URLS = {
    "at":   "https://www.nhc.noaa.gov/text/MIAREPNT3.shtml",
    "epac": "https://www.nhc.noaa.gov/text/MIAREPPN3.shtml",
}

# Mandatory pressure levels keyed by 2-digit PP code
MANDATORY_LEVELS: dict[str, Optional[float]] = {
    "99": None,   # surface / release level (height from hhh field)
    "00": 1000.0,
    "92": 925.0,
    "85": 850.0,
    "70": 700.0,
    "50": 500.0,
    "40": 400.0,
    "30": 300.0,
    "25": 250.0,
    "20": 200.0,
    "15": 150.0,
    "10": 100.0,
    "88": None,   # tropopause
    "77": None,   # max-wind level
}

# Standard atmosphere geopotential heights (gpm) per level — used for
# height reconstruction from the 3-digit coded field.
STD_HEIGHT: dict[str, float] = {
    "99": 0.0,
    "00": 111.0,
    "92": 762.0,
    "85": 1457.0,
    "70": 3012.0,
    "50": 5574.0,
    "40": 7185.0,
    "30": 9164.0,
    "25": 10363.0,
    "20": 11784.0,
    "15": 13608.0,
    "10": 16180.0,
}

# Acceptable height ranges (m) per level: (lo, hi)
HEIGHT_RANGE: dict[str, tuple[float, float]] = {
    "99": (0.0,    300.0),
    "00": (0.0,    600.0),
    "92": (400.0,  1300.0),
    "85": (1000.0, 2200.0),
    "70": (2400.0, 4200.0),
    "50": (4500.0, 6500.0),
    "40": (6500.0, 8500.0),
    "30": (8000.0, 10500.0),
    "25": (9500.0, 12000.0),
    "20": (11000.0,13500.0),
    "15": (12500.0,15500.0),
    "10": (14500.0,18000.0),
}

# High-level PP codes where hhh is in tens of gpm (multiply by 10)
UPPER_LEVEL_CODES = {"50", "40", "30", "25", "20", "15", "10"}

# WMO quadrant codes → (lat_sign, lon_sign)
QUADRANT_SIGN = {1: (1, 1), 3: (1, -1), 5: (-1, -1), 7: (-1, 1)}

# C++ kernel paths
_LIB_DIR  = Path(__file__).parent
_EXE_WIN  = _LIB_DIR / "dsa_proc.exe"
_EXE_UNIX = _LIB_DIR / "dsa_proc"

# ── Data classes ──────────────────────────────────────────────────────────────

@dataclass
class SoundingLevel:
    pressure_hPa: Optional[float]
    height_m:     Optional[float]
    temp_C:       Optional[float]
    dewpoint_C:   Optional[float]
    rh_pct:       Optional[float]
    wind_dir:     Optional[int]
    wind_spd_kts: Optional[int]
    level_code:   str = ""       # 'surface', '925', '850' …

@dataclass
class BLStats:
    mean_wind_dir_500m:  Optional[int]   = None
    mean_wind_spd_500m:  Optional[int]   = None
    reduction_kts:       Optional[int]   = None
    mean_wind_dir_150m:  Optional[int]   = None
    mean_wind_spd_150m:  Optional[int]   = None

@dataclass
class Dropsonde:
    basin:         str
    bulletin_time: str
    aircraft:      str               = ""
    mission:       str               = ""
    obs_num:       Optional[int]     = None
    release_lat:   Optional[float]   = None
    release_lon:   Optional[float]   = None
    release_time:  str               = ""
    surface_lat:   Optional[float]   = None
    surface_lon:   Optional[float]   = None
    surface_time:  str               = ""
    surface_pres_hPa: Optional[float] = None
    levels:        list[SoundingLevel] = field(default_factory=list)
    bl_stats:      BLStats            = field(default_factory=BLStats)
    derived:       dict               = field(default_factory=dict)
    raw_xxaa:      str               = ""
    raw_xxbb:      str               = ""

# ── WMO FM-36 Decoder ─────────────────────────────────────────────────────────

def _tokenize(text: str) -> list[str]:
    """Split text into whitespace-separated tokens, uppercased."""
    return text.upper().split()


def _decode_height(pp: str, hhh_str: str) -> Optional[float]:
    """
    Reconstruct full geopotential height (m) from the 3-digit coded field.

    Lower trop (99/00/92/85/70): hhh in metres, last 3 significant digits.
    Upper trop (50/40/30/25/20/15/10): hhh in tens of metres (× 10).
    """
    if not hhh_str or "/" in hhh_str:
        return None
    try:
        h3 = int(hhh_str)
    except ValueError:
        return None

    if pp in UPPER_LEVEL_CODES:
        # Multiply to get metres, then reconstruct leading digits
        h_raw = h3 * 10
        ref   = STD_HEIGHT.get(pp, 0.0)
        base  = round(ref / 10000) * 10000
        result = base + h_raw
        # If out of range try adjacent base
        lo, hi = HEIGHT_RANGE.get(pp, (0, 99999))
        if result < lo:
            result += 10000
        elif result > hi:
            result -= 10000
        return float(result)
    else:
        ref = STD_HEIGHT.get(pp, 0.0)
        lo, hi = HEIGHT_RANGE.get(pp, (0, 99999))
        # Try adding multiples of 1000m to bring h3 into the expected range
        for mult in range(0, 30):
            candidate = mult * 1000 + h3
            if lo <= candidate <= hi:
                return float(candidate)
        # Fallback: use value nearest to reference
        best = min(range(0, 20), key=lambda m: abs(m * 1000 + h3 - ref))
        return float(best * 1000 + h3)


def _decode_temp_dew(group: str) -> tuple[Optional[float], Optional[float]]:
    """
    Decode 5-char WMO temperature/dewpoint-depression group (TTTdd).

    Temperature encoding (TTT = 3-digit absolute value):
      TaTa = TTT // 10  (tens + units of temperature in °C)
      Ta   = TTT  % 10  (tenths of °C)
      If TaTa < 50 → T = +(TaTa + Ta/10) °C  (positive)
      If TaTa ≥ 50 → T = -(TaTa-50 + Ta/10) °C  (negative)

    Dewpoint depression encoding (dd = 2-digit suffix):
      dd < 50           → depression = dd × 0.1 °C  (tenths)
      50 ≤ dd ≤ 98      → depression = (dd-50) °C   (whole degrees)
      dd = 99           → missing dewpoint
    """
    if not group or len(group) < 5 or "/" in group[:3]:
        return None, None
    try:
        TTT = int(group[:3])
        dd  = int(group[3:5])
    except ValueError:
        return None, None

    TaTa = TTT // 10
    Ta   = TTT  % 10
    T = (TaTa + Ta / 10.0) if TaTa < 50 else -(TaTa - 50 + Ta / 10.0)

    if dd == 99:
        return T, None
    if dd < 50:
        depression = dd * 0.1
    else:
        depression = float(dd - 50)

    return T, T - depression


def _decode_wind(group: str) -> tuple[Optional[int], Optional[int]]:
    """Decode 5-char wind group (dddff) → (direction °, speed kts)."""
    if not group or len(group) < 5 or group.replace("/", "") == "":
        return None, None
    try:
        ddd = int(group[:3]) if "/" not in group[:3] else None
        ff  = int(group[3:5]) if "/" not in group[3:5] else None
    except ValueError:
        return None, None
    # Speed encoded > 99 kts uses flag; if ddd ends in '5x' convention apply:
    # (not common below FL300 but guard)
    return ddd, ff


def _rh_from_td(T: float, Td: float) -> float:
    """Relative humidity (%) from temperature and dewpoint (°C), Magnus approx."""
    e  = 6.112 * math.exp(17.67 * Td / (Td + 243.5))
    es = 6.112 * math.exp(17.67 * T  / (T  + 243.5))
    return round(min(100.0, 100.0 * e / es), 1)


def _parse_latlon_from_coord(coord: str) -> Optional[float]:
    """
    Parse coordinate string like '2641N' or '08299W' or '4596N' → decimal float.
    Sign: N/E positive, S/W negative.
    """
    m = re.match(r"^(\d+)([NSEW])$", coord.strip())
    if not m:
        return None
    raw, hemi = m.group(1), m.group(2)
    # Format: DDMM (4 chars) or DDDMM (5 chars)
    if len(raw) == 5:
        deg = int(raw[:3])
        mn  = int(raw[3:]) / 100.0
    else:
        deg = int(raw[:2])
        mn  = int(raw[2:]) / 100.0
    val = deg + mn
    if hemi in ("S", "W"):
        val = -val
    return round(val, 3)


def _decode_xxaa(tokens: list[str]) -> tuple[list[SoundingLevel], float | None, float | None]:
    """
    Decode the XXAA (mandatory levels) section.

    Returns (levels, lat, lon) where lat/lon comes from the mobile-station
    identification groups that precede the sounding body.

    WMO FM-36 identification structure for TEMP DROP (mobile):
      token[0]: NNIXX or station ID
      token[1]: 99LLL  → latitude: lat = LLL/10 °N  (before sounding body)
      token[2]: QLLLL  → longitude: Q=quadrant, LLLL = lon×10
      token[3]: MMMhh  → additional identifier (elevation / instrument code)
      token[4+]: sounding body (PP level triplets)
    """
    lat: Optional[float] = None
    lon: Optional[float] = None

    i = 0
    n = len(tokens)

    # ── Skip section marker (XXAA) if present ──
    if i < n and tokens[i] in ("XXAA", "TTAA"):
        i += 1

    # ── Identification groups ──
    # Station/sonde ID (first numeric group)
    if i < n and tokens[i].isdigit():
        i += 1

    # Latitude (99LLL format where LLL = lat × 10 in tenths of degrees)
    if i < n and tokens[i].startswith("99") and len(tokens[i]) == 5:
        try:
            lat = int(tokens[i][2:]) / 10.0
            i += 1
        except ValueError:
            pass

    # Longitude (QLLLL where first digit Q = quadrant)
    if i < n and len(tokens[i]) == 5 and tokens[i][0] in "1357":
        try:
            Q     = int(tokens[i][0])
            llll  = int(tokens[i][1:])
            lon_raw = llll / 10.0
            _, lon_sign = QUADRANT_SIGN.get(Q, (1, 1))
            lat_sign, _ = QUADRANT_SIGN.get(Q, (1, 1))
            if lat is not None:
                lat *= lat_sign
            lon = lon_sign * lon_raw
            i += 1
        except ValueError:
            pass

    # Skip one additional identification group (height/indicator)
    if i < n and len(tokens[i]) == 5 and tokens[i].isdigit():
        i += 1

    # ── Sounding body ──
    levels: list[SoundingLevel] = []
    surface_pres: Optional[float] = None

    while i < n:
        tok = tokens[i]

        # Terminator / extension section markers
        if tok in ("31313", "61616", "62626"):
            break
        if len(tok) < 5:
            i += 1
            continue

        pp  = tok[:2]
        hhh = tok[2:5]

        if pp not in MANDATORY_LEVELS:
            i += 1
            continue

        # Tropopause / max-wind: these carry wind data only
        if pp in ("88", "77"):
            # Consume the remaining groups for this level if present
            i += 3
            continue

        height  = _decode_height(pp, hhh)
        T, Td   = None, None
        wd, ws  = None, None

        # Temperature group
        if i + 1 < n and len(tokens[i + 1]) == 5:
            T, Td = _decode_temp_dew(tokens[i + 1])
        # Wind group
        if i + 2 < n and len(tokens[i + 2]) == 5:
            wd, ws = _decode_wind(tokens[i + 2])

        # Derive pressure for surface level
        if pp == "99":
            # Surface: pressure is encoded in XXBB or derived from context.
            # Use height hhh as surface elevation (metres MSL).
            pres = surface_pres  # May be None until XXBB is parsed
        else:
            pres = MANDATORY_LEVELS[pp]

        rh = _rh_from_td(T, Td) if T is not None and Td is not None else None

        label = "surface" if pp == "99" else f"{int(pres):d}" if pres else pp
        lv = SoundingLevel(
            pressure_hPa=pres,
            height_m=height,
            temp_C=round(T, 1) if T is not None else None,
            dewpoint_C=round(Td, 1) if Td is not None else None,
            rh_pct=rh,
            wind_dir=wd,
            wind_spd_kts=ws,
            level_code=label,
        )
        levels.append(lv)
        i += 3  # advance past the triplet

    return levels, lat, lon


def _decode_xxbb(tokens: list[str]) -> list[SoundingLevel]:
    """
    Decode the XXBB (significant temperature/humidity levels) section.

    XXBB significant levels use a sequential 2-digit label (00, 11, 22…)
    followed by a 3-digit pressure code:
      NNppp  where NN = sequential index, ppp = last 3 digits of pressure (hPa)

    Pressure reconstruction:
      ppp < 50           → pressure = (ppp + 1000) hPa   (surface layer ~1000–1050 hPa)
      50 ≤ ppp ≤ 1050    → pressure = ppp hPa
    """
    levels: list[SoundingLevel] = []
    i = 0
    n = len(tokens)

    # Skip section marker
    if i < n and tokens[i] in ("XXBB", "TTBB"):
        i += 1

    # Skip identification groups (station ID + lat + lon + ID)
    skipped = 0
    while i < n and skipped < 4 and n > 4:
        if tokens[i].isdigit() and len(tokens[i]) == 5:
            i += 1
            skipped += 1
        else:
            break

    while i < n:
        tok = tokens[i]
        if tok in ("31313", "61616", "62626"):
            break
        if len(tok) < 5:
            i += 1
            continue

        # Sequential label + pressure code
        try:
            NN  = int(tok[:2])
            ppp = int(tok[2:5])
        except ValueError:
            i += 1
            continue

        # Pressure reconstruction
        if ppp < 50:
            pres = float(ppp + 1000)
        else:
            pres = float(ppp)

        T, Td   = None, None
        wd, ws  = None, None

        if i + 1 < n and len(tokens[i + 1]) == 5:
            T, Td = _decode_temp_dew(tokens[i + 1])
        if i + 2 < n and len(tokens[i + 2]) == 5:
            wd, ws = _decode_wind(tokens[i + 2])

        rh = _rh_from_td(T, Td) if T is not None and Td is not None else None
        label = f"{int(pres):d}"

        levels.append(SoundingLevel(
            pressure_hPa=pres,
            height_m=None,
            temp_C=round(T, 1) if T is not None else None,
            dewpoint_C=round(Td, 1) if Td is not None else None,
            rh_pct=rh,
            wind_dir=wd,
            wind_spd_kts=ws,
            level_code=label,
        ))
        i += 3

    return levels


def _parse_recon_extension(text: str) -> dict:
    """
    Parse the 61616 / 62626 reconnaissance extension blocks.

    61616 line format:
      61616 ACID MISSION ... OB NN
    62626 line format:
      62626 MBL WND dddff [AEV NNNtt] [DLM WND ...] [WLhhh dddff NN]
    REL/SPG line:
      N REL LLLLNLLLLLWHHMMSSz SPG LLLLNLLLLLWHHMMSSz
    """
    ext: dict = {}

    # Aircraft & mission (61616)
    m = re.search(r"61616\s+(\S+)\s+(\S+(?:\s+\S+)?)\s+OB\s+(\d+)", text)
    if m:
        ext["aircraft"] = m.group(1)
        ext["mission"]  = m.group(2).strip()
        ext["obs_num"]  = int(m.group(3))

    # Boundary layer stats (62626)
    # MBL WND dddff  → mean BL wind
    m = re.search(r"MBL\s+WND\s+(\d{3})(\d{2})", text)
    if m:
        ext["bl_dir_500m"] = int(m.group(1))
        ext["bl_spd_500m"] = int(m.group(2))

    # DLM WND dddff → deep layer mean wind
    m = re.search(r"DLM\s+WND\s+(\d{3})(\d{2})", text)
    if m:
        ext["dlm_dir"] = int(m.group(1))
        ext["dlm_spd"] = int(m.group(2))

    # WL150 dddff → wind at 150m
    m = re.search(r"WL150\s+(\d{3})(\d{2})", text)
    if m:
        ext["wl150_dir"] = int(m.group(1))
        ext["wl150_spd"] = int(m.group(2))

    # AEV NNNNN → aircraft equivalent vertical speed (reduction factor ×1000)
    m = re.search(r"AEV\s+(\d{5})", text)
    if m:
        ext["aev"] = int(m.group(1))

    # REL position and time
    m = re.search(
        r"REL\s+(\d+[NS]\d+[EW])\s+(\d{6})",
        text,
    )
    if m:
        ext["release_coord"] = m.group(1)
        ext["release_time"]  = m.group(2)  # HHMMSS

    # SPG (surface position / splash)
    m = re.search(
        r"SPG\s+(\d+[NS]\d+[EW])\s+(\d{6})",
        text,
    )
    if m:
        ext["surface_coord"] = m.group(1)
        ext["surface_time"]  = m.group(2)

    return ext


def _parse_coord_group(coord_str: str) -> tuple[Optional[float], Optional[float]]:
    """Parse '2641N08299W' → (26.41, -82.99)."""
    m = re.match(r"(\d+)([NS])(\d+)([EW])", coord_str)
    if not m:
        return None, None
    lat_raw, lat_hemi, lon_raw, lon_hemi = m.groups()
    # Lat: DDMM or DDMMC (ends before N/S)
    lat_deg = int(lat_raw[:2]) + int(lat_raw[2:]) / 100.0
    lon_deg = int(lon_raw[:3]) + int(lon_raw[3:]) / 100.0
    if lat_hemi == "S":
        lat_deg = -lat_deg
    if lon_hemi == "W":
        lon_deg = -lon_deg
    return round(lat_deg, 3), round(lon_deg, 3)


def _parse_bulletin(text: str, basin: str) -> list[Dropsonde]:
    """
    Parse a complete NHC TEMP DROP text bulletin into a list of Dropsonde
    objects.  Each individual sounding is delimited by '=' in the bulletin.
    """
    sondes: list[Dropsonde] = []

    # Extract bulletin issue time from WMO header (UZNT13 KWBC DDHHMM)
    bulletin_time = ""
    m = re.search(r"(?:UZNT\d+|UZPN\d+)\s+KWBC\s+(\d{6})", text)
    if m:
        bulletin_time = m.group(1)  # DDHHMM

    # Split into individual sonde blocks (each ends with '=')
    blocks = re.split(r"=\s*", text)

    for block in blocks:
        block = block.strip()
        if not block or "XXAA" not in block:
            continue

        sonde = Dropsonde(basin=basin, bulletin_time=bulletin_time)

        # ── Extract XXAA and XXBB raw text ──
        xxaa_m = re.search(r"(XXAA\b.*?)(?=XXBB|31313|61616|$)", block, re.S)
        xxbb_m = re.search(r"(XXBB\b.*?)(?=31313|61616|$)", block, re.S)
        ext31  = re.search(r"31313.*",  block, re.S)

        xxaa_text = xxaa_m.group(1).strip() if xxaa_m else ""
        xxbb_text = xxbb_m.group(1).strip() if xxbb_m else ""
        ext_text  = ext31.group(0).strip()   if ext31  else ""

        sonde.raw_xxaa = xxaa_text
        sonde.raw_xxbb = xxbb_text

        # ── Decode XXAA mandatory levels ──
        if xxaa_text:
            tokens = _tokenize(xxaa_text)
            levels, lat, lon = _decode_xxaa(tokens)
            sonde.levels = levels
            # Lat/lon from identification groups (approximate release position)
            if lat is not None:
                sonde.release_lat = lat
            if lon is not None:
                sonde.release_lon = lon

        # ── Decode XXBB significant levels (merge into levels list) ──
        if xxbb_text:
            sig_levels = _decode_xxbb(_tokenize(xxbb_text))
            # Set surface pressure from the first XXBB level near 1000 hPa
            if sig_levels:
                first = sig_levels[0]
                if first.pressure_hPa and 950.0 <= first.pressure_hPa <= 1050.0:
                    sonde.surface_pres_hPa = first.pressure_hPa
                    # Patch surface level in XXAA levels if present
                    for lv in sonde.levels:
                        if lv.level_code == "surface" and lv.pressure_hPa is None:
                            lv.pressure_hPa = sonde.surface_pres_hPa

            # Merge XXBB levels that aren't already in XXAA mandatory levels
            existing_pressures = {lv.pressure_hPa for lv in sonde.levels if lv.pressure_hPa}
            for slv in sig_levels:
                if slv.pressure_hPa not in existing_pressures:
                    sonde.levels.append(slv)

        # ── Sort levels top-down (ascending pressure = descending altitude) ──
        # Top of sounding first (low pressure), surface last (high pressure)
        def sort_key(lv: SoundingLevel) -> float:
            if lv.pressure_hPa is not None:
                return -lv.pressure_hPa  # negate → low pressure (high alt) sorts first
            return 9999.0

        sonde.levels.sort(key=sort_key)

        # ── Parse recon extension (61616 / 62626 / REL / SPG) ──
        ext = _parse_recon_extension(ext_text + "\n" + block)
        sonde.aircraft  = ext.get("aircraft", "")
        sonde.mission   = ext.get("mission",  "")
        sonde.obs_num   = ext.get("obs_num")

        if "release_coord" in ext:
            lat, lon = _parse_coord_group(ext["release_coord"])
            if lat is not None:
                sonde.release_lat = lat
                sonde.release_lon = lon
            t = ext.get("release_time", "")
            if t and len(t) == 6:
                sonde.release_time = f"{t[:2]}:{t[2:4]}:{t[4:6]}Z"

        if "surface_coord" in ext:
            lat, lon = _parse_coord_group(ext["surface_coord"])
            if lat is not None:
                sonde.surface_lat = lat
                sonde.surface_lon = lon
            t = ext.get("surface_time", "")
            if t and len(t) == 6:
                sonde.surface_time = f"{t[:2]}:{t[2:4]}:{t[4:6]}Z"

        if "bl_dir_500m" in ext:
            sonde.bl_stats.mean_wind_dir_500m = ext["bl_dir_500m"]
            sonde.bl_stats.mean_wind_spd_500m = ext["bl_spd_500m"]

        if "wl150_dir" in ext:
            sonde.bl_stats.mean_wind_dir_150m = ext["wl150_dir"]
            sonde.bl_stats.mean_wind_spd_150m = ext["wl150_spd"]

        if sonde.levels:
            sondes.append(sonde)

    return sondes


# ── HTTP Fetch ────────────────────────────────────────────────────────────────

def _strip_html(html: str) -> str:
    """
    Remove HTML tags from an NHC text product page, returning plaintext.
    The actual bulletin content lives inside a <pre> block.
    """
    m = re.search(r"<pre>(.*?)</pre>", html, re.S | re.I)
    if m:
        raw = m.group(1)
    else:
        raw = re.sub(r"<[^>]+>", " ", html)
    # Decode common entities
    raw = raw.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
    raw = raw.replace("&nbsp;", " ")
    return raw


def fetch_bulletins(basins: list[str], timeout: int = 20) -> dict[str, str]:
    """
    Fetch raw bulletin text for each requested basin.
    Returns {basin: bulletin_text}.
    """
    results: dict[str, str] = {}
    session = requests.Session()
    session.headers["User-Agent"] = (
        "DSA-dropsonde-analyzer/1.0 (research tool; "
        "contact: sahrbaker@gmail.com)"
    )

    for basin in basins:
        url = NHC_URLS.get(basin)
        if not url:
            continue
        try:
            resp = session.get(url, timeout=timeout)
            resp.raise_for_status()
            text = _strip_html(resp.text)
            results[basin] = text
        except requests.RequestException as exc:
            print(f"[WARN] Could not fetch {basin.upper()} bulletin: {exc}",
                  file=sys.stderr)

    return results


# ── C++ Thermodynamic Kernel ──────────────────────────────────────────────────

def _find_kernel() -> Optional[Path]:
    exe = _EXE_WIN if platform.system() == "Windows" else _EXE_UNIX
    return exe if exe.exists() else None


def call_kernel(sondes: list[Dropsonde]) -> None:
    """
    Pass each sounding's pressure/T/Td arrays to the C++ dsa_proc kernel for
    derived thermodynamic parameters (CAPE, CIN, mixing ratio, theta-e, …).
    Results are stored in sonde.derived.
    """
    kernel = _find_kernel()
    if kernel is None:
        return  # kernel not compiled, skip silently

    for sonde in sondes:
        payload = [
            {
                "p":  lv.pressure_hPa,
                "z":  lv.height_m,
                "T":  lv.temp_C,
                "Td": lv.dewpoint_C,
                "wd": lv.wind_dir,
                "ws": lv.wind_spd_kts,
            }
            for lv in sonde.levels
            if lv.pressure_hPa is not None and lv.temp_C is not None
        ]
        if not payload:
            continue

        try:
            result = subprocess.run(
                [str(kernel)],
                input=json.dumps(payload),
                capture_output=True,
                text=True,
                timeout=10,
            )
            if result.returncode == 0:
                sonde.derived = json.loads(result.stdout)
        except (subprocess.TimeoutExpired, json.JSONDecodeError, OSError):
            pass


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    ap = argparse.ArgumentParser(
        description="Fetch and decode NHC Hurricane Reconnaisance Dropsonde Soundings"
    )
    ap.add_argument(
        "--basin", default="both",
        choices=["at", "epac", "both"],
        help="Which basin to fetch (default: both)",
    )
    ap.add_argument(
        "--output", default="-",
        help="Output JSON file path, or '-' for stdout (default: stdout)",
    )
    ap.add_argument(
        "--pretty", action="store_true",
        help="Pretty-print JSON output",
    )
    ap.add_argument(
        "--quiet", action="store_true",
        help="Suppress progress messages",
    )
    args = ap.parse_args()

    basins = ["at", "epac"] if args.basin == "both" else [args.basin]

    if not args.quiet:
        print(f"[DSA] Fetching TEMP DROP bulletins: {', '.join(b.upper() for b in basins)}",
              file=sys.stderr)

    bulletins = fetch_bulletins(basins)
    all_sondes: list[Dropsonde] = []

    for basin, text in bulletins.items():
        sondes = _parse_bulletin(text, basin)
        if not args.quiet:
            print(f"[DSA] Parsed {len(sondes)} sonde(s) from {basin.upper()} bulletin",
                  file=sys.stderr)
        all_sondes.extend(sondes)

    if not all_sondes and not args.quiet:
        print("[DSA] No active dropsonde data found (off-season or no active missions).",
              file=sys.stderr)

    # Call C++ kernel for thermodynamics
    call_kernel(all_sondes)

    # Serialise to JSON (convert dataclasses to dicts)
    output = [asdict(s) for s in all_sondes]
    indent = 2 if args.pretty else None
    json_text = json.dumps(output, indent=indent)

    if args.output == "-":
        print(json_text)
    else:
        with open(args.output, "w") as fh:
            fh.write(json_text)
        if not args.quiet:
            print(f"[DSA] Wrote {len(all_sondes)} sonde(s) → {args.output}",
                  file=sys.stderr)


if __name__ == "__main__":
    main()
