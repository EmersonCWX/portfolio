/**
 * mrms_proc.cpp — Vermont MRMS Processor
 * ========================================
 * Reads NOAA MRMS GRIB2 files (fetched by mrms_fetch.py),
 * extracts the Northeast CONUS subdomain, computes derived
 * fields, and writes output tiles / binary grids consumed
 * by the web viewer.
 *
 * Build:
 *   g++ -O2 -std=c++17 -o mrms_proc mrms_proc.cpp -leccodes -lz
 *   (requires ecCodes: https://confluence.ecmwf.int/display/ECC)
 *
 * Usage:
 *   ./mrms_proc --input ./data --output ./tiles --product reflect
 *   ./mrms_proc --input ./data --output ./tiles --all
 *
 * Products:
 *   reflect   — MRMS Seamless Hybrid-Scan Reflectivity composite (dBZ)
 *   echotops  — 18-dBZ echo tops (kft)
 *   precip    — Instantaneous precipitation rate (mm/hr)
 *   qpe1h     — 1-hour multi-sensor QPE (mm)
 *
 * Output:
 *   Binary float32 grids (.bin) + JSON metadata per product.
 *   Suitable for serving as tile overlays or ingestion
 *   into the portfolio MRMS viewer.
 */

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <map>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

// ecCodes GRIB2 decoding
#include <eccodes.h>

namespace fs = std::filesystem;

// ── Northeast CONUS bounding box ─────────────────────────────────────────────
static constexpr double NE_LAT_MIN =  40.5;
static constexpr double NE_LAT_MAX =  47.5;
static constexpr double NE_LON_MIN = -76.5;
static constexpr double NE_LON_MAX = -66.5;

// ── Missing / fill values ─────────────────────────────────────────────────────
static constexpr float MRMS_MISSING = -999.0f;

// ── Grid descriptor ───────────────────────────────────────────────────────────
struct Grid {
    std::vector<float> data;
    size_t  nx   = 0;
    size_t  ny   = 0;
    double  lat0 = 0.0, lat1 = 0.0;
    double  lon0 = 0.0, lon1 = 0.0;
    double  dlat = 0.0, dlon = 0.0;
    std::string validTime;
    std::string productName;
};

// ── Helper: format UTC timestamp from GRIB edition 2 keys ─────────────────────
static std::string grib2_timestamp(codes_handle* h) {
    long date = 0, time = 0;
    codes_get_long(h, "dataDate", &date);
    codes_get_long(h, "dataTime", &time);
    // date = YYYYMMDD, time = HHMM
    int yy = date / 10000;
    int mo = (date % 10000) / 100;
    int dd = date % 100;
    int hh = time / 100;
    int mi = time % 100;
    char buf[32];
    std::snprintf(buf, sizeof(buf), "%04d-%02d-%02dT%02d:%02dZ", yy, mo, dd, hh, mi);
    return buf;
}

// ── Open first GRIB2 message matching shortName ───────────────────────────────
static codes_handle* open_grib_message(const std::string& path,
                                        const std::string& shortName)
{
    FILE* f = std::fopen(path.c_str(), "rb");
    if (!f) throw std::runtime_error("Cannot open: " + path);

    int err = 0;
    codes_handle* h = nullptr;
    while ((h = codes_handle_new_from_file(nullptr, f, PRODUCT_GRIB, &err)) != nullptr) {
        if (err != CODES_SUCCESS) break;
        size_t sn_len = 64;
        char sn[64] = {};
        codes_get_string(h, "shortName", sn, &sn_len);
        if (shortName.empty() || shortName == sn) {
            std::fclose(f);
            return h;
        }
        codes_handle_delete(h);
    }
    std::fclose(f);
    throw std::runtime_error("GRIB2 message '" + shortName + "' not found in " + path);
}

