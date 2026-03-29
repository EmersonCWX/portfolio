/**
 * dsa_proc.cpp — Dropsonde Sounding Analyzer: Thermodynamics Kernel
 * ==================================================================
 * Reads a JSON array of sounding levels from stdin, computes derived
 * thermodynamic parameters, and writes enriched JSON to stdout.
 *
 * Build:
 *   Windows (MSVC): cl /O2 /EHsc /Fe:dsa_proc.exe dsa_proc.cpp
 *   Linux/macOS:    g++ -O2 -std=c++17 -o dsa_proc dsa_proc.cpp
 *
 * Usage:
 *   echo '[{"p":1013,"T":28.2,"Td":24.1,"z":0},...]' | ./dsa_proc
 *
 * Input JSON schema (array of level objects):
 *   p  — pressure (hPa)          required
 *   T  — temperature (°C)        required
 *   Td — dewpoint temperature (°C) optional, null → no moisture calcs
 *   z  — geopotential height (m) optional
 *   wd — wind direction (°)      optional
 *   ws — wind speed (kts)        optional
 *
 * Output JSON schema:
 *   levels[]     — original array augmented with per-level derived fields:
 *     q          — mixing ratio (g/kg)
 *     theta      — potential temperature (K)
 *     theta_e    — equivalent potential temperature (K), Bolton (1980)
 *     T_v        — virtual temperature (°C)
 *     T_wb       — wet-bulb temperature (°C), iterative psychrometric
 *     rh         — relative humidity (%)
 *   summary      — sounding-integrated diagnostics:
 *     LCL_P_hPa  — lifted condensation level pressure (hPa)
 *     LCL_T_C    — LCL temperature (°C)
 *     CAPE_J_kg  — convective available potential energy (J/kg), SB
 *     CIN_J_kg   — convective inhibition (J/kg), SB
 *     K_index    — K-index instability index (°C)
 *     TT_index   — Total-Totals index (°C)
 *     max_wind_kts — peak observed wind speed in sounding
 *     max_wind_P   — pressure level of peak wind (hPa)
 */

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <iostream>
#include <limits>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

// ── Minimal JSON helpers (no external dependencies) ───────────────────────────

// We use a hand-rolled JSON reader/writer adequate for the simple schema above.

struct Level {
    double p;
    double T;
    double Td;
    double z;
    int    wd;
    int    ws;
    bool   has_Td;
    bool   has_z;
    bool   has_wind;
    // Derived
    double q       = std::numeric_limits<double>::quiet_NaN();
    double theta   = std::numeric_limits<double>::quiet_NaN();
    double theta_e = std::numeric_limits<double>::quiet_NaN();
    double T_v     = std::numeric_limits<double>::quiet_NaN();
    double T_wb    = std::numeric_limits<double>::quiet_NaN();
    double rh      = std::numeric_limits<double>::quiet_NaN();
};

static bool _isnan(double v) {
    return std::isnan(v);
}

// ── Thermodynamic functions ───────────────────────────────────────────────────

static constexpr double KELVIN  = 273.15;
static constexpr double R_d     = 287.05;   // J kg⁻¹ K⁻¹  dry air
static constexpr double R_v     = 461.5;    // J kg⁻¹ K⁻¹  water vapour
static constexpr double epsilon = R_d / R_v;  // ≈ 0.622
static constexpr double c_p     = 1005.7;   // J kg⁻¹ K⁻¹  isobaric heat cap
static constexpr double L_v     = 2.501e6;  // J kg⁻¹  latent heat of vap at 0°C
static constexpr double kappa   = R_d / c_p; // ≈ 0.2854
static constexpr double g       = 9.80665;  // m s⁻²
static constexpr double P_0     = 1000.0;   // reference pressure (hPa)

/**
 * Saturation vapour pressure (hPa) at temperature T (°C).
 * Bolton (1980): accurate to ~0.1% for temperatures -35 to +35°C.
 */
static double e_s(double T_C) {
    return 6.112 * std::exp(17.67 * T_C / (T_C + 243.5));
}

/**
 * Mixing ratio (g/kg) given temperature T_C, dewpoint Td_C, pressure p_hPa.
 */
static double mixing_ratio(double Td_C, double p_hPa) {
    double e = e_s(Td_C);
    double w = 1000.0 * epsilon * e / (p_hPa - e);
    return w;
}

/**
 * Relative humidity (%) from T and Td (°C).
 */
static double rh_from_TdT(double T_C, double Td_C) {
    return 100.0 * e_s(Td_C) / e_s(T_C);
}

/**
 * Potential temperature θ (K) at pressure p_hPa, temperature T_C.
 */
