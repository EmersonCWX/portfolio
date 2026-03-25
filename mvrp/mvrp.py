"""
MVRP — Mesovortex Risk Parameter
Python driver / API layer.

Calls either the compiled C++ kernel (mvrp_core.dll / mvrp_core.so) for
speed, or falls back to a pure-Python implementation if the shared library
hasn't been compiled yet.

Usage
-----
    from mvrp import MVRPModel

    model = MVRPModel(
        storm_lat=29.5, storm_lon=-90.2,
        heading=340,           # degrees clockwise from north
        wind_kts=130,          # max sustained 1-min wind (knots)
        eye_diam_km=22,        # eye diameter in km
        rmax_km=45,            # radius of max winds in km
    )

    result = model.run()       # returns MVRPResult

    # GeoJSON suitable for Leaflet / browser overlay
    geojson = result.to_geojson()

Build the C++ kernel first (optional but fast):
    Windows:  cl /O2 /LD /EHsc mvrp_core.cpp /Fe:mvrp_core.dll
    Linux:    g++ -O2 -shared -fPIC -o mvrp_core.so mvrp_core.cpp
"""

from __future__ import annotations

import ctypes
import json
import math
import os
import platform
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional


# ---------------------------------------------------------------------------
# C++ kernel loader
# ---------------------------------------------------------------------------

_LIB_DIR   = Path(__file__).parent
_LIB_WIN   = _LIB_DIR / "mvrp_core.dll"
_LIB_UNIX  = _LIB_DIR / "mvrp_core.so"

def _load_kernel() -> Optional[ctypes.CDLL]:
    lib_path = _LIB_WIN if platform.system() == "Windows" else _LIB_UNIX
    if not lib_path.exists():
        return None
    try:
        lib = ctypes.CDLL(str(lib_path))
        lib.compute_risk.restype  = ctypes.c_double
        lib.compute_risk.argtypes = [ctypes.c_double] * 7
        lib.compute_risk_grid.restype  = None
        lib.compute_risk_grid.argtypes = [
            ctypes.c_double,  # storm_lat
            ctypes.c_double,  # storm_lon
            ctypes.c_double,  # heading
            ctypes.c_double,  # wind_kts
            ctypes.c_double,  # eye_diam_km
            ctypes.c_double,  # rmax_km
            ctypes.POINTER(ctypes.c_double),  # lats
            ctypes.POINTER(ctypes.c_double),  # lons
            ctypes.c_int,                     # n
            ctypes.POINTER(ctypes.c_double),  # out
        ]
        return lib
    except OSError:
        return None

_kernel = _load_kernel()


# ---------------------------------------------------------------------------
# Pure-Python fallback (mirrors mvrp_core.cpp exactly)
# ---------------------------------------------------------------------------

_DEG2RAD = math.pi / 180.0
_EARTH_R  = 6371.0


def _haversine(lat1, lon1, lat2, lon2):
    dlat = (lat2 - lat1) * _DEG2RAD
    dlon = (lon2 - lon1) * _DEG2RAD
    a = math.sin(dlat / 2)**2 + math.cos(lat1 * _DEG2RAD) * math.cos(lat2 * _DEG2RAD) * math.sin(dlon / 2)**2
    return 2.0 * _EARTH_R * math.asin(math.sqrt(a))


def _bearing(lat1, lon1, lat2, lon2):
    dlon = (lon2 - lon1) * _DEG2RAD
    y = math.sin(dlon) * math.cos(lat2 * _DEG2RAD)
    x = math.cos(lat1 * _DEG2RAD) * math.sin(lat2 * _DEG2RAD) \
      - math.sin(lat1 * _DEG2RAD) * math.cos(lat2 * _DEG2RAD) * math.cos(dlon)
    return (math.atan2(y, x) / _DEG2RAD + 360.0) % 360.0


def _bearing_diff(heading, to_point):
    diff = to_point - heading
    while diff >  180.0: diff -= 360.0
    while diff < -180.0: diff += 360.0
    return diff


def _intensity_factor(wind_kts):
    v = (wind_kts - 55.0) / (137.0 - 55.0)
    return max(0.0, min(1.0, v))


def _eye_factor(eye_diam_km):
    if eye_diam_km <= 0.0:
        return 0.5
    v = 1.0 - ((eye_diam_km - 10.0) / (90.0 - 10.0))
    return max(0.0, min(1.0, v))


