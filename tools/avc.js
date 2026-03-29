    // ── AVC back button ──
    document.getElementById('avc-back-btn').addEventListener('click', function () {
      document.getElementById('avc-view').classList.add('hidden');
      document.getElementById('model-explorer-view').classList.remove('hidden');
    });

    // ── AVC (Aurora Visibility Calculator) ──
    let avcChart = null;
    let avcLoaded = false;
    let avcLat = 44.4, avcLon = -72.0, avcCloudCover = 0, avcBz = 0;

    function avcInit() {
      if (avcLoaded) return;
      if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
          pos => { avcLat = pos.coords.latitude; avcLon = pos.coords.longitude; avcStartLoad(); },
          ()  => { avcStartLoad(); }
        );
      } else { avcStartLoad(); }
    }

    function avcStartLoad() {
      avcFetchLocation();
      avcFetchWeather();
      avcLoadData();
    }

    async function avcFetchLocation() {
      const el = document.getElementById('avc-loc');
      el.textContent = `(${avcLat.toFixed(2)}°N, ${Math.abs(avcLon).toFixed(2)}°W)`;
      try {
        const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${avcLat}&lon=${avcLon}&zoom=10&addressdetails=1`, { headers: { 'Accept-Language': 'en' } });
        if (!r.ok) return;
        const d = await r.json();
        if (d.address) {
          const a = d.address;
          let city = a.city || a.town || a.village || a.county || d.name || 'Unknown';
          let state = a.state || '';
          let loc = city + (state && state !== city ? `, ${state}` : '');
          el.textContent = `${loc} (${avcLat.toFixed(2)}°N, ${Math.abs(avcLon).toFixed(2)}°W)`;
        }
      } catch(e) {}
    }

    async function avcFetchWeather() {
      try {
        const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${avcLat}&longitude=${avcLon}&current=cloud_cover&forecast_days=1`);
        if (!r.ok) return;
        const d = await r.json();
        avcCloudCover = d.current.cloud_cover || 0;
        const desc = avcCloudDesc(avcCloudCover);
        document.getElementById('avc-cloud').textContent = `${avcCloudCover}% ${desc}`;
      } catch(e) {
        document.getElementById('avc-cloud').textContent = '-- (unavailable)';
      }
    }

    function avcCloudDesc(c) {
      if (c <= 10) return '(Clear)';
      if (c <= 25) return '(Mostly Clear)';
      if (c <= 50) return '(Partly Cloudy)';
      if (c <= 75) return '(Mostly Cloudy)';
      if (c <= 90) return '(Overcast)';
      return '(Dense Overcast)';
    }

    async function avcLoadData() {
      const loadEl    = document.getElementById('avc-loading');
      const errEl     = document.getElementById('avc-error');
      const contentEl = document.getElementById('avc-content');
      try {
        loadEl.style.display = 'block';
        errEl.style.display  = 'none';

        const [kpRes, magRes] = await Promise.all([
          fetch('https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json'),
          fetch('https://services.swpc.noaa.gov/json/rtsw/rtsw_mag_1m.json')
        ]);
        if (!kpRes.ok || !magRes.ok) throw new Error('NOAA fetch failed');

        // noaa-planetary-k-index.json returns [[header], [time_tag, kp, ...], ...]
        const kpRaw  = await kpRes.json();
        const kpRows = kpRaw.slice(1); // drop header row
        const magData = await magRes.json();

        // Bz
        const latestMag = magData[magData.length - 1];
        avcBz = -(Array.isArray(latestMag?.bz_gsm) ? latestMag.bz_gsm[0] : (latestMag?.bz_gsm || 0));
        const bzEl = document.getElementById('avc-bz');
        bzEl.textContent = avcBz.toFixed(1) + ' nT';
        bzEl.style.color = avcBz < 0 ? '#ff4d4d' : '#52d452';

        // Build 3-hourly Kp chart for last 24 h (last 8 entries)
        const now = new Date();
        const chartRows  = kpRows.slice(-8);
        const kpIndexData = chartRows.map(r => Math.round(parseFloat(r[1]) * 10) / 10);
        const timeLabels  = chartRows.map(r => r[0].split(' ')[1].substring(0, 5));

        const currentKp = parseFloat(kpRows[kpRows.length - 1]?.[1] || 0);

        // Update Kp display
        const kpEl = document.getElementById('avc-kp');
        kpEl.textContent = currentKp.toFixed(1);

        // Rating
        const ratingEl = document.getElementById('avc-rating');
        let rating = 'Unfavorable', color = '#52d452';
        if (currentKp <= 1 && avcCloudCover >= 80) {
          rating = "Don't even look - just go home";
          color = '#999';
        } else {
          const bzBoost = avcBz < -5 ? 1.5 : avcBz < -3 ? 1.2 : avcBz < 0 ? 1.0 : 0.7;
          const effKp = currentKp * bzBoost;
          const lat = Math.abs(avcLat);
          if (lat >= 60) {
            if (effKp >= 8) { rating='Spectacular'; color='#8b0000'; }
            else if (effKp >= 5) { rating='Excellent - Aurora Likely'; color='#ffd500'; }
            else if (effKp >= 3) { rating='Good - May Be Visible'; color='#52d452'; }
          } else if (lat >= 50) {
            if (effKp >= 8) { rating='Excellent'; color='#8b0000'; }
            else if (effKp >= 5) { rating='Moderate - May Be Visible'; color='#ff9500'; }
            else if (effKp >= 4) { rating='Fair - Unlikely'; color='#ffd500'; }
          } else if (lat >= 40) {
            if (effKp >= 8) { rating='Excellent - Likely Visible'; color='#8b0000'; }
            else if (effKp >= 6) { rating='Good - May Be Visible'; color='#ff4444'; }
            else if (effKp >= 4) { rating='Fair - Unlikely'; color='#ff9500'; }
          } else if (lat >= 30) {
            if (effKp >= 9) { rating='Fair - May Be Visible'; color='#8b0000'; }
            else if (effKp >= 7) { rating='Very Poor - Unlikely'; color='#ff4444'; }
          } else {
            if (effKp >= 9) { rating='Very Poor - May Be Visible'; color='#8b0000'; }
            else { rating='Extremely Unfavorable'; }
          }
          // cloud penalty
          if (avcCloudCover >= 80) rating = rating.replace('Excellent','Fair').replace('Good','Poor').replace('Moderate','Very Poor').replace('Likely','Unlikely');
          else if (avcCloudCover >= 60) rating = rating.replace('Excellent','Moderate').replace('Good','Fair');
        }
        ratingEl.textContent = rating;
        ratingEl.style.color = color;
        kpEl.style.color = color;

        // Highlight Kp scale
        document.querySelectorAll('.avc-kp-cell').forEach(cell => {
          cell.classList.remove('scale-active');
          const mn = parseFloat(cell.dataset.min), mx = parseFloat(cell.dataset.max);
          if (currentKp >= mn && currentKp < mx) cell.classList.add('scale-active');
        });

        // Chart
        if (avcChart) avcChart.destroy();
        const tinyScreen = window.innerWidth <= 480;
        const ctx = document.getElementById('avc-chart').getContext('2d');
        avcChart = new Chart(ctx, {
          type: 'line',
          data: {
            labels: timeLabels,
            datasets: [{ label: 'Kp Index', data: kpIndexData, borderColor: '#b07ee0', backgroundColor: 'rgba(176,126,224,0.1)', borderWidth: 2, tension: 0.3, fill: true, pointRadius: tinyScreen ? 2 : 3, pointBackgroundColor: '#b07ee0', pointBorderColor: 'var(--teal)' }]
          },
          options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { labels: { color: '#e8e8e8', font: { size: tinyScreen ? 8 : 11 } } } },
            scales: {
              x: { grid: { color: 'rgba(255,255,255,0.07)' }, ticks: { color: 'rgba(255,255,255,0.5)', font: { size: tinyScreen ? 7 : 10 }, maxRotation: 45 } },
              y: { beginAtZero: true, max: 9, grid: { color: 'rgba(255,255,255,0.07)' }, ticks: { color: 'rgba(255,255,255,0.5)', font: { size: tinyScreen ? 7 : 10 } }, title: { display: true, text: 'Kp Index', color: '#e8e8e8', font: { size: tinyScreen ? 8 : 11 } } }
            }
          }
        });

        document.getElementById('avc-update-time').textContent = now.toISOString().split('T')[1].substring(0,8) + ' UTC';
        contentEl.style.display = 'block';
        loadEl.style.display = 'none';
        avcLoaded = true;

      } catch(err) {
        errEl.textContent = 'Error loading data: ' + err.message;
        errEl.style.display = 'block';
        loadEl.style.display = 'none';
      }
    }