static double theta(double T_C, double p_hPa) {
    return (T_C + KELVIN) * std::pow(P_0 / p_hPa, kappa);
}

/**
 * Equivalent potential temperature θ_e (K), Bolton (1980) eq. 43.
 * Accurate moist-adiabatic formulation valid in the troposphere.
 *
 * Bolton, D., 1980: The computation of equivalent potential temperature.
 *   Mon. Wea. Rev., 108, 1046–1053.
 */
static double theta_e_bolton(double T_C, double Td_C, double p_hPa) {
    double T_K  = T_C  + KELVIN;
    double Td_K = Td_C + KELVIN;

    // Saturation mixing ratio at dewpoint (g/kg)
    double r = mixing_ratio(Td_C, p_hPa) / 1000.0;  // kg/kg

    // LCL temperature (Bolton eq. 15)
    double T_L = 1.0 / (1.0 / (Td_K - 56.0) + std::log(T_K / Td_K) / 800.0) + 56.0;

    // θ_e (Bolton eq. 43)
    double th_e = T_K *
        std::pow(P_0 / p_hPa, 0.2854 * (1.0 - 0.28e-3 * r * 1000.0)) *
        std::exp(
            (3.376 / T_L - 0.00254) *
            r * 1000.0 * (1.0 + 0.81e-3 * r * 1000.0)
        );
    return th_e;
}

/**
 * Virtual temperature T_v (°C) from T (°C), mixing ratio r (g/kg), pressure p (hPa).
 * Tv = T * (1 + r/epsilon) / (1 + r)   where r is in kg/kg here.
 */
static double T_virtual(double T_C, double r_g_kg) {
    double r = r_g_kg / 1000.0;
    double T_K = T_C + KELVIN;
    return T_K * (1.0 + r / epsilon) / (1.0 + r) - KELVIN;
}

/**
 * Lifted condensation level (LCL):
 * Returns (T_lcl °C, P_lcl hPa).
 * Uses Bolton (1980) eq. 15 and hydrostatic extrapolation.
 */
static std::pair<double, double> lcl(double T_C, double Td_C, double p_hPa) {
    double T_K  = T_C  + KELVIN;
    double Td_K = Td_C + KELVIN;

    // LCL temperature (Bolton eq. 15)
    double T_L_K = 1.0 / (1.0 / (Td_K - 56.0) + std::log(T_K / Td_K) / 800.0) + 56.0;

    // LCL pressure (Poisson)
    double P_L = p_hPa * std::pow(T_L_K / T_K, 1.0 / kappa);
    return { T_L_K - KELVIN, P_L };
}

/**
 * Moist-adiabatic temperature at pressure p2 starting from (T1, p1) and
 * saturated mixing ratio r_s.  Uses a simple Euler step (accurate enough
 * for CAPE integration with many narrow layers).
 */
static double moist_adiabat_step(double T_K, double r_s_kg_kg, double p_hPa,
                                  double dp_hPa) {
    // Eq. for saturated lapse rate (Emanuel 1994 notation):
    double es   = e_s(T_K - KELVIN);  // hPa
    double r_s  = r_s_kg_kg;
    double num  = 1.0 + (L_v * r_s) / (R_d * T_K);
    double den  = 1.0 + (L_v * L_v * r_s) / (c_p * R_v * T_K * T_K);
    double dT_dp = (R_d * T_K) / (p_hPa * c_p) * (num / den);
    return T_K + dT_dp * dp_hPa;
}

/**
 * Wet-bulb temperature T_wb (°C) via iterative psychrometric equation.
 * Uses Sprung's approximation as initial guess; refines with Newton's method.
 */
static double wet_bulb(double T_C, double Td_C, double p_hPa) {
    double rh  = rh_from_TdT(T_C, Td_C) / 100.0;
    // Initial guess: simplified
    double T_wb_C = T_C - (1.0 - rh) * (T_C + 112.0) / (T_C + 112.0 + 80.0);
    // Iterate: psychrometric equation  e_s(T_wb) - (p/A)*(T - T_wb) = e_d(Td)
    // where A = psychrometric constant ≈ 0.6665 for Assman psychrometer, hPa/°C
    double A = 6.6e-4 * p_hPa;
    double e_d = e_s(Td_C);
    for (int iter = 0; iter < 20; ++iter) {
        double f   = e_s(T_wb_C) - A * (T_C - T_wb_C) - e_d;
        double df  = 17.67 * 243.5 / std::pow(T_wb_C + 243.5, 2) * e_s(T_wb_C) + A;
        double dT  = -f / df;
        T_wb_C += dT;
        if (std::fabs(dT) < 1e-4) break;
    }
    return T_wb_C;
}