def _quadrant_factor(diff_deg, dist_km, rmax_km):
    angular = 0.5 + 0.5 * math.cos((diff_deg - 45.0) * _DEG2RAD)
    r_norm  = dist_km / max(rmax_km, 1.0)
    radial  = math.exp(-0.5 * ((r_norm - 1.8) / 0.9)**2)
    return angular * radial


def _compute_risk_py(storm_lat, storm_lon, heading, wind_kts, eye_diam_km, rmax_km, grid_lat, grid_lon):
    dist_km  = _haversine(storm_lat, storm_lon, grid_lat, grid_lon)
    brng     = _bearing(storm_lat, storm_lon, grid_lat, grid_lon)
    diff_deg = _bearing_diff(heading, brng)

    I = _intensity_factor(wind_kts)
    E = _eye_factor(eye_diam_km)
    Q = _quadrant_factor(diff_deg, dist_km, rmax_km)

    decay = math.exp(-dist_km / 250.0)
    base  = I * E * Q * decay

    extreme_bonus = 0.0
    if wind_kts >= 130.0 and 0 < eye_diam_km <= 25.0:
        extreme_bonus = 0.15 * Q * decay

    return max(0.0, min(100.0, (base + extreme_bonus) * 100.0))


# ---------------------------------------------------------------------------
# Risk colour mapping
# ---------------------------------------------------------------------------

# Thresholds (%) → colour hex  (matches portfolio legend)
_RISK_COLOURS = [
    (0,   10,  "#22bb33"),   # green
    (10,  25,  "#d4e600"),   # yellow-green
    (25,  45,  "#ffcc00"),   # yellow
    (45,  65,  "#ff6600"),   # orange
    (65,  80,  "#dd1111"),   # red
    (80,  95,  "#cc00cc"),   # purple
    (95,  101, "#ff69b4"),   # pink (hatched in browser)
]

def risk_colour(pct: float) -> str:
    for lo, hi, col in _RISK_COLOURS:
        if lo <= pct < hi:
            return col
    return _RISK_COLOURS[-1][2]


# ---------------------------------------------------------------------------
# Grid definition  (CONUS, ~0.5° resolution for speed)
# ---------------------------------------------------------------------------

_GRID_LAT_RANGE = (24.0, 50.0)   # degrees N
_GRID_LON_RANGE = (-125.0, -65.0) # degrees W
_GRID_STEP      = 0.5             # degrees


def _build_grid():
    lats, lons = [], []
    lat = _GRID_LAT_RANGE[0]
    while lat <= _GRID_LAT_RANGE[1]:
        lon = _GRID_LON_RANGE[0]
        while lon <= _GRID_LON_RANGE[1]:
            lats.append(lat)
            lons.append(lon)
            lon += _GRID_STEP
        lat += _GRID_STEP
    return lats, lons


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

@dataclass
class MVRPResult:
    """Holds the computed risk grid and metadata."""
    storm_lat: float
    storm_lon: float
    heading: float
    wind_kts: float
    eye_diam_km: float
    rmax_km: float
    lats: list[float]
    lons: list[float]
    risks: list[float]          # parallel to lats/lons
    using_kernel: bool = False

    def category(self) -> str:
        """Return Saffir-Simpson category string."""
        w = self.wind_kts
        if w < 64:   return "Tropical Storm"
        if w < 83:   return "Cat-1 Hurricane"
        if w < 96:   return "Cat-2 Hurricane"
        if w < 113:  return "Cat-3 Hurricane"
        if w < 137:  return "Cat-4 Hurricane"
        return "Cat-5 Hurricane"

    def peak_risk(self) -> float:
        return max(self.risks) if self.risks else 0.0

    def to_geojson(self, threshold: float = 5.0) -> dict:
        """
        Convert to GeoJSON FeatureCollection.
        Each feature is a 0.5°×0.5° cell polygon coloured by risk tier.
        Cells below `threshold`% are omitted to keep the payload small.
        """
        half = _GRID_STEP / 2.0
        features = []
        for lat, lon, risk in zip(self.lats, self.lons, self.risks):
            if risk < threshold:
                continue
            colour = risk_colour(risk)
            # Use hatching flag for purple/pink tiers (rendered in browser)
            hatch = risk >= 80.0
            coords = [
                [lon - half, lat - half],
                [lon + half, lat - half],
                [lon + half, lat + half],
                [lon - half, lat + half],
                [lon - half, lat - half],
            ]
            features.append({
                "type": "Feature",
                "geometry": { "type": "Polygon", "coordinates": [coords] },
                "properties": {
                    "risk": round(risk, 1),
                    "colour": colour,
                    "hatch": hatch,
                },
            })
        return {
            "type": "FeatureCollection",
            "features": features,
            "metadata": {
                "storm_lat":    self.storm_lat,
                "storm_lon":    self.storm_lon,
                "heading":      self.heading,
                "wind_kts":     self.wind_kts,
                "eye_diam_km":  self.eye_diam_km,
                "rmax_km":      self.rmax_km,
                "category":     self.category(),
                "peak_risk_pct": round(self.peak_risk(), 1),
                "using_kernel": self.using_kernel,
            },
        }

    def to_geojson_str(self, threshold: float = 5.0, indent: int = 0) -> str:
        return json.dumps(self.to_geojson(threshold), indent=indent or None)


