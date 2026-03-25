/**
 * MVRP Core — Mesovortex Risk Parameter
 * C++ computation kernel, callable from Python via ctypes.
 *
 * Compile (Windows, MSVC):
 *   cl /O2 /LD /EHsc mvrp_core.cpp /Fe:mvrp_core.dll
 *
 * Compile (Linux/macOS, GCC):
 *   g++ -O2 -shared -fPIC -o mvrp_core.so mvrp_core.cpp
 *
 * All exported functions use C linkage to prevent name mangling.
 */

#include <cmath>
#include <algorithm>

#ifdef _WIN32
  #define EXPORT extern "C" __declspec(dllexport)
#else
  #define EXPORT extern "C"
#endif

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

static constexpr double DEG2RAD = M_PI / 180.0;
static constexpr double EARTH_R  = 6371.0;  // km

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Haversine great-circle distance between two lat/lon points, in km.
 */
static double haversine(double lat1, double lon1, double lat2, double lon2) {
    double dlat = (lat2 - lat1) * DEG2RAD;
    double dlon = (lon2 - lon1) * DEG2RAD;
    double a = std::sin(dlat / 2) * std::sin(dlat / 2)
             + std::cos(lat1 * DEG2RAD) * std::cos(lat2 * DEG2RAD)
             * std::sin(dlon / 2) * std::sin(dlon / 2);
    return 2.0 * EARTH_R * std::asin(std::sqrt(a));
}

/**
 * Bearing from point 1 → point 2, degrees clockwise from north.
 */
static double bearing(double lat1, double lon1, double lat2, double lon2) {
    double dlon = (lon2 - lon1) * DEG2RAD;
    double y = std::sin(dlon) * std::cos(lat2 * DEG2RAD);
    double x = std::cos(lat1 * DEG2RAD) * std::sin(lat2 * DEG2RAD)
             - std::sin(lat1 * DEG2RAD) * std::cos(lat2 * DEG2RAD) * std::cos(dlon);
    double brng = std::atan2(y, x) / DEG2RAD;
    return std::fmod(brng + 360.0, 360.0);
}

/**
 * Angular difference between two bearings, −180…+180.
 * Positive = query point is clockwise (right) of storm heading.
 */
static double bearing_diff(double heading, double to_point) {
    double diff = to_point - heading;
    while (diff >  180.0) diff -= 360.0;
    while (diff < -180.0) diff += 360.0;
    return diff;
}

// ---------------------------------------------------------------------------
//  Intensity factor  (0 – 1)
//  Scales with category: Cat-1 ≈ 0.30, Cat-5 ≈ 1.00
//  Input: max sustained wind speed in knots.
// ---------------------------------------------------------------------------
static double intensity_factor(double wind_kts) {
    // Saffir-Simpson thresholds (knots): 64, 83, 96, 113, 137
    // Linear ramp: starts contributing at ~55 kts (just below Cat-1)
    double v = (wind_kts - 55.0) / (137.0 - 55.0);   // 0 at 55 kt, 1 at 137 kt
    return std::max(0.0, std::min(1.0, v));
}

// ---------------------------------------------------------------------------
//  Eye-size factor  (0 – 1)
//  Smaller eye → higher mesovortex potential.
//  eye_diam_km: typical range 20–80 km; ≤20 km caps at 1.0.
// ---------------------------------------------------------------------------
static double eye_factor(double eye_diam_km) {
    if (eye_diam_km <= 0.0) return 0.5;   // missing data — neutral
    double v = 1.0 - ((eye_diam_km - 10.0) / (90.0 - 10.0));
    return std::max(0.0, std::min(1.0, v));
}

// ---------------------------------------------------------------------------
//  Quadrant factor  (0 – 1)
//  Right-front quadrant carries maximum risk; rear-left minimum.
//  diff_deg: angular offset from storm heading (−180…+180).
//  dist_km:  distance from storm centre.
//  rmax_km:  radius of max winds.
// ---------------------------------------------------------------------------
static double quadrant_factor(double diff_deg, double dist_km, double rmax_km) {
    // Angular weight: cosine bell centred at +45° (right-front)
    double angular = 0.5 + 0.5 * std::cos((diff_deg - 45.0) * DEG2RAD);

    // Radial weight: Gaussian centred at 1.0–2.5× RMW, where LLWS is strongest
    double r_norm  = dist_km / std::max(rmax_km, 1.0);
    double radial  = std::exp(-0.5 * std::pow((r_norm - 1.8) / 0.9, 2.0));

    return angular * radial;
}

// ---------------------------------------------------------------------------
//  EXPORT: compute_risk
//
//  For a single grid point, compute mesovortex risk percentage (0–100).
//
//  Parameters
//  ----------
//  storm_lat, storm_lon  : storm centre (decimal degrees)
//  storm_heading_deg     : storm motion direction (° clockwise from N)
//  wind_kts              : max sustained 1-min winds (knots)
//  eye_diam_km           : eye diameter (km); pass 0 if unknown
//  rmax_km               : radius of maximum winds (km)
//  grid_lat, grid_lon    : query point
//
//  Returns
//  -------
//  Risk percentage  0.0 – 100.0
// ---------------------------------------------------------------------------
EXPORT double compute_risk(
    double storm_lat, double storm_lon,
    double storm_heading_deg,
    double wind_kts,
    double eye_diam_km,
    double rmax_km,
    double grid_lat, double grid_lon)
{
    double dist_km   = haversine(storm_lat, storm_lon, grid_lat, grid_lon);
    double brng      = bearing(storm_lat, storm_lon, grid_lat, grid_lon);
    double diff_deg  = bearing_diff(storm_heading_deg, brng);

    double I = intensity_factor(wind_kts);   // 0–1
    double E = eye_factor(eye_diam_km);       // 0–1
    double Q = quadrant_factor(diff_deg, dist_km, rmax_km);  // 0–1

    // Base risk: weighted product
    // I and E contribute to the "background" intensity; Q distributes spatially.
    double base = I * E * Q;

    // Distance cut-off: negligible risk beyond 350 km
    double range_decay = std::exp(-dist_km / 250.0);
    base *= range_decay;

    // Cap bonus for extreme intensity + tiny eye
    double extreme_bonus = 0.0;
    if (wind_kts >= 130.0 && eye_diam_km > 0.0 && eye_diam_km <= 25.0) {
        extreme_bonus = 0.15 * Q * range_decay;
    }

    double risk = (base + extreme_bonus) * 100.0;
    return std::max(0.0, std::min(100.0, risk));
}

// ---------------------------------------------------------------------------
//  EXPORT: compute_risk_grid
//
//  Batch version — fills output array for a full lat/lon grid.
//
//  Parameters
//  ----------
//  storm_*             : same as compute_risk
//  lats, lons          : flat arrays of grid-point coordinates
//  n                   : number of grid points
//  out                 : pre-allocated output array of length n (caller owns)
// ---------------------------------------------------------------------------
EXPORT void compute_risk_grid(
    double storm_lat, double storm_lon,
    double storm_heading_deg,
    double wind_kts,
    double eye_diam_km,
    double rmax_km,
    const double* lats, const double* lons,
    int n,
    double* out)
{
    for (int i = 0; i < n; i++) {
        out[i] = compute_risk(
            storm_lat, storm_lon,
            storm_heading_deg,
            wind_kts,
            eye_diam_km,
            rmax_km,
            lats[i], lons[i]);
    }
}