/**
 * Compute CAPE and CIN (J/kg) by lifting a surface-based parcel.
 *
 * Algorithm:
 * 1. Identify surface parcel (lowest level with valid T, Td).
 * 2. Lift parcel dry adiabatically to LCL.
 * 3. From LCL upward, lift along saturated (pseudo-)adiabat.
 * 4. At each grid layer, compare parcel T_v to environment T_v.
 *    Integrate over layers where parcel is buoyant (CAPE) or negatively
 *    buoyant below EL (CIN).
 */
struct CAPEResult {
    double CAPE = 0.0;
    double CIN  = 0.0;
    double LCL_P = std::numeric_limits<double>::quiet_NaN();
    double LCL_T = std::numeric_limits<double>::quiet_NaN();
};

static CAPEResult cape_cin(const std::vector<Level>& levels) {
    CAPEResult res;
    if (levels.empty()) return res;

    // Find surface parcel (highest pressure with valid T and Td)
    const Level* sfc = nullptr;
    for (auto it = levels.rbegin(); it != levels.rend(); ++it) {
        if (it->has_Td && !_isnan(it->T) && !_isnan(it->Td)) {
            sfc = &(*it);
            break;
        }
    }
    if (!sfc) return res;

    // Surface parcel properties
    double T_sfc_C  = sfc->T;
    double Td_sfc_C = sfc->Td;
    double P_sfc    = sfc->p;

    // LCL
    auto [T_lcl_C, P_lcl] = lcl(T_sfc_C, Td_sfc_C, P_sfc);
    res.LCL_P = P_lcl;
    res.LCL_T = T_lcl_C;

    // Parcel mixing ratio at surface (conserved below LCL)
    double r_parcel = mixing_ratio(Td_sfc_C, P_sfc) / 1000.0;  // kg/kg

    // Theta of surface parcel (conserved on dry adiabat)
    double theta_sfc = theta(T_sfc_C, P_sfc);  // K

    double CAPE = 0.0, CIN = 0.0;
    double T_parcel_K = 0.0;
    bool   above_lcl  = false;

    // Loop upward through sounding levels
    for (int i = (int)levels.size() - 2; i >= 0; --i) {
        const Level& lo = levels[i + 1];  // lower boundary
        const Level& hi = levels[i];      // upper boundary

        if (hi.p > P_sfc) continue;  // below surface parcel

        // Parcel temperature at the upper level
        if (!above_lcl && hi.p > P_lcl) {
            // Dry adiabatic: parcel T(p) from theta_sfc
            T_parcel_K = theta_sfc * std::pow(hi.p / P_0, kappa);
        } else {
            // We just crossed LCL
            above_lcl = true;
            // Lift moist-adiabatically from the lower level's parcel temp
            double T_lo_parcel_K = theta_sfc * std::pow(
                std::min(lo.p, P_lcl) / P_0, kappa);
            // Saturated mixing ratio at top of dry-adiabat segment
            double T_at_lcl_K = T_lcl_C + KELVIN;
            double r_s = mixing_ratio((T_at_lcl_K - KELVIN), P_lcl) / 1000.0;
            r_s = std::max(r_s, 0.0);

            // Integrate moist adiabat in 10-hPa steps from LCL to hi.p
            double p_step = std::min(lo.p, P_lcl);
            double T_step = T_lo_parcel_K;
            double dp     = 10.0;
            while (p_step - dp > hi.p) {
                double r_s_cur = mixing_ratio(T_step - KELVIN, p_step) / 1000.0;
                r_s_cur = std::max(r_s_cur, 0.0);
                T_step = moist_adiabat_step(T_step, r_s_cur, p_step, -dp);
                p_step -= dp;
            }
            // Final step
            double r_s_cur = mixing_ratio(T_step - KELVIN, p_step) / 1000.0;
            T_step = moist_adiabat_step(T_step, r_s_cur, p_step, -(p_step - hi.p));
            T_parcel_K = T_step;
        }

        // Environmental virtual temperature (approximate without environment moisture)
        double r_env = hi.has_Td
            ? mixing_ratio(hi.Td, hi.p) / 1000.0
            : 0.0;
        double Tv_env_K    = (hi.T + KELVIN) * (1.0 + r_env / epsilon) / (1.0 + r_env);

        // Parcel virtual temperature
        double r_parcel_layer = above_lcl
            ? mixing_ratio(T_parcel_K - KELVIN, hi.p) / 1000.0
            : r_parcel;
        double Tv_parcel_K = T_parcel_K * (1.0 + r_parcel_layer / epsilon)
                             / (1.0 + r_parcel_layer);

        // Layer-mean buoyancy (trapezoidal average across pressure layer)
        double buoy = g * (Tv_parcel_K - Tv_env_K) / Tv_env_K;

        // Layer depth in metres (hydrostatic):
        // dz ≈ -R_d * T_bar / (g * p_bar) * dp
        double T_bar   = 0.5 * (lo.T + hi.T) + KELVIN;
        double p_bar   = 0.5 * (lo.p + hi.p);
        double dp_pa   = (lo.p - hi.p) * 100.0;  // Pa
        double dz      = (R_d * T_bar * dp_pa) / (g * p_bar * 100.0);

        double contribution = buoy * dz;
        if (contribution > 0.0)
            CAPE += contribution;
        else if (CAPE == 0.0)        // still in CIN layer
            CIN  += contribution;    // CIN is negative by convention
    }

    res.CAPE = CAPE;
    res.CIN  = CIN;
    return res;
}

