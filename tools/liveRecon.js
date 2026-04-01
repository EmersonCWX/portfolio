// ═══════════════════════════════════════════════════════════════════════════
// LIVE RECONNAISSANCE
// NOAA & USAF Hurricane Hunter — Real-Time Flight Tracking & Data
//
// Data pipeline (equivalent to Python/Pandas in the browser):
//   NHC Active Storms : https://www.nhc.noaa.gov/CurrentStorms.json
//   HDOB Bulletins    : https://api.weather.gov/products?type=HDOB
//
// Mission phase detection, flight-level wind graph, and live map
// are computed client-side using the same logic a Python/NumPy
// script would apply to the raw HDOB observation stream.
// ═══════════════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  // ── Constants ───────────────────────────────────────────────────────────────
  const NHC_STORMS = 'https://www.nhc.noaa.gov/CurrentStorms.json';

  // TGFTP raw bulletin files — always contain the most recent bulletin for each WMO product.
  // Tried in order; first successful fetch with parseable obs wins.
  // Note: api.weather.gov/products?type=HDOB returns 400; NWS does not ingest HDOB via that API.
  const HDOB_SOURCES = [
    // Atlantic — NOAA WP-3D (KNHC) and USAF WC-130J (KUAS / KWBC)
    'https://tgftp.nws.noaa.gov/data/raw/ur/urnt15.knhc..txt',
    'https://tgftp.nws.noaa.gov/data/raw/ur/urnt15.kuas..txt',
    'https://tgftp.nws.noaa.gov/data/raw/ur/urnt15.kwbc..txt',
    // East Pacific — NOAA (KNHC) and USAF (KBIX)
    'https://tgftp.nws.noaa.gov/data/raw/ur/urpn15.knhc..txt',
    'https://tgftp.nws.noaa.gov/data/raw/ur/urpn15.kbix..txt',
    // NWS products API — try last (often empty even during active missions)
    'https://api.weather.gov/products/types/HDOB/locations/KNHC',
  ];

  // CORS proxy — NOAA/TGFTP servers do not send Access-Control-Allow-Origin headers.
  // All proxies are raced simultaneously; first valid response wins.
  // Per-request AbortController timeout (8s) prevents slow proxies from stalling.
  const PROXIES = [
    url => 'https://corsproxy.io/?' + encodeURIComponent(url),
    url => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(url),
    url => 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(url),
  ];

  const PROXY_TIMEOUT_MS = 8000;

  // Fetch one URL through one proxy with a hard timeout.
  function proxyFetch(proxyUrl) {
    const ac = new AbortController();
    const id = setTimeout(() => ac.abort(), PROXY_TIMEOUT_MS);
    return fetch(proxyUrl, { signal: ac.signal })
      .then(r => { clearTimeout(id); if (!r.ok) throw new Error(r.status); return r; })
      .catch(e => { clearTimeout(id); throw e; });
  }

  // Race all proxies — returns the first Response that succeeds.
  function pFetch(url) {
    return Promise.any(PROXIES.map(p => proxyFetch(p(url))))
      .catch(() => { throw new Error('All proxies failed for: ' + url); });
  }

  const IN_STORM_NM = 100;   // nm → aircraft is "in storm"
  const STALE_HRS   = 8;     // hours before bulletin is considered stale
  const REFRESH_MS  = 90000; // auto-refresh interval
  const API_TIMEOUT = 8000;  // ms — hard cap on any single network call

  // Timed fetch — aborts after API_TIMEOUT ms (prevents a single slow server
  // from stalling the whole load cycle)
  function tFetch(url, opts) {
    const ac = new AbortController();
    const id = setTimeout(() => ac.abort(), API_TIMEOUT);
    return fetch(url, { ...opts, signal: ac.signal })
      .then(r  => { clearTimeout(id); return r; })
      .catch(e => { clearTimeout(id); throw e; });
  }

  // ── State ───────────────────────────────────────────────────────────────────
  let _map        = null;
  let _trackGrp   = null;
  let _stormGrp   = null;
  let _obs        = [];
  let _storms     = [];
  let _timer      = null;
  let _mapInited  = false;

  // ── Haversine distance in nautical miles ────────────────────────────────────
  function nm(lat1, lon1, lat2, lon2) {
    const R   = 3440.065;
    const rad = d => d * Math.PI / 180;
    const dLa = rad(lat2 - lat1), dLo = rad(lon2 - lon1);
    const a   = Math.sin(dLa/2)**2 +
                Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLo/2)**2;
    return R * 2 * Math.asin(Math.sqrt(Math.min(1, a)));
  }

  // ── Parse HDOB lat/lon ───────────────────────────────────────────────────────
  // Standard HDOB format: lat = DDMM[.d][NS] (2-digit deg, 2-digit min)
  //                       lon = DDDMM[.d][EW] (3-digit deg, 2-digit min)
  // Handles both "2614N" (4 chars) and "2614.5N" (6 chars), and
  // 3-digit degree lats near the equator ("0930N").
  function parseLat(s) {
    const dir = s.slice(-1);
    const b   = s.slice(0, -1);          // strip N/S
    // Degrees are always the first 2 characters for lat
    const deg = parseInt(b.slice(0, 2), 10);
    const min = parseFloat(b.slice(2)) || 0;
    return (deg + min / 60) * (dir === 'S' ? -1 : 1);
  }
  function parseLon(s) {
    const dir = s.slice(-1);
    const b   = s.slice(0, -1);          // strip E/W
    // Degrees are always the first 3 characters for lon
    const deg = parseInt(b.slice(0, 3), 10);
    const min = parseFloat(b.slice(3)) || 0;
    return (deg + min / 60) * (dir === 'W' ? -1 : 1);
  }

  // Return a number or null when the field is all slashes / missing
  function num(s, scale) {
    if (!s || /^[+\-]?[\/]+$/.test(s.trim())) return null;
    const v = parseFloat(s.replace(/[^0-9.\-+]/g, ''));
    return isNaN(v) ? null : (scale ? v / scale : v);
  }

  // ── Parse one HDOB product text into an array of observations ──────────────
  function parseHDOB(text) {
    const obs = [];

    // Aircraft ID: in raw TGFTP bulletins the line after "HDOB NN YYYYMMDD" or
    // "Aircraft:" label contains the tail number / callsign.
    // Examples:  "Aircraft: NOAA2"  |  "NOAA2"  |  "AF300"  |  "AF301"
    let acId = 'HH';
    const acM =
      /Aircraft:\s*([A-Z0-9]+)/i.exec(text) ||
      /\bHDOB\s+\d+\s+\d+\s+([A-Z]{2,6}\d+)/i.exec(text) ||
      /\b(NOAA\d+|AF\d{3}|N\d{2}RF)\b/.exec(text);
    if (acM) acId = acM[1];

    // HDOB 30-second obs format (NHOP Appendix G), fields space-separated, line-wrapped at col 72.
    // Actual layout confirmed from TGFTP bulletins:
    //   HHMMSS  DDMM[NS]  DDDMM[EW]  AAAA[A]  BBBBB  CCCC  ±TTT[T]  ±TTT[T]  DDDSSN  PPP  ...
    //   1:time  2:lat     3:lon      4:alt     5:skip 6:skip 7:temp   8:dew    9:wdspd 10:pk
    //
    // Key points:
    //  - Altitude (field 4) is 4 digits, not 5 (e.g., 7854)
    //  - Fields 5 and 6 are two separate numeric tokens (e.g., 02216 and 0188) — both skipped
    //  - Wind dir+speed (field 9) is ONE 6-char token: DDD+SSS, e.g. "070015" = 070°/015 kt
    //  - Dew point may be //// (4 slashes = missing)
    //  - Lines wrap mid-record; \s+ between groups handles cross-line whitespace
    //  - Field 11 = SFMR surface wind speed (kts or ///)
    const re = /(\d{6})\s+(\d{2,4}[NS])\s+(\d{3,5}[EW])\s+([\d\/]{4,5})\s+([\d\/]{4,5})\s+([\d\/]{4,5})\s+([+\-]?[\d\/]{3,5})\s+([+\-]?[\d\/]{3,5})\s+([\d\/]{6})\s+([\d\/]{3})(?:\s+([\d\/]{3}))?/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      // groups 5 and 6 are skipped (,, in destructuring)
      const [, ts, latR, lonR, altR, , , tempR, dewR, windR, pkR, sfmrR] = m;
      const lat = parseLat(latR);
      const lon = parseLon(lonR);
      if (isNaN(lat) || isNaN(lon)) continue;
      obs.push({
        acId,
        timeStr: ts,
        hh:  parseInt(ts.slice(0, 2), 10),
        mm:  parseInt(ts.slice(2, 4), 10),
        ss:  parseInt(ts.slice(4, 6), 10),
        lat, lon,
        alt:      num(altR),              // feet (pressure altitude)
        temp:     num(tempR, 10),         // °C  (field × 10)
        dew:      num(dewR,  10),         // °C  (field × 10, or null if ////)
        wdir:     num(windR.slice(0, 3)), // degrees  (first 3 chars of 6-char wind token)
        wspd:     num(windR.slice(3, 6)), // knots    (last  3 chars of 6-char wind token)
        pkWind:   num(pkR),               // knots (peak surface wind)
        sfmrWind: sfmrR ? num(sfmrR) : null // knots (SFMR surface wind, null off-season)
      });
    }
    return { acId, obs };
  }

  // ── Assign mission phase to each observation ─────────────────────────────
  // Logic mirrors what a Python script would do with pandas/numpy:
  //   - Compute distance to storm at each time step
  //   - Find closest approach (eyewall pass)
  //   - Observations before min-distance = ENROUTE (or IN STORM if close)
  //   - Observations after  min-distance = RETURNING (or IN STORM if close)
  function assignPhases(observations, storms) {
    if (!observations.length) return observations;

    // Pick the target storm (closest to the midpoint of the track)
    let target = null;
    if (storms.length) {
      const mid = observations[Math.floor(observations.length / 2)];
      let best = Infinity;
      for (const s of storms) {
        const d = nm(mid.lat, mid.lon, s.lat, s.lon);
        if (d < best) { best = d; target = s; }
      }
    }

    if (!target) {
      // No storm data — use wind speed as proxy (>= 80 kt = in-storm)
      return observations.map(o => ({
        ...o, phase: (o.wspd || 0) >= 80 ? 'IN STORM' : 'ENROUTE', distToStorm: null
      }));
    }

    const dists    = observations.map(o => nm(o.lat, o.lon, target.lat, target.lon));
    const minIdx   = dists.indexOf(Math.min(...dists));

    return observations.map((o, i) => ({
      ...o,
      distToStorm: dists[i],
      target,
      phase:
        dists[i] <= IN_STORM_NM ? 'IN STORM' :
        i <= minIdx             ? 'ENROUTE'  : 'RETURNING'
    }));
  }

  // ── Leaflet map init ─────────────────────────────────────────────────────
  function initMap() {
    if (_mapInited) return;
    _mapInited = true;
    _map = L.map('lr-map', { zoomControl: true, attributionControl: false });
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      subdomains: 'abcd', maxZoom: 18
    }).addTo(_map);
    _trackGrp = L.layerGroup().addTo(_map);
    _stormGrp = L.layerGroup().addTo(_map);
    _map.setView([25, -70], 5);
  }

  // ── Render flight track ──────────────────────────────────────────────────
  const PHASE_COLOR = {
    'ENROUTE'  : '#4caf50',
    'IN STORM' : '#f44336',
    'RETURNING': '#ff9800'
  };

  function renderMap(obs, storms) {
    _trackGrp.clearLayers();
    _stormGrp.clearLayers();
    if (!obs.length) return;

    // Draw track segments colored by phase
    let bs = 0;
    for (let i = 1; i <= obs.length; i++) {
      if (i < obs.length && obs[i].phase === obs[bs].phase) continue;
      const seg     = obs.slice(bs, i);
      const color   = PHASE_COLOR[seg[0].phase] || '#888';
      const latlngs = seg.map(o => [o.lat, o.lon]);
      L.polyline(latlngs, { color, weight: 2.5, opacity: 0.9 }).addTo(_trackGrp);
      // Phase-start dot
      L.circleMarker(latlngs[0], {
        radius: 3, color, fillColor: color, fillOpacity: 1, weight: 0
      }).addTo(_trackGrp);
      bs = i;
    }

    // Departure marker
    const first = obs[0];
    L.circleMarker([first.lat, first.lon], {
      radius: 5, color: '#4caf50', fillColor: '#4caf50', fillOpacity: 0.5, weight: 2
    }).bindTooltip('Mission start', { direction: 'right' }).addTo(_trackGrp);

    // Current aircraft position
    const last   = obs[obs.length - 1];
    const lColor = PHASE_COLOR[last.phase] || '#888';
    L.marker([last.lat, last.lon], {
      icon: L.divIcon({
        className: '',
        html: `<div style="
          width:15px;height:15px;
          background:${lColor};
          border:2px solid #fff;
          border-radius:50%;
          box-shadow:0 0 10px ${lColor},0 0 4px #fff;
        "></div>`,
        iconAnchor: [7, 7]
      })
    }).bindPopup(`
      <div style="font-family:monospace;font-size:12px;line-height:1.8;min-width:140px;">
        <strong>${last.acId}</strong><br>
        ${String(last.hh).padStart(2,'0')}:${String(last.mm).padStart(2,'0')} UTC<br>
        Phase:&nbsp;<strong>${last.phase}</strong><br>
        Alt:&nbsp;${last.alt != null ? 'FL'+(last.alt/100).toFixed(0) : '—'}<br>
        Wind:&nbsp;${last.wdir != null ? last.wdir+'°' : '—'}
               /&nbsp;${last.wspd != null ? last.wspd+' kt' : '—'}<br>
        Peak:&nbsp;${last.pkWind != null ? last.pkWind+' kt' : '—'}<br>
        ${last.distToStorm != null ? 'Dist to Storm:&nbsp;'+last.distToStorm.toFixed(0)+' nm' : ''}
      </div>
    `, { maxWidth: 200 }).addTo(_trackGrp);

    // Storm center + range rings
    for (const s of storms) {
      // 100 nm ring (IN STORM threshold)
      L.circle([s.lat, s.lon], {
        radius: 185200, color: 'rgba(244,67,54,0.55)', weight: 1.5, fill: false, dashArray: '5,4'
      }).addTo(_stormGrp);
      // 200 nm ring (ENROUTE/RETURNING transition)
      L.circle([s.lat, s.lon], {
        radius: 370400, color: 'rgba(255,152,0,0.35)', weight: 1, fill: false, dashArray: '3,7'
      }).addTo(_stormGrp);
      // Storm icon
      L.marker([s.lat, s.lon], {
        icon: L.divIcon({
          className: '',
          html: '<div style="font-size:28px;line-height:1;user-select:none;filter:drop-shadow(0 0 8px rgba(255,60,60,0.9));">&#127741;</div>',
          iconAnchor: [14, 14]
        })
      }).bindPopup(`
        <div style="font-family:monospace;font-size:12px;line-height:1.8;">
          <strong>${s.name}</strong><br>
          ${s.classification || ''}&nbsp;${s.intensity ? s.intensity+' kt' : ''}
        </div>
      `).addTo(_stormGrp);
    }

    // Fit map bounds to track + storms — deferred so tiles are sized correctly
    try {
      const pts = obs.map(o => [o.lat, o.lon]);
      storms.forEach(s => pts.push([s.lat, s.lon]));
      const bounds = L.latLngBounds(pts).pad(0.1);
      requestAnimationFrame(() => _map.fitBounds(bounds));
    } catch (_) {}
  }

  // ── Flight-level wind speed graph ("G-meter visualization") ───────────────
  // This graph plots flight-level wind speed over the duration of the mission —
  // a high-fidelity proxy for the turbulence (g-loading) experienced by the
  // crew, equivalent to a Python matplotlib time-series wind plot.
  function renderWindGraph(obs) {
    const canvas = document.getElementById('lr-wind-canvas');
    if (!canvas) return;
    const ctx  = canvas.getContext('2d');
    const dpr  = window.devicePixelRatio || 1;
    const W    = canvas.offsetWidth || canvas.clientWidth || 270;
    const H    = 155;
    canvas.width  = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width  = W + 'px';
    canvas.style.height = H + 'px';
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, H);

    const wsObs = obs.filter(o => o.wspd != null);
    if (wsObs.length < 2) {
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      ctx.font = '11px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('No wind data available', W / 2, H / 2);
      return;
    }

    const padL = 32, padR = 8, padT = 14, padB = 20;
    const cW   = W - padL - padR;
    const cH   = H - padT - padB;
    const n    = wsObs.length;
    const all  = wsObs.flatMap(o => [o.wspd || 0, o.pkWind || 0]);
    const maxW = Math.ceil(Math.max(...all) / 20) * 20 || 100;

    const tx = i => padL + (i / Math.max(n - 1, 1)) * cW;
    const ty = v => padT + cH - (v / maxW) * cH;

    // Phase-colored background bands
    const pAlpha = {
      'ENROUTE'  : 'rgba(76,175,80,0.09)',
      'IN STORM' : 'rgba(244,67,54,0.13)',
      'RETURNING': 'rgba(255,152,0,0.09)'
    };
    let bs = 0;
    for (let i = 1; i <= n; i++) {
      if (i < n && wsObs[i].phase === wsObs[bs].phase) continue;
      ctx.fillStyle = pAlpha[wsObs[bs].phase] || 'transparent';
      ctx.fillRect(tx(bs), padT, tx(i < n ? i : n - 1) - tx(bs) + (i >= n ? cW - (tx(n-1)-padL) : 0), cH);
      bs = i;
    }

    // Horizontal grid lines
    for (let v = 0; v <= maxW; v += 20) {
      const y = ty(v);
      ctx.strokeStyle = 'rgba(255,255,255,0.055)';
      ctx.lineWidth   = 1;
      ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + cW, y); ctx.stroke();
      ctx.fillStyle   = 'rgba(255,255,255,0.28)';
      ctx.font        = '8px monospace';
      ctx.textAlign   = 'right';
      ctx.fillText(v, padL - 3, y + 3);
    }

    // Y-axis label
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.font      = '7px monospace';
    ctx.textAlign = 'left';
    ctx.fillText('kts', 1, padT - 3);

    // Peak wind dashed line
    const pkObs = wsObs.filter(o => o.pkWind != null);
    if (pkObs.length >= 2) {
      ctx.strokeStyle = 'rgba(255,100,100,0.5)';
      ctx.lineWidth   = 1.5;
      ctx.setLineDash([3, 5]);
      ctx.beginPath();
      pkObs.forEach((o, j) => {
        const idx = wsObs.indexOf(o);
        (j === 0 ? ctx.moveTo : ctx.lineTo).call(ctx, tx(idx), ty(o.pkWind));
      });
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Flight-level wind speed solid line
    ctx.strokeStyle = '#4caf50';
    ctx.lineWidth   = 2;
    ctx.beginPath();
    wsObs.forEach((o, i) => (i === 0 ? ctx.moveTo : ctx.lineTo).call(ctx, tx(i), ty(o.wspd)));
    ctx.stroke();

    // Current value dot
    ctx.fillStyle   = '#ffffff';
    ctx.shadowColor = '#4caf50';
    ctx.shadowBlur  = 8;
    ctx.beginPath();
    ctx.arc(tx(n - 1), ty(wsObs[n - 1].wspd), 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;

    // X-axis time labels
    const step = Math.max(1, Math.floor(n / 5));
    wsObs.forEach((o, i) => {
      if (i % step !== 0 && i !== n - 1) return;
      ctx.fillStyle = 'rgba(255,255,255,0.28)';
      ctx.font      = '7px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(
        `${String(o.hh).padStart(2,'0')}:${String(o.mm).padStart(2,'0')}`,
        tx(i), H - 3
      );
    });
  }

  // ── Render current observation table ────────────────────────────────────────
  function renderObsTable(o) {
    const tb = document.getElementById('lr-obs-tbody');
    if (!tb || !o) return;
    const row = (label, val) => `<tr>
      <td>${label}</td>
      <td>${val != null ? val : '<span class="lr-muted">—</span>'}</td>
    </tr>`;
    const fmt = (v, unit) => v != null ? `${v}${unit}` : null;
    const altFt = o.alt != null ? Math.round(o.alt) : null;
    const altM  = altFt  != null ? Math.round(altFt * 0.3048) : null;
    tb.innerHTML = [
      row('Wind Direction', fmt(o.wdir, '°')),
      row('Wind Speed',     fmt(o.wspd, ' kt')),
      row('Peak Gust',      fmt(o.pkWind, ' kt')),
      row('SFMR Surface',   o.sfmrWind != null ? o.sfmrWind + ' kt' : null),
      row('Flight Level',   altFt != null ? `FL${String(Math.round(altFt/100)).padStart(3,'0')} &nbsp;<span style="color:#666;font-size:0.85em">${altFt.toLocaleString()} ft / ${altM.toLocaleString()} m</span>` : null),
      row('Temperature',    o.temp != null ? o.temp.toFixed(1) + ' °C' : null),
      row('Dew Point',      o.dew  != null ? o.dew.toFixed(1)  + ' °C' : null),
      row('Dist to Storm',  o.distToStorm != null ? o.distToStorm.toFixed(0) + ' nm' : null),
    ].join('');
  }

  // ── Render mission summary box ───────────────────────────────────────────────
  const FL_TO_SFC = 0.90; // standard flight-level to surface wind reduction

  function renderSummaryBox(obs) {
    const box = document.getElementById('lr-summary-box');
    if (!box || !obs.length) return;

    const last = obs[obs.length - 1];

    // Last ping time
    const ping = `${String(last.hh).padStart(2,'0')}:${String(last.mm).padStart(2,'0')}:${String(last.ss).padStart(2,'0')} UTC`;

    // Peak SFMR (ignore nulls)
    const sfmrVals = obs.map(o => o.sfmrWind).filter(v => v != null);
    const peakSFMR = sfmrVals.length ? Math.max(...sfmrVals) : null;

    // Peak flight-level wind × 0.90 reduction
    const flVals  = obs.map(o => o.wspd).filter(v => v != null);
    const peakFL  = flVals.length ? Math.max(...flVals) : null;
    const peakSfc = peakFL != null ? Math.round(peakFL * FL_TO_SFC) : null;

    // Cruise altitude — median of all obs above 1,000 ft, ignoring descent/landing.
    // Raw "last obs alt" shows approach altitude (as low as 192 ft) for old bulletins.
    const cruiseAlts = obs.map(o => o.alt).filter(v => v != null && v > 1000).sort((a,b)=>a-b);
    const medAlt  = cruiseAlts.length
      ? cruiseAlts[Math.floor(cruiseAlts.length / 2)] : null;
    const altFt   = medAlt ? Math.round(medAlt) : null;
    const altM    = altFt  ? Math.round(altFt * 0.3048) : null;
    const flNum   = altFt  ? `FL${String(Math.round(altFt / 100)).padStart(3, '0')}` : null;

    // Current SFMR (last obs with a valid sfmrWind value)
    const lastSFMR = [...obs].reverse().find(o => o.sfmrWind != null);
    const curSFMR  = lastSFMR ? lastSFMR.sfmrWind : null;

    document.getElementById('lr-sum-ping').textContent     = ping;
    document.getElementById('lr-sum-sfmr-cur').textContent = curSFMR  != null ? curSFMR  + ' kt' : 'No data';
    document.getElementById('lr-sum-sfmr').textContent     = peakSFMR != null ? peakSFMR + ' kt' : 'No data';
    document.getElementById('lr-sum-fl').innerHTML = peakSfc != null
      ? `${peakSfc} kt <span style="color:#666;font-size:0.85em;font-weight:400">sfc &nbsp;/&nbsp; ${peakFL} kt FL</span>`
      : 'No data';
    document.getElementById('lr-sum-alt').textContent   = altFt != null
      ? `${flNum} · ${altFt.toLocaleString()} ft / ${altM.toLocaleString()} m` : '—';

    // Staleness warning injected into last-ping field
    const ageH = bulletinAgeHours(obs);
    if (ageH != null && ageH > STALE_HRS) {
      const pingEl = document.getElementById('lr-sum-ping');
      if (pingEl) pingEl.innerHTML =
        ping + `<div style="font-size:0.72rem;color:#f44336;margin-top:3px">⚠ ${Math.round(ageH)}h old</div>`;
    }

    box.style.display = '';
  }

  // ── Fetch NHC active storms ─────────────────────────────────────────────────
  async function fetchStorms() {
    try {
      const r = await pFetch(NHC_STORMS);
      const d = await r.json();
      return (d.activeStorms || []).map(s => {
        const latS = String(s.latitude  || s.latitudeNumeric  || '0');
        const lonS = String(s.longitude || s.longitudeNumeric || '0');
        const lat  = parseFloat(latS) * (latS.includes('S') ? -1 : 1);
        const lon  = parseFloat(lonS) * (lonS.includes('W') ? -1 : 1);
        return {
          id: s.id, name: s.name || 'Unknown Storm',
          classification: s.classification,
          intensity: s.intensity,
          lat: isNaN(lat) ? 0 : lat,
          lon: isNaN(lon) ? 0 : lon
        };
      }).filter(s => s.lat !== 0 || s.lon !== 0);
    } catch (_) { return []; }
  }

  // ── Fetch latest HDOB bulletin — all TGFTP sources raced in parallel ──────
  // Sequential retry was the main latency bottleneck. Now all TGFTP files are
  // fetched simultaneously; the first one that contains valid obs wins.
  // The NWS products API is checked last as a fallback (always fast, often empty).
  async function fetchHDOBText() {
    const tgftpUrls = HDOB_SOURCES.filter(u => !u.includes('api.weather.gov'));
    const apiUrl    = HDOB_SOURCES.find(u =>  u.includes('api.weather.gov'));

    // Helper: fetch one TGFTP URL through proxy and return text if obs are present
    const tryTgftp = async (url) => {
      const resp = await pFetch(url);
      if (!resp.ok) throw new Error(resp.status);
      const txt = await resp.text();
      if (/\d{6}\s+\d{2,4}[NS]\s+\d{3,5}[EW]/i.test(txt)) return txt;
      throw new Error('no obs');
    };

    // Race all TGFTP sources simultaneously
    try {
      const txt = await Promise.any(tgftpUrls.map(tryTgftp));
      console.log('[LiveRecon] Got bulletin (parallel TGFTP race)');
      return txt;
    } catch (_) {
      console.log('[LiveRecon] All TGFTP sources empty — trying NWS API fallback');
    }

    // NWS products API fallback
    if (apiUrl) {
      try {
        const resp  = await tFetch(apiUrl);
        if (resp.ok) {
          const json  = await resp.json();
          const items = json['@graph'] || [];
          if (items.length) {
            const bull = await fetch(items[0]['@id']);
            if (bull.ok) {
              const prod = await bull.json();
              if (prod.productText) return prod.productText;
            }
          }
        }
      } catch (e) {
        console.warn('[LiveRecon] NWS API error:', e.message);
      }
    }

    return null;
  }

  // ── Check bulletin staleness (returns age in hours or null) ──────────────────
  function bulletinAgeHours(obs) {
    if (!obs.length) return null;
    const last = obs[obs.length - 1];
    const now  = new Date();
    const utcH = now.getUTCHours(), utcM = now.getUTCMinutes();
    let   diff = (utcH * 60 + utcM) - (last.hh * 60 + last.mm);
    if (diff < -720) diff += 1440; // crossed midnight
    return diff / 60;
  }

  // ── Mission list state ───────────────────────────────────────────────────────
  let _missions        = []; // [{ id, time, office, acId, text }]
  let _activeMissionIdx = -1;

  const OFFICE_ORG = { KNHC: 'NOAA', KWBC: 'USAF', KBIX: 'USAF', KUAS: 'USAF' };

  // ── Fetch list of HDOB bulletins from NWS API (last 24h, all locations) ──────
  async function fetchMissionList() {
    const locations = ['KNHC', 'KWBC', 'KBIX', 'KUAS'];
    const cutoff    = Date.now() - 24 * 3600 * 1000;
    const items     = [];

    await Promise.all(locations.map(async loc => {
      try {
        const r = await tFetch(
          `https://api.weather.gov/products/types/HDOB/locations/${loc}?limit=50`
        );
        if (!r.ok) return;
        const json = await r.json();
        for (const item of (json['@graph'] || [])) {
          const t = new Date(item.issuanceTime).getTime();
          if (t >= cutoff) items.push({
            id:     item['@id'],
            time:   new Date(item.issuanceTime),
            office: loc,
            acId:   null,
            text:   null
          });
        }
      } catch (_) {}
    }));

    return items.sort((a, b) => b.time - a.time);
  }

  // ── Render mission selector bar ────────────────────────────────────────────
  function renderMissionSelector() {
    const bar = document.getElementById('lr-mission-bar');
    if (!bar) return;

    if (!_missions.length) {
      bar.style.display = 'none';
      return;
    }

    bar.style.display = 'flex';
    bar.innerHTML = _missions.map((m, i) => {
      const hh  = String(m.time.getUTCHours()).padStart(2, '0');
      const mm  = String(m.time.getUTCMinutes()).padStart(2, '0');
      const day = m.time.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
      const org = OFFICE_ORG[m.office] || m.office;
      const ac  = m.acId ? m.acId : org;
      const active = i === _activeMissionIdx ? ' lr-mission-btn--active' : '';
      return `<button class="lr-mission-btn${active}" onclick="window._lrSelectMission(${i})">
        <span class="lr-mission-ac">${ac}</span>
        <span class="lr-mission-time">${hh}:${mm}Z ${day}</span>
      </button>`;
    }).join('');
  }

  // ── Render all dashboard panels from parsed obs ────────────────────────────
  function renderDashboard(obs, acId) {
    const statusEl = document.getElementById('lr-status-msg');
    const layoutEl = document.getElementById('lr-main-layout');

    if (!obs.length) {
      if (statusEl) { statusEl.textContent = 'Bulletin received but no observation lines could be parsed.'; statusEl.style.display = 'block'; }
      if (layoutEl) layoutEl.style.display = 'none';
      return;
    }

    _obs = assignPhases(obs, _storms);
    const last = _obs[_obs.length - 1];

    // Status strip
    const phaseEl = document.getElementById('lr-phase-badge');
    if (phaseEl) {
      phaseEl.textContent = last.phase;
      phaseEl.className   = 'lr-phase-badge lr-phase-' + last.phase.toLowerCase().replace(/ /g, '-');
    }
    const acEl = document.getElementById('lr-ac-id');
    if (acEl) acEl.textContent = acId;
    const tEl = document.getElementById('lr-obs-time');
    if (tEl) tEl.textContent = `${String(last.hh).padStart(2,'0')}:${String(last.mm).padStart(2,'0')}Z`;

    // Show layout
    if (statusEl) statusEl.style.display = 'none';
    if (layoutEl) layoutEl.style.display = '';
    if (_map) _map.invalidateSize();

    renderSummaryBox(_obs);
    renderMap(_obs, _storms);
    renderObsTable(last);
    requestAnimationFrame(() => renderWindGraph(_obs));
  }

  // ── Select a mission by index — fetches text on demand ────────────────────
  window._lrSelectMission = async function (idx) {
    if (idx < 0 || idx >= _missions.length) return;
    _activeMissionIdx = idx;
    renderMissionSelector();

    const m         = _missions[idx];
    const statusEl  = document.getElementById('lr-status-msg');
    const layoutEl  = document.getElementById('lr-main-layout');

    if (!m.text) {
      if (statusEl) { statusEl.textContent = `Loading mission ${idx + 1} of ${_missions.length}…`; statusEl.style.display = 'block'; }
      if (layoutEl) layoutEl.style.display = 'none';
      try {
        const r = await tFetch(m.id);
        if (r.ok) {
          const json = await r.json();
          m.text = json.productText || '';
        }
      } catch (e) {
        console.warn('[LiveRecon] Mission fetch error:', e.message);
        if (statusEl) { statusEl.textContent = 'Failed to load mission bulletin.'; statusEl.style.display = 'block'; }
        return;
      }
    }

    const { acId, obs } = parseHDOB(m.text || '');
    if (acId !== 'HH') m.acId = acId;
    renderMissionSelector(); // update label now we have acId

    const ageH = bulletinAgeHours(obs);
    if (ageH != null && ageH > STALE_HRS)
      console.warn('[LiveRecon] Bulletin is', ageH.toFixed(1), 'h old');

    renderDashboard(obs, acId);
  };

  // ── Main data fetch + render cycle ──────────────────────────────────────────
  async function fetchAndRender() {
    const statusEl = document.getElementById('lr-status-msg');
    const layoutEl = document.getElementById('lr-main-layout');
    if (statusEl) { statusEl.textContent = 'Fetching NOAA reconnaissance data…'; statusEl.style.display = 'block'; }
    if (layoutEl) layoutEl.style.display = 'none';

    // Fetch storms + mission list in parallel
    const [storms, missions] = await Promise.all([
      fetchStorms().catch(() => []),
      fetchMissionList()
    ]);
    _storms   = storms;
    _missions = missions;
    renderMissionSelector();

    if (missions.length) {
      // NWS API returned results — auto-select most recent
      console.log('[LiveRecon] Found', missions.length, 'mission(s) in last 24h via NWS API');
      await window._lrSelectMission(0);
      return;
    }

    // ── Off-season / NWS empty → fall back to TGFTP ──────────────────────────
    console.log('[LiveRecon] NWS API empty — falling back to TGFTP');
    const rawText = await fetchHDOBText();

    if (!rawText) {
      if (statusEl) statusEl.textContent =
        'No reconnaissance bulletins found. There may be no active mission right now, ' +
        'or the bulletin server is temporarily unavailable.';
      return;
    }

    // Build a synthetic mission entry for the TGFTP bulletin
    const { acId, obs } = parseHDOB(rawText);
    console.log('[LiveRecon] TGFTP: parsed', obs.length, 'obs, acId:', acId);

    if (!obs.length) {
      if (statusEl) statusEl.textContent = 'Bulletin received but observation lines could not be parsed.';
      console.warn('[LiveRecon] Raw bulletin (first 500 chars):', rawText.slice(0, 500));
      return;
    }

    // Parse the actual bulletin date from the HDOB header line: "HDOB NN YYYYMMDD"
    // Using today's date + setUTCHours was wrong — Mar 26 bulletin showed as "Apr 1 20z"
    const lastObs  = obs[obs.length - 1];
    const dateM    = /HDOB\s+\d+\s+(\d{4})(\d{2})(\d{2})/i.exec(rawText);
    const synTime  = dateM
      ? new Date(Date.UTC(+dateM[1], +dateM[2] - 1, +dateM[3], lastObs.hh, lastObs.mm, lastObs.ss))
      : (() => { const d = new Date(); d.setUTCHours(lastObs.hh, lastObs.mm, lastObs.ss, 0); return d; })();
    _missions = [{ id: null, time: synTime, office: 'TGFTP', acId, text: rawText }];
    _activeMissionIdx = 0;
    renderMissionSelector();
    renderDashboard(obs, acId);
  }

  // ── Public init (called by view switcher) ────────────────────────────────────
  window.liveReconInit = function () {
    initMap();
    fetchAndRender();

    // Bind refresh button (once)
    const rb = document.getElementById('lr-refresh-btn');
    if (rb && !rb._lrBound) {
      rb.addEventListener('click', fetchAndRender);
      rb._lrBound = true;
    }

    // Redraw graph on window resize (debounced)
    if (!window._lrResizeBound) {
      window._lrResizeBound = true;
      let resizeTimer;
      window.addEventListener('resize', () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => { if (_obs.length) renderWindGraph(_obs); }, 200);
      });
    }

    // Auto-refresh
    clearInterval(_timer);
    _timer = setInterval(fetchAndRender, REFRESH_MS);
  };

})();
