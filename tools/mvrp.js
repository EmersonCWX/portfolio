    // ── MV-REP (Mesovortex Risk Evaluation Parameter) ──
    (function () {
      // ── Math kernel (mirrors mvrp_core.cpp) ──
      const DEG2RAD = Math.PI / 180;
      const EARTH_R = 6371;

      function haversine(lat1, lon1, lat2, lon2) {
        const dlat = (lat2 - lat1) * DEG2RAD;
        const dlon = (lon2 - lon1) * DEG2RAD;
        const a = Math.sin(dlat/2)**2
                + Math.cos(lat1*DEG2RAD)*Math.cos(lat2*DEG2RAD)*Math.sin(dlon/2)**2;
        return 2 * EARTH_R * Math.asin(Math.sqrt(a));
      }

      function bearing(lat1, lon1, lat2, lon2) {
        const dlon = (lon2 - lon1) * DEG2RAD;
        const y = Math.sin(dlon) * Math.cos(lat2*DEG2RAD);
        const x = Math.cos(lat1*DEG2RAD)*Math.sin(lat2*DEG2RAD)
                - Math.sin(lat1*DEG2RAD)*Math.cos(lat2*DEG2RAD)*Math.cos(dlon);
        return (Math.atan2(y, x) / DEG2RAD + 360) % 360;
      }

      function bearingDiff(heading, toPoint) {
        let d = toPoint - heading;
        while (d >  180) d -= 360;
        while (d < -180) d += 360;
        return d;
      }

      function intensityFactor(wind) {
        return Math.max(0, Math.min(1, (wind - 55) / (137 - 55)));
      }

      // Smaller, tighter eye = stronger barotropic shear = more mesovortex
      // instability. Exponential so a contracting eye (30→20km) drives a
      // steep rise rather than a gentle linear climb.
      function eyeFactor(eyeDiam) {
        if (eyeDiam <= 0) return 0.6;
        // Normalise: eye=10km → 1.0, eye=60km → ~0.08
        return Math.max(0, Math.min(1, Math.exp(-0.045 * (eyeDiam - 10))));
      }

      function quadrantFactor(diffDeg, distKm, rmaxKm) {
        const rNorm = distKm / Math.max(rmaxKm, 1);

        // ── Hard outer cutoff ──────────────────────────────────────────────
        // Mesovortices exist only within the eyewall. Beyond 2.5× RMW the
        // convective ring ends and barotropic instability collapses to zero.
        if (rNorm > 2.5) return 0;

        // ── Radial ring ────────────────────────────────────────────────────
        // Gaussian peaked exactly at the RMW (rNorm=1). σ=0.28 ≈ half-width
        // of ~0.3×RMW so the meaningful ring spans roughly 0.4-1.6× RMW.
        const radial = Math.exp(-0.5 * ((rNorm - 1.0) / 0.28) ** 2);

        // ── Angular confinement ────────────────────────────────────────────
        // A mesovortex lives ≤25 s. At 60 m/s eyewall wind that is ~1.5 km
        // of arc travel, or <1° of the eyewall circle for a 37km-RMW storm.
        // Each vortex therefore forms AND dissipates within its birth sector;
        // it cannot rotate from the left-rear to the right-front quadrant.
        // A Gaussian with σ=65° captures this tight confinement:
        //   right-front +45°  → angular = 1.00 (maximum)
        //   forward      +90°  → angular = 0.73
        //   right-rear     0°  → angular = 0.73
        //   left-front  +135°  → angular = 0.22
        //   left-rear   -135°  → angular = 0.09
        //   dead behind -180°  → angular = 0.04
        // Storm translation adds to wind on the right side (super-rotation),
        // which is why the peak sits at +45° (right-of-motion forward sector).
        const angOff  = ((diffDeg - 45) + 540) % 360 - 180; // ∈ [-180, +180]
        const angular = Math.exp(-0.5 * (angOff / 65) ** 2);

        return angular * radial;
      }

// ── Coastal land-interaction enhancement ──────────────────────────────
      // Observed: areas 0-4 statute miles inland show elevated mesovortex
      // damage swaths. Mechanism: sudden roughness jump at the land-sea
      // boundary disrupts balanced eyewall flow, injecting boundary-layer
      // vorticity that coalesces into more frequent / longer-lived mesovortices.
      //
      // CONUS Gulf + Atlantic SE coast polyline (directed W→E along Gulf, then
      // S→N up the Atlantic).  Inland = LEFT side of the directed polyline
      // (2-D cross product > 0).  Covers TX→FL Gulf coast and FL→VA Atlantic.
      const COAST_PTS = [
        [25.9,-97.4],[27.8,-97.4],[28.5,-96.4],[29.3,-94.8],[29.7,-93.9],
        [29.8,-93.3],[29.5,-92.2],[29.7,-91.2],[29.6,-90.7],[29.2,-90.0],
        [29.0,-89.8],[29.1,-89.4],[29.0,-89.2],[30.4,-88.9],[30.7,-88.0],
        [30.4,-87.2],[30.2,-85.7],[29.7,-85.0],[29.8,-84.7],[29.9,-83.6],
        [29.1,-83.0],[28.9,-82.6],[28.2,-82.8],[27.8,-82.7],[27.3,-82.6],
        [26.9,-82.2],[26.6,-82.0],[26.2,-81.7],[25.8,-81.4],[25.1,-81.1],
        [24.8,-81.0],[24.6,-81.8],[24.7,-81.0],[25.1,-80.4],[25.5,-80.4],
        [25.8,-80.2],[26.1,-80.1],[26.7,-80.0],[27.5,-80.3],[28.1,-80.7],
        [28.6,-81.0],[29.2,-81.0],[29.8,-81.3],[30.3,-81.4],[30.7,-81.5],
        [31.1,-81.5],[31.7,-81.2],[32.1,-80.8],[32.8,-79.9],[33.5,-79.1],
        [33.8,-78.0],[34.2,-77.9],[34.7,-76.7],[35.2,-75.5],[35.9,-75.6],
        [36.9,-76.0],
      ];

      // Distance from point P to segment A→B (km, using haversine for the
      // clamped projection point so curvature is handled correctly).
      function distToSegKm(pLat,pLon, aLat,aLon, bLat,bLon) {
        const dx=bLon-aLon, dy=bLat-aLat;
        const len2=dx*dx+dy*dy;
        if (len2 < 1e-12) return haversine(pLat,pLon,aLat,aLon);
        const t = Math.max(0, Math.min(1,
          ((pLon-aLon)*dx + (pLat-aLat)*dy) / len2));
        return haversine(pLat,pLon, aLat+t*dy, aLon+t*dx);
      }

      // Returns a multiplier applied to mesovortex risk for coastal land zones.
      // Peak = 1.45 right at the shoreline, falling linearly to 1.0 at 4 mi.
      // No enhancement is applied offshore (cross-product <= 0).
      function coastalFactor(lat, lon) {
        const LAND_KM = 4 * 1.60934;   // 4 statute miles = 6.44 km
        let minD = Infinity, bestCross = 0;
        for (let i = 0; i < COAST_PTS.length - 1; i++) {
          const [aLat,aLon] = COAST_PTS[i];
          const [bLat,bLon] = COAST_PTS[i+1];
          const d = distToSegKm(lat,lon, aLat,aLon, bLat,bLon);
          if (d < minD) {
            minD = d;
            // 2-D cross product: positive → left side of A→B → inland
            const daX=bLon-aLon, daY=bLat-aLat;
            const dpX=lon-aLon,  dpY=lat-aLat;
            bestCross = daX*dpY - daY*dpX;
          }
        }
        // Only enhance inland points within 4 statute miles of the coast
        if (bestCross <= 0 || minD > LAND_KM) return 1.0;
        return 1.0 + 0.45 * (1 - minD / LAND_KM);
      }

      // ── NWP Convective Parameters (HRRR / RRFS) ─────────────────────────────
      //
      // Updraft Helicity (2-5 km AGL, m²/s²)
      //   Captures rotating eyewall updrafts. High UH → organized rotation →
      //   elevated mesovortex formation probability.
      //   Calibration: 0→×0.50 (absent), 75→×1.00 (neutral), ≥150→×1.60 (extreme)
      //
      function uhFactor(uh) {
        if (uh == null || isNaN(uh) || uh < 0) return 1.0; // neutral when unavailable
        return 0.50 + 1.10 * Math.max(0, Math.min(1, uh / 150));
      }

      // Storm Relative Helicity (0-3 km, m²/s²)
      //   Low-level streamwise vorticity available for tilting into rotating updrafts.
      //   Calibration: 0→×0.60, 200→×1.05, ≥400→×1.50
      //
      function srhFactor(srh) {
        if (srh == null || isNaN(srh) || srh < 0) return 1.0; // neutral when unavailable
        return 0.60 + 0.90 * Math.max(0, Math.min(1, srh / 400));
      }

      // ── HRRR / RRFS Lambert Conformal CONUS 3-km grid projection ────────────
      // Both HRRR and RRFS-A share the same NCEP CONUS domain:
      //   nx=1799, ny=1059, dx=3000 m, standard parallel=38.5°N,
      //   central meridian=−97.5°W, SW corner≈21.14°N 122.72°W
      //
      const _LC = (function () {
        const R   = 6371229.0;               // NCEP sphere radius (m)
        const dx  = 3000;                    // grid spacing (m)
        const phi0 = 38.5  * DEG2RAD;        // standard parallel
        const lam0 = -97.5 * DEG2RAD;        // central meridian
        const n    = Math.sin(phi0);
        const F    = R * Math.cos(phi0) / n * Math.pow(Math.tan(Math.PI / 4 + phi0 / 2), n);
        const r0   = R * Math.cos(phi0) / n; // ρ at standard parallel (y-reference)

        function proj(latD, lonD) {
          const phi  = latD * DEG2RAD, lam = lonD * DEG2RAD;
          const rhoM = F / Math.pow(Math.tan(Math.PI / 4 + phi / 2), n);
          const th   = n * (lam - lam0);
          return { x: rhoM * Math.sin(th), y: r0 - rhoM * Math.cos(th) };
        }

        const orig = proj(21.1381, -122.7195); // SW corner → (i=0, j=0)
        return { dx, nx: 1799, ny: 1059, proj, orig };
      })();

      function latLonToHRRRij(lat, lon) {
        const { proj, orig, dx, nx, ny } = _LC;
        const pt = proj(lat, lon);
        return {
          i: Math.max(0, Math.min(nx - 1, Math.round((pt.x - orig.x) / dx))),
          j: Math.max(0, Math.min(ny - 1, Math.round((pt.y - orig.y) / dx))),
        };
      }

      // ── NOMADS OpeNDAP fetch helpers ─────────────────────────────────────────
      //
      // USER API HOOK ─────────────────────────────────────────────────────────
      // If you have a CORS-enabled proxy or GRIB2-to-JSON service for HRRR /
      // RRFS, replace the baseURL strings inside fetchNWP() with your endpoint.
      // The default attempts NOMADS OpeNDAP directly (CORS permitting).
      //
      // Expected OpeNDAP ASCII response format (time dim always [0]):
      //   [0][jRel][iRel], value
      //
      // HRRR sfc variable names:
      //   mxuphl25 - Max updraft helicity 2-5 km (m²/s²)
      //   hlcy     - Storm relative helicity 0-3 km (m²/s²)
      // RRFS sfc variable names (adjust if catalog differs):
      //   maxupdrft_hlcy - Max updraft helicity 2-5 km (m²/s²)
      //   hlcy           - Storm relative helicity 0-3 km (m²/s²)
      // ─────────────────────────────────────────────────────────────────────────

      const NWP_FETCH_RADIUS_DEG = 1.2; // ±1.2° (~134 km) bounding box around storm

      function latestCycle(lagMin) {
        const d = new Date(Date.now() - lagMin * 60 * 1000);
        return {
          ymd: d.toISOString().slice(0, 10).replace(/-/g, ''),
          hh:  String(d.getUTCHours()).padStart(2, '0'),
        };
      }

      // Parse NOMADS OpeNDAP ASCII text into an (i,j)-keyed Map of values.
      function parseOpeNDAPASCII(text, jOff, iOff) {
        const map = new Map();
        const re  = /\[0\]\[(\d+)\]\[(\d+)\],\s*([-\d.eE+]+)/g;
        let m;
        while ((m = re.exec(text)) !== null) {
          const j = parseInt(m[1], 10) + jOff;
          const i = parseInt(m[2], 10) + iOff;
          const v = parseFloat(m[3]);
          if (isFinite(v) && v > -9e19) map.set(`${j}_${i}`, v);
        }
        return map.size > 0 ? map : null;
      }

      async function tryFetchText(url) {
        try {
          const r = await fetch(url, { mode: 'cors', cache: 'no-store' });
          return r.ok ? r.text() : null;
        } catch { return null; }
      }

      // Fetch UH + SRH OpeNDAP subregion grids for a model (HRRR or RRFS).
      // Returns { uhMap, srhMap, source } or null if unavailable.
      async function fetchNWP(model, lat, lon) {
        const r = NWP_FETCH_RADIUS_DEG;
        const c0 = latLonToHRRRij(lat - r, lon - r);
        const c1 = latLonToHRRRij(lat + r, lon + r);
        const iMin = Math.min(c0.i, c1.i), iMax = Math.max(c0.i, c1.i);
        const jMin = Math.min(c0.j, c1.j), jMax = Math.max(c0.j, c1.j);

        let baseURL, uhVar, srhVar;
        if (model === 'HRRR') {
          const { ymd, hh } = latestCycle(90); // HRRR ~1 h availability lag
          baseURL = `https://nomads.ncep.noaa.gov/dods/hrrr/hrrr${ymd}/hrrr_sfc_t${hh}z.ascii`;
          uhVar   = 'mxuphl25';
          srhVar  = 'hlcy';
        } else { // RRFS-A
          const { ymd, hh } = latestCycle(120); // RRFS ~2 h availability lag
          baseURL = `https://nomads.ncep.noaa.gov/dods/rrfs_a/rrfs_a${ymd}/rrfs_a_f000.t${hh}z.ascii`;
          uhVar   = 'maxupdrft_hlcy'; // adjust if RRFS OpeNDAP catalog uses a different name
          srhVar  = 'hlcy';
        }

        const range = `[0][${jMin}:${jMax}][${iMin}:${iMax}]`;
        const [uhText, srhText] = await Promise.all([
          tryFetchText(`${baseURL}?${uhVar}${range}`),
          tryFetchText(`${baseURL}?${srhVar}${range}`),
        ]);

        const uhMap  = uhText  ? parseOpeNDAPASCII(uhText,  jMin, iMin) : null;
        const srhMap = srhText ? parseOpeNDAPASCII(srhText, jMin, iMin) : null;
        return (uhMap || srhMap) ? { uhMap, srhMap, source: model } : null;
      }

      // Nearest-neighbour lookup of UH and SRH at a given lat/lon.
      function nwpAt(nwpData, lat, lon) {
        if (!nwpData) return { uh: null, srh: null };
        const { i, j } = latLonToHRRRij(lat, lon);
        const key = `${j}_${i}`;
        return {
          uh:  nwpData.uhMap  ? (nwpData.uhMap.get(key)  ?? null) : null,
          srh: nwpData.srhMap ? (nwpData.srhMap.get(key) ?? null) : null,
        };
      }

      // Merge HRRR (primary) and RRFS (secondary) datasets - HRRR wins on overlap.
      function mergeNWP(hrrr, rrfs) {
        if (!hrrr && !rrfs) return null;
        if (!hrrr) return rrfs;
        if (!rrfs) return hrrr;
        const uhMap  = new Map([...(rrfs.uhMap  || new Map()), ...(hrrr.uhMap  || new Map())]);
        const srhMap = new Map([...(rrfs.srhMap || new Map()), ...(hrrr.srhMap || new Map())]);
        return {
          uhMap:  uhMap.size  ? uhMap  : null,
          srhMap: srhMap.size ? srhMap : null,
          source: 'HRRR+RRFS',
        };
      }

      function computeRisk(sLat, sLon, heading, wind, eyeDiam, rmax, gLat, gLon, nwpData) {
        const dist  = haversine(sLat, sLon, gLat, gLon);
        const brng  = bearing(sLat, sLon, gLat, gLon);
        const diff  = bearingDiff(heading, brng);
        const I     = intensityFactor(wind);
        const E     = eyeFactor(eyeDiam);
        const Q     = quadrantFactor(diff, dist, rmax);
        // Land interaction: 0-4 miles inland from any CONUS coastline gets
        // up to 1.45× the base mesovortex probability (roughness discontinuity
        // effect).  Offshore grid points are unaffected (factor = 1.0).
        const CF    = coastalFactor(gLat, gLon);
        // NWP convective scale: product of per-point UH and SRH factors from
        // HRRR / RRFS, clamped [0.30, 2.00].  Returns 1.0 (neutral) if no NWP
        // data is loaded for this grid point.
        const { uh, srh } = nwpAt(nwpData, gLat, gLon);
        const NWP   = Math.max(0.30, Math.min(2.00, uhFactor(uh) * srhFactor(srh)));
        const base  = I * E * Q * CF * NWP;
        const bonus = (wind >= 130 && eyeDiam > 0 && eyeDiam <= 25) ? 0.15 * Q * CF * NWP : 0;
        return Math.max(0, Math.min(100, (base + bonus) * 100));
      }

      // Grid step 0.25° ≈ 28km - fine enough to resolve a 37km RMW with
      // 2-3 sample points across the eyewall width.
      const STEP = 0.25;
      const gridPts = [];
      for (let lat = 24; lat <= 50; lat += STEP)
        for (let lon = -125; lon <= -65; lon += STEP)
          gridPts.push([lat, lon]);

      // ── Risk → colour tiers (15% increments) ──
      const TIERS = [
        { lo:  0, hi:  15, col: '#22bb33', hatch: false },
        { lo: 15, hi:  30, col: '#d4e600', hatch: false },
        { lo: 30, hi:  45, col: '#ffcc00', hatch: false },
        { lo: 45, hi:  60, col: '#ff6600', hatch: false },
        { lo: 60, hi:  75, col: '#dd1111', hatch: false },
        { lo: 75, hi:  90, col: '#cc00cc', hatch: true  },
        { lo: 90, hi: 101, col: '#ff69b4', hatch: true  },
      ];
      function riskTier(pct) { return TIERS.find(t => pct >= t.lo && pct < t.hi) || TIERS[0]; }

      function category(wind) {
        if (wind < 64)  return 'Tropical Storm';
        if (wind < 83)  return 'Cat-1 Hurricane';
        if (wind < 96)  return 'Cat-2 Hurricane';
        if (wind < 113) return 'Cat-3 Hurricane';
        if (wind < 137) return 'Cat-4 Hurricane';
        return 'Cat-5 Hurricane';
      }

      // ── Historical storm database ──
      // Parameters reflect NHC best track data at time of landfall.
      // eye / rmax are estimates where not officially published.
      const HISTORICAL = [
        {
          name: 'Helene', year: 2024,
          tag:  'Cat-4 · Sep 26, 2024',
          lat: 29.9, lon: -83.7, heading: 355, wind: 120, eye: 38, rmax: 37,
          note: 'Landfall near Perry, FL - catastrophic flooding across Appalachians & SE US',
        },
        {
          name: 'Milton', year: 2024,
          tag:  'Cat-3 · Oct 9, 2024',
          lat: 27.2, lon: -82.4, heading: 88, wind: 100, eye: 16, rmax: 24,
          note: 'Landfall near Siesta Key, FL - record rapid intensification (Cat-5 peak 180 kt)',
        },
        {
          name: 'Melissa', year: 2025,
          tag:  'Cat-2 · est. 2025',
          lat: 29.2, lon: -89.3, heading: 15, wind: 88, eye: 42, rmax: 52,
          note: 'Gulf Coast landfall - estimated parameters (refine with NHC best track data)',
        },
      ];

      // ── Empirical RMW / eye estimates for live NHC data ──
      function estimateRmax(wind) {
        // Simplified: larger rmax at lower intensities, contracts as storm strengthens
        return Math.max(15, Math.round(90 - (wind - 64) * 0.48));
      }
      function estimateEye(rmax) {
        return Math.max(8, Math.round(rmax * 0.58));
      }

      // ── Leaflet map ──
      let mvrpMap    = null;
      let riskLayer  = null;
      let stormMark  = null;
      let mvrpInited = false;
      let activeCard = null;

      // ── Render a storm card into a container ──
      function renderStormCard(container, storm) {
        const card = document.createElement('div');
        card.className = 'mvrp-storm-card';
        card.innerHTML =
          `<div class="mvrp-storm-card-name">${storm.name} ${storm.year}` +
          (storm.live ? ' <span class="mvrp-live-badge">LIVE</span>' : '') +
          `</div>
           <div class="mvrp-storm-card-tag">${storm.tag}</div>
           <div class="mvrp-storm-card-stats">
             <span class="mvrp-storm-stat">${Math.round(storm.wind)} kt</span>
             <span class="mvrp-storm-stat">Eye ~${Math.round(storm.eye)} km</span>
             <span class="mvrp-storm-stat">RMW ~${Math.round(storm.rmax)} km</span>
             <span class="mvrp-storm-stat">Hdg ${Math.round(storm.heading)}°</span>
           </div>
           <div class="mvrp-storm-card-note">${storm.note}</div>`;
        card.addEventListener('click', () => runAnalysis(storm, card));
        container.appendChild(card);
      }

      // ── Fetch active NHC storms ──
      async function fetchLiveStorms() {
        const statusEl = document.getElementById('mvrp-live-status');
        const cardsEl  = document.getElementById('mvrp-live-cards');
        const dotEl    = document.getElementById('mvrp-live-dot');
        try {
          const r = await fetch('https://www.nhc.noaa.gov/CurrentStorms.json');
          if (!r.ok) throw new Error('NHC unavailable');
          const d = await r.json();
          // Only show TC-strength storms (hurricane = ≥64 kt)
          const storms = (d.activeStorms || []).filter(s => parseFloat(s.intensity || 0) >= 64);
          if (storms.length === 0) {
            statusEl.textContent = 'No active hurricanes - select a historical case below.';
            return;
          }
          statusEl.textContent = `${storms.length} active storm${storms.length > 1 ? 's' : ''} - NHC`;
          dotEl.style.background = '#22bb33';
          storms.forEach(s => {
            const wind  = parseFloat(s.intensity);
            const lat   = parseFloat(s.latitudeNumeric  ?? s.latitude);
            const lon   = parseFloat(s.longitudeNumeric ?? s.longitude);
            const hdg   = parseFloat(s.movementDir ?? 0);
            const rmax  = estimateRmax(wind);
            const eye   = estimateEye(rmax);
            const name  = s.name.charAt(0).toUpperCase() + s.name.slice(1).toLowerCase();
            const yr    = new Date(s.lastUpdate).getFullYear();
            renderStormCard(cardsEl, {
              name, year: yr,
              tag:  category(wind) + ' · Live',
              lat, lon, heading: hdg, wind, eye, rmax,
              note: 'Updated ' + new Date(s.lastUpdate).toUTCString(),
              live: true,
            });
          });
        } catch (e) {
          statusEl.textContent = 'NHC data unavailable - select a historical case below.';
        }
      }

      // ── Run analysis for a storm object ──
      async function runAnalysis(storm, cardEl) {
        if (activeCard) activeCard.classList.remove('active');
        activeCard = cardEl;
        if (cardEl) cardEl.classList.add('active');

        const { lat: sLat, lon: sLon, heading, wind, eye: eyeDiam, rmax } = storm;
        const statusEl = document.getElementById('mvrp-status');
        const nwpRowEl = document.getElementById('mvrp-nwp-row');
        statusEl.className   = 'mvrp-status running';
        statusEl.textContent = `Fetching NWP data for ${storm.name} ${storm.year}\u2026`;
        nwpRowEl.style.display = 'none';

        // ── Fetch HRRR and RRFS convective parameter grids concurrently ─────────
        const [hrrrData, rrfsData] = await Promise.all([
          fetchNWP('HRRR', sLat, sLon),
          fetchNWP('RRFS', sLat, sLon),
        ]);
        const nwpData = mergeNWP(hrrrData, rrfsData);

        // ── NWP chip display: storm-center UH and SRH + % contribution ──────────
        {
          const ctr   = nwpAt(nwpData, sLat, sLon);
          const uhV   = ctr.uh  != null ? ctr.uh.toFixed(0)  + '\u202fm\u00b2/s\u00b2' : '--';
          const srhV  = ctr.srh != null ? ctr.srh.toFixed(0) + '\u202fm\u00b2/s\u00b2' : '--';
          const dPct  = (factor, val) => val == null ? '' :
            ` <span style="font-size:9px;opacity:0.65">(${factor >= 1 ? '+' : ''}${((factor - 1) * 100).toFixed(0)}%)</span>`;
          if (nwpData) {
            nwpRowEl.innerHTML =
              `<span class="mvrp-nwp-src">${nwpData.source}</span>` +
              `<span class="mvrp-nwp-chip"><span class="mvrp-nwp-lbl">UH 2-5\u202fkm</span> ${uhV}${dPct(uhFactor(ctr.uh), ctr.uh)}</span>` +
              `<span class="mvrp-nwp-chip"><span class="mvrp-nwp-lbl">SRH 0-3\u202fkm</span> ${srhV}${dPct(srhFactor(ctr.srh), ctr.srh)}</span>`;
          } else {
            nwpRowEl.innerHTML =
              `<span class="mvrp-nwp-src" style="color:rgba(255,255,255,0.28)">NWP unavailable \u2014 base physics only</span>`;
          }
          nwpRowEl.style.display = 'flex';
        }

        statusEl.textContent = `Analyzing ${storm.name} ${storm.year} (${storm.tag})\u2026`;

        setTimeout(() => {
          const risks = gridPts.map(([lat, lon]) =>
            computeRisk(sLat, sLon, heading, wind, eyeDiam, rmax, lat, lon, nwpData));
          const peak = Math.max(...risks);

          if (riskLayer) { mvrpMap.removeLayer(riskLayer); riskLayer = null; }
          if (stormMark) { mvrpMap.removeLayer(stormMark); stormMark = null; }

          // ── Marching Squares filled contour polygons ──
          // 1. Map the risks[] array onto a 2-D grid, apply 2-pass box blur so
          //    adjacent grid cells blend smoothly (organic contour edges).
          // 2. Run Marching Squares at each tier threshold to get closed rings.
          // 3. Render each ring as a Leaflet L.polygon with fill + stroke outline,
          //    painting lowest → highest so inner zones sit on top of outer.

          const GLAT0  = 24, GLON0 = -125;
          const GLAT_N = Math.round((50  - GLAT0) / STEP) + 1;   // 53
          const GLON_N = Math.round((-65 - GLON0) / STEP) + 1;   // 121

          const g2d = [];
          for (let r = 0; r < GLAT_N; r++) g2d.push(new Float32Array(GLON_N));
          gridPts.forEach(([lat, lon], i) => {
            const r = Math.round((lat - GLAT0) / STEP);
            const c = Math.round((lon - GLON0) / STEP);
            if (r >= 0 && r < GLAT_N && c >= 0 && c < GLON_N) g2d[r][c] = risks[i];
          });

          // 3×3 box blur pass - run twice to approximate a Gaussian.
          // Keeps the risk envelope tight while smoothing grid-point jitter.
          function boxBlur(src, nR, nC) {
            const dst = src.map(row => new Float32Array(row));
            for (let r = 0; r < nR; r++)
              for (let c = 0; c < nC; c++) {
                let s = 0, n = 0;
                for (let dr = -1; dr <= 1; dr++)
                  for (let dc = -1; dc <= 1; dc++) {
                    const rr=r+dr, cc=c+dc;
                    if (rr>=0&&rr<nR&&cc>=0&&cc<nC) { s+=src[rr][cc]; n++; }
                  }
                dst[r][c] = s/n;
              }
            return dst;
          }
// Record the true computed peak BEFORE blur.
          // The 0.25° grid is coarser than most eyewalls, so box blur averages
          // peak cells against zero-value neighbours and can reduce a genuine
          // 18% peak to ~2%, killing all visible contours.  We rescale after
          // blurring so the peak is faithfully preserved while the shape stays
          // smooth.  This is NOT the old "force everything to 93%" hack -
          // we scale to the actual computed peak, whatever that is.
          let rawPeak = 0;
          for (let r = 0; r < GLAT_N; r++)
            for (let c = 0; c < GLON_N; c++)
              if (g2d[r][c] > rawPeak) rawPeak = g2d[r][c];

          // Single box-blur pass - smooths sub-grid jitter without smearing
          // the risk envelope by more than one grid step (~0.5°).
          let sg = boxBlur(g2d, GLAT_N, GLON_N);

          // Rescale blurred grid so its peak matches the raw computed peak.
          // e.g. Helene 18.2% raw → blur reduces to ~4% → rescale back to 18.2%
          // Colour tiers: <15% green, 15-30% yellow, 30-45% orange-yellow, etc.
          if (rawPeak > 0) {
            let blurPeak = 0;
            for (let r = 0; r < GLAT_N; r++)
              for (let c = 0; c < GLON_N; c++)
                if (sg[r][c] > blurPeak) blurPeak = sg[r][c];
            if (blurPeak > 0) {
              const scale = rawPeak / blurPeak;
              for (let r = 0; r < GLAT_N; r++)
                for (let c = 0; c < GLON_N; c++)
                  sg[r][c] = Math.min(100, sg[r][c] * scale);
            }
          }

          // Drop near-zero noise after rescaling.
          for (let r = 0; r < GLAT_N; r++)
            for (let c = 0; c < GLON_N; c++)
              if (sg[r][c] < 1) sg[r][c] = 0;

          // Marching Squares - returns array of closed rings (each = [[row,col]…])
          // traced at the given threshold value.
          function marchingSquares(g, nR, nC, thresh) {
            const segs = [];
            // Linear interpolation along an edge: fraction from v0 to v1 where value = thresh
            const li = (v0,v1) => Math.abs(v1-v0)<1e-6 ? 0.5 : Math.max(0,Math.min(1,(thresh-v0)/(v1-v0)));

            for (let r = 0; r < nR-1; r++) {
              for (let c = 0; c < nC-1; c++) {
                // Cell corners: SW=bottom-left, SE=bottom-right, NE=top-right, NW=top-left
                const sw=g[r][c], se=g[r][c+1], ne=g[r+1][c+1], nw=g[r+1][c];
                const code=(sw>=thresh?1:0)|(se>=thresh?2:0)|(ne>=thresh?4:0)|(nw>=thresh?8:0);
                if (!code || code===15) continue;
                // Iso-contour crossing points in [row,col] float coordinates
                const S=[r,       c+li(sw,se)];  // south edge (between SW and SE)
                const E=[r+li(se,ne), c+1    ];  // east edge  (between SE and NE)
                const N=[r+1,     c+li(nw,ne)];  // north edge (between NW and NE)
                const W=[r+li(sw,nw), c      ];  // west edge  (between SW and NW)
                const ps=(p,q)=>segs.push([p,q]);
                switch(code) {
                  case 1:  ps(S,W); break;
                  case 2:  ps(E,S); break;
                  case 3:  ps(E,W); break;
                  case 4:  ps(N,E); break;
                  case 5:  ps(S,W); ps(N,E); break;  // saddle: SW and NE isolated
                  case 6:  ps(N,S); break;
                  case 7:  ps(N,W); break;
                  case 8:  ps(W,N); break;
                  case 9:  ps(S,N); break;
                  case 10: ps(S,E); ps(W,N); break;  // saddle: SE and NW isolated
                  case 11: ps(E,N); break;
                  case 12: ps(W,E); break;
                  case 13: ps(S,E); break;
                  case 14: ps(W,S); break;
                }
              }
            }

            // Assemble unordered segments into closed rings via adjacency traversal.
            // Each contour point appears in exactly 2 segments, so the chain is
            // unambiguous. Coords are snapped to a fixed-precision string key.
            const snap = ([r,c]) => `${Math.round(r*1e4)},${Math.round(c*1e4)}`;
            const nodes = new Map();
            segs.forEach(([p,q]) => {
              const kp=snap(p), kq=snap(q);
              if (!nodes.has(kp)) nodes.set(kp, {pt:p, adj:[]});
              if (!nodes.has(kq)) nodes.set(kq, {pt:q, adj:[]});
              nodes.get(kp).adj.push(kq);
              nodes.get(kq).adj.push(kp);
            });

            const rings=[], done=new Set();
            for (const [sK, sN] of nodes) {
              if (done.has(sK) || sN.adj.length!==2) continue;
              const ring=[sN.pt]; done.add(sK);
              let prevK=sK, curK=sN.adj[0];
              while (curK !== sK) {
                if (done.has(curK)) break;
                const n=nodes.get(curK); if (!n) break;
                ring.push(n.pt); done.add(curK);
                const nk = n.adj[0]===prevK ? n.adj[1] : n.adj[0];
                prevK=curK; curK=nk;
              }
              if (ring.length >= 3) rings.push(ring);
            }
            return rings;
          }

          // Convert [row,col] grid coords → Leaflet [lat,lon]
          const toLL = ([r,c]) => [GLAT0 + r*STEP, GLON0 + c*STEP];

          // Chaikin corner-cutting smoothing - each pass replaces every edge
          // A→B with two new vertices at the 1/4 and 3/4 positions, rounding
          // the corners without noticeably shrinking the polygon.
          function chaikin(ring, passes) {
            let pts = ring.slice();
            for (let p = 0; p < passes; p++) {
              const out = [];
              const n = pts.length;
              for (let i = 0; i < n; i++) {
                const [r0, c0] = pts[i];
                const [r1, c1] = pts[(i + 1) % n];
                out.push([r0 * 0.75 + r1 * 0.25, c0 * 0.75 + c1 * 0.25]);
                out.push([r0 * 0.25 + r1 * 0.75, c0 * 0.25 + c1 * 0.75]);
              }
              pts = out;
            }
            return pts;
          }

          // Darken a hex colour by factor f for the polygon stroke outline
          const darken = (hex, f) => {
            const n=parseInt(hex.slice(1),16);
            return '#'+[n>>16,(n>>8)&0xff,n&0xff]
              .map(v=>Math.round(v*f).toString(16).padStart(2,'0')).join('');
          };

          // Ray-casting point-in-polygon test used to match holes to their
          // parent outer ring when building annular (donut) polygons.
          function ptInRing(pt, ring) {
            let inside = false;
            const [pr, pc] = pt;
            for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
              const [ri, ci] = ring[i], [rj, cj] = ring[j];
              if (((ci > pc) !== (cj > pc)) &&
                  (pr < (rj - ri) * (pc - ci) / (cj - ci) + ri))
                inside = !inside;
            }
            return inside;
          }

          // Pre-compute contour rings at every tier boundary.
          // loThresholds[i] = lower edge of TIERS[i] (or 5 for the first tier).
          // Appending the sentinel (hi of last tier) gives the innermost core ring.
          const loThresholds = TIERS.map((t, i) => i === 0 ? 5 : t.lo);
          loThresholds.push(TIERS[TIERS.length - 1].hi);
          const allRings = loThresholds.map(th =>
            marchingSquares(sg, GLAT_N, GLON_N, th));

          // L.layerGroup holds all tier polygons.
          const lg = L.layerGroup().addTo(mvrpMap);

          // Render each tier as an ANNULAR (donut) polygon:
          //   outer ring = contour at tier.lo
          //   holes      = contour rings at tier.hi that lie inside the outer ring
          // This guarantees every map point is covered by AT MOST ONE tier fill,
          // completely eliminating opacity-stacking at the storm centre.
          for (let ti = 0; ti < TIERS.length; ti++) {
            const tier   = TIERS[ti];
            const oRings = allRings[ti];      // outer boundary rings
            const iRings = allRings[ti + 1];  // hole rings (next tier inward)

            oRings.forEach(outerRing => {
              if (outerRing.length < 3) return;
              const smoothedOuter = chaikin(outerRing, 3);
              const outerLL = smoothedOuter.map(toLL);
              // Only include inner rings whose first point is inside the unsmoothed
              // outer ring (ptInRing uses grid coords before Chaikin expansion).
              const holes = iRings
                .filter(ir => ir.length >= 3 && ptInRing(ir[0], outerRing))
                .map(ir => chaikin(ir, 3).map(toLL));
              L.polygon([outerLL, ...holes], {
                color:        darken(tier.col, 0.55),
                weight:       1.5,
                opacity:      1,
                fillColor:    tier.col,
                fillOpacity:  0.45,
                smoothFactor: 1,
              }).addTo(lg);
              if (tier.hatch) {
                L.polygon([outerLL, ...holes], {
                  stroke: false, fillColor: '#000',
                  fillOpacity: 0.15, smoothFactor: 1,
                }).addTo(lg);
              }
            });
          }

          riskLayer = lg;

          const icon = L.divIcon({
            html: '<div style="width:14px;height:14px;border-radius:50%;background:#ff3333;border:2px solid #fff;box-shadow:0 0 10px #ff3333"></div>',
            iconSize: [14,14], iconAnchor: [7,7], className: '',
          });
          stormMark = L.marker([sLat, sLon], { icon })
            .bindTooltip(`<strong>${storm.name} ${storm.year}</strong><br>${category(wind)}<br>${wind} kt · Eye ~${eyeDiam} km`, { permanent: false })
            .addTo(mvrpMap);

          const cellCount = risks.filter(r => r >= 5).length;
          statusEl.className = 'mvrp-status';
          statusEl.textContent = `${storm.name} - ${cellCount} cells ≥5% risk`;

          const infoBar  = document.getElementById('mvrp-info-bar');
          const catBadge = document.getElementById('mvrp-cat-badge');
          const peakEl   = document.getElementById('mvrp-peak-val');
          catBadge.textContent  = `${category(wind)} · ${storm.name} ${storm.year}`;
          peakEl.textContent    = `${peak.toFixed(1)}%`;
          peakEl.style.color    = riskTier(peak).col;
          infoBar.style.display = 'flex';

          mvrpMap.setView([sLat, sLon], 4);
        }, 20);
      }

      window.mvrpInit = function () {
        if (mvrpInited) return;
        mvrpInited = true;
        mvrpMap = L.map('mvrp-map', { center: [35, -92], zoom: 4 });
        L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
          attribution: '&copy; <a href="https://carto.com/">CARTO</a>',
          maxZoom: 9,
        }).addTo(mvrpMap);
        // Populate historical cards immediately, live storms async
        HISTORICAL.forEach(s => renderStormCard(document.getElementById('mvrp-hist-cards'), s));
        fetchLiveStorms();
      };

      // ── Back button ──
      document.getElementById('mvrp-back-btn').addEventListener('click', function () {
        document.getElementById('mvrp-view').classList.add('hidden');
        document.getElementById('model-explorer-view').classList.remove('hidden');
      });
    })();
