"""Render static track/position images for recon missions — matplotlib only.

No live map tiles (and therefore no API key) are needed: coastlines come from
a small bundled Natural Earth 1:110m land-polygon file (scripts/assets/), and
storm/aircraft positions come from the already-parsed HDOB obs. Mirrors the
static-image approach used by sites like cyclonicwx.com/recon/ — images are
regenerated on each pipeline run and the frontend just displays them (user
refreshes to see the latest, no auto-reloading map tiles involved).
"""
import json
import re
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.collections import LineCollection

ASSETS_DIR = Path(__file__).resolve().parent / "assets"
LAND_GEOJSON = ASSETS_DIR / "ne_110m_land.geojson"
OUT_DIR = Path(__file__).resolve().parent.parent / "data" / "recon"

PHASE_COLOR = {"ENROUTE": "#4caf50", "IN STORM": "#f44336", "RETURNING": "#ff9800"}
LAND_COLOR = "#2a2a2a"
LAND_EDGE = "#555555"
BG_COLOR = "#0d1117"
GRID_COLOR = "#2a2f3a"
TEXT_COLOR = "#aab0bb"

_land_polys = None


def _load_land():
    """Lazily parse the bundled GeoJSON into flat (xs, ys) ring lists."""
    global _land_polys
    if _land_polys is not None:
        return _land_polys
    polys = []
    if LAND_GEOJSON.exists():
        data = json.loads(LAND_GEOJSON.read_text(encoding="utf-8"))
        for feat in data["features"]:
            geom = feat["geometry"]
            rings = geom["coordinates"] if geom["type"] == "Polygon" else [
                ring for poly in geom["coordinates"] for ring in poly
            ]
            for ring in rings:
                polys.append(([p[0] for p in ring], [p[1] for p in ring]))
    _land_polys = polys
    return polys


def _draw_basemap(ax, lon_min, lon_max, lat_min, lat_max):
    ax.set_facecolor(BG_COLOR)
    for xs, ys in _load_land():
        if max(xs) < lon_min or min(xs) > lon_max or max(ys) < lat_min or min(ys) > lat_max:
            continue
        ax.fill(xs, ys, facecolor=LAND_COLOR, edgecolor=LAND_EDGE, linewidth=0.6, zorder=1)
    ax.set_xlim(lon_min, lon_max)
    ax.set_ylim(lat_min, lat_max)
    ax.set_aspect(1 / max(0.15, abs(__import__("math").cos(__import__("math").radians((lat_min + lat_max) / 2)))))
    ax.grid(True, color=GRID_COLOR, linewidth=0.5, zorder=0)
    ax.tick_params(colors=TEXT_COLOR, labelsize=7)
    for spine in ax.spines.values():
        spine.set_color(GRID_COLOR)


def _pad_bounds(lons, lats, min_pad=0.5):
    lon_span = max(lons) - min(lons) or 1
    lat_span = max(lats) - min(lats) or 1
    pad = max(min_pad, 0.15 * max(lon_span, lat_span))
    return (min(lons) - pad, max(lons) + pad, min(lats) - pad, max(lats) + pad)


def _plot_track(ax, obs, storms):
    # Phase-colored line segments
    segs, colors = [], []
    for i in range(len(obs) - 1):
        segs.append([(obs[i]["lon"], obs[i]["lat"]), (obs[i + 1]["lon"], obs[i + 1]["lat"])])
        colors.append(PHASE_COLOR.get(obs[i]["phase"], "#888888"))
    if segs:
        ax.add_collection(LineCollection(segs, colors=colors, linewidths=1.8, zorder=3))

    first, last = obs[0], obs[-1]
    ax.scatter([first["lon"]], [first["lat"]], s=26, c="#4caf50", edgecolors="white",
               linewidths=0.8, zorder=4, label="Start")
    last_color = PHASE_COLOR.get(last["phase"], "#888888")
    ax.scatter([last["lon"]], [last["lat"]], s=60, c=last_color, edgecolors="white",
               linewidths=1.2, zorder=5, label="Aircraft")

    for s in storms:
        ax.scatter([s["lon"]], [s["lat"]], marker="*", s=180, c="#ff4444",
                   edgecolors="white", linewidths=0.8, zorder=4)
        ax.annotate(s["name"], (s["lon"], s["lat"]), color="#ff8888", fontsize=7,
                    xytext=(4, 4), textcoords="offset points", zorder=4)
        for r_nm, alpha in ((100, 0.55), (200, 0.3)):
            r_deg = r_nm / 60.0
            circle = plt.Circle((s["lon"], s["lat"]), r_deg, fill=False,
                                 edgecolor="#f44336", alpha=alpha, linewidth=1, zorder=2)
            ax.add_patch(circle)


def _save(fig, path):
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    fig.savefig(path, dpi=130, facecolor=BG_COLOR, bbox_inches="tight", pad_inches=0.15)
    plt.close(fig)


def slugify(key):
    return re.sub(r"[^A-Za-z0-9_\-]", "_", key)[:80]


def render_mission_images(slug, obs, storms):
    """Render 'latest 10 min' and 'full mission' track images. Returns relative paths."""
    if not obs:
        return None, None

    fig1, ax1 = plt.subplots(figsize=(5.2, 4.4))
    recent = obs[-20:]  # ~10 min at 30s cadence
    lons = [o["lon"] for o in recent]
    lats = [o["lat"] for o in recent]
    near_storms = [s for s in storms if min(
        ((o["lon"] - s["lon"]) ** 2 + (o["lat"] - s["lat"]) ** 2) ** 0.5 for o in recent
    ) < 5]
    bounds = _pad_bounds(lons + [s["lon"] for s in near_storms],
                         lats + [s["lat"] for s in near_storms], min_pad=0.4)
    _draw_basemap(ax1, *bounds)
    _plot_track(ax1, recent, near_storms)
    ax1.set_title("Latest 10 Minutes of Observations", color=TEXT_COLOR, fontsize=9)
    latest_path = OUT_DIR / f"{slug}_latest.png"
    _save(fig1, latest_path)

    fig2, ax2 = plt.subplots(figsize=(5.6, 4.8))
    lons_full = [o["lon"] for o in obs]
    lats_full = [o["lat"] for o in obs]
    bounds_full = _pad_bounds(lons_full + [s["lon"] for s in storms],
                              lats_full + [s["lat"] for s in storms])
    _draw_basemap(ax2, *bounds_full)
    _plot_track(ax2, obs, storms)
    ax2.set_title("Full Mission Track", color=TEXT_COLOR, fontsize=9)
    full_path = OUT_DIR / f"{slug}_full.png"
    _save(fig2, full_path)

    return f"data/recon/{slug}_latest.png", f"data/recon/{slug}_full.png"


def render_mission_csv(slug, obs):
    """Write a plain CSV 'sheet' of decoded observations — easy to open in Excel/Sheets."""
    if not obs:
        return None
    cols = ["timeStr", "lat", "lon", "alt", "temp", "dew", "wdir", "wspd",
            "pkWind", "sfmrWind", "phase", "distToStorm"]
    lines = [",".join(cols)]
    for o in obs:
        row = []
        for c in cols:
            v = o.get(c)
            row.append("" if v is None else str(v))
        lines.append(",".join(row))
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    csv_path = OUT_DIR / f"{slug}.csv"
    csv_path.write_text("\n".join(lines), encoding="utf-8")
    return f"data/recon/{slug}.csv"
