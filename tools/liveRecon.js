// ═══════════════════════════════════════════════════════════════════════════
// LIVE RECONNAISSANCE
// NOAA & USAF Hurricane Hunter — Real-Time Flight Tracking & Data
//
// Data pipeline: scripts/recon_data.py fetches NHC/NWS/TGFTP server-side
// (via .github/workflows/recon-data-mirror.yml, every ~5 min) and does ALL
// parsing there — HDOB decode, phase detection, storm/mission matching,
// category classification. It writes one ready-to-render data/recon.json.
//
// This file only renders that JSON (map, wind graph, storm header, mission
// selector, obs table). No network parsing or CORS workarounds happen here.
// ═══════════════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  // ── Constants ───────────────────────────────────────────────────────────────
  const DATA_URL    = 'data/recon.json'; // same-origin, produced by scripts/recon_data.py
  const STALE_HRS   = 8;     // hours before bulletin is considered stale
  const REFRESH_MS  = 90000; // auto-refresh interval
  const API_TIMEOUT = 8000;  // ms — hard cap on the data fetch

  // Timed fetch — aborts after API_TIMEOUT ms
  function tFetch(url, opts) {
    const ac = new AbortController();
    const id = setTimeout(() => ac.abort(), API_TIMEOUT);
    return fetch(url, { ...opts, signal: ac.signal })
      .then(r  => { clearTimeout(id); return r; })
      .catch(e => { clearTimeout(id); throw e; });
  }

  // ── State ───────────────────────────────────────────────────────────────────
  let _obs        = [];
  let _storms     = [];
  let _missions   = []; // [{ id, time (Date), office, org, acId, source, targetStormId, imageLatest, imageFull, csv, obs }]
  let _activeMissionIdx = -1;
  let _selectedStormId  = null; // sticky user pick when multiple storms are active
  let _trackView  = 'latest';   // 'latest' | 'full' — which static track image is shown
  let _timer      = null;

  // ── Render track image panel ─────────────────────────────────────────────
  // No live map tiles (and therefore no API key): scripts/recon_data.py
  // pre-renders a static PNG per mission (matplotlib + bundled coastlines).
  // Like cyclonicwx.com/recon, the image only updates when the pipeline runs
  // or the user clicks refresh — it does not auto-reload every cycle.
  function renderTrackImage() {
    const img   = document.getElementById('lr-track-img');
    const empty = document.getElementById('lr-track-empty');
    const csvA  = document.getElementById('lr-track-csv-link');
    if (!img) return;

    const m = _missions[_activeMissionIdx];
    const path = m && (_trackView === 'full' ? m.imageFull : m.imageLatest);

    document.getElementById('lr-track-tab-latest')?.classList.toggle('lr-track-tab--active', _trackView === 'latest');
    document.getElementById('lr-track-tab-full')?.classList.toggle('lr-track-tab--active', _trackView === 'full');

    if (!path) {
      img.style.display = 'none';
      if (empty) empty.style.display = 'flex';
    } else {
      img.src = path + '?t=' + Date.now();
      img.style.display = '';
      if (empty) empty.style.display = 'none';
    }

    if (csvA) {
      if (m && m.csv) { csvA.href = m.csv; csvA.style.display = ''; }
      else            { csvA.style.display = 'none'; }
    }
  }

  window._lrSetTrackView = function (view) {
    _trackView = view;
    renderTrackImage();
  };

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
  // (storms/category/basin are precomputed by scripts/recon_data.py)

  function agoText(iso) {
    if (!iso) return '';
    const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
    if (mins < 1) return 'Updated just now';
    if (mins < 60) return `Updated ${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    return `Updated ${hrs}h ${mins % 60}m ago`;
  }

  // Pick the storm most relevant to the current dashboard — honor a manual
  // tab selection first, else whichever storm the active mission's
  // observations are tracking toward, else the strongest active storm.
  function pickPrimaryStorm(storms) {
    if (!storms.length) return null;
    if (_selectedStormId) {
      const picked = storms.find(s => s.id === _selectedStormId);
      if (picked) return picked;
    }
    if (_obs.length) {
      const target = _obs[_obs.length - 1].target;
      if (target) return storms.find(s => s.id === target.id) || target;
    }
    return storms.reduce((best, s) => (s.intensity || 0) > (best.intensity || 0) ? s : best, storms[0]);
  }

  // ── Render storm tab strip — only shown when 2+ storms are active ────────
  function renderStormTabs(storms, activeId) {
    const tabs = document.getElementById('lr-storm-tabs');
    if (!tabs) return;
    if (storms.length < 2) { tabs.style.display = 'none'; tabs.innerHTML = ''; return; }

    tabs.style.display = 'flex';
    tabs.innerHTML = storms.map(st => {
      const cat    = st.category;
      const active = st.id === activeId ? ' lr-storm-tab--active' : '';
      return `<button class="lr-storm-tab${active}" onclick="window._lrSelectStorm('${st.id}')">
        <span class="lr-storm-tab-dot${cat.cls ? ' ' + cat.cls : ''}"></span>
        <span class="lr-storm-tab-name">${st.name}</span>
        <span class="lr-storm-tab-cat">${cat.label}</span>
      </button>`;
    }).join('');
  }

  // Manual storm-tab selection — sticks until that storm dissipates.
  window._lrSelectStorm = function (id) {
    _selectedStormId = id;
    renderStormHeader(_storms);
  };

  // ── Render storm header banner ───────────────────────────────────────────
  function renderStormHeader(storms) {
    const box = document.getElementById('lr-storm-header');
    if (!box) return;

    const s = pickPrimaryStorm(storms);
    if (!s) { box.style.display = 'none'; return; }
    _selectedStormId = s.id;
    renderStormTabs(storms, s.id);

    const cat = s.category;
    const catEl = document.getElementById('lr-storm-cat');
    catEl.textContent = cat.label;
    catEl.className   = 'lr-storm-cat' + (cat.cls ? ' ' + cat.cls : '');

    document.getElementById('lr-storm-name').textContent    = s.name;
    document.getElementById('lr-storm-basin').textContent   =
      [s.basin, 'NHC'].filter(Boolean).join(' · ').toUpperCase();
    document.getElementById('lr-storm-updated').textContent = agoText(s.lastUpdate);

    document.getElementById('lr-storm-wind').textContent = s.intensity != null
      ? `${s.intensity} kt · ${s.windMph} mph` : '—';
    document.getElementById('lr-storm-pres').textContent = s.pressure != null
      ? `${s.pressure} mb` : '—';
    document.getElementById('lr-storm-mov').textContent  = s.movementSpeed != null
      ? `${s.movementCompass} at ${s.movementSpeed} kt` : 'Stationary';
    document.getElementById('lr-storm-pos').textContent  = s.latDisplay && s.lonDisplay
      ? `${s.latDisplay} ${s.lonDisplay}` : '—';
    document.getElementById('lr-storm-pos-label').textContent =
      s.advNum ? `Position · Adv #${s.advNum}` : 'Position';

    renderAircraftStatus();
    box.style.display = '';
  }

  // ── Render "aircraft in storm" / idle status line under the storm header ──
  function renderAircraftStatus() {
    const wrap = document.getElementById('lr-storm-aircraft-status');
    const text = document.getElementById('lr-storm-aircraft-text');
    if (!wrap || !text) return;

    const last = _obs.length ? _obs[_obs.length - 1] : null;
    const ageH = _obs.length ? bulletinAgeHours(_obs) : null;
    const isFresh = ageH != null && ageH <= STALE_HRS;
    const inSelectedStorm = last && last.target && last.target.id === _selectedStormId;

    if (last && isFresh && last.phase === 'IN STORM' && inSelectedStorm) {
      wrap.classList.add('lr-aircraft-in-storm');
      text.textContent = `AIRCRAFT IN STORM · ${last.acId}`;
      return;
    }

    wrap.classList.remove('lr-aircraft-in-storm');

    // Aircraft is active, but in a different storm than the one currently shown.
    if (last && isFresh && last.phase === 'IN STORM' && last.target && !inSelectedStorm) {
      text.textContent = `No aircraft in this storm — ${last.acId} is in ${last.target.name}`;
      return;
    }

    if (last) {
      const mins = Math.max(0, Math.round((ageH || 0) * 60));
      const hrs  = Math.floor(mins / 60);
      const elapsed = hrs > 0 ? `${hrs}h ${mins % 60}m` : `${mins}m`;
      const archived = _missions.length
        ? ` · ${_missions.length} mission${_missions.length === 1 ? '' : 's'} archived`
        : '';
      text.textContent = `No aircraft on station — last mission ended ${elapsed} ago${archived}`;
    } else {
      text.textContent = 'No reconnaissance missions in the last 24 hours';
    }
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
      const ac  = m.acId ? m.acId : m.org;
      const active = i === _activeMissionIdx ? ' lr-mission-btn--active' : '';
      return `<button class="lr-mission-btn${active}" onclick="window._lrSelectMission(${i})">
        <span class="lr-mission-ac">${ac}</span>
        <span class="lr-mission-time">${hh}:${mm}Z ${day}</span>
      </button>`;
    }).join('');
  }

  // ── Render all dashboard panels from parsed obs ────────────────────────────
  // Phases/target are already precomputed by scripts/recon_data.py — this
  // function only renders, it never reassigns phases itself.
  function renderDashboard(obs, acId) {
    const statusEl = document.getElementById('lr-status-msg');
    const layoutEl = document.getElementById('lr-main-layout');

    if (!obs.length) {
      if (statusEl) { statusEl.textContent = 'Bulletin received but no observation lines could be parsed.'; statusEl.style.display = 'block'; }
      if (layoutEl) layoutEl.style.display = 'none';
      return;
    }

    _obs = obs;
    const last = _obs[_obs.length - 1];
    renderStormHeader(_storms);

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

    renderSummaryBox(_obs);
    renderTrackImage();
    renderObsTable(last);
    requestAnimationFrame(() => renderWindGraph(_obs));
  }

  // ── Select a mission by index — no fetch needed, data is already parsed ───
  window._lrSelectMission = function (idx) {
    if (idx < 0 || idx >= _missions.length) return;
    _activeMissionIdx = idx;
    renderMissionSelector();

    const m      = _missions[idx];
    const target = _storms.find(s => s.id === m.targetStormId) || null;
    const obs    = (m.obs || []).map(o => ({ ...o, target }));

    const ageH = bulletinAgeHours(obs);
    if (ageH != null && ageH > STALE_HRS)
      console.warn('[LiveRecon] Bulletin is', ageH.toFixed(1), 'h old');

    renderDashboard(obs, m.acId || m.org || m.office);
  };

  // ── Main data fetch + render cycle ──────────────────────────────────────────
  // Single same-origin fetch — scripts/recon_data.py has already done all the
  // NOAA/NWS fetching and HDOB/phase parsing, so there's nothing left to do
  // here except read the JSON and hand it to the render functions.
  async function fetchAndRender() {
    const statusEl = document.getElementById('lr-status-msg');
    const layoutEl = document.getElementById('lr-main-layout');
    if (statusEl) { statusEl.textContent = 'Loading reconnaissance data…'; statusEl.style.display = 'block'; }
    if (layoutEl) layoutEl.style.display = 'none';

    let data;
    try {
      const r = await tFetch(DATA_URL + '?t=' + Date.now());
      if (!r.ok) throw new Error('HTTP ' + r.status);
      data = await r.json();
    } catch (e) {
      console.error('[LiveRecon] data fetch failed:', e.message);
      if (statusEl) statusEl.textContent =
        'Could not load reconnaissance data. The data mirror may not have run yet — try refreshing shortly.';
      return;
    }

    _storms   = data.storms   || [];
    _missions = (data.missions || []).map(m => ({ ...m, time: new Date(m.time) }));
    _activeMissionIdx = -1;

    renderMissionSelector();
    renderStormHeader(_storms);

    if (!_missions.length) {
      _obs = [];
      renderStormHeader(_storms);
      if (statusEl) statusEl.textContent =
        'No reconnaissance bulletins found. There may be no active mission right now, ' +
        'or the data mirror is still catching up.';
      return;
    }

    window._lrSelectMission(0);
  }

  // ── Public init (called by view switcher) ────────────────────────────────────
  window.liveReconInit = function () {
    fetchAndRender();

    // Bind refresh button (once)
    const rb = document.getElementById('lr-refresh-btn');
    if (rb && !rb._lrBound) {
      rb.addEventListener('click', fetchAndRender);
      rb._lrBound = true;
    }

    // Track image reload — images are static (see renderTrackImage), so this
    // just re-requests the current image with a fresh cache-busting param.
    const trb = document.getElementById('lr-track-refresh-btn');
    if (trb && !trb._lrBound) {
      trb.addEventListener('click', renderTrackImage);
      trb._lrBound = true;
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