// ── Stability Indices ─────────────────────────────────────────────────────────

/**
 * K-Index = (T850 - T500) + Td850 - (T700 - Td700)
 * Values > 30 indicate high thunderstorm potential.
 */
static double k_index(
    double T850, double Td850,
    double T700, double Td700,
    double T500)
{
    return (T850 - T500) + Td850 - (T700 - Td700);
}

/**
 * Total-Totals Index = (T850 + Td850) - 2 * T500
 * Values > 50 indicate severe weather potential.
 */
static double tt_index(double T850, double Td850, double T500) {
    return (T850 + Td850) - 2.0 * T500;
}

// ── JSON Parser (minimal, for this schema) ────────────────────────────────────

static double json_num(const std::string& src, const std::string& key,
                       double fallback = std::numeric_limits<double>::quiet_NaN())
{
    std::string pattern = "\"" + key + "\"";
    auto pos = src.find(pattern);
    if (pos == std::string::npos) return fallback;
    pos = src.find(':', pos + pattern.size());
    if (pos == std::string::npos) return fallback;
    ++pos;
    while (pos < src.size() && (src[pos] == ' ' || src[pos] == '\t')) ++pos;
    if (pos >= src.size() || src[pos] == 'n') return fallback;  // null
    try {
        size_t end;
        double v = std::stod(src.substr(pos), &end);
        return v;
    } catch (...) {
        return fallback;
    }
}

static std::vector<std::string> json_split_objects(const std::string& arr) {
    std::vector<std::string> objs;
    int depth = 0;
    size_t start = std::string::npos;
    for (size_t i = 0; i < arr.size(); ++i) {
        if (arr[i] == '{') {
            if (depth == 0) start = i;
            ++depth;
        } else if (arr[i] == '}') {
            --depth;
            if (depth == 0 && start != std::string::npos) {
                objs.push_back(arr.substr(start, i - start + 1));
                start = std::string::npos;
            }
        }
    }
    return objs;
}

// ── JSON Writer helpers ───────────────────────────────────────────────────────

static std::string fmt_dbl(double v, int prec = 2) {
    if (std::isnan(v) || std::isinf(v)) return "null";
    std::ostringstream oss;
    oss.precision(prec);
    oss << std::fixed << v;
    return oss.str();
}

static std::string level_to_json(const Level& lv, bool first) {
    std::ostringstream o;
    if (!first) o << ",";
    o << "{";
    o << "\"p\":"  << fmt_dbl(lv.p, 1);
    o << ",\"T\":"  << fmt_dbl(lv.T, 1);
    if (lv.has_Td) o << ",\"Td\":"  << fmt_dbl(lv.Td, 1);
    else           o << ",\"Td\":null";
    if (lv.has_z)  o << ",\"z\":"   << fmt_dbl(lv.z, 0);
    if (lv.has_wind) {
        o << ",\"wd\":" << lv.wd;
        o << ",\"ws\":" << lv.ws;
    }
    // Derived
    o << ",\"q\":"      << fmt_dbl(lv.q,       2);
    o << ",\"theta\":"  << fmt_dbl(lv.theta,    2);
    o << ",\"theta_e\":" << fmt_dbl(lv.theta_e, 2);
    o << ",\"T_v\":"    << fmt_dbl(lv.T_v,      2);
    o << ",\"T_wb\":"   << fmt_dbl(lv.T_wb,     2);
    o << ",\"rh\":"     << fmt_dbl(lv.rh,       1);
    o << "}";
    return o.str();
}

// ── Main ──────────────────────────────────────────────────────────────────────