@dataclass
class MVRPModel:
    """Main model interface."""
    storm_lat:   float               # decimal degrees N
    storm_lon:   float               # decimal degrees W (negative)
    heading:     float               # degrees clockwise from N (storm motion)
    wind_kts:    float               # max sustained 1-min wind speed
    eye_diam_km: float = 40.0        # eye diameter, km  (0 = unknown)
    rmax_km:     float = 50.0        # radius of max winds, km

    def run(self) -> MVRPResult:
        """Compute risk over the CONUS grid and return an MVRPResult."""
        lats, lons = _build_grid()
        n = len(lats)
        risks = [0.0] * n
        using_kernel = False

        if _kernel is not None:
            # Use compiled C++ kernel
            DArr = ctypes.c_double * n
            c_lats = DArr(*lats)
            c_lons = DArr(*lons)
            c_out  = DArr(*risks)
            _kernel.compute_risk_grid(
                self.storm_lat, self.storm_lon,
                self.heading, self.wind_kts,
                self.eye_diam_km, self.rmax_km,
                c_lats, c_lons, ctypes.c_int(n), c_out,
            )
            risks = list(c_out)
            using_kernel = True
        else:
            # Pure-Python fallback
            for i in range(n):
                risks[i] = _compute_risk_py(
                    self.storm_lat, self.storm_lon,
                    self.heading, self.wind_kts,
                    self.eye_diam_km, self.rmax_km,
                    lats[i], lons[i],
                )

        return MVRPResult(
            storm_lat=self.storm_lat,
            storm_lon=self.storm_lon,
            heading=self.heading,
            wind_kts=self.wind_kts,
            eye_diam_km=self.eye_diam_km,
            rmax_km=self.rmax_km,
            lats=lats,
            lons=lons,
            risks=risks,
            using_kernel=using_kernel,
        )


# ---------------------------------------------------------------------------
# CLI quick-test
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="MVRP — Mesovortex Risk Parameter")
    parser.add_argument("--lat",     type=float, default=29.5,  help="Storm centre latitude")
    parser.add_argument("--lon",     type=float, default=-90.2, help="Storm centre longitude")
    parser.add_argument("--heading", type=float, default=340.0, help="Storm heading (° CW from N)")
    parser.add_argument("--wind",    type=float, default=130.0, help="Max sustained wind (knots)")
    parser.add_argument("--eye",     type=float, default=22.0,  help="Eye diameter (km)")
    parser.add_argument("--rmax",    type=float, default=45.0,  help="Radius of max winds (km)")
    parser.add_argument("--out",     type=str,   default=None,  help="Output GeoJSON file (optional)")
    parser.add_argument("--threshold", type=float, default=5.0, help="Min risk %% to include in output")
    args = parser.parse_args()

    model  = MVRPModel(args.lat, args.lon, args.heading, args.wind, args.eye, args.rmax)
    result = model.run()

    print(f"Storm:      {result.category()}  ({result.wind_kts} kt)")
    print(f"Eye:        {result.eye_diam_km} km diameter")
    print(f"Kernel:     {'C++ (fast)' if result.using_kernel else 'Python (fallback)'}")
    print(f"Peak risk:  {result.peak_risk():.1f}%")
    print(f"Grid pts:   {len(result.risks)}")

    if args.out:
        out_path = Path(args.out)
        out_path.write_text(result.to_geojson_str(threshold=args.threshold, indent=2))
        print(f"GeoJSON → {out_path}")