// ── Decode full grid from open handle ────────────────────────────────────────
static Grid decode_grid(codes_handle* h) {
    Grid g;

    size_t sz = 0;
    codes_get_size(h, "values", &sz);
    std::vector<double> vals(sz);
    codes_get_double_array(h, "values", vals.data(), &sz);

    // Copy to float
    g.data.resize(sz);
    for (size_t i = 0; i < sz; ++i)
        g.data[i] = static_cast<float>(vals[i]);

    codes_get_long(h, "Ni", reinterpret_cast<long*>(&g.nx));
    codes_get_long(h, "Nj", reinterpret_cast<long*>(&g.ny));

    double lat0 = 0, latN = 0, lon0 = 0, lonN = 0;
    codes_get_double(h, "latitudeOfFirstGridPointInDegrees",  &lat0);
    codes_get_double(h, "latitudeOfLastGridPointInDegrees",   &latN);
    codes_get_double(h, "longitudeOfFirstGridPointInDegrees", &lon0);
    codes_get_double(h, "longitudeOfLastGridPointInDegrees",  &lonN);

    g.lat0 = lat0; g.lat1 = latN;
    g.lon0 = lon0; g.lon1 = lonN;
    g.dlat = (g.ny > 1) ? (latN - lat0) / (g.ny - 1) : 0.0;
    g.dlon = (g.nx > 1) ? (lonN - lon0) / (g.nx - 1) : 0.0;

    g.validTime   = grib2_timestamp(h);
    size_t pn_len = 128;
    char   pn[128] = {};
    codes_get_string(h, "name", pn, &pn_len);
    g.productName = pn;

    return g;
}

// ── Subset to Northeast bounding box ─────────────────────────────────────────
static Grid subset_northeast(const Grid& src) {
    // Compute row/col index ranges
    int row0 = static_cast<int>(std::floor((NE_LAT_MIN - src.lat0) / src.dlat));
    int row1 = static_cast<int>(std::ceil ((NE_LAT_MAX - src.lat0) / src.dlat));
    int col0 = static_cast<int>(std::floor((NE_LON_MIN - src.lon0) / src.dlon));
    int col1 = static_cast<int>(std::ceil ((NE_LON_MAX - src.lon0) / src.dlon));

    row0 = std::max(row0, 0);
    row1 = std::min(row1, (int)src.ny - 1);
    col0 = std::max(col0, 0);
    col1 = std::min(col1, (int)src.nx - 1);

    Grid out;
    out.nx   = static_cast<size_t>(col1 - col0 + 1);
    out.ny   = static_cast<size_t>(row1 - row0 + 1);
    out.lat0 = src.lat0 + row0 * src.dlat;
    out.lat1 = src.lat0 + row1 * src.dlat;
    out.lon0 = src.lon0 + col0 * src.dlon;
    out.lon1 = src.lon0 + col1 * src.dlon;
    out.dlat = src.dlat;
    out.dlon = src.dlon;
    out.validTime   = src.validTime;
    out.productName = src.productName;

    out.data.resize(out.nx * out.ny, MRMS_MISSING);
    for (size_t r = 0; r < out.ny; ++r)
        for (size_t c = 0; c < out.nx; ++c)
            out.data[r * out.nx + c] = src.data[(row0 + r) * src.nx + (col0 + c)];

    return out;
}

// ── Replace GRIB missing with sentinel ───────────────────────────────────────
static void mask_missing(Grid& g, double grib_missing) {
    const float thr = static_cast<float>(grib_missing * 0.99);
    for (auto& v : g.data)
        if (v >= thr) v = MRMS_MISSING;
}

// ── Write binary float32 grid ─────────────────────────────────────────────────
static void write_bin(const Grid& g, const std::string& out_path) {
    std::ofstream f(out_path, std::ios::binary);
    if (!f) throw std::runtime_error("Cannot write: " + out_path);
    // Header: nx(u32) ny(u32)
    uint32_t nx32 = static_cast<uint32_t>(g.nx);
    uint32_t ny32 = static_cast<uint32_t>(g.ny);
    f.write(reinterpret_cast<const char*>(&nx32), 4);
    f.write(reinterpret_cast<const char*>(&ny32), 4);
    f.write(reinterpret_cast<const char*>(g.data.data()),
            g.data.size() * sizeof(float));
    std::cout << "  [write] " << out_path
              << "  (" << g.nx << "x" << g.ny << " px)\n";
}

// ── Write JSON metadata sidecar ───────────────────────────────────────────────
static void write_json(const Grid& g, const std::string& out_path) {
    // Compute data range (ignoring missing)
    float vmin =  1e30f, vmax = -1e30f;
    for (auto v : g.data) {
        if (v == MRMS_MISSING) continue;
        vmin = std::min(vmin, v);
        vmax = std::max(vmax, v);
    }
    std::ofstream f(out_path);
    f << "{\n"
      << "  \"product\": \""   << g.productName << "\",\n"
      << "  \"validTime\": \"" << g.validTime   << "\",\n"
      << "  \"nx\": "          << g.nx          << ",\n"
      << "  \"ny\": "          << g.ny          << ",\n"
      << "  \"lat0\": "        << g.lat0        << ",\n"
      << "  \"lat1\": "        << g.lat1        << ",\n"
      << "  \"lon0\": "        << g.lon0        << ",\n"
      << "  \"lon1\": "        << g.lon1        << ",\n"
      << "  \"dlat\": "        << g.dlat        << ",\n"
      << "  \"dlon\": "        << g.dlon        << ",\n"
      << "  \"vmin\": "        << vmin          << ",\n"
      << "  \"vmax\": "        << vmax          << ",\n"
      << "  \"missing\": "     << MRMS_MISSING  << "\n"
      << "}\n";
    std::cout << "  [meta]  " << out_path << "\n";
}

