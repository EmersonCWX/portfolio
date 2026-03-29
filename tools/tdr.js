// ── TDR Radar Viewer ─────────────────────────────────────────────────────────
// Data source: https://www.aoml.noaa.gov/ftp/hrd/data/RTradar/
// Products: composites (planview PNGs), swaths (alt-slice PNGs), zoom, tilt
// C-Band/MMR raw data on seb.omao.noaa.gov is NetCDF + AVI only, not web-displayable.

function tdrInit() {
  // Prevent re-init
  if (window._tdrReady) return;
  window._tdrReady = true;

  const TDR_BASE = 'https://www.aoml.noaa.gov/ftp/hrd/data/RTradar/';

  const PROXIES = [
    u => 'https://corsproxy.io/?url='             + encodeURIComponent(u),
    u => 'https://api.allorigins.win/raw?url='    + encodeURIComponent(u),
    u => 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(u),
    u => 'https://thingproxy.freeboard.io/fetch/' + u,
  ];

  async function _fetchText(url) {
    const _one = async (fetchUrl) => {
      const ctrl = new AbortController();
      const tid  = setTimeout(() => ctrl.abort(), 9000);
      try {
        const r = await fetch(fetchUrl, { cache: 'no-store', signal: ctrl.signal });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return await r.text();
      } finally { clearTimeout(tid); }
    };
    const candidates = [url, ...PROXIES.map(p => p(url))];
    try { return await Promise.any(candidates.map(u => _one(u))); }
    catch (_) { throw new Error('all sources failed for ' + url); }
  }

  // Parse Apache-style directory listing → [{name, isDir}]
  function _parseDir(html) {
    const entries = [];
    const seen    = new Set();
    const re      = /href="([^"?#][^"]*?)"/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
      let raw = m[1];
      if (raw === '../' || raw === '/' || raw.startsWith('?') || raw.startsWith('http')) continue;
      const isDir = raw.endsWith('/');
      const name  = raw.replace(/\/$/, '');
      if (!seen.has(name)) { seen.add(name); entries.push({ name, isDir }); }
    }
    return entries;
  }

  // Parse mission folder name e.g. "20251028H1" or "20260202N1"
  function _parseMission(folder) {
    const m = folder.match(/^(\d{4})(\d{2})(\d{2})([A-Za-z])(\d+)$/);
    if (!m) return null;
    const [, y, mo, d, ac, num] = m;
    const acMap = { H: 'N43RF', N: 'N42RF', G: 'G-IV', I: 'N43RF/B' };
    return {
      id:       folder,
      dateStr:  `${y}-${mo}-${d}`,
      dateVal:  parseInt(y + mo + d, 10),
      aircraft: acMap[ac.toUpperCase()] || ac.toUpperCase(),
      num:      parseInt(num, 10),
    };
  }

  // ── DOM refs ──────────────────────────────────────────────────────────────
  const statusEl      = document.getElementById('tdr-status');
  const missionList   = document.getElementById('tdr-mission-list');
  const imgContainer  = document.getElementById('tdr-img-container');
  const imgEl         = document.getElementById('tdr-radar-img');
  const imgNav        = document.getElementById('tdr-img-nav');
  const imgLabel      = document.getElementById('tdr-img-label');
  const imgCount      = document.getElementById('tdr-img-count');
  const placeholder   = document.getElementById('tdr-placeholder');
  const missionHeader = document.getElementById('tdr-mission-header');

  let _year     = '';
  let _missions = [];
  let _sel      = null;   // selected mission object
  let _product  = 'composites';
  let _images   = [];
  let _idx      = 0;

  // ── Helpers ───────────────────────────────────────────────────────────────
  function _setStatus(msg, isErr) {
    statusEl.innerHTML  = msg;
    statusEl.className  = isErr ? 'tdr-status tdr-status-err' : 'tdr-status';
    statusEl.style.display = '';
    missionList.innerHTML = '';
  }

  function _showImage(idx) {
    if (!_images.length) return;
    _idx = Math.max(0, Math.min(idx, _images.length - 1));
    const url  = _images[_idx];
    const name = url.split('/').pop().replace(/_/g, ' ').replace('.png', '');
    imgEl.src       = url;
    imgLabel.textContent = name;
    imgCount.textContent = `${_idx + 1} / ${_images.length}`;
    imgContainer.style.display = 'flex';
    placeholder.style.display  = 'none';
    imgNav.style.display       = _images.length > 1 ? '' : 'none';
  }

  // ── Load a year's mission list ────────────────────────────────────────────
  async function _loadYear(year) {
    _year     = year;
    _missions = [];
    _sel      = null;
    imgContainer.style.display = 'none';
    placeholder.style.display  = '';
    missionHeader.textContent  = '';
    _setStatus('Scanning ' + year + ' flight archive&hellip;');

    try {
      const html  = await _fetchText(TDR_BASE + year + '/');
      const dirs  = _parseDir(html).filter(e => e.isDir);
      _missions   = dirs
        .map(e => _parseMission(e.name))
        .filter(Boolean)
        .sort((a, b) => b.dateVal - a.dateVal || b.num - a.num);

      if (!_missions.length) {
        _setStatus('No radar missions found for ' + year + '.', true);
        return;
      }

      statusEl.style.display = 'none';
      missionList.innerHTML  = '';
      _missions.forEach(m => {
        const el = document.createElement('div');
        el.className = 'tdr-mission-item';
        el.innerHTML =
          `<div class="tdr-mi-date">${m.dateStr}</div>` +
          `<div class="tdr-mi-ac">${m.aircraft} &mdash; Flight ${m.num}</div>`;
        el.addEventListener('click', () => _selectMission(m, el));
        missionList.appendChild(el);
      });
    } catch (err) {
      _setStatus('Failed to load ' + year + ': ' + err.message, true);
    }
  }

  // ── Select mission + load product ────────────────────────────────────────
  async function _selectMission(m, el) {
    document.querySelectorAll('.tdr-mission-item').forEach(e => e.classList.remove('active'));
    el.classList.add('active');
    _sel = m;
    missionHeader.textContent = m.dateStr + '  ·  ' + m.aircraft + '  ·  Flight ' + m.num;
    await _loadProduct();
  }

  async function _loadProduct() {
    if (!_sel) return;
    imgContainer.style.display = 'none';
    placeholder.style.display  = '';
    placeholder.textContent    = 'Loading ' + _product + '\u2026';

    const subUrl = TDR_BASE + _year + '/' + _sel.id + '/' + _product + '/';
    try {
      const html   = await _fetchText(subUrl);
      const files  = _parseDir(html)
        .filter(e => !e.isDir && /\.(png|gif|jpg)$/i.test(e.name))
        .map(e => subUrl + e.name)
        .sort();

      if (!files.length) {
        placeholder.textContent = 'No images found in \u201c' + _product + '\u201d for this mission.';
        return;
      }
      _images = files;
      _showImage(0);
    } catch (err) {
      placeholder.textContent = 'Load failed: ' + err.message;
    }
  }

  // ── Year buttons ──────────────────────────────────────────────────────────
  document.querySelectorAll('.tdr-year-btn').forEach(btn => {
    btn.addEventListener('click', function () {
      document.querySelectorAll('.tdr-year-btn').forEach(b => b.classList.remove('active'));
      this.classList.add('active');
      _loadYear(this.dataset.year);
    });
  });

  // ── Product buttons ───────────────────────────────────────────────────────
  document.querySelectorAll('.tdr-product-btn').forEach(btn => {
    btn.addEventListener('click', function () {
      document.querySelectorAll('.tdr-product-btn').forEach(b => b.classList.remove('active'));
      this.classList.add('active');
      _product = this.dataset.product;
      _loadProduct();
    });
  });

  // ── Image navigation ──────────────────────────────────────────────────────
  document.getElementById('tdr-prev').addEventListener('click', () => _showImage(_idx - 1));
  document.getElementById('tdr-next').addEventListener('click', () => _showImage(_idx + 1));

  // Keyboard left/right when TDR view is visible
  document.addEventListener('keydown', e => {
    if (document.getElementById('tdr-view').classList.contains('hidden')) return;
    if (e.key === 'ArrowLeft')  _showImage(_idx - 1);
    if (e.key === 'ArrowRight') _showImage(_idx + 1);
  });

  // ── Auto-load most recent season ─────────────────────────────────────────
  const now     = new Date();
  const month   = now.getMonth() + 1; // 1-based
  // Hurricane season peaks Jun-Nov; if off-season use previous year
  const defYear = (month < 6) ? String(now.getFullYear() - 1) : String(now.getFullYear());
  const initBtn = document.querySelector('.tdr-year-btn[data-year="' + defYear + '"]')
                || document.querySelector('.tdr-year-btn');
  if (initBtn) { initBtn.classList.add('active'); _loadYear(initBtn.dataset.year); }
}