int main() {
    // Read all stdin
    std::string input(std::istreambuf_iterator<char>(std::cin),
                      std::istreambuf_iterator<char>());

    if (input.empty()) {
        std::cerr << "[dsa_proc] No input received.\n";
        return 1;
    }

    // Parse JSON array of level objects
    auto obj_strs = json_split_objects(input);
    std::vector<Level> levels;
    levels.reserve(obj_strs.size());

    for (const auto& s : obj_strs) {
        Level lv{};
        lv.p  = json_num(s, "p");
        lv.T  = json_num(s, "T");
        double Td = json_num(s, "Td");
        lv.has_Td  = !std::isnan(Td);
        lv.Td = lv.has_Td ? Td : 0.0;
        double z = json_num(s, "z");
        lv.has_z = !std::isnan(z);
        lv.z = lv.has_z ? z : 0.0;
        double wd = json_num(s, "wd");
        double ws = json_num(s, "ws");
        lv.has_wind = !std::isnan(wd) && !std::isnan(ws);
        lv.wd = lv.has_wind ? (int)wd : 0;
        lv.ws = lv.has_wind ? (int)ws : 0;

        if (std::isnan(lv.p) || std::isnan(lv.T)) continue;
        levels.push_back(lv);
    }

    // Sort levels top-down (lowest pressure first = highest altitude)
    std::sort(levels.begin(), levels.end(),
        [](const Level& a, const Level& b){ return a.p < b.p; });

    // ── Per-level derived quantities ──
    double max_wind_kts = 0.0;
    double max_wind_P   = std::numeric_limits<double>::quiet_NaN();

    for (auto& lv : levels) {
        if (lv.has_Td) {
            lv.q       = mixing_ratio(lv.Td, lv.p);
            lv.theta_e = theta_e_bolton(lv.T, lv.Td, lv.p);
            lv.T_v     = T_virtual(lv.T, lv.q);
            lv.T_wb    = wet_bulb(lv.T, lv.Td, lv.p);
            lv.rh      = std::clamp(rh_from_TdT(lv.T, lv.Td), 0.0, 100.0);
        } else {
            lv.T_v = lv.T;  // approximate virtual = actual when no moisture
        }
        lv.theta = theta(lv.T, lv.p);

        if (lv.has_wind && lv.ws > max_wind_kts) {
            max_wind_kts = lv.ws;
            max_wind_P   = lv.p;
        }
    }

    // ── CAPE / CIN ──
    CAPEResult cr = cape_cin(levels);

    // ── Find levels at key pressures for stability indices ──
    auto find_level = [&](double target_p) -> const Level* {
        const Level* best = nullptr;
        double best_diff = 999.0;
        for (const auto& lv : levels) {
            double diff = std::fabs(lv.p - target_p);
            if (diff < best_diff) {
                best_diff = diff;
                best = &lv;
            }
        }
        return (best_diff < 30.0) ? best : nullptr;
    };

    const Level* l850 = find_level(850.0);
    const Level* l700 = find_level(700.0);
    const Level* l500 = find_level(500.0);

    double K   = std::numeric_limits<double>::quiet_NaN();
    double TT  = std::numeric_limits<double>::quiet_NaN();

    if (l850 && l850->has_Td && l700 && l700->has_Td && l500) {
        K  = k_index(l850->T, l850->Td, l700->T, l700->Td, l500->T);
        TT = tt_index(l850->T, l850->Td, l500->T);
    }

    // ── Emit output JSON ──
    std::ostringstream out;
    out << "{";
    out << "\"levels\":[";
    for (size_t i = 0; i < levels.size(); ++i)
        out << level_to_json(levels[i], i == 0);
    out << "],";
    out << "\"summary\":{";
    out << "\"LCL_P_hPa\":"  << fmt_dbl(cr.LCL_P, 1) << ",";
    out << "\"LCL_T_C\":"    << fmt_dbl(cr.LCL_T, 1) << ",";
    out << "\"CAPE_J_kg\":"  << fmt_dbl(cr.CAPE,  0) << ",";
    out << "\"CIN_J_kg\":"   << fmt_dbl(cr.CIN,   0) << ",";
    out << "\"K_index\":"    << fmt_dbl(K,         1) << ",";
    out << "\"TT_index\":"   << fmt_dbl(TT,        1) << ",";
    out << "\"max_wind_kts\":" << fmt_dbl(max_wind_kts, 0) << ",";
    out << "\"max_wind_P\":"   << fmt_dbl(max_wind_P,   1);
    out << "}}";

    std::cout << out.str() << std::flush;
    return 0;
}
