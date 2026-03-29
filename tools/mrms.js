    /* ── Vermont MRMS Viewer ── */
    document.getElementById('mrms-back-btn').addEventListener('click', function () {
      document.getElementById('mrms-view').classList.add('hidden');
      document.getElementById('model-explorer-view').classList.remove('hidden');
    });

    let _mrmsMap = null;
    let _mrmsRadarLayer = null;
    let _mrmsWarningsLayer = null;
    let _mrmsLoopTimer = null;
    let _mrmsRefreshTimer = null;
    let _mrmsLoopPlaying = false;
    let _mrmsCurrentProduct = 'reflect';

    // IEM tile URL builder — returns XYZ tile template string
    function mrmsLayerUrl(product) {
      const BASE = 'https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0';
      switch (product) {
        case 'reflect':  return BASE + '/q2-hsr/{z}/{x}/{y}.png';
        case 'echotops': return BASE + '/nexrad-eet/{z}/{x}/{y}.png';
        case 'precip1h': return BASE + '/q2-n1p/{z}/{x}/{y}.png';
        case 'precip24h':return BASE + '/q2-p24h/{z}/{x}/{y}.png';
        default:         return BASE + '/q2-hsr/{z}/{x}/{y}.png';
      }
    }

    // Build a historical reflectivity tile URL for the loop (MRMS SeamlessHSR, 2-min resolution)
    function mrmsLoopUrl(minutesAgo) {
      const d = new Date(Date.now() - minutesAgo * 60000);
      // Round to nearest 2-min interval
      const mins = Math.floor(d.getUTCMinutes() / 2) * 2;
      const pad = n => String(n).padStart(2, '0');
      const ts = d.getUTCFullYear().toString()
        + pad(d.getUTCMonth() + 1)
        + pad(d.getUTCDate())
        + pad(d.getUTCHours())
        + pad(mins);
      return 'https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/mrms::lcref-' + ts + '/{z}/{x}/{y}.png';
    }

    function mrmsTimestampLabel(minutesAgo) {
      if (minutesAgo === 0) return 'LIVE';
      const d = new Date(Date.now() - minutesAgo * 60000);
      const pad = n => String(n).padStart(2, '0');
      return pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ' UTC  (-' + minutesAgo + ' min)';
    }

    function mrmsUpdateTimestamp() {
      const d = new Date();
      const pad = n => String(n).padStart(2, '0');
      const label = pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds()) + ' UTC — LIVE';
      const el = document.getElementById('mrms-timestamp');
      if (el) el.textContent = label;
    }

    function mrmsSetLegend(product) {
      const el = document.getElementById('mrms-legend');
      if (!el) return;
      if (product === 'reflect') {
        el.innerHTML = '<span style="font-size:11px;color:var(--text-muted);margin-right:4px">dBZ</span>'
          + '<div class="mrms-legend-bar">'
          + '<span class="mrms-legend-label">5</span>'
          + '<div class="mrms-legend-gradient" style="background:linear-gradient(to right,#646464,#04e9e7,#019ff4,#0300f4,#02fd02,#01c501,#008e00,#fdf802,#e5bc00,#fd9500,#fd0000,#d40000,#bc0000,#f800fd,#9854c6)"></div>'
          + '<span class="mrms-legend-label">75</span></div>';
      } else if (product === 'echotops') {
        el.innerHTML = '<span style="font-size:11px;color:var(--text-muted);margin-right:4px">Echo Top (kft)</span>'
          + '<div class="mrms-legend-bar">'
          + '<span class="mrms-legend-label">0</span>'
          + '<div class="mrms-legend-gradient" style="background:linear-gradient(to right,#646464,#02fd02,#fdf802,#fd9500,#fd0000,#f800fd)"></div>'
          + '<span class="mrms-legend-label">60+</span></div>';
      } else {
        el.innerHTML = '<span style="font-size:11px;color:var(--text-muted);margin-right:4px">in/hr</span>'
          + '<div class="mrms-legend-bar">'
          + '<span class="mrms-legend-label">0</span>'
          + '<div class="mrms-legend-gradient" style="background:linear-gradient(to right,#d3d3d3,#04e9e7,#019ff4,#02fd02,#fdf802,#fd9500,#fd0000,#9854c6)"></div>'
          + '<span class="mrms-legend-label">4+</span></div>';
      }
    }

    function mrmsInit() {
      if (_mrmsMap) { _mrmsMap.invalidateSize(); return; }

      _mrmsMap = L.map('mrms-map', {
        center: [44.0, -72.7],   // Vermont center
        zoom: 7,
        zoomControl: true,
        attributionControl: true
      });

      // Dark basemap (CartoDB Dark Matter)
      L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; <a href="https://carto.com/">CARTO</a>',
        subdomains: 'abcd',
        maxZoom: 14,
        opacity: 0.85
      }).addTo(_mrmsMap);

      // State/county borders (light)
      L.tileLayer('https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/usstates/{z}/{x}/{y}.png', {
        opacity: 0.5,
        pane: 'overlayPane'
      }).addTo(_mrmsMap);

      // MRMS radar layer
      _mrmsRadarLayer = L.tileLayer(mrmsLayerUrl('reflect'), {
        opacity: 0.85,
        pane: 'overlayPane',
        attribution: 'MRMS &copy; NOAA / <a href="https://mesonet.agron.iastate.edu">IEM</a>'
      }).addTo(_mrmsMap);

      // Labels on top
      L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png', {
        subdomains: 'abcd',
        maxZoom: 14,
        pane: 'overlayPane'
      }).addTo(_mrmsMap);

      mrmsUpdateTimestamp();
      mrmsSetLegend('reflect');

      // Product selector
      document.querySelectorAll('.mrms-product-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
          document.querySelectorAll('.mrms-product-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          _mrmsCurrentProduct = btn.dataset.product;
          mrmsStopLoop();
          if (_mrmsRadarLayer) _mrmsMap.removeLayer(_mrmsRadarLayer);
          _mrmsRadarLayer = L.tileLayer(mrmsLayerUrl(_mrmsCurrentProduct), {
            opacity: 0.85,
            pane: 'overlayPane'
          }).addTo(_mrmsMap);
          mrmsSetLegend(_mrmsCurrentProduct);
          mrmsUpdateTimestamp();
        });
      });

      // Warnings toggle
      document.getElementById('mrms-warnings-chk').addEventListener('change', function () {
        if (this.checked) {
          _mrmsWarningsLayer = L.tileLayer.wms('https://mesonet.agron.iastate.edu/cgi-bin/wms/us/wwa.cgi?', {
            layers: 'warnings_v3',
            format: 'image/png',
            transparent: true,
            opacity: 0.8,
            attribution: 'NWS Warnings &copy; NOAA'
          }).addTo(_mrmsMap);
        } else if (_mrmsWarningsLayer) {
          _mrmsMap.removeLayer(_mrmsWarningsLayer);
          _mrmsWarningsLayer = null;
        }
      });

      // Loop button
      document.getElementById('mrms-loop-btn').addEventListener('click', function () {
        _mrmsLoopPlaying ? mrmsStopLoop() : mrmsStartLoop();
      });

      // Scrubber
      document.getElementById('mrms-scrubber').addEventListener('input', function () {
        const frame = parseInt(this.value);           // 0 = oldest, 10 = now
        const minsAgo = (10 - frame) * 5;
        const url = minsAgo === 0 ? mrmsLayerUrl(_mrmsCurrentProduct) : mrmsLoopUrl(minsAgo);
        if (_mrmsRadarLayer) _mrmsMap.removeLayer(_mrmsRadarLayer);
        _mrmsRadarLayer = L.tileLayer(url, { opacity: 0.85, pane: 'overlayPane' }).addTo(_mrmsMap);
        document.getElementById('mrms-frame-label').textContent = mrmsTimestampLabel(minsAgo);
      });

      // Auto-refresh every 5 minutes
      _mrmsRefreshTimer = setInterval(function () {
        if (!_mrmsLoopPlaying) {
          const url = mrmsLayerUrl(_mrmsCurrentProduct);
          if (_mrmsRadarLayer) _mrmsMap.removeLayer(_mrmsRadarLayer);
          _mrmsRadarLayer = L.tileLayer(url, { opacity: 0.85, pane: 'overlayPane' }).addTo(_mrmsMap);
          mrmsUpdateTimestamp();
        }
      }, 5 * 60 * 1000);
    }

    function mrmsStartLoop() {
      if (_mrmsLoopPlaying) return;
      _mrmsLoopPlaying = true;
      const btn = document.getElementById('mrms-loop-btn');
      const icon = document.getElementById('mrms-loop-icon');
      btn.classList.add('playing');
      icon.className = 'fas fa-stop';
      document.getElementById('mrms-loop-scrubber').classList.add('visible');

      const FRAMES = 11;        // 0–50 min ago in 5-min steps, + live
      const FRAME_MS = 600;     // ms per frame
      let frame = 0;
      const scrubber = document.getElementById('mrms-scrubber');
      const frameLabel = document.getElementById('mrms-frame-label');

      function step() {
        const minsAgo = (FRAMES - 1 - frame) * 5;
        const url = minsAgo === 0 ? mrmsLayerUrl(_mrmsCurrentProduct) : mrmsLoopUrl(minsAgo);
        if (_mrmsRadarLayer) _mrmsMap.removeLayer(_mrmsRadarLayer);
        _mrmsRadarLayer = L.tileLayer(url, { opacity: 0.85, pane: 'overlayPane' }).addTo(_mrmsMap);
        scrubber.value = frame;
        frameLabel.textContent = mrmsTimestampLabel(minsAgo);
        document.getElementById('mrms-timestamp').textContent = mrmsTimestampLabel(minsAgo);
        frame = (frame + 1) % FRAMES;
        _mrmsLoopTimer = setTimeout(step, FRAME_MS);
      }
      step();
    }

    function mrmsStopLoop() {
      if (!_mrmsLoopPlaying) return;
      _mrmsLoopPlaying = false;
      clearTimeout(_mrmsLoopTimer);
      const btn = document.getElementById('mrms-loop-btn');
      const icon = document.getElementById('mrms-loop-icon');
      if (btn) { btn.classList.remove('playing'); }
      if (icon) { icon.className = 'fas fa-play'; }
      const scrubber = document.getElementById('mrms-loop-scrubber');
      if (scrubber) scrubber.classList.remove('visible');
      // Snap back to live
      if (_mrmsMap) {
        if (_mrmsRadarLayer) _mrmsMap.removeLayer(_mrmsRadarLayer);
        _mrmsRadarLayer = L.tileLayer(mrmsLayerUrl(_mrmsCurrentProduct), { opacity: 0.85, pane: 'overlayPane' }).addTo(_mrmsMap);
        mrmsUpdateTimestamp();
      }
    }

