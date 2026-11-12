// ══════════════════════════════════════════════════════════════════
// U.S. UPPER-AIR SOUNDING VIEWER — sounding.js
// Displays SounderPy/MetPy soundings pre-rendered by
// scripts/sounding_data.py (raw data: University of Wyoming archive).
// ══════════════════════════════════════════════════════════════════
(function () {
  'use strict';

  const DATA_DIR      = 'data/soundings/';
  const DEFAULT_WMO   = '72518';   // Albany, NY — closest RAOB to Burlington, VT
  const STORAGE_KEY   = 'snd-station';
  const DAYS          = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  const _dom = {};
  let _index = null;

  function setStatus(type, msg) {
    _dom.status.className   = 'snd-status' + (type ? ' ' + type : '');
    _dom.status.textContent = msg;
  }

  function cycleDate(key) {
    return new Date(Date.UTC(+key.slice(0, 4), +key.slice(4, 6) - 1, +key.slice(6, 8), +key.slice(8, 10)));
  }

  function cycleLabel(key) {
    const d = cycleDate(key);
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    return `${DAYS[d.getUTCDay()]} ${mm}/${dd} ${key.slice(8, 10)}Z`;
  }

  function stationLabel(s) {
    return `${s.name}, ${s.state} (${s.id})`;
  }

  function rawUrl(wmo, key) {
    const date = `${key.slice(0, 4)}-${key.slice(4, 6)}-${key.slice(6, 8)}`;
    return _index.raw_url
      .replace('{date}', date)
      .replace('{hh}', key.slice(8, 10))
      .replace('{wmo}', wmo);
  }

  function showEmpty(msg) {
    _dom.figure.hidden = true;
    _dom.empty.hidden  = false;
    _dom.emptyMsg.innerHTML = msg;
  }

  function populateStations() {
    const byState = {};
    _index.stations.forEach(s => (byState[s.state] = byState[s.state] || []).push(s));
    _dom.stationSel.innerHTML = '';
    Object.keys(byState).sort().forEach(state => {
      const group = document.createElement('optgroup');
      group.label = state;
      byState[state]
        .sort((a, b) => a.name.localeCompare(b.name))
        .forEach(s => group.appendChild(new Option(stationLabel(s), s.wmo)));
      _dom.stationSel.appendChild(group);
    });

    const saved = localStorage.getItem(STORAGE_KEY);
    const has = wmo => wmo && _index.available[wmo];
    _dom.stationSel.value = has(saved) ? saved : has(DEFAULT_WMO) ? DEFAULT_WMO : _index.stations[0].wmo;
  }

  function populateCycles() {
    const cycles = _index.available[_dom.stationSel.value] || [];
    _dom.cycleSel.innerHTML = '';
    cycles.forEach(key => _dom.cycleSel.appendChild(new Option(cycleLabel(key), key)));
    _dom.cycleSel.disabled = !cycles.length;
  }

  function showSounding() {
    const wmo = _dom.stationSel.value;
    const key = _dom.cycleSel.value;
    const station = _index.stations.find(s => s.wmo === wmo);
    const idx = _dom.cycleSel.selectedIndex;
    _dom.prevBtn.disabled = idx >= _dom.cycleSel.options.length - 1;
    _dom.nextBtn.disabled = idx <= 0;
    if (!station || !key) {
      showEmpty('No soundings are available for this station yet.');
      return;
    }

    const src = `${DATA_DIR}${key}/${wmo}.webp`;
    _dom.rawLink.href = rawUrl(wmo, key);
    _dom.rawLink.setAttribute('aria-disabled', 'false');
    _dom.imgLink.href = src;
    _dom.img.alt = `${stationLabel(station)} sounding, ${cycleLabel(key)}`;
    _dom.caption.textContent = `${stationLabel(station)} \u00B7 WMO ${wmo} \u00B7 ${cycleLabel(key)} \u00B7 click to view fullscreen`;
    setStatus('loading', 'Loading sounding\u2026');

    _dom.img.onload = function () {
      _dom.empty.hidden  = true;
      _dom.figure.hidden = false;
      setStatus('good', `${stationLabel(station)} \u2014 ${cycleLabel(key)}`);
    };
    _dom.img.onerror = function () {
      showEmpty('The image for this sounding could not be loaded.');
      setStatus('error', 'Image failed to load.');
    };
    _dom.img.src = src;
  }

  function stepCycle(delta) {
    const i = _dom.cycleSel.selectedIndex + delta;
    if (i < 0 || i >= _dom.cycleSel.options.length) return;
    _dom.cycleSel.selectedIndex = i;
    showSounding();
  }

  async function loadIndex() {
    setStatus('loading', 'Loading station list\u2026');
    try {
      const res = await fetch(`${DATA_DIR}index.json?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      _index = await res.json();
    } catch (e) {
      setStatus('error', 'Sounding archive unavailable.');
      showEmpty('The sounding archive could not be loaded. Soundings are generated after each radiosonde launch; please check back shortly.');
      return;
    }
    if (!_index.stations || !_index.stations.length) {
      setStatus('', '');
      showEmpty('No soundings have been processed yet. They are generated after each radiosonde launch.');
      return;
    }
    _dom.stationSel.disabled = false;
    populateStations();
    populateCycles();
    showSounding();
    _dom.updated.textContent = `Archive updated ${_index.generated.replace('T', ' ')} \u00B7 last ${_index.retention_days} days`;
  }

  function initDom() {
    _dom.backBtn    = document.getElementById('sounding-back-btn');
    _dom.stationSel = document.getElementById('snd-station-select');
    _dom.cycleSel   = document.getElementById('snd-cycle-select');
    _dom.prevBtn    = document.getElementById('snd-prev-btn');
    _dom.nextBtn    = document.getElementById('snd-next-btn');
    _dom.rawLink    = document.getElementById('snd-raw-link');
    _dom.status     = document.getElementById('snd-status');
    _dom.figure     = document.getElementById('snd-figure');
    _dom.img        = document.getElementById('snd-img');
    _dom.imgLink    = document.getElementById('snd-img-link');
    _dom.caption    = document.getElementById('snd-caption');
    _dom.empty      = document.getElementById('snd-empty-state');
    _dom.emptyMsg   = document.getElementById('snd-empty-msg');
    _dom.updated    = document.getElementById('snd-updated');
    _dom.lightbox      = document.getElementById('snd-lightbox');
    _dom.lightboxImg   = document.getElementById('snd-lightbox-img');
    _dom.lightboxClose = document.getElementById('snd-lightbox-close');
  }

  function openLightbox() {
    _dom.lightboxImg.src = _dom.img.src;
    _dom.lightboxImg.alt = _dom.img.alt;
    _dom.lightbox.hidden = false;
    document.body.style.overflow = 'hidden';
  }

  function closeLightbox() {
    _dom.lightbox.hidden = true;
    _dom.lightboxImg.src = '';
    document.body.style.overflow = '';
  }

  function wireEvents() {
    _dom.backBtn.addEventListener('click', function () {
      if (window._showModelExplorer) window._showModelExplorer();
    });
    _dom.stationSel.addEventListener('change', function () {
      localStorage.setItem(STORAGE_KEY, this.value);
      populateCycles();
      showSounding();
    });
    _dom.cycleSel.addEventListener('change', showSounding);
    _dom.prevBtn.addEventListener('click', () => stepCycle(1));
    _dom.nextBtn.addEventListener('click', () => stepCycle(-1));
    // Fullscreen lightbox: plain click opens in-page; ctrl/middle-click still opens the raw image in a new tab
    _dom.imgLink.addEventListener('click', function (e) {
      if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
      e.preventDefault();
      openLightbox();
    });
    _dom.lightboxClose.addEventListener('click', closeLightbox);
    _dom.lightbox.addEventListener('click', function (e) {
      if (e.target === _dom.lightbox) closeLightbox();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !_dom.lightbox.hidden) closeLightbox();
    });
  }

  let _initialized = false;
  window.soundingInit = function () {
    if (_initialized) return;
    _initialized = true;
    initDom();
    wireEvents();
    loadIndex();
  };
})();
