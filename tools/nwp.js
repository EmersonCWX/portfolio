    // ── NWP Model Sandbox ────────────────────────────────────────────────────
    let _nwpInited          = false;
    let _nwpMap             = null;
    let _nwpHrrrLayer       = null;
    let _nwpCurrentProduct  = 'refd';
    let _nwpCurrentFhr      = 0;
    let _nwpCurrentRun      = 0;
    let _nwpLoopPlaying     = false;
    let _nwpLoopTimer       = null;



    function nwpRunTimestamp(runIndex) {
      var d = new Date();
      d.setUTCHours(d.getUTCHours() - 1 - runIndex, 0, 0, 0);
      var pad = function(n) { return String(n).padStart(2, '0'); };
      return '' + d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) + pad(d.getUTCHours()) + '00';
    }

    function nwpTileUrl(product, fhr) {
      var fmin  = String(fhr * 60).padStart(4, '0');
      var param = product === 'refp' ? 'REFP' : 'REFD';
      var runKey = _nwpCurrentRun === 0 ? '0' : nwpRunTimestamp(_nwpCurrentRun);
      return 'https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/hrrr::' + param + '-F' + fmin + '-' + runKey + '/{z}/{x}/{y}.png';
    }

    function nwpFhrText(fhr) {
      return 'F+' + String(fhr).padStart(2, '0') + 'h';
    }

    function nwpRunLabel() {
      var d = new Date();
      d.setUTCHours(d.getUTCHours() - 1 - _nwpCurrentRun, 0, 0, 0);
      return String(d.getUTCHours()).padStart(2, '0') + 'Z';
    }

    function nwpUpdateTimestamp(fhr) {
      var lbl   = document.getElementById('nwp-run-dd-label');
      var fhrEl = document.getElementById('nwp-fhr-display');
      if (lbl)   lbl.textContent   = nwpRunLabel() + ' Run';
      if (fhrEl) fhrEl.textContent = '\u00a0\u00b7\u00a0' + nwpFhrText(fhr);
    }

    function nwpHrrrMapInit() {
      if (_nwpMap) { _nwpMap.invalidateSize(); nwpUpdateTimestamp(_nwpCurrentFhr); return; }

      _nwpMap = L.map('nwp-map', {
        center: [44.0, -72.7], zoom: 7, zoomControl: true, attributionControl: true
      });

      L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; <a href="https://carto.com/">CARTO</a>',
        subdomains: 'abcd', maxZoom: 14, opacity: 0.85
      }).addTo(_nwpMap);

      L.tileLayer('https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/usstates/{z}/{x}/{y}.png', {
        opacity: 0.5, pane: 'overlayPane'
      }).addTo(_nwpMap);

      _nwpHrrrLayer = L.tileLayer(nwpTileUrl('refd', 0), {
        opacity: 0.85, pane: 'overlayPane',
        attribution: 'HRRR &copy; NOAA / <a href="https://mesonet.agron.iastate.edu">IEM</a>'
      }).addTo(_nwpMap);

      L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png', {
        subdomains: 'abcd', maxZoom: 14, pane: 'overlayPane'
      }).addTo(_nwpMap);

      nwpUpdateTimestamp(0);
    }

    function nwpSetHrrrLayer() {
      if (!_nwpMap) return;
      if (_nwpHrrrLayer) _nwpMap.removeLayer(_nwpHrrrLayer);
      _nwpHrrrLayer = L.tileLayer(nwpTileUrl(_nwpCurrentProduct, _nwpCurrentFhr), {
        opacity: 0.85, pane: 'overlayPane'
      }).addTo(_nwpMap);
    }

    function nwpStartLoop() {
      if (_nwpLoopPlaying) return;
      _nwpLoopPlaying = true;
      var btn  = document.getElementById('nwp-loop-btn');
      var icon = document.getElementById('nwp-loop-icon');
      if (btn)  btn.classList.add('playing');
      if (icon) icon.className = 'fas fa-stop';
      (function step() {
        _nwpCurrentFhr = (_nwpCurrentFhr + 1) % 19;
        document.getElementById('nwp-fhr-slider').value = _nwpCurrentFhr;
        document.getElementById('nwp-fhr-label').textContent = nwpFhrText(_nwpCurrentFhr);
        nwpSetHrrrLayer();
        nwpUpdateTimestamp(_nwpCurrentFhr);
        _nwpLoopTimer = setTimeout(step, 800);
      })();
    }

    function nwpStopLoop() {
      _nwpLoopPlaying = false;
      clearTimeout(_nwpLoopTimer);
      var btn  = document.getElementById('nwp-loop-btn');
      var icon = document.getElementById('nwp-loop-icon');
      if (btn)  btn.classList.remove('playing');
      if (icon) icon.className = 'fas fa-play';
    }

    function nwpInit() {
      if (_nwpInited) {
        // Re-entered: just invalidate if HRRR is showing
        if (_nwpMap && document.getElementById('nwp-hrrr-panel').classList.contains('active')) {
          setTimeout(function () { _nwpMap.invalidateSize(); }, 100);
        }
        return;
      }
      _nwpInited = true;

      // Run dropdown
      (function () {
        var now  = new Date();
        var menu = document.getElementById('nwp-run-dd-menu');
        var ddBtn = document.getElementById('nwp-run-dd-btn');
        var dd   = document.getElementById('nwp-run-dd');

        for (var i = 0; i < 10; i++) {
          (function (offset) {
            var run = new Date(now);
            run.setUTCHours(now.getUTCHours() - 1 - offset, 0, 0, 0);
            var hz   = String(run.getUTCHours()).padStart(2, '0') + 'Z';
            var item = document.createElement('button');
            item.className = 'nwp-run-dd-item' + (offset === 0 ? ' active' : '');
            if (offset === 0) {
              item.innerHTML = hz
                + '<span style="font-size:10px;color:var(--text-muted);margin-left:4px">Latest</span>';
            } else {
              item.textContent = hz;
            }
            item.addEventListener('click', function () {
              document.querySelectorAll('.nwp-run-dd-item').forEach(function (it) { it.classList.remove('active'); });
              item.classList.add('active');
              dd.classList.remove('open');
              nwpStopLoop();
              _nwpCurrentRun = offset;
              _nwpCurrentFhr = 0;
              document.getElementById('nwp-fhr-slider').value = 0;
              document.getElementById('nwp-fhr-label').textContent = nwpFhrText(0);
              nwpSetHrrrLayer();
              nwpUpdateTimestamp(0);
            });
            menu.appendChild(item);
          })(i);
        }

        ddBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          dd.classList.toggle('open');
        });

        document.addEventListener('click', function () {
          dd.classList.remove('open');
        });
      })();

      // HRRR product buttons
      document.querySelectorAll('#nwp-product-bar .mrms-product-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
          document.querySelectorAll('#nwp-product-bar .mrms-product-btn').forEach(function (b) { b.classList.remove('active'); });
          btn.classList.add('active');
          nwpStopLoop();
          _nwpCurrentProduct = btn.dataset.product;
          nwpSetHrrrLayer();
        });
      });

      // Forecast hour slider
      document.getElementById('nwp-fhr-slider').addEventListener('input', function () {
        _nwpCurrentFhr = parseInt(this.value);
        document.getElementById('nwp-fhr-label').textContent = nwpFhrText(_nwpCurrentFhr);
        nwpSetHrrrLayer();
        nwpUpdateTimestamp(_nwpCurrentFhr);
      });

      // Loop button
      document.getElementById('nwp-loop-btn').addEventListener('click', function () {
        _nwpLoopPlaying ? nwpStopLoop() : nwpStartLoop();
      });

      // Default: init HRRR map
      setTimeout(nwpHrrrMapInit, 100);
    }

