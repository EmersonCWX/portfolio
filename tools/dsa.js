    // ════════════════════════════════════════════════════════════
    // DROPSONDE ANALYZER (DSA)
    // ════════════════════════════════════════════════════════════
    (function () {
      'use strict';

      // ── State ─────────────────────────────────────────────────
      let _mode          = 'live';
      let _basin         = 'at';
      let _sondes        = [];
      let _missionGroups = [];
      let _activeSonde   = null;
      let _liveLoaded    = false;
      let _fetching      = false;
      let _archiveCache  = {};      // 'BASINS:YYYYMMDD' → sondes[]

      // ── DOM refs ─────────────────────────────────────────────
      const backBtn      = document.getElementById('dsa-back-btn');
      const sondeList    = document.getElementById('dsa-sonde-list');
      const display      = document.getElementById('dsa-display');
      const canvas       = document.getElementById('dsa-skewt-canvas');
      const ctx          = canvas.getContext('2d');
      const skewTip      = document.getElementById('dsa-skewt-tip');
      const titleEl      = document.getElementById('dsa-sonde-title');
      const subtitleEl   = document.getElementById('dsa-sonde-subtitle');
      const statsBox     = document.getElementById('dsa-stats-box');
      const statsContent = document.getElementById('dsa-stats-content');
      const keyTbody     = document.getElementById('dsa-key-tbody');
      const windTbody    = document.getElementById('dsa-wind-tbody');
      const archiveRow   = document.getElementById('dsa-archive-row');
      const datePicker   = document.getElementById('dsa-date-picker');

      // Hit-targets populated by _drawSkewT for hover tooltips
      let _skewHits = []; // [{x, y, pressure, temp, dewpoint}]

      canvas.addEventListener('mousemove', e => {
        const rect = canvas.getBoundingClientRect();
        const mx = (e.clientX - rect.left) * (canvas.width  / rect.width);
        const my = (e.clientY - rect.top)  * (canvas.height / rect.height);
        let closest = null, bestD = 14; // px radius threshold
        for (const h of _skewHits) {
          const d = Math.hypot(mx - h.x, my - h.y);
          if (d < bestD) { bestD = d; closest = h; }
        }
        if (!closest) { skewTip.style.display = 'none'; return; }
        const lines = [`<span style="color:rgba(255,255,255,0.5);font-size:10px">${closest.pressure} MB</span>`];
        if (closest.temp     != null) lines.push(`<span style="color:#ff8888">T: ${closest.temp.toFixed(1)}°C</span>`);
        if (closest.dewpoint != null) lines.push(`<span style="color:#66ee99">Td: ${closest.dewpoint.toFixed(1)}°C</span>`);
        if (closest.rh       != null) lines.push(`<span style="color:rgba(200,200,255,0.7)">RH: ${closest.rh}%</span>`);
        skewTip.innerHTML = lines.join('<br>');
        // Position tooltip near cursor, keeping inside canvas
        const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
        const tw = 110, th = lines.length * 18 + 12;
        const left = cx + 14 + tw > rect.width  ? cx - tw - 10 : cx + 14;
        const top  = cy - th / 2 < 0            ? 4            : cy - th / 2;
        skewTip.style.left    = left + 'px';
        skewTip.style.top     = top  + 'px';
        skewTip.style.display = 'block';
      });
      canvas.addEventListener('mouseleave', () => { skewTip.style.display = 'none'; });

      // Set date picker max to today
      datePicker.max = new Date().toISOString().substring(0, 10);

      // ── Back button ───────────────────────────────────────────
      backBtn.addEventListener('click', function () {
        if (window._showLiveRecon) window._showLiveRecon();
      });

      // ── Mode toggle ───────────────────────────────────────────
      document.querySelectorAll('.dsa-mode-btn').forEach(btn => {
        btn.addEventListener('click', function () {
          document.querySelectorAll('.dsa-mode-btn').forEach(b => b.classList.remove('active'));
          this.classList.add('active');
          _mode = this.dataset.mode;
          archiveRow.style.display = _mode === 'archive' ? 'flex' : 'none';
          if (_mode === 'live') {
            if (!_liveLoaded) _loadLive();
            else { display.style.display = 'none'; _renderMissionGroups(); }
          } else {
            _setLoading('Select a date and click <strong>Load</strong> to browse archived missions.');
          }
        });
      });

      // ── Basin buttons ─────────────────────────────────────────
      document.querySelectorAll('.dsa-basin-btn').forEach(btn => {
        btn.addEventListener('click', function () {
          if (this.id === 'dsa-archive-load-btn') return;
          document.querySelectorAll('.dsa-basin-btn:not(#dsa-archive-load-btn)').forEach(b => b.classList.remove('active'));
          this.classList.add('active');
          _basin = this.dataset.basin;
          _liveLoaded = false;
          if (_mode === 'live') _loadLive();
          else { const v = datePicker.value; if (v) _loadArchive(v.replace(/-/g, '')); }
        });
      });

      // ── Refresh ───────────────────────────────────────────────
      document.getElementById('dsa-refresh-btn').addEventListener('click', function () {
        if (_mode === 'live') { _liveLoaded = false; _loadLive(); }
        else {
          const v = datePicker.value;
          if (v) {
            const k = (_basin === 'both' ? 'at+epac' : _basin) + ':' + v.replace(/-/g, '');
            delete _archiveCache[k];
            _loadArchive(v.replace(/-/g, ''));
          }
        }
      });

      // ── Archive date load ─────────────────────────────────────
      document.getElementById('dsa-archive-load-btn').addEventListener('click', function () {
        const v = datePicker.value; if (v) _loadArchive(v.replace(/-/g, ''));
      });
      datePicker.addEventListener('keydown', e => {
        if (e.key === 'Enter') { const v = datePicker.value; if (v) _loadArchive(v.replace(/-/g, '')); }
      });

      // ── NHC URLs ──────────────────────────────────────────────
      const NHC_LIVE = {
        at:   'https://www.nhc.noaa.gov/text/MIAREPNT3.shtml',
        epac: 'https://www.nhc.noaa.gov/text/MIAREPPN3.shtml',
      };
      const NHC_ARCHIVE_BASE  = 'https://www.nhc.noaa.gov/archive/recon/';
      // Subdirectory names and file prefix per basin
      const NHC_ARCHIVE_SUBDIR = { at: 'REPNT3',  epac: 'REPPN3'  };

      // Ordered list of CORS proxy wrappers to try in sequence
      const PROXIES = [
        u => 'https://corsproxy.io/?url='           + encodeURIComponent(u),
        u => 'https://api.allorigins.win/raw?url='  + encodeURIComponent(u),
        u => 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(u),
        u => 'https://thingproxy.freeboard.io/fetch/' + u,
      ];

      async function _fetchUrl(url) {
        const TIMEOUT_MS = 8000;
        const _one = async (fetchUrl) => {
          const ctrl = new AbortController();
          const tid  = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
          try {
            const r = await fetch(fetchUrl, { cache: 'no-store', signal: ctrl.signal });
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return await r.text();
          } finally { clearTimeout(tid); }
        };

        // Build all candidates: direct first, then all proxies
        const candidates = [
          url,
          ...PROXIES.map(p => p(url))
        ];

        // Race them all — first success wins
        try {
          return await Promise.any(candidates.map(u => _one(u)));
        } catch (_) {
          throw new Error('all sources failed');
        }
      }

      // Live pages have <pre>; archive files are plain text
      function _stripHtml(html) {
        const pre = html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
        if (pre) {
          return pre[1]
            .replace(/&amp;/g,'&').replace(/&lt;/g,'<')
            .replace(/&gt;/g,'>').replace(/&nbsp;/g,' ');
        }
        return html.replace(/<[^>]+>/g,' ');
      }

      // ── Load: Live ────────────────────────────────────────────
      async function _loadLive() {
        if (_fetching) return;
        _fetching = true;
        _setLoading('Loading real-time reconnaissance data&hellip;');
        display.style.display = 'none';
        const today = new Date().toISOString().replace(/-/g, '').substring(0, 8);
        const basins = _basin === 'both' ? ['at', 'epac'] : [_basin];
        const all = [];
        for (const b of basins) {
          try {
            const html  = await _fetchUrl(NHC_LIVE[b]);
            const text  = _stripHtml(html);
            const parsed = _parseBulletin(text, b, today);
            all.push(...parsed);
          } catch (err) { console.warn('[DSA] live fetch failed:', b, err); }
        }
        _sondes       = all;
        _liveLoaded   = true;
        _fetching     = false;
        _missionGroups = _groupByMission(_sondes);
        if (!_sondes.length) {
          _setLoading(
            'No active reconnaissance missions detected.<br>' +
            '<small>Hurricane recon flights operate Jun\u2013Nov when storms are active. ' +
            'Use the <strong>Archive</strong> tab to browse past missions.</small>',
            true);
          return;
        }
        _renderMissionGroups();
      }

      // ── Load: Archive ─────────────────────────────────────────
      async function _loadArchive(yyyymmdd) {
        const basins  = _basin === 'both' ? ['at', 'epac'] : [_basin];
        const cacheKey = basins.join('+') + ':' + yyyymmdd;
        const dispDate = yyyymmdd.substring(0,4) + '-' + yyyymmdd.substring(4,6) + '-' + yyyymmdd.substring(6,8);

        if (_archiveCache[cacheKey]) {
          _sondes        = _archiveCache[cacheKey];
          _missionGroups = _groupByMission(_sondes);
          if (!_sondes.length) _setLoading('No dropsonde data found for ' + dispDate + '.', true);
          else _renderMissionGroups();
          return;
        }

        if (_fetching) return;
        _fetching = true;
        _setLoading('Scanning NHC archive for ' + dispDate + '&hellip;');
        display.style.display = 'none';

        const year = yyyymmdd.substring(0, 4);

        // Fetch each basin's subdirectory index separately
        const files = [];
        let anyIndexOk = false;
        for (const basin of basins) {
          const subdir   = NHC_ARCHIVE_SUBDIR[basin];
          const indexUrl = NHC_ARCHIVE_BASE + year + '/' + subdir + '/';
          let   indexHtml = '';
          try {
            indexHtml = await _fetchUrl(indexUrl);
            anyIndexOk = true;
          } catch (err) {
            console.warn('[DSA] archive index failed:', basin, err);
            continue;
          }
          // Match e.g. href="REPNT3-KNHC.202510271348.txt"
          const re = new RegExp(
            'href="(' + subdir + '-K[A-Z]+\\.' + yyyymmdd + '\\d+\.txt)"', 'gi');
          let m;
          while ((m = re.exec(indexHtml)) !== null) {
            files.push({ basin, filename: m[1], url: indexUrl + m[1] });
          }
        }

        if (!anyIndexOk) {
          const fallback = NHC_ARCHIVE_BASE + year + '/' + NHC_ARCHIVE_SUBDIR[basins[0]] + '/';
          _setLoading(
            'Could not reach NHC archive — all proxies failed.<br>' +
            '<small>NHC may be blocking automated requests. Try again in a moment, ' +
            'or check <a href="' + fallback + '" target="_blank" rel="noopener" ' +
            'style="color:var(--teal)">nhc.noaa.gov</a> directly.</small>',
            true);
          _fetching = false; return;
        }

        if (!files.length) {
          _archiveCache[cacheKey] = [];
          _setLoading('No reconnaissance bulletins found for ' + dispDate + '.<br><small>No active storm may have been present in the selected basin on this date.</small>', true);
          _fetching = false; return;
        }

        // Cap at 60 files to avoid overwhelming the browser (pick evenly spaced if over limit)
        const MAX_FILES = 60;
        const fetchList = files.length > MAX_FILES
          ? files.filter((_, i) => i % Math.ceil(files.length / MAX_FILES) === 0).slice(0, MAX_FILES)
          : files;

        // Fetch bulletins in batches of 4
        _setLoading('Found ' + files.length + ' bulletin' + (files.length > 1 ? 's' : '') +
          (files.length > MAX_FILES ? ' (sampling ' + fetchList.length + ')' : '') + ' \u2014 downloading\u2026');
        const all = [];
        for (let i = 0; i < fetchList.length; i += 4) {
          const batch = fetchList.slice(i, i + 4);
          if (i > 0) _setLoading('Loading ' + Math.min(i + 4, fetchList.length) + ' / ' + fetchList.length + ' bulletins\u2026');
          const results = await Promise.allSettled(
            batch.map(async f => {
              const raw  = await _fetchUrl(f.url);
              const text = _stripHtml(raw);
              return _parseBulletin(text, f.basin, yyyymmdd);
            })
          );
          for (const r of results) if (r.status === 'fulfilled') all.push(...r.value);
        }

        // Deduplicate by aircraft + obs_num + position
        const seen   = new Set();
        const deduped = all.filter(s => {
          const k = s.aircraft + '|' + s.obs_num + '|' + s.rel_time + '|' + s.rel_lat;
          if (seen.has(k)) return false;
          seen.add(k); return true;
        });

        _archiveCache[cacheKey] = deduped;
        _sondes        = deduped;
        _missionGroups = _groupByMission(deduped);
        _fetching      = false;

        if (!deduped.length) {
          _setLoading('No decodable dropsondes found for ' + dispDate + '.', true);
          return;
        }
        _renderMissionGroups();
      }

      function _setLoading(msg, isError) {
        sondeList.innerHTML = '<div class="dsa-status-msg' + (isError ? ' error' : '') + '">' + msg + '</div>';
        display.style.display = 'none';
      }


      // ── FM-36 TEMP DROP parser ─────────────────────────────────
      //  Verified against real NHC bulletin data.
      const MAN_LEVELS = {
        '99':null,'00':1000,'92':925,'85':850,'70':700,
        '50':500,'40':400,'30':300,'25':250,'20':200,'15':150,'10':100
      };
      const STD_H = {
        '99':0,'00':111,'92':762,'85':1457,'70':3012,
        '50':5574,'40':7185,'30':9164,'25':10363,'20':11784,'15':13608,'10':16180
      };
      const H_RANGE = {
        '99':[0,300],'00':[0,600],'92':[400,1300],'85':[1000,2200],
        '70':[2400,4200],'50':[4500,6500],'40':[6500,8500],
        '30':[8000,10500],'25':[9500,12000],'20':[11000,13500],
        '15':[12500,15500],'10':[14500,18000]
      };
      const UPPER = new Set(['50','40','30','25','20','15','10']);

      function _decodeHeight(pp, hhh) {
        if (!hhh || hhh.includes('/')) return null;
        const h3 = parseInt(hhh, 10);
        if (isNaN(h3)) return null;
        const ref = STD_H[pp] || 0;
        const [lo, hi] = H_RANGE[pp] || [0, 99999];
        if (UPPER.has(pp)) {
          const hm = h3 * 10;
          const base = Math.round(ref / 10000) * 10000;
          let r = base + hm;
          if (r < lo) r += 10000;
          if (r > hi) r -= 10000;
          return r;
        } else {
          for (let m = 0; m < 30; m++) {
            const c = m * 1000 + h3;
            if (c >= lo && c <= hi) return c;
          }
          return h3;
        }
      }

      function _decodeTempDew(grp) {
        if (!grp || grp.length < 5) return [null, null];
        const tPart = grp.substring(0, 3);
        const dPart = grp.substring(3, 5);
        // Missing temp part → nothing to salvage
        if (/\//.test(tPart)) return [null, null];
        const TTT = parseInt(tPart, 10);
        if (isNaN(TTT) || TTT === 999) return [null, null];
        const TaTa = Math.floor(TTT / 10);
        const Ta   = TTT % 10;
        const T = TaTa < 50 ? (TaTa + Ta/10) : -(TaTa - 50 + Ta/10);
        // Physical bounds check
        if (T < -85 || T > 55) return [null, null];
        // Missing or unavailable dewpoint → return temp only
        if (/\//.test(dPart)) return [+T.toFixed(1), null];
        const dd = parseInt(dPart, 10);
        if (isNaN(dd) || dd === 99) return [+T.toFixed(1), null];
        let dep;
        if (dd < 50) dep = dd * 0.1;
        else         dep = dd - 50;                  // WMO table 0777: 50-98 → whole °C
        // A depression > 50°C is physically impossible in the troposphere
        if (dep > 50) return [+T.toFixed(1), null];
        const Td = +(T - dep).toFixed(1);
        return [+T.toFixed(1), Td < -60 ? null : Td];
      }

      function _decodeWind(grp) {
        if (!grp || grp.length < 5 || /\/\/\//.test(grp)) return [null, null];
        // All-nines or all-zeros direction = missing/not observed
        if (grp === '99999') return [null, null];
        let dir = parseInt(grp.substring(0,3), 10);
        let spd = parseInt(grp.substring(3,5), 10);
        if (isNaN(dir) || isNaN(spd)) return [null, null];
        // WMO FM convention: when speed > 99 kt, dir += 500 and spd = actual - 100
        if (dir >= 500) { dir -= 500; spd += 100; }
        // After any adjustment, reject invalid directions
        if (dir > 360) return [null, null];
        return [dir, spd];
      }

      function _rh(T, Td) {
        if (T == null || Td == null) return null;
        const es = 6.112 * Math.exp(17.67*T  / (T  + 243.5));
        const e  = 6.112 * Math.exp(17.67*Td / (Td + 243.5));
        return Math.min(100, +(100*e/es).toFixed(0));
      }

      function _parseXXAA(tokens) {
        let lat = null, lon = null;
        let i = 0;
        if (tokens[i] === 'XXAA' || tokens[i] === 'TTAA') i++;
        if (i < tokens.length && /^\d+$/.test(tokens[i])) i++; // station ID

        // Latitude (99LLL)
        if (i < tokens.length && tokens[i].startsWith('99') && tokens[i].length === 5) {
          lat = parseInt(tokens[i].substring(2), 10) / 10;
          i++;
        }
        // Longitude (QLLLL)
        if (i < tokens.length && tokens[i].length === 5 && '1357'.includes(tokens[i][0])) {
          const Q    = parseInt(tokens[i][0], 10);
          const lraw = parseInt(tokens[i].substring(1), 10) / 10;
          const sign = {1:1, 3:-1, 5:-1, 7:1}[Q] || 1;
          lon = sign * lraw;
          if (lat !== null && Q > 4) lat = -lat; // southern hemisphere
          i++;
        }
        // Skip additional ID group
        if (i < tokens.length && /^\d{5}$/.test(tokens[i])) i++;

        const levels = [];
        while (i < tokens.length) {
          const tok = tokens[i];
          if (['31313','61616','62626'].includes(tok)) break;
          const pp  = tok.substring(0,2);
          const hhh = tok.substring(2,5);
          if (!(pp in MAN_LEVELS)) { i++; continue; }
          if (pp === '88' || pp === '77') { i += 3; continue; }

          const height = _decodeHeight(pp, hhh);
          const [T, Td]   = (i+1 < tokens.length) ? _decodeTempDew(tokens[i+1]) : [null,null];
          const [wd, ws]  = (i+2 < tokens.length) ? _decodeWind(tokens[i+2]) : [null,null];
          const pres = pp === '99' ? null : MAN_LEVELS[pp];
          levels.push({
            pressure: pres,
            height:   height,
            temp:     T,
            dewpoint: Td,
            rh:       _rh(T,Td),
            wind_dir: wd,
            wind_spd: ws,
            src: 'xxaa'
          });
          i += 3;
        }
        return { levels, lat, lon };
      }

      function _parseXXBB(tokens) {
        if (!tokens.length) return { levels:[], sfcPres: null };
        let i = 0;
        if (tokens[i] === 'XXBB' || tokens[i] === 'TTBB') i++;
        // Skip up to 4 ID groups
        let skipped = 0;
        while (i < tokens.length && skipped < 4 && /^\d{5}$/.test(tokens[i])) { i++; skipped++; }

        const levels = [];
        let sfcPres = null;
        while (i < tokens.length) {
          const tok = tokens[i];
          if (['31313','61616','62626','21212'].includes(tok)) break;
          if (tok.length < 5) { i++; continue; }
          const ppp = parseInt(tok.substring(2,5), 10);
          if (isNaN(ppp)) { i++; continue; }
          const pres = ppp < 50 ? ppp + 1000 : ppp;
          if (i === 0 && pres >= 950 && pres <= 1060) sfcPres = pres;

          // XXBB has no wind group — only nnPPP + TTTdd pairs
          const [T, Td] = (i+1 < tokens.length) ? _decodeTempDew(tokens[i+1]) : [null,null];
          levels.push({ pressure: pres, height: null, temp: T, dewpoint: Td,
                        rh: _rh(T,Td), wind_dir: null, wind_spd: null, src:'xxbb' });
          if (!sfcPres && pres >= 950 && pres <= 1060) sfcPres = pres;
          i += 2;
        }
        return { levels, sfcPres };
      }

      // PPBB / 21212 — significant wind levels (wind-only, no temp)
      // Format: nnPPP dddff pairs
      // Section marker is 'PPBB' (traditional) or '21212' (NHC FM-36 bulletins)
      function _parsePPBB(tokens) {
        if (!tokens.length) return [];
        let i = 0;
        const isRealPPBB = tokens[i] === 'PPBB';
        if (tokens[i] === 'PPBB' || tokens[i] === '21212') i++;
        // Skip ID groups only for traditional PPBB format (21212 sections have no ID groups)
        if (isRealPPBB) {
          let skipped = 0;
          while (i < tokens.length && skipped < 4 && /^\d{5}$/.test(tokens[i])) { i++; skipped++; }
        }
        const levels = [];
        while (i + 1 < tokens.length) {
          const tok = tokens[i];
          if (['31313','61616','62626'].includes(tok)) break;
          if (tok.length < 5) { i++; continue; }
          const ppp = parseInt(tok.substring(2,5), 10);
          if (isNaN(ppp)) { i++; continue; }
          const pres = ppp < 50 ? ppp + 1000 : ppp;
          const [wd, ws] = _decodeWind(tokens[i+1]);
          if (wd != null && ws != null) {
            levels.push({ pressure: pres, height: null, temp: null, dewpoint: null,
                          rh: null, wind_dir: wd, wind_spd: ws, src: 'ppbb' });
          }
          i += 2;
        }
        return levels;
      }

      function _parseExt(text) {
        const ext = {};
        // Aircraft + mission (61616)
        const m1 = text.match(/61616\s+(\S+)\s+([\w\s]+?)\s+OB\s+(\d+)/i);
        if (m1) { ext.aircraft = m1[1]; ext.mission = m1[2].trim(); ext.obs_num = +m1[3]; }
        // BL mean wind (62626 MBL WND dddff)
        const m2 = text.match(/MBL\s+WND\s+(\d{3})(\d{2})/i);
        if (m2) { ext.bl_dir = +m2[1]; ext.bl_spd = +m2[2]; }
        // 150m wind
        const m3 = text.match(/WL150\s+(\d{3})(\d{2})/i);
        if (m3) { ext.wl150_dir = +m3[1]; ext.wl150_spd = +m3[2]; }
        // Release position
        const m4 = text.match(/REL\s+(\d+[NS])(\d+[EW])\s+(\d{6})/i);
        if (m4) {
          ext.rel_lat = _parseCoord(m4[1]);
          ext.rel_lon = _parseCoord(m4[2]);
          const t = m4[3];
          ext.rel_time = t.substring(0,2)+':'+t.substring(2,4)+':'+t.substring(4,6)+'Z';
        }
        // Surface position
        const m5 = text.match(/SPG\s+(\d+[NS])(\d+[EW])\s+(\d{6})/i);
        if (m5) {
          ext.sfc_lat = _parseCoord(m5[1]);
          ext.sfc_lon = _parseCoord(m5[2]);
          const t = m5[3];
          ext.sfc_time = t.substring(0,2)+':'+t.substring(2,4)+':'+t.substring(4,6)+'Z';
        }
        return ext;
      }

      function _parseCoord(s) {
        const m = s.match(/^(\d+)([NSEW])$/i);
        if (!m) return null;
        const raw = m[1], hem = m[2].toUpperCase();
        const deg = (raw.length >= 4)
          ? parseInt(raw.slice(0,-2), 10) + parseInt(raw.slice(-2), 10)/100
          : parseInt(raw.slice(0,-1), 10) + parseInt(raw.slice(-1), 10)/10;
        return (hem === 'S' || hem === 'W') ? -deg : +deg;
      }

      function _parseBulletin(text, basin, fileDate) {
        const sondes = [];
        // Extract bulletin timestamp (DDHHmm in header)
        const hdrM = text.match(/(?:UZNT\d+|UZPN\d+)\s+KWBC\s+(\d{6})/i);
        const bulletinTime = hdrM ? hdrM[1] : '';

        // Derive the true calendar date from the bulletin day-of-month.
        // fileDate is YYYYMMDD (the date the archive file was fetched, or today for live).
        // If the bulletin header day differs, trust the header.
        if (bulletinTime.length === 6 && fileDate && fileDate.length === 8) {
          const bulletinDay = parseInt(bulletinTime.substring(0, 2), 10);
          const refYear  = parseInt(fileDate.substring(0, 4), 10);
          const refMonth = parseInt(fileDate.substring(4, 6), 10); // 1-based
          const refDay   = parseInt(fileDate.substring(6, 8), 10);
          if (bulletinDay !== refDay) {
            // Build a Date at midnight UTC for the reference month and find the correct day
            let y = refYear, m = refMonth;
            if (bulletinDay > refDay + 5) {
              // bulletin day looks like prior month (e.g. ref=Mar 2, bulletin=Mar 30 → Feb 30 impossible → Feb 28/29)
              m -= 1;
              if (m < 1) { m = 12; y -= 1; }
            }
            const mm = String(m).padStart(2, '0');
            const dd = String(bulletinDay).padStart(2, '0');
            fileDate = String(y) + mm + dd;
          }
        }

        // Split into individual sonde blocks (separated by '=')
        const blocks = text.split(/=\s*/);
        for (const block of blocks) {
          const hasXXAA = block.includes('XXAA');
          const hasXXBB = block.includes('XXBB');
          if (!hasXXAA && !hasXXBB) continue;

          // Extract XXAA / XXBB / significant-wind sections
          // NHC FM-36 bulletins use '21212' (Section 2 marker) instead of 'PPBB'
          const xxaaM = block.match(/XXAA\b([\s\S]*?)(?=XXBB|21212|PPBB|31313|61616|$)/i);
          const xxbbM = block.match(/XXBB\b([\s\S]*?)(?=21212|PPBB|31313|61616|$)/i);
          const ppbbM = block.match(/(?:21212|PPBB)\b([\s\S]*?)(?=31313|61616|62626|$)/i);

          const xxaaText = xxaaM ? xxaaM[0] : '';
          const xxbbText = xxbbM ? xxbbM[0] : '';
          const ppbbText = ppbbM ? ppbbM[0] : '';

          const { levels: bbLevels, sfcPres } = _parseXXBB(xxbbText.toUpperCase().split(/\s+/).filter(Boolean));
          const pbLevels = _parsePPBB(ppbbText.toUpperCase().split(/\s+/).filter(Boolean));

          if (hasXXAA) {
            // ── XXAA block: create new sonde ──────────────────────────────────────
            const { levels: aaLevels, lat, lon } = _parseXXAA(xxaaText.toUpperCase().split(/\s+/).filter(Boolean));
            const ext = _parseExt(block);

            // Merge: XXAA first, then XXBB significant temp levels, then 21212/PPBB wind levels
            const existing = new Set(aaLevels.filter(l=>l.pressure).map(l=>l.pressure));
            const merged = [...aaLevels];
            for (const bl of bbLevels) {
              if (bl.pressure && !existing.has(bl.pressure)) { merged.push(bl); existing.add(bl.pressure); }
            }
            for (const pl of pbLevels) {
              const hit = merged.find(lv => lv.pressure === pl.pressure);
              if (hit) { if (hit.wind_dir == null) { hit.wind_dir = pl.wind_dir; hit.wind_spd = pl.wind_spd; } }
              else { merged.push(pl); existing.add(pl.pressure); }
            }

            // Patch surface pressure from XXBB into the surface level in XXAA
            if (sfcPres) {
              for (const lv of merged) {
                if (lv.pressure == null) { lv.pressure = sfcPres; break; }
              }
            }

            // Sort top-down by pressure (ascending = descending altitude)
            merged.sort((a,b) => (a.pressure||9999) - (b.pressure||9999));

            const sonde = {
              basin,
              bulletinTime,
              fileDate:   fileDate || null,
              aircraft:   ext.aircraft || '',
              mission:    ext.mission  || '',
              obs_num:    ext.obs_num  || null,
              rel_lat:    ext.rel_lat  != null ? ext.rel_lat : lat,
              rel_lon:    ext.rel_lon  != null ? ext.rel_lon : lon,
              rel_time:   ext.rel_time || '',
              sfc_lat:    ext.sfc_lat  || null,
              sfc_lon:    ext.sfc_lon  || null,
              sfc_time:   ext.sfc_time || '',
              bl_dir:     ext.bl_dir   || null,
              bl_spd:     ext.bl_spd   || null,
              wl150_dir:  ext.wl150_dir|| null,
              wl150_spd:  ext.wl150_spd|| null,
              levels: merged,
            };
            if (merged.length) sondes.push(sonde);

          } else {
            // ── XXBB-only block: merge into the preceding sonde ───────────────────
            // NHC FM-36 splits each sonde into two messages: XXAA (mandatory) + XXBB (significant)
            // The XXBB block contains significant temperature levels AND the 21212 wind section
            if (!sondes.length) continue;
            const last = sondes[sondes.length - 1];
            const existing = new Set(last.levels.filter(l=>l.pressure).map(l=>l.pressure));

            for (const bl of bbLevels) {
              if (!bl.pressure) continue;
              const hit = last.levels.find(lv => lv.pressure === bl.pressure);
              if (hit) {
                // Patch in temp/dewpoint for levels already present (e.g. mandatory levels in XXAA)
                if (hit.temp == null && bl.temp != null) { hit.temp = bl.temp; hit.dewpoint = bl.dewpoint; hit.rh = bl.rh; }
              } else {
                last.levels.push(bl);
                existing.add(bl.pressure);
              }
            }
            for (const pl of pbLevels) {
              const hit = last.levels.find(lv => lv.pressure === pl.pressure);
              if (hit) { if (hit.wind_dir == null) { hit.wind_dir = pl.wind_dir; hit.wind_spd = pl.wind_spd; } }
              else { last.levels.push(pl); existing.add(pl.pressure); }
            }
            if (sfcPres) {
              for (const lv of last.levels) {
                if (lv.pressure == null) { lv.pressure = sfcPres; break; }
              }
            }
            last.levels.sort((a,b) => (a.pressure||9999) - (b.pressure||9999));
          }
        }
        return sondes;
      }

      // ── Group sondes by mission ───────────────────────────────
      function _groupByMission(sondes) {
        const map = new Map();
        for (const s of sondes) {
          const aircraft = s.aircraft || 'UNKNOWN';
          const mission  = s.mission  || 'UNK-MISSION';
          const date     = s.fileDate || '00000000';
          const key  = aircraft + '|' + mission + '|' + date;
          if (!map.has(key)) {
            map.set(key, { aircraft, mission, date, basin: s.basin, sondes: [] });
          }
          map.get(key).sondes.push(s);
        }
        // Sort each group's sondes by obs_num (ascending)
        for (const g of map.values()) {
          g.sondes.sort((a, b) => (a.obs_num || 0) - (b.obs_num || 0));
        }
        // Sort groups: newest date first, then alphabetically by aircraft
        return Array.from(map.values()).sort((a, b) => {
          if (b.date !== a.date) return b.date.localeCompare(a.date);
          return a.aircraft.localeCompare(b.aircraft);
        });
      }

      // ── Render mission groups ─────────────────────────────────
      function _renderMissionGroups() {
        sondeList.innerHTML = '';
        if (!_missionGroups.length) { _setLoading('No dropsonde data found.', true); return; }

        _missionGroups.forEach((group, gIdx) => {
          const d = group.date;
          let dateLabel = d;
          if (d && d.length === 8) {
            try {
              dateLabel = new Date(d.substring(0,4)+'-'+d.substring(4,6)+'-'+d.substring(6,8))
                .toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
            } catch (_) {}
          }
          const basinLabel = group.basin === 'at' ? 'ATLANTIC' : 'E. PACIFIC';
          const isOpen = gIdx === 0;

          const groupEl = document.createElement('div');
          groupEl.className = 'dsa-mission-group' + (isOpen ? ' open' : '');

          // Build header
          const header = document.createElement('div');
          header.className = 'dsa-mission-header';
          header.innerHTML =
            '<span class="dsa-mission-callsign">' + group.aircraft + '</span>' +
            '<span class="dsa-mission-id">'       + group.mission  + '</span>' +
            '<span class="dsa-mission-date">'     + dateLabel      + '</span>' +
            '<span class="dsa-mission-basin">'    + basinLabel     + '</span>' +
            '<span class="dsa-mission-count">'    + group.sondes.length + ' sonde' + (group.sondes.length !== 1 ? 's' : '') + '</span>' +
            '<span class="dsa-mission-chevron">&#9660;</span>';

          header.addEventListener('click', () => groupEl.classList.toggle('open'));

          // Build sonde rows
          const sondesEl = document.createElement('div');
          sondesEl.className = 'dsa-mission-sondes';

          group.sondes.forEach(s => {
            const globalIdx = _sondes.indexOf(s);
            const row = document.createElement('div');
            row.className = 'dsa-sonde-item';
            const latStr = s.rel_lat != null
              ? (s.rel_lat >= 0 ? s.rel_lat.toFixed(2)+'°N' : Math.abs(s.rel_lat).toFixed(2)+'°S')
              : '—';
            const lonStr = s.rel_lon != null
              ? (s.rel_lon < 0 ? Math.abs(s.rel_lon).toFixed(2)+'°W' : s.rel_lon.toFixed(2)+'°E')
              : '—';
            row.innerHTML =
              '<span class="dsa-sonde-ob">Sonde ' + (s.obs_num != null ? s.obs_num : '—') + '</span>' +
              '<span class="dsa-sonde-time">' + (s.rel_time || s.bulletinTime || '——') + '</span>' +
              '<span class="dsa-sonde-pos">' + latStr + '&nbsp;' + lonStr + '</span>';
            row.addEventListener('click', () => _selectSonde(globalIdx, row));
            sondesEl.appendChild(row);
          });

          groupEl.appendChild(header);
          groupEl.appendChild(sondesEl);
          sondeList.appendChild(groupEl);
        });

        // Auto-select first sonde in first group
        const firstRow = sondeList.querySelector('.dsa-sonde-item');
        if (firstRow) firstRow.click();
      }

      function _selectSonde(idx, rowEl) {
        _activeSonde = _sondes[idx];
        document.querySelectorAll('.dsa-sonde-item').forEach(el => el.classList.remove('active'));
        if (rowEl) rowEl.classList.add('active');
        _renderDisplay(_activeSonde);
      }

      // ── Display render ────────────────────────────────────────
      function _renderDisplay(sonde) {
        display.style.display = '';

        // Header
        const latStr = sonde.rel_lat != null
          ? (sonde.rel_lat >= 0 ? sonde.rel_lat.toFixed(2)+'°N' : Math.abs(sonde.rel_lat).toFixed(2)+'°S')
          : '—';
        const lonStr = sonde.rel_lon != null
          ? (sonde.rel_lon < 0 ? Math.abs(sonde.rel_lon).toFixed(2)+'°W' : sonde.rel_lon.toFixed(2)+'°E')
          : '—';
        titleEl.textContent =
          (sonde.aircraft || 'Dropsonde') + '  —  ' + latStr + ',  ' + lonStr;
        const _fd = sonde.fileDate;
        let _dStr = '';
        if (_fd && _fd.length === 8) {
          try {
            _dStr = new Date(_fd.substring(0,4)+'-'+_fd.substring(4,6)+'-'+_fd.substring(6,8))
              .toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
          } catch (_) {}
        }
        subtitleEl.textContent =
          (sonde.mission || '') +
          (sonde.rel_time ? '  ·  Dropped ' + sonde.rel_time : '') +
          (_dStr ? '  ·  ' + _dStr : '') +
          (sonde.basin === 'at' ? '  ·  Atlantic' : '  ·  E. Pacific');

        // Stats box
        const lines = [];
        if (sonde.bl_spd != null)
          lines.push(`Mean wind (lowest 500m): <strong>${sonde.bl_dir}° at ${sonde.bl_spd} kts</strong>`);
        if (sonde.wl150_spd != null)
          lines.push(`Wind at 150 m: <strong>${sonde.wl150_dir}° at ${sonde.wl150_spd} kts</strong>`);
        if (sonde.sfc_time)
          lines.push(`Surface time: <strong>${sonde.sfc_time}</strong>`);

        if (lines.length) {
          statsContent.innerHTML = lines.join('<br>');
          statsBox.style.display = '';
        } else {
          statsBox.style.display = 'none';
        }

        // Tables
        _currentSonde = sonde;
        _renderKeyTable(sonde.levels);
        _renderWindTable(sonde.levels);

        // Skew-T
        requestAnimationFrame(() => _drawSkewT(sonde.levels));
      }

      // ── Key levels table ──────────────────────────────────────
      const KEY_PRESSURES = [850, 925, 1000];
      let _keyFilter = 'key'; // 'key' | 'all'
      let _currentSonde = null;

      // Wire filter buttons
      document.getElementById('dsa-key-filters').addEventListener('click', e => {
        const btn = e.target.closest('.dsa-key-btn');
        if (!btn) return;
        _keyFilter = btn.dataset.filter;
        document.querySelectorAll('.dsa-key-btn').forEach(b => b.classList.toggle('active', b === btn));
        if (_currentSonde) _renderKeyTable(_currentSonde.levels);
      });

      function _renderKeyTable(levels) {
        keyTbody.innerHTML = '';
        // Detect surface level: level with the lowest height value
        const levelsWithHt = levels.filter(lv => lv.height != null);
        const sfcLevel = levelsWithHt.length
          ? levelsWithHt.reduce((min, lv) => lv.height < min.height ? lv : min)
          : null;
        const rows = [];
        for (const lv of levels) {
          const p = lv.pressure;
          if (_keyFilter === 'key') {
            // 850, 925, 1000 mb + dynamically detected surface level
            if (p == null) { rows.push(lv); continue; }
            if (KEY_PRESSURES.includes(p) || lv === sfcLevel) rows.push(lv);
          } else {
            // 'all' — every level that has temp or wind data
            rows.push(lv);
          }
        }
        // Sort top-down by pressure (low mb = high altitude first)
        rows.sort((a,b) => (a.pressure||9999) - (b.pressure||9999));

        for (const lv of rows) {
          const tr = document.createElement('tr');
          const label = lv.pressure != null
            ? lv.pressure + ' mb' + (lv === sfcLevel ? ' (SFC)' : '')
            : 'Sfc';
          const ht    = lv.height != null ? lv.height.toFixed(0) + ' m' : '—';
          const wind  = lv.wind_dir != null && lv.wind_spd != null
            ? lv.wind_dir + '° / ' + lv.wind_spd + ' kt'
            : '—';
          const temp  = lv.temp != null ? lv.temp.toFixed(1) + '°C' : '—';
          const rh    = lv.rh   != null ? lv.rh + '%' : '—';

          // Temp cell color
          const tColor = lv.temp != null ? _tempColor(lv.temp) : '';
          // RH cell color
          const rhColor = lv.rh != null ? _rhColor(lv.rh) : '';

          tr.innerHTML = `
            <td class="dsa-td-p">${label}</td>
            <td>${ht}</td>
            <td>${wind}</td>
            <td style="background:${tColor};color:#111;font-weight:600">${temp}</td>
            <td style="background:${rhColor};color:#111;font-weight:600">${rh}</td>
          `;
          keyTbody.appendChild(tr);
        }
      }

      // ── Wind profile table ────────────────────────────────────
      const MAX_WIND_BAR = 80; // kts → full bar width
      function _renderWindTable(levels) {
        windTbody.innerHTML = '';
        const sorted = [...levels]
          .filter(lv => lv.pressure != null && lv.wind_spd != null)
          .sort((a,b) => (a.pressure||0) - (b.pressure||0)); // top → surface
        for (const lv of sorted) {
          const pct = Math.min(100, (lv.wind_spd / MAX_WIND_BAR) * 100);
          const barColor = _windColor(lv.wind_spd);
          const htLabel = lv.height != null ? '<span class="dsa-wind-ht"> / ' + Math.round(lv.height) + ' m</span>' : '';
          const dirLabel = lv.wind_dir != null ? lv.wind_dir + '° @ ' : '';
          const tr = document.createElement('tr');
          tr.innerHTML = `
            <td class="dsa-td-p">${lv.pressure} mb${htLabel}</td>
            <td class="dsa-wind-cell">
              <div class="dsa-wind-bar" style="width:${pct}%;background:${barColor}"></div>
              <span class="dsa-wind-val">${lv.wind_dir != null ? lv.wind_dir + '° @ ' : ''}${lv.wind_spd} kts</span>
            </td>
          `;
          windTbody.appendChild(tr);
        }
      }

      // ── Color helpers ─────────────────────────────────────────
      function _tempColor(T) {
        // Map -30…+40°C → cold(blue)…warm(red/orange)
        const t = Math.max(-30, Math.min(40, T));
        const frac = (t + 30) / 70;
        const r = Math.round(50  + frac * 205);
        const g = Math.round(100 - frac * 40);
        const b = Math.round(220 - frac * 200);
        return `rgba(${r},${g},${b},0.85)`;
      }

      function _rhColor(rh) {
        // 0% → dry red/orange, 100% → moist blue
        const frac = Math.min(100, rh) / 100;
        const r = Math.round(220 - frac * 170);
        const g = Math.round(100 + frac * 50);
        const b = Math.round(50  + frac * 200);
        return `rgba(${r},${g},${b},0.85)`;
      }

      function _windColor(ws) {
        // 0→calm(light blue) 30→green 60→yellow 80→red
        const frac = Math.min(1, ws / 80);
        if (frac < 0.4)  return `rgba(${Math.round(100+frac*100)},${Math.round(180+frac*20)},255,0.9)`;
        if (frac < 0.7)  return `rgba(80,220,${Math.round(255-frac*300)},0.9)`;
        return `rgba(255,${Math.round(220-frac*200)},20,0.9)`;
      }

      // ── Skew-T / Log-P renderer ───────────────────────────────
      // Coordinate: y=0 top (low P), y=CH bottom (high P/surface)
      //   py(P) = CH * log(P/pTop) / log(pBot/pTop)
      //   tx(T,P) = CW * (T - tLeft - skew(P)) / (tRight-tLeft)
      //   skew(P) = SKEW * (CH - py(P)) / CH   (right-lean increases upward)

      const T_LEFT = -50, T_RIGHT = 65;
      const SKEW   = 55;   // °C slant over full chart height

      function _drawSkewT(levels) {
        // Size canvas to fill parent width
        const W = canvas.parentElement.offsetWidth || 540;
        const H = 460;
        canvas.width  = W;
        canvas.height = H;
        const PAD_L = 46, PAD_R = 12, PAD_T = 10, PAD_B = 34;
        const CW = W - PAD_L - PAD_R;
        const CH = H - PAD_T - PAD_B;

        // ── Dynamic pressure range from actual data ───────────
        const validP = levels.filter(lv => lv.pressure != null).map(lv => lv.pressure);
        const maxP   = validP.length ? Math.max(...validP) : 1050;
        const minP   = validP.length ? Math.min(...validP) : 100;
        // 25 hPa padding above and below the data extent
        const pBot = Math.min(1050, Math.ceil(maxP  / 25) * 25 + 25);
        const pTop = Math.max(50,   Math.floor(minP / 25) * 25 - 25);

        // Only show isobars that fall within the dynamic range
        const pLines = [1000, 925, 850, 700, 500, 400, 300, 200, 100]
          .filter(p => p <= pBot && p >= pTop);

        // Local coordinate helpers using dynamic range
        // y=0 is top (low pressure / high altitude), y=CH is bottom (high pressure / surface)
        const py = (P) => CH * Math.log(P / pTop) / Math.log(pBot / pTop);

        // Dynamically shift the temperature axis so all data stays on-chart.
        // "Effective" temperature at level P = T - skew(P). If every T_eff falls in
        // [tLeft, tRight] then tx() is in [0, CW].
        let tLeft = T_LEFT, tRight = T_RIGHT;
        {
          const tEffs = [];
          for (const lv of levels) {
            if (!lv.pressure) continue;
            const s = SKEW * (CH - py(lv.pressure)) / CH;
            if (lv.temp     != null) tEffs.push(lv.temp     - s);
            if (lv.dewpoint != null) tEffs.push(lv.dewpoint - s);
          }
          if (tEffs.length) {
            const lo = Math.min(...tEffs), hi = Math.max(...tEffs);
            const center    = (lo + hi) / 2;
            const halfRange = Math.max(35, (hi - lo) / 2 + 10);
            tLeft  = Math.floor((center - halfRange) / 10) * 10;
            tRight = Math.ceil ((center + halfRange) / 10) * 10;
          }
        }
        // Always keep 0°C on-chart as a reference
        if (tLeft  > 0) tLeft  = -10;
        if (tRight < 0) tRight =  10;

        const tx = (T, P) => {
          const y    = py(P);
          // Skew increases upward (y=0 is top): invert so skew=0 at bottom, max at top
          const skew = SKEW * (CH - y) / CH;
          return CW * (T - tLeft - skew) / (tRight - tLeft);
        };

        ctx.clearRect(0, 0, W, H);
        ctx.save();
        ctx.translate(PAD_L, PAD_T);

        // Background
        ctx.fillStyle = '#0b0b0b';
        ctx.fillRect(0, 0, CW, CH);

        // ── Pressure grid lines (horizontal) ──
        ctx.lineWidth = 0.6;
        for (const p of pLines) {
          const y = py(p);
          ctx.strokeStyle = 'rgba(255,255,255,0.08)';
          ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(CW, y); ctx.stroke();
          // Label
          ctx.fillStyle = 'rgba(255,255,255,0.3)';
          ctx.font = '9px Inter,sans-serif';
          ctx.textAlign = 'right';
          ctx.fillText(p + ' hPa', -4, y + 3);
        }

        // ── Isotherms (slanted, blue dashed) ──
        ctx.save();
        ctx.rect(0, 0, CW, CH); ctx.clip();
        ctx.setLineDash([4, 6]);
        ctx.lineWidth = 0.6;
        // Cover full visible area: from tLeft at the bottom to tRight+SKEW at the top
        const isoStart = Math.floor(tLeft / 10) * 10;
        const isoEnd   = Math.ceil((tRight + SKEW) / 10) * 10;
        ctx.strokeStyle = 'rgba(100,140,220,0.18)';
        ctx.lineWidth   = 0.6;
        for (let T = isoStart; T <= isoEnd; T += 10) {
          ctx.beginPath();
          ctx.moveTo(tx(T, pBot), py(pBot));
          ctx.lineTo(tx(T, pTop), py(pTop));
          ctx.stroke();
        }
        ctx.setLineDash([]);
        ctx.restore();
        // ── Temperature axis labels (bottom only) ──
        ctx.font = '8px Inter,sans-serif';
        ctx.textAlign = 'center';
        for (let T = isoStart; T <= isoEnd; T += 10) {
          const x = tx(T, pBot);
          if (x < 0 || x > CW) continue;
          ctx.fillStyle = 'rgba(255,255,255,0.22)';
          ctx.fillText(T + '°', x, CH + 11);
        }

        // ── Dry adiabats (gray, curved) ──
        ctx.save();
        ctx.rect(0, 0, CW, CH); ctx.clip();
        ctx.lineWidth = 0.6;
        ctx.strokeStyle = 'rgba(180,180,180,0.12)';
        for (let theta0 = 250; theta0 <= 430; theta0 += 10) {
          ctx.beginPath();
          let first = true;
          for (let p = pBot; p >= pTop; p -= 5) {
            const T_K = theta0 * Math.pow(p / 1000, 0.2854);
            const T_C = T_K - 273.15;
            const x = tx(T_C, p);
            const y = py(p);
            if (first) { ctx.moveTo(x, y); first = false; }
            else ctx.lineTo(x, y);
          }
          ctx.stroke();
        }
        ctx.restore();

        // ── Moist adiabats (green dashed) ──
        ctx.save();
        ctx.rect(0, 0, CW, CH); ctx.clip();
        ctx.lineWidth = 0.6;
        ctx.setLineDash([3, 5]);
        ctx.strokeStyle = 'rgba(80,180,80,0.18)';
        for (let The_K = 280; The_K <= 400; The_K += 10) {
          ctx.beginPath();
          let T_K = The_K * Math.pow(1000 / pBot, 0.2854);
          let first = true;
          for (let p = pBot; p >= pTop; p -= 5) {
            const T_C = T_K - 273.15;
            const x = tx(T_C, p);
            const y = py(p);
            if (first) { ctx.moveTo(x, y); first = false; }
            else ctx.lineTo(x, y);
            const esat = 6.112 * Math.exp(17.67*T_C / (T_C+243.5));
            const r_s  = 0.622 * esat / (p - esat) / 1000;
            const dT_dp = (287.05 * T_K / (p * 1005))
              * (1 + 2.501e6*r_s/(287.05*T_K))
              / (1 + 2.501e6*2.501e6*r_s/(1005*461.5*T_K*T_K));
            T_K += dT_dp * (-5);
          }
          ctx.stroke();
        }
        ctx.setLineDash([]);
        ctx.restore();

        // ── Temperature trace (red) ──
        const withT  = levels.filter(lv => lv.pressure && lv.temp  != null).sort((a,b)=>a.pressure-b.pressure);
        const withTd = levels.filter(lv => lv.pressure && lv.dewpoint != null).sort((a,b)=>a.pressure-b.pressure);

        ctx.save();
        ctx.rect(0, 0, CW, CH); ctx.clip();

        if (withT.length > 1) {
          ctx.lineWidth = 2;
          ctx.strokeStyle = '#e83040';
          ctx.beginPath();
          withT.forEach((lv, i) => {
            const x = tx(lv.temp, lv.pressure);
            const y = py(lv.pressure);
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          });
          ctx.stroke();
        }
        // Draw T dots — register hit targets for hover tooltip
        _skewHits = [];
        withT.forEach(lv => {
          const x = tx(lv.temp, lv.pressure);
          const y = py(lv.pressure);
          ctx.fillStyle = '#e83040';
          ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI*2); ctx.fill();
          _skewHits.push({ x: x + PAD_L, y: y + PAD_T, pressure: lv.pressure, temp: lv.temp, dewpoint: null });
        });

        // ── Dewpoint trace (green) ──
        if (withTd.length > 1) {
          ctx.lineWidth = 2;
          ctx.strokeStyle = '#22cc66';
          ctx.beginPath();
          withTd.forEach((lv, i) => {
            const x = tx(lv.dewpoint, lv.pressure);
            const y = py(lv.pressure);
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          });
          ctx.stroke();
        }
        // Draw Td dots — merge into existing hit or push new
        withTd.forEach(lv => {
          const x = tx(lv.dewpoint, lv.pressure);
          const y = py(lv.pressure);
          ctx.fillStyle = '#22cc66';
          ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI*2); ctx.fill();
          const existing = _skewHits.find(h => h.pressure === lv.pressure && h.temp != null);
          if (existing) existing.dewpoint = lv.dewpoint;
          else _skewHits.push({ x: x + PAD_L, y: y + PAD_T, pressure: lv.pressure, temp: null, dewpoint: lv.dewpoint });
        });
        ctx.restore();

        // ── Wind barbs (right margin) ──
        const withW = levels.filter(lv => lv.pressure && lv.wind_dir!=null && lv.wind_spd!=null)
          .sort((a,b)=>a.pressure-b.pressure);
        const barbX = CW - 40;
        ctx.save();
        for (const lv of withW) {
          const y = py(lv.pressure);
          if (y < 0 || y > CH) continue;
          _drawWindBarb(ctx, barbX, y, lv.wind_dir, lv.wind_spd);
        }
        ctx.restore();

        // ── Temperature axis title ──
        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        ctx.font = '10px Inter,sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Temperature (°C)', CW/2, CH + 30);

        ctx.restore(); // undo PAD translate
      }

      function _drawWindBarb(ctx, x, y, dir, spd) {
        if (spd == null || dir == null) return;

        // Standard meteorological wind barb
        // Shaft points toward "from" direction (upwind). Barbs on left when facing upwind.
        const STAFF = 22;   // shaft length (px)
        const BLEN  = 7;    // full barb perpendicular reach
        const BSTEP = 5;    // spacing between barb features along shaft
        const PFILL = 7;    // pennant depth along shaft

        ctx.save();
        ctx.strokeStyle = 'rgba(200,220,255,0.82)';
        ctx.fillStyle   = 'rgba(200,220,255,0.82)';
        ctx.lineWidth   = 1.3;
        ctx.lineCap     = 'square';
        ctx.lineJoin    = 'miter';

        // Calm (<2.5 kt): two concentric circles, no shaft
        if (spd < 2.5) {
          ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI*2); ctx.stroke();
          ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI*2); ctx.stroke();
          ctx.restore();
          return;
        }

        ctx.translate(x, y);
        // After rotation: +x = upwind ("from" direction), +y = right when facing upwind
        ctx.rotate((dir - 90) * Math.PI / 180);

        // Station dot
        ctx.beginPath(); ctx.arc(0, 0, 2, 0, Math.PI*2); ctx.fill();

        // Shaft
        ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(STAFF, 0); ctx.stroke();

        const n50 = Math.floor(spd / 50);
        const n10 = Math.floor((spd % 50) / 10);
        const n5  = Math.round((spd % 10) / 5);

        let p = STAFF; // current position along shaft, working inward from tip

        // ── Pennants (50 kt): filled right-triangle flags at the tip ──
        for (let i = 0; i < n50; i++) {
          ctx.beginPath();
          ctx.moveTo(p,         0);      // front point on shaft
          ctx.lineTo(p - PFILL, 0);      // back point on shaft
          ctx.lineTo(p,        -BLEN);   // apex
          ctx.closePath();
          ctx.fill();
          p -= PFILL + 1;
        }
        if (n50 > 0) p -= 3; // small gap after pennant block

        // ── Full barbs (10 kt): angled lines with slight backward lean ──
        for (let i = 0; i < n10; i++) {
          ctx.beginPath();
          ctx.moveTo(p, 0);
          ctx.lineTo(p + 3, -BLEN);
          ctx.stroke();
          p -= BSTEP;
        }

        // ── Half barb (5 kt) ──
        if (n5) {
          // If this is the only feature, walk it back from tip
          if (n50 === 0 && n10 === 0) p -= BSTEP;
          ctx.beginPath();
          ctx.moveTo(p, 0);
          ctx.lineTo(p + 2, -(BLEN * 0.5));
          ctx.stroke();
        }

        ctx.restore();
      }

      // ── Init (called when view is shown) ─────────────────────
      window.dsaInit = function () {
        if (!_liveLoaded && _mode === 'live') _loadLive();
      };

    })(); // ── DSA IIFE end ──