// ── Process one product file ──────────────────────────────────────────────────
static void process_file(const std::string& grib_path,
                          const std::string& out_dir,
                          const std::string& product_tag)
{
    std::cout << "\n[mrms_proc] " << grib_path << "\n";
    codes_handle* h = open_grib_message(grib_path, "");
    Grid full = decode_grid(h);

    double grib_miss = 9999.0;
    codes_get_double(h, "missingValue", &grib_miss);
    codes_handle_delete(h);

    mask_missing(full, grib_miss);
    Grid ne = subset_northeast(full);

    fs::create_directories(out_dir);
    const std::string stem = out_dir + "/" + product_tag + "_NE_" + ne.validTime;
    write_bin(ne, stem + ".bin");
    write_json(ne, stem + ".json");
}

// ── CLI entry point ───────────────────────────────────────────────────────────
int main(int argc, char* argv[]) {
    std::string input_dir = "./data";
    std::string output_dir = "./tiles";
    std::string product   = "reflect";
    bool process_all = false;

    for (int i = 1; i < argc; ++i) {
        std::string arg(argv[i]);
        if      (arg == "--input"   && i+1 < argc) input_dir  = argv[++i];
        else if (arg == "--output"  && i+1 < argc) output_dir = argv[++i];
        else if (arg == "--product" && i+1 < argc) product    = argv[++i];
        else if (arg == "--all")                   process_all = true;
        else if (arg == "--help") {
            std::cout << "Usage: mrms_proc [--input DIR] [--output DIR] "
                         "[--product reflect|echotops|precip|qpe1h] [--all]\n";
            return 0;
        }
    }

    const std::map<std::string, std::string> PRODUCT_GLOB = {
        { "reflect",   "MergedReflectivityQCComposite" },
        { "echotops",  "EchoTop_18"                    },
        { "precip",    "PrecipRate"                    },
        { "qpe1h",     "MultiSensor_QPE_01H_Pass2"     },
    };

    std::vector<std::pair<std::string,std::string>> targets;
    if (process_all) {
        for (auto& [tag, substr] : PRODUCT_GLOB)
            targets.emplace_back(tag, substr);
    } else {
        auto it = PRODUCT_GLOB.find(product);
        if (it == PRODUCT_GLOB.end()) {
            std::cerr << "[error] Unknown product: " << product << "\n";
            return 1;
        }
        targets.emplace_back(product, it->second);
    }

    int errors = 0;
    for (auto& [tag, substr] : targets) {
        // Find latest matching .grib2 or .grib2.gz in input_dir
        std::string best_file;
        fs::file_time_type best_time{};
        try {
            for (auto& entry : fs::directory_iterator(input_dir)) {
                const std::string fname = entry.path().filename().string();
                auto ends_with = [](const std::string& s, const std::string& sfx) {
                    return s.size() >= sfx.size() && s.compare(s.size()-sfx.size(), sfx.size(), sfx) == 0;
                };
                if (fname.find(substr) != std::string::npos &&
                    (ends_with(fname, ".grib2") || ends_with(fname, ".grib2.gz")))
                {
                    auto mtime = entry.last_write_time();
                    if (best_file.empty() || mtime > best_time) {
                        best_time = mtime;
                        best_file = entry.path().string();
                    }
                }
            }
        } catch (const fs::filesystem_error& e) {
            std::cerr << "[error] " << e.what() << "\n";
            ++errors;
            continue;
        }

        if (best_file.empty()) {
            std::cerr << "[warn] No file found for product: " << tag << "\n";
            continue;
        }

        try {
            process_file(best_file, output_dir, tag);
        } catch (const std::exception& ex) {
            std::cerr << "[error] " << ex.what() << "\n";
            ++errors;
        }
    }

    std::cout << "\n[mrms_proc] Done. Errors: " << errors << "\n";
    return errors > 0 ? 1 : 0;
}
