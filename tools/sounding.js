// ══════════════════════════════════════════════════════════════════
// NOAA RADIOSONDE / ATMOSPHERIC SOUNDING VIEWER  — sounding.js
// Skew-T Log-P, hodograph, thermodynamic indices
// Data: University of Wyoming Upper Air Archive (via CORS proxy)
// ══════════════════════════════════════════════════════════════════
(function () {
  'use strict';

  // ══ Skew-T display constants ════════════════════════════════════
  const SKEW    = 45;    // °C skew per log10 pressure decade
  const P_BOT   = 1050;
  const P_TOP   = 100;
  const TSK_MIN = -50;   // left edge in skewed-T space
  const TSK_MAX = 60;    // right edge
  const CW = 720, CH = 720;          // canvas logical size (px)
  const PL = 50, PR = 60, PT = 20, PB = 30;  // plot padding

  // ══ Physical constants ══════════════════════════════════════════
  const Rd = 287.05;
  const Rv = 461.5;
  const cp = 1005.7;
  const Lv = 2.501e6;
  const g  = 9.80665;

  // ══ Station database (WMO, name, NWS WFO office) ════════════════
  // nws: NWS WFO code used for api.weather.gov MAN/SGL products.
  //      null = no active balloon launch confirmed via NWS API.
  const STATIONS = [
    { wmo: '74560', name: 'Burlington, VT (KBTV)',       nws: null  },
    { wmo: '72501', name: 'Albany, NY (KALB)',            nws: 'ALY' },
    { wmo: '72518', name: 'Upton, NY (KOKX)',             nws: 'OKX' },
    { wmo: '74646', name: 'Caribou, ME (KCAR)',           nws: 'CAR' },
    { wmo: '72403', name: 'Amarillo, TX (KAMA)',          nws: 'AMA' },
    { wmo: '72228', name: 'Birmingham, AL (KBMX)',        nws: 'BMX' },
    { wmo: '72776', name: 'Boise, ID (KBOI)',             nws: 'BOI' },
    { wmo: '72712', name: 'Billings, MT (KBLX)',          nws: null  },
    { wmo: '72357', name: 'Norman, OK (KOUN)',            nws: 'OUN' },
    { wmo: '72558', name: 'Omaha/Valley, NE (KOAX)',      nws: 'OAX' },
    { wmo: '72549', name: 'Lincoln, IL (KILX)',           nws: 'ILX' },
    { wmo: '72649', name: 'Chanhassen, MN (KMPX)',        nws: 'MPX' },
    { wmo: '72634', name: 'Rapid City, SD (KUNR)',        nws: 'UNR' },
    { wmo: '72388', name: 'San Diego, CA (KNKX) ⚠',      nws: null  },
    { wmo: '72376', name: 'El Paso, TX (KEPZ)',           nws: 'EPZ' },
    { wmo: '72469', name: 'Midland, TX (KMAF)',           nws: 'MAF' },
    { wmo: '72765', name: 'Spokane, WA (KOTX)',           nws: 'OTX' },
    { wmo: '72451', name: 'Denver, CO (KDNR)',            nws: null  },
    { wmo: '72681', name: 'Riverton, WY (KRIW)',          nws: 'RIW' },
    { wmo: '72317', name: 'Little Rock, AR (KLZK)',       nws: 'LZK' },
    { wmo: '72363', name: 'Shreveport, LA (KSHV)',        nws: 'SHV' },
    { wmo: '72235', name: 'Jackson, MS (KJAN)',           nws: 'JAN' },
    { wmo: '72208', name: 'Tallahassee, FL (KTLH)',       nws: null  },
    { wmo: '72215', name: 'Tampa Bay, FL (KTBW)',         nws: 'TBW' },
    { wmo: '72327', name: 'Nashville, TN (KOHX)',         nws: 'OHX' },
    { wmo: '72330', name: 'Memphis, TN (KNQA)',           nws: null  },
    { wmo: '72230', name: 'Slidell, LA (KLIX)',           nws: 'LIX' },
    { wmo: '72493', name: 'Pittsburgh, PA (KPBZ)',        nws: 'PBZ' },
    { wmo: '72665', name: 'Topeka, KS (KTOP)',            nws: 'TOP' },
    { wmo: '72251', name: 'Miami, FL (KMFL)',             nws: 'MFL' },
    { wmo: '72211', name: 'Key West, FL (KEYW)',          nws: 'KEY' },
    { wmo: '72492', name: 'Gray, ME (KGYX)',              nws: 'GYX' },
    { wmo: '72526', name: 'Wallops Is, VA (KWAL)',        nws: null  },
    { wmo: '72528', name: 'Sterling, VA (KIAD) ⚠',       nws: null  },
    { wmo: '72764', name: 'Medford, OR (KMFR)',           nws: 'MFR' },
    { wmo: '72797', name: 'Oakland, CA (KOAK) ⚠',        nws: null  },
    { wmo: '72201', name: 'Corpus Christi, TX (KCRP)',    nws: 'CRP' },
  ];

  // ══ Module state ════════════════════════════════════════════════
  const _dom = {};
  let _skewHits = [];

  // ══ Thermodynamics ══════════════════════════════════════════════

  // Saturation vapor pressure (hPa) — Bolton 1980
  function es(T) {
    return 6.112 * Math.exp(17.67 * T / (T + 243.5));
  }

  // Saturation mixing ratio (g/kg)
  function ws(T, p) {
    const e = es(T);
    return 1000 * (Rd / Rv) * e / (p - e);
  }

  // LCL temperature (°C)
  function tlcl(T, Td) {
    return Td - (0.212 + 1.571e-3 * Td - 4.36e-4 * (T - Td)) * (T - Td);
  }

  // LCL pressure (hPa)
  function plcl(T, Td, p) {
    const tl = tlcl(T, Td);
    return p * Math.pow((tl + 273.15) / (T + 273.15), cp / Rd);
  }

  // Dry parcel temperature at pressure p
  function dryParcel(T0, p0, p) {
    const theta = (T0 + 273.15) * Math.pow(1000 / p0, Rd / cp);
    return theta * Math.pow(p / 1000, Rd / cp) - 273.15;
  }

  // Moist adiabatic lapse rate dT/dp (K/hPa) — positive value
  function malr(T, p) {
    const TK = T + 273.15;
    const rs  = ws(T, p) / 1000; // kg/kg
    const a   = Lv * rs / (Rd * TK);
    const b   = Lv * Lv * rs / (cp * Rv * TK * TK);
    return (Rd * TK / (cp * p)) * ((1 + a) / (1 + b));
  }

  // Lift moist parcel from (T_start °C, p_start hPa) to p_end hPa — RK4
  function liftMoist(T0, p_start, p_end, steps) {
    steps = steps || 20;
    if (p_start === p_end) return T0;
    const dp = (p_end - p_start) / steps;
    let T = T0, p = p_start;
    for (let i = 0; i < steps; i++) {
      const k1 = malr(T,                     p            );
      const k2 = malr(T + 0.5 * k1 * dp,    p + 0.5 * dp );
      const k3 = malr(T + 0.5 * k2 * dp,    p + 0.5 * dp );
      const k4 = malr(T +       k3 * dp,    p +       dp  );
      T += (dp / 6) * (k1 + 2 * k2 + 2 * k3 + k4);
      p += dp;
    }
    return T;
  }

  // Pressure-log-weighted interpolation
  function interpField(snd, p_target, field) {
    for (let i = 0; i < snd.length - 1; i++) {
      const a = snd[i], b = snd[i + 1];
      if (a.pres >= p_target && b.pres <= p_target) {
        if (a[field] == null || b[field] == null) return null;
        const f = (Math.log(a.pres) - Math.log(p_target)) /
                  (Math.log(a.pres) - Math.log(b.pres));
        return a[field] + f * (b[field] - a[field]);
      }
    }
    return null;
  }

  // Surface-based parcel trace — returns [{pres, temp}] array
  function parcelTrace(snd) {
    if (!snd || snd.length === 0) return [];
    const sfc = snd[0];
    if (sfc.temp == null || sfc.dwpt == null) return [];

    const T0   = sfc.temp, Td0 = sfc.dwpt, p0 = sfc.pres;
    const pLCL = Math.min(plcl(T0, Td0, p0), p0);
    const tLCL = tlcl(T0, Td0);
    const trace = [];

    for (const lvl of snd) {
      const p = lvl.pres;
      if (p > p0 + 0.5) continue;
      let T;
      if (p >= pLCL) {
        T = dryParcel(T0, p0, p);
      } else {
        T = liftMoist(tLCL, pLCL, p, 40);
      }
      trace.push({ pres: p, temp: T });
    }
    return trace;
  }

  // CAPE / CIN (J/kg) using CAPE = Rd ∫ (Tp - Te) d(lnp) layer sum
  function capeCin(snd) {
    const trace = parcelTrace(snd);
    if (trace.length < 2) return { cape: 0, cin: 0, lfc: null, el: null };

    let cape = 0, cin = 0, lfc = null, el = null;

    for (let i = 1; i < trace.length; i++) {
      const ptA = trace[i - 1], ptB = trace[i];
      const envA = interpField(snd, ptA.pres, 'temp');
      const envB = interpField(snd, ptB.pres, 'temp');
      if (envA == null || envB == null) continue;

      const Tp_mid = (ptA.temp + ptB.temp) / 2;
      const Te_mid = (envA     + envB)     / 2;
      const dlnP   = Math.log(ptA.pres / ptB.pres); // > 0 going upward
      const contrib = Rd * (Tp_mid - Te_mid) * dlnP;

      if (contrib > 0) {
        cape += contrib;
        if (lfc == null) lfc = ptB.pres;
        el = ptB.pres;
      } else if (lfc == null) {
        cin += contrib;
      }
    }
    // Only report CIN when an LFC exists; without one the whole-column integral
    // is meteorologically meaningless and explodes to −5000+ with BUFR's many levels.
    return { cape: Math.max(0, cape), cin: lfc !== null ? Math.min(0, cin) : 0, lfc, el };
  }

  // Stability indices
  function kIndex(snd) {
    const t850 = interpField(snd, 850, 'temp');
    const t700 = interpField(snd, 700, 'temp');
    const t500 = interpField(snd, 500, 'temp');
    const d850 = interpField(snd, 850, 'dwpt');
    const d700 = interpField(snd, 700, 'dwpt');
    if ([t850, t700, t500, d850, d700].some(v => v == null)) return null;
    return (t850 - t500) + d850 - (t700 - d700);
  }

  function totalTotals(snd) {
    const t850 = interpField(snd, 850, 'temp');
    const t500 = interpField(snd, 500, 'temp');
    const d850 = interpField(snd, 850, 'dwpt');
    if ([t850, t500, d850].some(v => v == null)) return null;
    return (t850 + d850) - 2 * t500;
  }

  function liftedIndex(snd) {
    const t500 = interpField(snd, 500, 'temp');
    const trace = parcelTrace(snd);
    if (t500 == null || trace.length < 2) return null;
    const pt = trace.slice().reverse().find(t => t.pres <= 500 + 5);
    if (!pt) return null;
    return t500 - pt.temp;
  }

  function showalterIndex(snd) {
    const t500 = interpField(snd, 500, 'temp');
    const t850 = interpField(snd, 850, 'temp');
    const d850 = interpField(snd, 850, 'dwpt');
    if ([t500, t850, d850].some(v => v == null)) return null;
    const pLCL = plcl(t850, d850, 850); // pressure at LCL (< 850)
    const tLCL = tlcl(t850, d850);
    // If LCL is below 500 hPa (pLCL > 500): lift moist from LCL to 500
    // If LCL is above 500 hPa (pLCL < 500): still on dry adiabat at 500
    const parcel500 = pLCL > 500
      ? liftMoist(tLCL, pLCL, 500, 50)
      : dryParcel(t850, 850, 500);
    return t500 - parcel500;
  }

  function precipWater(snd) {
    let pw = 0;
    for (let i = 1; i < snd.length; i++) {
      const a = snd[i - 1], b = snd[i];
      if (a.dwpt == null || b.dwpt == null) continue;
      const wa = ws(a.dwpt, a.pres) / 1000; // kg/kg
      const wb = ws(b.dwpt, b.pres) / 1000;
      const dp = Math.abs(a.pres - b.pres) * 100; // Pa
      pw += 0.5 * (wa + wb) * dp / g; // kg/m² = mm
    }
    return pw;
  }

  // ── Bulk wind shear magnitude (knots) from surface to hAGL_m ─────
  function bulkShear(snd, hAGL_m) {
    const obs = snd.filter(s => s.sknt != null && s.drct != null && s.hght != null);
    if (obs.length < 2) return null;
    const sfcH = obs[0].hght;
    const toUV = (spd, dir) => {
      const r = dir * Math.PI / 180;
      return { u: -spd * Math.sin(r), v: -spd * Math.cos(r) };
    };
    const uvSfc = toUV(obs[0].sknt, obs[0].drct);
    const targetH = sfcH + hAGL_m;
    // Interpolate wind at target height
    let best = null, bestDiff = Infinity;
    for (const o of obs) {
      const diff = Math.abs(o.hght - targetH);
      if (diff < bestDiff) { bestDiff = diff; best = o; }
    }
    if (!best || bestDiff > hAGL_m * 0.45) return null;
    const uvTop = toUV(best.sknt, best.drct);
    const du = uvTop.u - uvSfc.u;
    const dv = uvTop.v - uvSfc.v;
    return Math.sqrt(du * du + dv * dv); // knots
  }

  // ── Storm-relative helicity (m²/s²) using Bunkers right-mover ───
  function stormRelHelicity(snd, hAGL_m) {
    const KT_TO_MS = 0.5144;
    const obs = snd.filter(s => s.sknt != null && s.drct != null && s.hght != null);
    if (obs.length < 2) return null;
    const sfcH = obs[0].hght;
    const toUV = (spd, dir) => {
      const r = dir * Math.PI / 180;
      return { u: -spd * Math.sin(r), v: -spd * Math.cos(r) };
    };
    // Mean wind 0–6 km (simple layer average)
    const lyr6 = obs.filter(o => o.hght - sfcH <= 6000);
    if (lyr6.length < 2) return null;
    let uSum = 0, vSum = 0;
    for (const o of lyr6) { const uv = toUV(o.sknt, o.drct); uSum += uv.u; vSum += uv.v; }
    const uMean = uSum / lyr6.length, vMean = vSum / lyr6.length;
    // 0–6 km shear vector (for Bunkers deviation)
    const uvSfc = toUV(lyr6[0].sknt, lyr6[0].drct);
    const uvTop = toUV(lyr6[lyr6.length - 1].sknt, lyr6[lyr6.length - 1].drct);
    const shU = uvTop.u - uvSfc.u, shV = uvTop.v - uvSfc.v;
    const shMag = Math.sqrt(shU * shU + shV * shV);
    if (shMag === 0) return null;
    // Bunkers right-mover: deviate 7.5 m/s perpendicular (right) to shear
    const D = 7.5 / KT_TO_MS; // 7.5 m/s → kt
    const stormU = uMean + D * (shV / shMag);
    const stormV = vMean - D * (shU / shMag);
    // Integrate SRH over 0 to hAGL_m
    const layer = obs.filter(o => o.hght - sfcH <= hAGL_m);
    let srh = 0;
    for (let i = 0; i < layer.length - 1; i++) {
      const a = layer[i], b = layer[i + 1];
      const uvA = toUV(a.sknt, a.drct), uvB = toUV(b.sknt, b.drct);
      const uA = uvA.u - stormU, vA = uvA.v - stormV;
      const uB = uvB.u - stormU, vB = uvB.v - stormV;
      srh += uA * vB - uB * vA;
    }
    return -srh * KT_TO_MS * KT_TO_MS; // convert kt² → m²/s²
  }

  // ── Possible hazard classification ───────────────────────────────
  function classifyHazard(snd) {
    if (!snd || snd.length < 3) return null;
    const { cape }       = capeCin(snd);
    const ki   = kIndex(snd);
    const pw   = precipWater(snd);
    const sfc  = snd[0] || {};
    const sfcT = sfc.temp;
    const shr6 = bulkShear(snd, 6000);
    const srh1 = stormRelHelicity(snd, 1000);
    const srh3 = stormRelHelicity(snd, 3000);

    // PDS Tornado — particularly dangerous situation
    if (cape >= 2000 && shr6 != null && shr6 >= 50 && srh1 != null && srh1 >= 200) {
      return {
        type: 'PDS TOR',
        severity: 'extreme',
        color: '#ff0000',
        icon: '',
        desc: `CAPE ${cape.toFixed(0)} J/kg · 0–6 km shear ${shr6.toFixed(0)} kt · SRH₀₋₁ ${srh1.toFixed(0)} m²s⁻²`,
      };
    }
    // Tornado watch-level
    if (cape >= 1000 && shr6 != null && shr6 >= 35 &&
        ((srh1 != null && srh1 >= 100) || (srh3 != null && srh3 >= 150))) {
      return {
        type: 'TOR',
        severity: 'severe',
        color: '#ff4422',
        icon: '',
        desc: `CAPE ${cape.toFixed(0)} J/kg · 0–6 km shear ${shr6.toFixed(0)} kt · SRH₀₋₃ ${srh3 != null ? srh3.toFixed(0) : '—'} m²s⁻²`,
      };
    }
    // Marginal tornado threat
    if (cape >= 500 && shr6 != null && shr6 >= 25 &&
        ((srh1 != null && srh1 >= 40) || (srh3 != null && srh3 >= 75))) {
      return {
        type: 'MARGINAL TOR',
        severity: 'moderate',
        color: '#ff8800',
        icon: '',
        desc: `CAPE ${cape.toFixed(0)} J/kg · 0–6 km shear ${shr6.toFixed(0)} kt · SRH₀₋₁ ${srh1 != null ? srh1.toFixed(0) : '—'} m²s⁻²`,
      };
    }
    // Freezing rain — warm nose above near-/sub-freezing surface
    const warmNose = sfcT != null && sfcT <= 2 &&
      snd.some(s => s.hght > (snd[0].hght || 0) && s.temp != null && s.temp > 2);
    if (warmNose && pw != null && pw >= 3) {
      return {
        type: 'FRZRN',
        severity: 'marginal',
        color: '#88ccff',
        icon: '',
        desc: `Sfc temp ${(sfcT * 9 / 5 + 32).toFixed(1)} °F · warm layer aloft · PW ${(pw / 25.4).toFixed(2)} in`,
      };
    }
    // Rain / general precipitation
    if ((pw != null && pw >= 15 && ki != null && ki >= 20) ||
        (cape >= 100 && pw != null && pw >= 10)) {
      return {
        type: 'RAIN',
        severity: 'calm',
        color: '#4499ff',
        icon: '',
        desc: `PW ${pw != null ? (pw / 25.4).toFixed(2) : '—'} in · K-Index ${ki != null ? ki.toFixed(0) : '—'} · CAPE ${cape.toFixed(0)} J/kg`,
      };
    }
    // No significant hazard
    return {
      type: 'NONE',
      severity: 'calm',
      color: '#6db56d',
      icon: '',
      desc: `CAPE ${cape.toFixed(0)} J/kg · stable or weakly unstable profile`,
    };
  }

  // ══ Data fetch ════════════════════════════════════════════════
  async function fetchSounding(wmo, year, month, day, hour) {
    const m2 = String(month).padStart(2, '0');
    const d2 = String(day).padStart(2, '0');
    const h2 = String(hour).padStart(2, '0');
    // UWyoming migrated from cgi-bin to wsgi in 2025; new endpoint returns winds in m/s
    const target = `https://weather.uwyo.edu/wsgi/sounding?datetime=${year}-${m2}-${d2} ${h2}:00:00&id=${wmo}&src=UNKNOWN&type=TEXT:LIST`;

    const proxies = [
      `https://api.allorigins.win/raw?url=${encodeURIComponent(target)}`,
      `https://corsproxy.io/?url=${encodeURIComponent(target)}`,
      `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(target)}`,
    ];

    // Race all proxies simultaneously — fastest successful response wins.
    return Promise.any(proxies.map(proxy =>
      fetch(proxy, { signal: AbortSignal.timeout(15000) })
        .then(resp => { if (!resp.ok) throw new Error('HTTP ' + resp.status); return resp.text(); })
    ));
  }

  // ══ NWS api.weather.gov — FM-35 TTAA mandatory levels fetch ═══
  // No CORS proxy needed; api.weather.gov has native CORS headers.
  // MAN product = TTAA mandatory levels (surface–100 mb, 12 levels).
  // Only ~14 days of history; older dates fall back to UWyoming.

  async function fetchSoundingNWS(nwsOffice, year, month, day, hour) {
    const BASE = 'https://api.weather.gov';
    const targetTime = new Date(Date.UTC(year, month - 1, day, hour, 0, 0));

    const r = await fetch(`${BASE}/products/types/MAN/locations/${nwsOffice}`,
      { signal: AbortSignal.timeout(12000) });
    if (!r.ok) throw new Error(`NWS MAN list: HTTP ${r.status}`);
    const j = await r.json();
    const items = j['@graph'] || [];
    if (!items.length) throw new Error(`No NWS MAN products at ${nwsOffice}`);

    let best = items[0];
    let bestDt = Math.abs(new Date(best.issuanceTime) - targetTime);
    for (const it of items.slice(1)) {
      const dt = Math.abs(new Date(it.issuanceTime) - targetTime);
      if (dt < bestDt) { bestDt = dt; best = it; }
    }

    const pr = await fetch(`${BASE}/products/${best.id}`, { signal: AbortSignal.timeout(12000) });
    if (!pr.ok) throw new Error(`NWS product: HTTP ${pr.status}`);
    const productText = (await pr.json()).productText || '';
    return parseNWSMan(productText);
  }

  function parseNWSMan(txt) {
    // FM-35 temperature field: TaTaTa (3-digit integer)
    // Even → positive °C; odd → negative °C (value is tenths of °C)
    function decodeTmp(s3) {
      const v = parseInt(s3, 10);
      if (!isFinite(v)) return null;
      const t = (v % 2 === 0) ? v / 10 : -(v / 10);
      return (t > -90 && t < 50) ? t : null; // sanity check
    }
    // Dewpoint depression DnDn: ≤50 → tenths of °C; >50 → whole °C − 50
    function decodeDwpt(tmp, s2) {
      const td = parseInt(s2, 10);
      if (!isFinite(td) || td >= 99) return null;
      const dep = td <= 50 ? td / 10 : td - 50;
      return tmp - dep;
    }
    // Wind group dddff (speeds ≥100 kt: direction coded as ddd+500)
    function decodeWind(g) {
      if (!g || !/^\d{5}$/.test(g)) return { drct: null, sknt: null };
      let ddd = parseInt(g.slice(0, 3), 10);
      let ff  = parseInt(g.slice(3, 5), 10);
      if (ddd > 500) { ddd -= 500; ff += 100; }
      return { drct: ddd, sknt: ff };
    }
    // Geopotential height from level code + encoded hhh (last 3 digits in m)
    const HGT_OFFSET = { 92: 0, 85: 1000, 70: 3000, 50: 5000, 40: 7000 };
    function decodeHeight(pp, hhhStr) {
      const hhh = parseInt(hhhStr, 10);
      if (!isFinite(hhh)) return null;
      if (pp === 99) return null;
      if (pp === 0)  return hhh > 500 ? hhh - 1000 : hhh;
      const off = HGT_OFFSET[pp];
      return off !== undefined ? hhh + off : null;
    }
    // Standard pressure by PP code
    const STD_PRESS = { 99: 'sfc', 0: 1000, 92: 925, 85: 850, 70: 700,
                        50: 500, 40: 400, 30: 300, 25: 250, 20: 200, 15: 150, 10: 100 };

    // Extract TTAA section; stop at tropo/max-wind/additional-data separators
    const m = txt.match(/\bTTAA\b([\s\S]*?)(?:\bTTBB\b|\bPPAA\b|\bPPBB\b|21212|31313|51515|77777|=)/);
    if (!m) return [];
    const tok = m[1].trim().split(/\s+/);
    let i = 0;
    if (/^\d{5}$/.test(tok[i])) i++; // YYGGiw
    if (/^\d{5}$/.test(tok[i])) i++; // station number

    const out = [];
    while (i + 2 < tok.length) {
      const lvl = tok[i], tGrp = tok[i + 1], wGrp = tok[i + 2];
      if (!/^\d{5}$/.test(lvl) || !/^\d{5}$/.test(tGrp) || !/^\d{5}$/.test(wGrp)) { i++; continue; }
      const pp  = parseInt(lvl.slice(0, 2), 10);
      const hhh = lvl.slice(2, 5);
      // Stop at tropopause (88), max wind (77), or any special section marker
      if ([88, 77, 66, 44, 55, 31, 51, 41, 61, 21].includes(pp)) break;
      const pEntry = STD_PRESS[pp];
      if (pEntry === undefined) { i += 3; continue; }
      i += 3;
      const tmp  = decodeTmp(tGrp.slice(0, 3));
      const dwpt = tmp != null ? decodeDwpt(tmp, tGrp.slice(3, 5)) : null;
      const { drct, sknt } = decodeWind(wGrp);
      const pres = (pEntry === 'sfc')
        ? (() => { const n = parseInt(hhh, 10); return n < 100 ? n + 1000 : n; })()
        : pEntry;
      out.push({ pres, hght: decodeHeight(pp, hhh), temp: tmp, dwpt,
                 relh: null, mixr: null, drct, sknt });
    }
    return out;
  }

  function parseSounding(html) {
    const preMatch = html.match(/<pre>([\s\S]*?)<\/pre>/i);
    if (!preMatch) return null;

    const lines = preMatch[1].split('\n');
    const data  = [];
    let sepCount = 0, inData = false;

    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      if (t.startsWith('---') || t.startsWith('===')) {
        sepCount++;
        if (sepCount === 2) inData = true;
        else if (sepCount > 2) break;
        continue;
      }
      if (!inData) continue;

      const parts = t.split(/\s+/);
      if (parts.length < 8) continue;

      const pres = parseFloat(parts[0]);
      if (!isFinite(pres) || pres <= 0 || pres > 1100) continue;

      const hght = parseFloat(parts[1]);
      const temp = parseFloat(parts[2]);
      const dwpt = parseFloat(parts[3]);
      const relh = parseFloat(parts[4]);
      const mixr = parseFloat(parts[5]);
      const drct = parseFloat(parts[6]);
      const sknt = parseFloat(parts[7]);

      data.push({
        pres,
        hght: isFinite(hght)            ? hght : null,
        temp: isFinite(temp) && temp > -200 ? temp : null,
        dwpt: isFinite(dwpt) && dwpt > -200 ? dwpt : null,
        relh: isFinite(relh) && relh >= 0   ? relh : null,
        mixr: isFinite(mixr) && mixr >= 0   ? mixr : null,
        drct: isFinite(drct)            ? drct : null,
        sknt: isFinite(sknt) && sknt >= 0   ? sknt / 0.514444 : null,  // wsgi returns m/s → convert to knots
      });
    }

    const h2    = html.match(/<h2>([\s\S]*?)<\/h2>/i);
    const stationInfo = h2 ? h2[1].replace(/<[^>]+>/g, '').trim() : null;
    return data.length > 3 ? { data, stationInfo } : null;
  }

  // ══ Canvas coordinate helpers ════════════════════════════════
  function pToY(p) {
    const lT = Math.log(P_TOP), lB = Math.log(P_BOT);
    return PT + (Math.log(p) - lT) / (lB - lT) * (CH - PT - PB);
  }

  function skewtToX(Tsk) {
    return PL + (Tsk - TSK_MIN) / (TSK_MAX - TSK_MIN) * (CW - PL - PR);
  }

  function rawToX(T, p) {
    return skewtToX(T + SKEW * Math.log10(1000 / p));
  }

  // ══ Draw Skew-T ══════════════════════════════════════════════
  function drawSkewT(snd) {
    const canvas = _dom.skewtCanvas;
    canvas.width  = CW;
    canvas.height = CH;
    const ctx = canvas.getContext('2d');
    const plotW = CW - PL - PR, plotH = CH - PT - PB;

    // Background
    ctx.fillStyle = '#07030d';
    ctx.fillRect(0, 0, CW, CH);
    ctx.fillStyle = '#0c0518';
    ctx.fillRect(PL, PT, plotW, plotH);

    // ─ Clip to plot area for background lines ─
    ctx.save();
    ctx.beginPath();
    ctx.rect(PL, PT, plotW, plotH);
    ctx.clip();

    // Isotherms
    ctx.lineWidth = 0.5;
    ctx.setLineDash([]);
    for (let T = -200; T <= 80; T += 10) {
      const y1 = pToY(P_BOT), y2 = pToY(P_TOP);
      const x1 = rawToX(T, P_BOT), x2 = rawToX(T, P_TOP);
      const zero = T === 0;
      ctx.strokeStyle = zero ? 'rgba(200,200,60,0.55)' : 'rgba(55,75,140,0.32)';
      ctx.lineWidth   = zero ? 1.0 : 0.5;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }

    // Dry adiabats
    ctx.strokeStyle = 'rgba(160,90,30,0.27)';
    ctx.lineWidth   = 0.55;
    ctx.setLineDash([3, 5]);
    for (let theta = 220; theta <= 520; theta += 10) {
      ctx.beginPath();
      let first = true;
      for (let p = P_BOT; p >= P_TOP - 5; p -= 8) {
        const T = (theta) * Math.pow(p / 1000, Rd / cp) - 273.15;
        const x = rawToX(T, p), y = pToY(p);
        if (first) { ctx.moveTo(x, y); first = false; } else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // Moist adiabats
    ctx.lineWidth = 0.55;
    ctx.setLineDash([4, 6]);
    for (let Tw = -22; Tw <= 44; Tw += 4) {
      ctx.strokeStyle = 'rgba(35,130,75,0.24)';
      ctx.beginPath();
      let T = Tw, first = true;
      for (let p = 1000; p >= P_TOP - 5; p -= 20) {
        const x = rawToX(T, p), y = pToY(p);
        if (first) { ctx.moveTo(x, y); first = false; } else ctx.lineTo(x, y);
        if (p > P_TOP) T = liftMoist(T, p, Math.max(p - 20, P_TOP), 5);
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // Mixing ratio lines
    ctx.lineWidth = 0.5;
    ctx.setLineDash([2, 7]);
    for (const mr of [0.4, 1, 2, 4, 7, 10, 16, 24]) {
      ctx.strokeStyle = 'rgba(80,190,170,0.2)';
      ctx.beginPath();
      let first = true;
      for (let p = P_BOT; p >= 400; p -= 8) {
        const e  = mr * p / (1000 * (1000 * (Rd / Rv) + mr));
        if (e <= 0) continue;
        const Td = 243.5 * Math.log(e / 6.112) / (17.67 - Math.log(e / 6.112));
        const x  = rawToX(Td, p), y = pToY(p);
        if (first) { ctx.moveTo(x, y); first = false; } else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);

    ctx.restore(); // end clip

    // Isobars (drawn full-width for labels)
    const isobars = [1000, 925, 850, 700, 600, 500, 400, 300, 250, 200, 150, 100];
    ctx.font      = '10.5px Consolas, monospace';
    ctx.textAlign = 'right';
    for (const p of isobars) {
      if (p > P_BOT || p < P_TOP) continue;
      const y = pToY(p);
      ctx.save();
      ctx.beginPath(); ctx.rect(PL, PT, plotW, plotH); ctx.clip();
      ctx.strokeStyle = 'rgba(90,90,115,0.38)';
      ctx.lineWidth   = (p === 850 || p === 700 || p === 500) ? 0.9 : 0.45;
      ctx.beginPath(); ctx.moveTo(PL, y); ctx.lineTo(CW - PR, y); ctx.stroke();
      ctx.restore();
      ctx.fillStyle = 'rgba(150,140,190,0.6)';
      ctx.fillText(p, PL - 4, y + 3.5);
    }

    // T-axis labels (display in °F; internal calc stays in °C)
    ctx.font      = '9.5px Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(80,110,190,0.5)';
    for (let T = -40; T <= 50; T += 10) {
      const x = rawToX(T, P_BOT);
      if (x < PL || x > CW - PR) continue;
      const zero = T === 0;
      ctx.fillStyle = zero ? 'rgba(200,200,70,0.6)' : 'rgba(80,110,190,0.5)';
      const TF = Math.round(T * 9 / 5 + 32);
      ctx.fillText(TF + '°', x, CH - PB + 13);
    }

    // Plot border
    ctx.strokeStyle = 'rgba(139,32,192,0.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect(PL, PT, plotW, plotH);

    if (!snd || snd.length === 0) return;

    // ─ CAPE/CIN ─
    const trace = parcelTrace(snd);
    if (trace.length > 1) {
      ctx.save();
      ctx.beginPath(); ctx.rect(PL, PT, plotW, plotH); ctx.clip();

      const capePts = [], cinPts = [];
      for (const pt of trace) {
        const env = interpField(snd, pt.pres, 'temp');
        if (env == null) continue;
        const xP = rawToX(pt.temp, pt.pres);
        const xE = rawToX(env,     pt.pres);
        const y  = pToY(pt.pres);
        if (pt.temp > env) capePts.push({ xP, xE, y });
        else               cinPts.push({ xP, xE, y });
      }

      const fillRegion = (pts, color) => {
        if (pts.length < 2) return;
        ctx.beginPath();
        ctx.moveTo(pts[0].xE, pts[0].y);
        pts.forEach(p => ctx.lineTo(p.xE, p.y));
        [...pts].reverse().forEach(p => ctx.lineTo(p.xP, p.y));
        ctx.closePath();
        ctx.fillStyle = color;
        ctx.fill();
      };
      fillRegion(capePts, 'rgba(139,32,192,0.14)');
      fillRegion(cinPts,  'rgba(70,120,255,0.11)');

      // Parcel trace line
      ctx.strokeStyle = 'rgba(255,255,255,0.8)';
      ctx.lineWidth   = 1.4;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      trace.forEach((pt, i) => {
        const x = rawToX(pt.temp, pt.pres), y = pToY(pt.pres);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }

    // ─ Temperature trace ─
    const tValid = snd.filter(s => s.temp != null);
    if (tValid.length > 1) {
      ctx.save();
      ctx.beginPath(); ctx.rect(PL, PT, plotW, plotH); ctx.clip();
      ctx.strokeStyle = '#ff4444';
      ctx.lineWidth   = 2.0;
      ctx.lineJoin    = 'round';
      ctx.beginPath();
      tValid.forEach((s, i) => {
        const x = rawToX(s.temp, s.pres), y = pToY(s.pres);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
      ctx.restore();
      // Label below surface endpoint
      const tSfc = tValid[0];
      const txL = rawToX(tSfc.temp, tSfc.pres);
      const tyL = pToY(tSfc.pres);
      ctx.save();
      ctx.font         = 'bold 11px monospace';
      ctx.fillStyle    = '#ff4444';
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(tSfc.temp.toFixed(1) + '\u00B0C', txL, tyL + 4);
      ctx.restore();
    }

    // ─ Dewpoint trace ─
    const dValid = snd.filter(s => s.dwpt != null);
    if (dValid.length > 1) {
      ctx.save();
      ctx.beginPath(); ctx.rect(PL, PT, plotW, plotH); ctx.clip();
      ctx.strokeStyle = '#44cc66';
      ctx.lineWidth   = 2.0;
      ctx.lineJoin    = 'round';
      ctx.beginPath();
      dValid.forEach((s, i) => {
        const x = rawToX(s.dwpt, s.pres), y = pToY(s.pres);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
      ctx.restore();
      // Label below surface endpoint
      const dSfc = dValid[0];
      const dxL = rawToX(dSfc.dwpt, dSfc.pres);
      const dyL = pToY(dSfc.pres);
      ctx.save();
      ctx.font         = 'bold 11px monospace';
      ctx.fillStyle    = '#44cc66';
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(dSfc.dwpt.toFixed(1) + '\u00B0C', dxL, dyL + 4);
      ctx.restore();
    }

    // ─ Wind barbs ─
    drawWindBarbs(ctx, snd);

    // ─ Hit-targets for hover tooltip ─
    _skewHits = [];
    for (const s of snd) {
      if (s.temp == null && s.dwpt == null) continue;
      const y = pToY(s.pres);
      if (s.temp != null) {
        _skewHits.push({
          x: rawToX(s.temp, s.pres), y,
          pres: s.pres, temp: s.temp, dwpt: s.dwpt, relh: s.relh,
          wind: s.sknt != null ? `${s.drct ? s.drct.toFixed(0) : '?'}°/${s.sknt}kt` : null,
        });
      }
      if (s.dwpt != null) {
        _skewHits.push({
          x: rawToX(s.dwpt, s.pres), y,
          pres: s.pres, temp: s.temp, dwpt: s.dwpt, relh: s.relh,
        });
      }
    }
  }

  function drawWindBarbs(ctx, snd) {
    const x0   = CW - PR + 14;
    const levels = [1000, 925, 850, 700, 600, 500, 400, 300, 250, 200, 150, 100];
    for (const p of levels) {
      const obs = snd.find(s => s.sknt != null && s.drct != null && Math.abs(s.pres - p) < 30);
      if (!obs) continue;
      const y   = pToY(p);
      const spd = obs.sknt;
      const dir = obs.drct;
      // Direction wind comes FROM; barb points INTO wind
      const rad = (270 - dir) * Math.PI / 180;
      const dx  = Math.cos(rad), dy = -Math.sin(rad);
      const len = 18;
      ctx.strokeStyle = 'rgba(180,180,255,0.5)';
      ctx.fillStyle   = 'rgba(180,180,255,0.5)';
      ctx.lineWidth   = 1;
      // Staff
      ctx.beginPath();
      ctx.moveTo(x0, y);
      ctx.lineTo(x0 + dx * len, y + dy * len);
      ctx.stroke();
      // Barbs
      const perp = [-dy, dx];
      const bLen = 7;
      let rem = spd, pos = len;
      // Pennants (50 kt)
      while (rem >= 50) {
        const bx = x0 + dx * pos, by = y + dy * pos;
        ctx.beginPath();
        ctx.moveTo(bx, by);
        ctx.lineTo(bx + perp[0] * bLen + dx * 5, by + perp[1] * bLen + dy * 5);
        ctx.lineTo(bx + dx * 5, by + dy * 5);
        ctx.closePath(); ctx.fill();
        pos -= 6; rem -= 50;
      }
      // Full barbs (10 kt)
      while (rem >= 10) {
        const bx = x0 + dx * pos, by = y + dy * pos;
        ctx.beginPath();
        ctx.moveTo(bx, by);
        ctx.lineTo(bx + perp[0] * bLen, by + perp[1] * bLen);
        ctx.stroke();
        pos -= 4.5; rem -= 10;
      }
      // Half barb (5 kt)
      if (rem >= 5) {
        const bx = x0 + dx * pos, by = y + dy * pos;
        ctx.beginPath();
        ctx.moveTo(bx, by);
        ctx.lineTo(bx + perp[0] * bLen * 0.5, by + perp[1] * bLen * 0.5);
        ctx.stroke();
      }
    }
  }

  // ══ Draw Hodograph ════════════════════════════════════════════
  function drawHodograph(snd) {
    const canvas = _dom.hodoCanvas;
    const SIZE   = 270;
    canvas.width = canvas.height = SIZE;
    const ctx = canvas.getContext('2d');
    const cx = SIZE / 2, cy = SIZE / 2;
    const maxSpd = 80;
    const scale  = (SIZE / 2 - 20) / maxSpd;

    ctx.fillStyle = '#07030d';
    ctx.fillRect(0, 0, SIZE, SIZE);

    // Grid rings + labels
    for (const r of [20, 40, 60, 80]) {
      ctx.strokeStyle = 'rgba(90,90,130,0.3)';
      ctx.lineWidth   = 0.7;
      ctx.beginPath();
      ctx.arc(cx, cy, r * scale, 0, 2 * Math.PI);
      ctx.stroke();
      ctx.fillStyle = 'rgba(120,110,170,0.4)';
      ctx.font      = '9px Consolas, monospace';
      ctx.textAlign = 'left';
      ctx.fillText(r + 'kt', cx + r * scale + 2, cy - 2);
    }
    // Axes
    ctx.strokeStyle = 'rgba(90,90,130,0.25)';
    ctx.lineWidth   = 0.6;
    ctx.beginPath(); ctx.moveTo(cx, 16);        ctx.lineTo(cx, SIZE - 16); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(16, cy);         ctx.lineTo(SIZE - 16, cy); ctx.stroke();
    // Cardinal labels
    ctx.fillStyle = 'rgba(130,120,180,0.45)';
    ctx.font      = '9px Consolas, monospace';
    ctx.textAlign = 'center'; ctx.fillText('N', cx, 13);
    ctx.textAlign = 'center'; ctx.fillText('S', cx, SIZE - 3);
    ctx.textAlign = 'left';   ctx.fillText('E', SIZE - 13, cy + 4);
    ctx.textAlign = 'right';  ctx.fillText('W', 13, cy + 4);

    // Layer color scheme (height AGL)
    const LAYERS = [
      { maxH: 3000,     col: '#ff3333' },
      { maxH: 6000,     col: '#33cc44' },
      { maxH: 9000,     col: '#ffdd00' },
      { maxH: 12000,    col: '#88ccff' },
      { maxH: Infinity, col: '#cc88ff' },
    ];

    const obs = snd.filter(s => s.sknt != null && s.drct != null && s.hght != null);
    if (obs.length < 2) { return; }

    const sfcH = obs[0].hght;
    const toXY = (spd, dir) => {
      const r = dir * Math.PI / 180;
      return {
        x: cx + (-spd * Math.sin(r)) * scale,
        y: cy - (-spd * Math.cos(r)) * scale,
      };
    };

    ctx.lineWidth = 1.8;
    ctx.lineJoin  = 'round';
    ctx.lineCap   = 'round';
    for (let i = 1; i < obs.length; i++) {
      const a = obs[i - 1], b = obs[i];
      const relH = b.hght - sfcH;
      const layer = LAYERS.find(l => relH <= l.maxH) || LAYERS[LAYERS.length - 1];
      ctx.strokeStyle = layer.col;
      const pA = toXY(a.sknt, a.drct), pB = toXY(b.sknt, b.drct);
      ctx.beginPath(); ctx.moveTo(pA.x, pA.y); ctx.lineTo(pB.x, pB.y); ctx.stroke();
    }
    // Legend
    ctx.font = '9px Consolas, monospace';
    [['0-10k ft', '#ff3333'], ['10-20k ft', '#33cc44'], ['20-30k ft', '#ffdd00'], ['30-40k ft', '#88ccff']].forEach(([lbl, col], i) => {
      ctx.fillStyle = col;
      ctx.fillRect(5, 6 + i * 13, 8, 8);
      ctx.fillStyle = 'rgba(200,200,200,0.6)';
      ctx.textAlign = 'left';
      ctx.fillText(lbl, 16, 14 + i * 13);
    });
  }

  // ══ 3D Hodograph ════════════════════════════════════════════
  // Axes: X = U-wind (east+), Y = height (up), Z = V-wind (north+)
  // Rendered with simple rotatable isometric projection; drag to orbit.

  const _hodo3d = {
    azimuth:  -35,   // degrees
    elevation: 25,   // degrees
    zoom:      1.0,
    dragging:  false,
    lastX:     0,
    lastY:     0,
    data:      null, // last snd passed in
  };

  function draw3DHodograph(snd) {
    _hodo3d.data = snd;
    _render3DHodograph();
  }

  function _render3DHodograph() {
    const snd    = _hodo3d.data;
    const canvas = _dom.hodo3dCanvas;
    const isFS   = document.fullscreenElement === _dom.hodoCard;
    const SIZE   = isFS
      ? Math.round(Math.min(window.innerHeight - 140, window.innerWidth - 40))
      : 270;
    canvas.width = canvas.height = SIZE;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#07030d';
    ctx.fillRect(0, 0, SIZE, SIZE);

    if (!snd) return;
    const obs = snd.filter(s => s.sknt != null && s.drct != null && s.hght != null);
    if (obs.length < 2) return;

    const sfcH   = obs[0].hght;
    const maxSpd = 80;

    // Convert met wind to U/V
    const toUV = (spd, dir) => {
      const r = dir * Math.PI / 180;
      return { u: -spd * Math.sin(r), v: -spd * Math.cos(r) };
    };

    // Max height for Z axis
    const maxH = Math.max(...obs.map(s => s.hght - sfcH), 12000);

    // Projection parameters
    const az  = _hodo3d.azimuth  * Math.PI / 180;
    const el  = _hodo3d.elevation * Math.PI / 180;
    const scaleH   = ((SIZE / 2 - 30) / maxSpd) * _hodo3d.zoom;
    const scaleZ   = ((SIZE / 2 - 30) / maxH)   * _hodo3d.zoom;

    // 3D → 2D projection (camera aligned with az/el)
    const cx = SIZE / 2;
    const cy = SIZE / 2 + Math.round(SIZE * 0.06);
    function project(u, hAGL, v) {
      // Rotate around Y (azimuth) then tilt (elevation)
      const cosA = Math.cos(az), sinA = Math.sin(az);
      const cosE = Math.cos(el), sinE = Math.sin(el);
      const x3 = u    * scaleH;
      const y3 = hAGL * scaleZ;
      const z3 = v    * scaleH;
      // Yaw
      const xR = x3 * cosA + z3 * sinA;
      const zR = -x3 * sinA + z3 * cosA;
      // Pitch
      const xF = xR;
      const yF = y3 * cosE - zR * sinE;
      return { sx: cx + xF, sy: cy - yF };
    }

    // ── Circular clip — prevents hard rectangular edge when zoomed ───
    const clipR = SIZE / 2 - 2;
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, clipR, 0, Math.PI * 2);
    ctx.clip();

    // ── Draw grid planes (faint) ─────────────────────────────
    ctx.strokeStyle = 'rgba(80,80,130,0.22)';
    ctx.lineWidth   = 0.6;
    // Horizontal rings at key heights
    for (const hAGL of [0, 1000, 3000, 6000, 12000]) {
      if (hAGL > maxH * 1.05) continue;
      const steps = 36;
      ctx.beginPath();
      for (let n = 0; n <= steps; n++) {
        const ang = (n / steps) * 2 * Math.PI;
        const u   = maxSpd * Math.cos(ang);
        const v   = maxSpd * Math.sin(ang);
        const p   = project(u, hAGL, v);
        n === 0 ? ctx.moveTo(p.sx, p.sy) : ctx.lineTo(p.sx, p.sy);
      }
      ctx.stroke();
    }
    // Vertical speed rings
    for (const spd of [20, 40, 60, 80]) {
      const p0 = project(spd, 0, 0), p1 = project(spd, maxH, 0);
      ctx.beginPath(); ctx.moveTo(p0.sx, p0.sy); ctx.lineTo(p1.sx, p1.sy); ctx.stroke();
    }

    // ── Axes ────────────────────────────────────────────────
    ctx.lineWidth = 1;
    // U axis (E/W)
    const axisLen = maxSpd * 0.9;
    const pO  = project(0,       0,       0);
    const pU  = project(axisLen, 0,       0);
    const pNu = project(-axisLen,0,       0);
    const pV  = project(0,       0,       axisLen);
    const pNv = project(0,       0,      -axisLen);
    const pY  = project(0,       maxH,    0);

    [[pNu, pU, 'rgba(100,100,170,0.4)'], [pNv, pV, 'rgba(100,100,170,0.4)']].forEach(([a, b, col]) => {
      ctx.strokeStyle = col;
      ctx.beginPath(); ctx.moveTo(a.sx, a.sy); ctx.lineTo(b.sx, b.sy); ctx.stroke();
    });
    ctx.strokeStyle = 'rgba(80,160,120,0.5)';
    ctx.beginPath(); ctx.moveTo(pO.sx, pO.sy); ctx.lineTo(pY.sx, pY.sy); ctx.stroke();

    // Axis labels
    ctx.font      = '9px Consolas, monospace';
    ctx.fillStyle = 'rgba(130,120,180,0.5)';
    ctx.textAlign = 'center';
    ctx.fillText('E',  pU.sx + 8,  pU.sy);
    ctx.fillText('W',  pNu.sx - 4, pNu.sy);
    ctx.fillText('N',  pV.sx,      pV.sy - 6);
    ctx.fillText('S',  pNv.sx,     pNv.sy + 10);
    ctx.fillStyle = 'rgba(80,200,130,0.5)';
    ctx.fillText('↑ HGHT', pY.sx, pY.sy - 4);

    // ── Height labels on Z axis (removed here — drawn fixed after clip) ───

    // ── Layer color scheme ───────────────────────────────────
    const LAYERS = [
      { maxH: 3000,     col: '#ff3333' },
      { maxH: 6000,     col: '#33cc44' },
      { maxH: 9000,     col: '#ffdd00' },
      { maxH: 12000,    col: '#88ccff' },
      { maxH: Infinity, col: '#cc88ff' },
    ];

    // ── Wind trace ───────────────────────────────────────────
    ctx.lineWidth = 2.0;
    ctx.lineJoin  = 'round';
    ctx.lineCap   = 'round';
    for (let i = 1; i < obs.length; i++) {
      const a = obs[i - 1], b = obs[i];
      const uvA = toUV(a.sknt, a.drct), uvB = toUV(b.sknt, b.drct);
      const pA  = project(uvA.u, a.hght - sfcH, uvA.v);
      const pB  = project(uvB.u, b.hght - sfcH, uvB.v);
      const relH = b.hght - sfcH;
      const col  = (LAYERS.find(l => relH <= l.maxH) || LAYERS[LAYERS.length - 1]).col;
      ctx.strokeStyle = col;
      ctx.beginPath(); ctx.moveTo(pA.sx, pA.sy); ctx.lineTo(pB.sx, pB.sy); ctx.stroke();
    }

    // ── End circular clip ────────────────────────────────────
    ctx.restore();

    // ── Fixed altitude labels (right side, always in place) ──
    const altLabels = [
      { hAGL: 1000,  label: '3.3k ft',  col: 'rgba(200,180,255,0.7)' },
      { hAGL: 3000,  label: '10k ft',   col: '#ff3333' },
      { hAGL: 6000,  label: '20k ft',   col: '#33cc44' },
      { hAGL: 9000,  label: '30k ft',   col: '#ffdd00' },
      { hAGL: 12000, label: '39k ft',   col: '#88ccff' },
    ];
    ctx.font      = `${Math.max(9, Math.round(SIZE * 0.026))}px Consolas, monospace`;
    ctx.textAlign = 'right';
    const colX    = SIZE - 6;
    const rowH    = Math.round(SIZE * 0.048);
    const startY  = Math.round(SIZE * 0.12);
    altLabels.forEach(({ hAGL, label, col }, i) => {
      if (hAGL > maxH * 1.05) return;
      ctx.fillStyle = col;
      ctx.fillText(label, colX, startY + i * rowH);
    });

    // Orbit hint
    const hintSize = Math.max(8, Math.round(SIZE * 0.022));
    ctx.fillStyle  = 'rgba(150,130,200,0.35)';
    ctx.textAlign  = 'center';
    ctx.font       = `${hintSize}px Consolas, monospace`;
    ctx.fillText('drag to rotate  |  scroll to zoom', SIZE / 2, SIZE - 6);
  }

  function _init3DInteraction() {
    const c = _dom.hodo3dCanvas;

    c.addEventListener('contextmenu', e => e.preventDefault());

    c.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      e.preventDefault();
      _hodo3d.dragging = true;
      _hodo3d.lastX = e.clientX;
      _hodo3d.lastY = e.clientY;
    });
    window.addEventListener('mouseup', () => { _hodo3d.dragging = false; });
    window.addEventListener('mousemove', e => {
      if (!_hodo3d.dragging || !_hodo3d.data) return;
      const dx = e.clientX - _hodo3d.lastX;
      const dy = e.clientY - _hodo3d.lastY;
      _hodo3d.lastX = e.clientX;
      _hodo3d.lastY = e.clientY;
      _hodo3d.azimuth   -= dx * 0.5;
      _hodo3d.elevation  = Math.max(-85, Math.min(85, _hodo3d.elevation - dy * 0.4));
      _render3DHodograph();
    });
    c.addEventListener('wheel', e => {
      e.preventDefault();
      _hodo3d.zoom = Math.max(0.4, Math.min(3.0, _hodo3d.zoom * (e.deltaY < 0 ? 1.1 : 0.91)));
      _render3DHodograph();
    }, { passive: false });
  }

  // ══ Update indices panel ═════════════════════════════════════
  function updateIndices(snd) {
    const { cape, cin } = capeCin(snd);
    const ki = kIndex(snd);
    const tt = totalTotals(snd);
    const li = liftedIndex(snd);
    const pw = precipWater(snd);
    const t500 = interpField(snd, 500, 'temp');
    const sfc  = snd[0] || {};

    const setEl = (id, txt, cls) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.textContent = txt;
      el.className = 'snd-idx-val' + (cls ? ' ' + cls : '');
    };

    const fmt = (v, d) => (v == null || !isFinite(v)) ? '—' : v.toFixed(d);

    const capeClass = cape > 2500 ? 'severe' : cape > 1000 ? 'moderate' : cape > 250 ? 'marginal' : 'calm';
    const cinClass  = Math.abs(cin) > 100 ? 'severe' : Math.abs(cin) > 50 ? 'moderate' : 'calm';
    const liClass   = li   == null ? '' : li   < -6 ? 'severe' : li < -3 ? 'moderate' : li < 0 ? 'marginal' : 'calm';
    const kiClass   = ki   == null ? '' : ki   > 40 ? 'severe' : ki > 30 ? 'moderate' : ki > 20 ? 'marginal' : 'calm';
    const ttClass   = tt   == null ? '' : tt   > 55 ? 'severe' : tt > 50 ? 'moderate' : tt > 44 ? 'marginal' : 'calm';

    setEl('snd-i-cape',  fmt(cape, 0) + ' J/kg', capeClass);
    setEl('snd-i-cin',   fmt(cin,  0) + ' J/kg', cinClass);
    setEl('snd-i-li',    fmt(li,   1),            liClass);
    setEl('snd-i-ki',    fmt(ki,   1),            kiClass);
    const toF = c => (c != null && isFinite(c)) ? c * 9 / 5 + 32 : null;
    setEl('snd-i-pw',    pw != null && isFinite(pw) ? (pw / 25.4).toFixed(2) + ' in' : '—', '');
    setEl('snd-i-t500',  fmt(toF(t500), 1) + ' °F',   '');
    setEl('snd-i-sfct',  fmt(toF(sfc.temp), 1) + ' °F', '');
    setEl('snd-i-sfctd', fmt(toF(sfc.dwpt), 1) + ' °F', '');
    const rh = sfc.relh != null ? sfc.relh
             : (sfc.temp != null && sfc.dwpt != null ? Math.round(100 * es(sfc.dwpt) / es(sfc.temp)) : null);
    setEl('snd-i-sfcrh', rh != null ? rh + ' %' : '—', '');

    // ── Hazard card ──────────────────────────────────────────────
    const hazard = classifyHazard(snd);
    if (hazard && _dom.hazardCard) {
      _dom.hazardCard.style.display = '';
      if (_dom.hazardType) {
        _dom.hazardType.textContent = hazard.type;
        _dom.hazardType.style.color = hazard.color;
      }
      _dom.hazardCard.style.borderColor = hexToRgba(hazard.color, 0.45);
    }
  }

  function hexToRgba(hex, a) {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
    if (!m) return 'rgba(139,32,192,0.45)';
    return `rgba(${parseInt(m[1],16)},${parseInt(m[2],16)},${parseInt(m[3],16)},${a})`;
  }

  // ══ Populate data table ════════════════════════════════════════
  function populateTable(snd) {
    const tbody = _dom.tableTbody;
    if (!tbody) return;
    tbody.innerHTML = '';
    const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
    const wDir = d => d == null ? '—' : dirs[Math.round(d / 22.5) % 16];
    const f1  = v => v != null && isFinite(v) ? v.toFixed(1) : '—';
    const f0  = v => v != null && isFinite(v) ? v.toFixed(0) : '—';

    const toF = c => c != null && isFinite(c) ? c * 9 / 5 + 32 : null;
    const hgtFt = m => m != null && isFinite(m) ? Math.round(m * 3.28084) : null;
    for (const s of snd) {
      const tr = document.createElement('tr');
      tr.innerHTML =
        `<td class="td-pres">${f0(s.pres)}</td>` +
        `<td>${f0(hgtFt(s.hght))}</td>` +
        `<td class="td-temp">${f1(toF(s.temp))}</td>` +
        `<td class="td-dwpt">${f1(toF(s.dwpt))}</td>` +
        `<td>${f0(s.relh)}</td>` +
        `<td class="td-wind">${wDir(s.drct)} ${s.sknt != null ? f0(s.sknt) + 'kt' : '—'}</td>`;
      tbody.appendChild(tr);
    }
  }

  // ══ Load sounding from URL ════════════════════════════════════
  async function loadSounding(wmo, year, month, day, hour) {
    _dom.fetchBtn.disabled = true;
    _dom.demoBtn.disabled  = true;

    let data = null, stationInfo = null, sourceLabel = '';

    try {
      // ── Fire UWyoming and NWS in parallel; take whichever has more levels ──
      setStatus('loading', 'Fetching sounding\u2026');
      const station  = STATIONS.find(s => s.wmo === wmo);
      const nwsCode  = station ? station.nws : null;
      const ageMs    = Date.now() - new Date(Date.UTC(year, month - 1, day, hour, 0, 0));
      const recentMs = 13 * 86400000;

      const uwPromise = fetchSounding(wmo, year, month, day, hour)
        .then(html => { const p = parseSounding(html); return p && p.data.length >= 5 ? p : null; })
        .catch(() => null);

      const nwsPromise = (nwsCode && ageMs >= 0 && ageMs < recentMs)
        ? fetchSoundingNWS(nwsCode, year, month, day, hour)
            .then(d => d && d.length >= 5 ? { data: d, stationInfo: null, nws: true } : null)
            .catch(() => null)
        : Promise.resolve(null);

      const [uwResult, nwsResult] = await Promise.all([uwPromise, nwsPromise]);

      // Prefer UWyoming (more levels); fall back to NWS
      if (uwResult) {
        data        = uwResult.data;
        stationInfo = uwResult.stationInfo;
        sourceLabel = 'UWyoming archive';
      } else if (nwsResult) {
        data        = nwsResult.data;
        sourceLabel = `NWS ${nwsCode}`;
      }

      if (!data) {
        setStatus('error', 'No data returned. The sounding may not exist for this station/time. Try a different date, check the WMO number, or note the archive may be temporarily unavailable.');
        showEmpty(); return;
      }

      const mm = String(month).padStart(2, '0'), dd = String(day).padStart(2, '0'), hh = String(hour).padStart(2, '0');
      _setInfoCard(stationInfo || wmo, wmo, `${year}-${mm}-${dd} ${hh}:00 UTC`, data.length + ' levels');

      _dom.mainLayout.style.display = '';
      _dom.tableWrap.style.display  = '';
      _dom.emptyState.style.display = 'none';

      drawSkewT(data);
      drawHodograph(data);
      draw3DHodograph(data);
      updateIndices(data);
      populateTable(data);

      setStatus('good', `Loaded \u2014 ${stationInfo || ('WMO ' + wmo)} \u00B7 ${sourceLabel}`);
    } catch (err) {
      console.error('[SoundingViewer]', err);
      setStatus('error', 'Fetch failed: ' + err.message + '. The archive may be down or the CORS proxy may be unavailable.');
      showEmpty();
    } finally {
      _dom.fetchBtn.disabled = false;
      _dom.demoBtn.disabled  = false;
    }
  }

  // ══ Demo sounding (classic supercell — Oklahoma June) ════════
  function loadDemo() {
    const demo = [
      { pres: 974, hght:   388, temp: 29.0, dwpt: 20.0, relh: 60, mixr: 14.9, drct: 185, sknt:  8 },
      { pres: 952, hght:   579, temp: 27.2, dwpt: 19.5, relh: 63, mixr: 14.3, drct: 200, sknt: 12 },
      { pres: 925, hght:   813, temp: 25.0, dwpt: 17.0, relh: 60, mixr: 12.5, drct: 210, sknt: 14 },
      { pres: 900, hght:  1040, temp: 22.5, dwpt: 14.0, relh: 57, mixr: 10.7, drct: 215, sknt: 16 },
      { pres: 850, hght:  1490, temp: 19.0, dwpt:  8.0, relh: 49, mixr:  7.9, drct: 220, sknt: 22 },
      { pres: 800, hght:  1967, temp: 15.4, dwpt:  2.4, relh: 44, mixr:  6.1, drct: 230, sknt: 28 },
      { pres: 750, hght:  2470, temp: 12.0, dwpt: -2.0, relh: 42, mixr:  5.2, drct: 235, sknt: 33 },
      { pres: 700, hght:  3013, temp:  7.8, dwpt: -6.0, relh: 38, mixr:  4.3, drct: 240, sknt: 38 },
      { pres: 650, hght:  3598, temp:  3.2, dwpt:-11.0, relh: 34, mixr:  3.3, drct: 248, sknt: 44 },
      { pres: 600, hght:  4230, temp: -1.8, dwpt:-16.0, relh: 31, mixr:  2.5, drct: 255, sknt: 50 },
      { pres: 550, hght:  4916, temp: -7.2, dwpt:-22.0, relh: 29, mixr:  1.9, drct: 260, sknt: 55 },
      { pres: 500, hght:  5660, temp:-13.0, dwpt:-28.0, relh: 27, mixr:  1.4, drct: 263, sknt: 58 },
      { pres: 450, hght:  6480, temp:-19.3, dwpt:-36.0, relh: 24, mixr:  0.9, drct: 267, sknt: 60 },
      { pres: 400, hght:  7400, temp:-26.5, dwpt:-44.0, relh: 22, mixr:  0.5, drct: 270, sknt: 62 },
      { pres: 350, hght:  8420, temp:-34.5, dwpt:-53.0, relh: 19, mixr:  0.3, drct: 272, sknt: 58 },
      { pres: 300, hght:  9600, temp:-43.0, dwpt:-63.0, relh: 18, mixr:  0.1, drct: 275, sknt: 52 },
      { pres: 250, hght: 10870, temp:-52.0, dwpt:-73.0, relh: 16, mixr:  0.1, drct: 272, sknt: 44 },
      { pres: 200, hght: 12400, temp:-57.5, dwpt:-78.0, relh: 16, mixr:  0.0, drct: 268, sknt: 36 },
      { pres: 150, hght: 14300, temp:-60.0, dwpt:-80.0, relh: 14, mixr:  0.0, drct: 260, sknt: 25 },
      { pres: 100, hght: 16700, temp:-61.5, dwpt:-82.0, relh: 12, mixr:  0.0, drct: 255, sknt: 18 },
    ];

    _setInfoCard('Demo — Classic Supercell Profile', 'N/A', 'Synthetic profile', demo.length + ' levels');
    _dom.mainLayout.style.display = '';
    _dom.tableWrap.style.display  = '';
    _dom.emptyState.style.display = 'none';

    drawSkewT(demo);
    drawHodograph(demo);
    draw3DHodograph(demo);
    updateIndices(demo);
    populateTable(demo);
    setStatus('good', 'Demo loaded — supercell-favorable Oklahoma sounding (synthetic)');
  }

  // ══ Helpers ════════════════════════════════════════════════════
  function setStatus(type, msg) {
    if (!_dom.status) return;
    _dom.status.textContent = msg;
    _dom.status.className   = 'snd-status ' + type;
  }

  function showEmpty() {
    if (_dom.mainLayout) _dom.mainLayout.style.display = 'none';
    if (_dom.tableWrap)  _dom.tableWrap.style.display  = 'none';
    if (_dom.emptyState) _dom.emptyState.style.display = '';
  }

  function _setInfoCard(name, wmo, dateStr, levels) {
    const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
    set('snd-station-name',   name);
    set('snd-station-wmo',    wmo);
    set('snd-station-date',   dateStr);
    set('snd-station-levels', levels);
  }

  // ══ DOM init ═══════════════════════════════════════════════════
  function initDom() {
    _dom.backBtn     = document.getElementById('sounding-back-btn');
    _dom.stationSel  = document.getElementById('snd-station-select');
    _dom.wmoInput    = null; // removed — WMO read from station select
    _dom.yearInput   = document.getElementById('snd-year');
    _dom.monthInput  = document.getElementById('snd-month');
    _dom.dayInput    = document.getElementById('snd-day');
    _dom.hourSel     = document.getElementById('snd-hour');
    _dom.fetchBtn    = document.getElementById('snd-fetch-btn');
    _dom.demoBtn     = document.getElementById('snd-demo-btn');
    _dom.status      = document.getElementById('snd-status');
    _dom.mainLayout  = document.getElementById('snd-main-layout');
    _dom.tableWrap   = document.getElementById('snd-table-wrap');
    _dom.emptyState  = document.getElementById('snd-empty-state');
    _dom.skewtCanvas  = document.getElementById('snd-skewt-canvas');
    _dom.skewtTip     = document.getElementById('snd-skewt-tip');
    _dom.hodoCanvas   = document.getElementById('snd-hodo-canvas');
    _dom.hodo3dCanvas = document.getElementById('snd-hodo-3d-canvas');
    _dom.hodoToggle   = document.getElementById('snd-hodo-toggle-btn');
    _dom.tableTbody   = document.getElementById('snd-data-tbody');
    _dom.hodoCard     = document.getElementById('snd-hodo-card');
    _dom.hodo3dFsBtn  = document.getElementById('snd-hodo3d-fs-btn');
    _dom.hazardCard   = document.getElementById('snd-hazard-card');
    _dom.hazardIcon   = document.getElementById('snd-hazard-icon');
    _dom.hazardType   = document.getElementById('snd-hazard-type');
    _dom.hazardDesc   = document.getElementById('snd-hazard-desc');
  }

  function wireEvents() {
    // Back → model explorer
    _dom.backBtn.addEventListener('click', function () {
      if (window._showModelExplorer) window._showModelExplorer();
    });

    // Populate station dropdown
    STATIONS.forEach(s => {
      const opt = document.createElement('option');
      opt.value       = s.wmo;
      opt.textContent = `${s.wmo}  ${s.name}`;
      _dom.stationSel.appendChild(opt);
    });

    // Station select drives WMO directly
    _dom.stationSel.addEventListener('change', function () {});

    // Default date: yesterday UTC
    const yesterday = new Date(Date.now() - 86400000);
    _dom.yearInput.value  = yesterday.getUTCFullYear();
    _dom.monthInput.value = String(yesterday.getUTCMonth() + 1).padStart(2, '0');
    _dom.dayInput.value   = String(yesterday.getUTCDate()).padStart(2, '0');

    // Fetch button
    _dom.fetchBtn.addEventListener('click', function () {
      const wmo   = _dom.stationSel.value.trim();
      const year  = parseInt(_dom.yearInput.value);
      const month = parseInt(_dom.monthInput.value);
      const day   = parseInt(_dom.dayInput.value);
      const hour  = parseInt(_dom.hourSel.value);
      if (!wmo)                        { setStatus('error', 'Select a station.'); return; }
      if (!year || !month || !day)     { setStatus('error', 'Fill in the date fields.');    return; }
      if (month < 1 || month > 12)     { setStatus('error', 'Month must be 1–12.');          return; }
      if (day   < 1 || day   > 31)     { setStatus('error', 'Day must be 1–31.');             return; }
      loadSounding(wmo, year, month, day, hour);
    });

    // Demo button
    _dom.demoBtn.addEventListener('click', loadDemo);

    // 2D / 3D toggle
    _dom.hodoToggle.addEventListener('click', function () {
      const is3d = _dom.hodo3dCanvas.style.display !== 'none';
      _dom.hodoCanvas.style.display   = is3d  ? '' : 'none';
      _dom.hodo3dCanvas.style.display = is3d  ? 'none' : '';
      _dom.hodoToggle.classList.toggle('active', !is3d);
      _dom.hodo3dFsBtn.style.display  = is3d  ? 'none' : '';  // show when 3D active
      if (!is3d && _hodo3d.data) _render3DHodograph();
    });

    // 3D fullscreen button
    _dom.hodo3dFsBtn.addEventListener('click', function () {
      if (!document.fullscreenElement) {
        _dom.hodoCard.requestFullscreen().catch(function (err) {
          console.warn('Fullscreen request failed:', err.message);
        });
      } else {
        document.exitFullscreen();
      }
    });

    // Fullscreen change
    document.addEventListener('fullscreenchange', function () {
      const isFS = document.fullscreenElement === _dom.hodoCard;
      _dom.hodo3dFsBtn.textContent = isFS ? '✕ Exit' : '⛶';
      const titleEl = document.getElementById('snd-hodo-title');
      if (titleEl) titleEl.textContent = isFS ? '3D VWP (Vertical Wind Profile)' : 'Hodograph';
      _dom.hodo3dCanvas.style.transform = '';
      if (_hodo3d.data) _render3DHodograph();
    });

    // Enter key on inputs
    [_dom.yearInput, _dom.monthInput, _dom.dayInput].forEach(el => {
      el.addEventListener('keydown', e => { if (e.key === 'Enter') _dom.fetchBtn.click(); });
    });

    // Skew-T hover tooltip
    _dom.skewtCanvas.addEventListener('mousemove', function (e) {
      const rect = _dom.skewtCanvas.getBoundingClientRect();
      const mx   = (e.clientX - rect.left)  * (_dom.skewtCanvas.width  / rect.width);
      const my   = (e.clientY - rect.top)   * (_dom.skewtCanvas.height / rect.height);
      let closest = null, bestD = 22;
      for (const h of _skewHits) {
        const d = Math.hypot(mx - h.x, my - h.y);
        if (d < bestD) { bestD = d; closest = h; }
      }
      if (!closest) { _dom.skewtTip.style.display = 'none'; return; }
      const lines = [
        `<span style="color:rgba(200,180,255,0.65);font-size:10px">${closest.pres} hPa</span>`,
      ];
      if (closest.temp != null) lines.push(`<span style="color:#ff8888">Temp\u202F${closest.temp.toFixed(1)}\u202F\u00B0C</span>`);
      if (closest.dwpt != null) lines.push(`<span style="color:#66ee99">Dew\u202F${closest.dwpt.toFixed(1)}\u202F\u00B0C</span>`);
      if (closest.relh != null) lines.push(`<span style="color:rgba(180,200,255,0.7)">RH\u202F${closest.relh}%</span>`);
      if (closest.wind != null) lines.push(`<span style="color:rgba(180,180,200,0.55)">${closest.wind}</span>`);
      _dom.skewtTip.innerHTML = lines.join('<br>');
      const cx  = e.clientX - rect.left, cy = e.clientY - rect.top;
      const th  = lines.length * 19 + 10, tw = 138;
      const lft = cx + 14 + tw > rect.width  ? cx - tw - 8 : cx + 14;
      const top = cy - th / 2 < 0            ? 4           : Math.min(cy - th / 2, rect.height - th - 4);
      _dom.skewtTip.style.left    = lft + 'px';
      _dom.skewtTip.style.top     = top + 'px';
      _dom.skewtTip.style.display = 'block';
    });
    _dom.skewtCanvas.addEventListener('mouseleave', function () {
      _dom.skewtTip.style.display = 'none';
    });
  }

  // ══ TREP — Tornado Risk Evaluation Parameter ════════════════════
  // Algorithm: Modified STP (Thompson, Edwards, Hart & Elmore 2003 WAF;
  // Thompson et al. 2012 WAF). Forecast data: Open-Meteo GFS API.

  function _lclHeightAGL(snd) {
    const sfc = snd[0];
    if (!sfc || sfc.temp == null || sfc.dwpt == null || sfc.pres == null || sfc.hght == null) return null;
    const pLCL = Math.min(plcl(sfc.temp, sfc.dwpt, sfc.pres), sfc.pres);
    for (let i = 0; i < snd.length - 1; i++) {
      const a = snd[i], b = snd[i + 1];
      if (a.pres >= pLCL && b.pres <= pLCL && a.hght != null && b.hght != null) {
        const f = (Math.log(a.pres) - Math.log(pLCL)) / (Math.log(a.pres) - Math.log(b.pres));
        return a.hght + f * (b.hght - a.hght) - sfc.hght;
      }
    }
    return null;
  }

  function _dwptFromRH(T, rh) {
    if (T == null || rh == null || rh <= 0) return null;
    const e = (rh / 100) * es(T);
    if (e <= 0) return null;
    return 243.5 * Math.log(e / 6.112) / (17.67 - Math.log(e / 6.112));
  }

  async function _trepGeocode(query) {
    const ll = query.match(/^(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)$/);
    if (ll) {
      const lat = parseFloat(ll[1]), lon = parseFloat(ll[2]);
      if (lat < 24 || lat > 50 || lon < -125 || lon > -65)
        throw new Error('Coordinates outside CONUS (lat 24\u201350\u00b0N, lon 65\u2013125\u00b0W).');
      return { lat, lon, name: `${lat.toFixed(3)}, ${lon.toFixed(3)}` };
    }
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=5&language=en&format=json`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const json = await resp.json();
    if (!json.results || json.results.length === 0)
      throw new Error('Location not found. Try "City, ST" or "lat, lon".');
    const us = json.results.find(r => r.country_code === 'US') || json.results[0];
    if (us.country_code !== 'US')
      throw new Error('Only CONUS locations supported. Try "City, ST".');
    const lat = us.latitude, lon = us.longitude;
    if (lat < 24 || lat > 50 || lon < -125 || lon > -65)
      throw new Error('Location is outside CONUS boundaries.');
    return { lat, lon, name: `${us.name}${us.admin1 ? ', ' + us.admin1 : ''}` };
  }

  async function _fetchModelSounding(lat, lon, hrOffset, model) {
    const isHRRR = model === 'gfs_hrrr';
    // HRRR omits 400/300 hPa and has a 48hr horizon; GFS goes full depth at 3 days
    const LEVELS       = isHRRR ? [1000, 925, 850, 700, 600, 500] : [1000, 925, 850, 700, 600, 500, 400, 300];
    const forecastDays = isHRRR ? 2 : 3;
    const modelParam   = model || 'gfs_seamless';
    const bld = prefix => LEVELS.map(l => `${prefix}_${l}hPa`).join(',');
    const hourly = [
      bld('temperature'), bld('relative_humidity'),
      bld('wind_speed'), bld('wind_direction'), bld('geopotential_height'),
      'temperature_2m,dewpoint_2m,surface_pressure,wind_speed_10m,wind_direction_10m',
    ].join(',');
    const url = `https://api.open-meteo.com/v1/gfs?latitude=${lat}&longitude=${lon}` +
      `&hourly=${hourly}&timezone=UTC&forecast_days=${forecastDays}&models=${modelParam}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!resp.ok) throw new Error(`${modelParam} fetch failed (HTTP ${resp.status})`);
    const json = await resp.json();
    if (json.error) throw new Error(json.reason || `Open-Meteo ${modelParam} error`);

    const KMH_TO_KT = 0.539957;
    const target = new Date(Date.now() + hrOffset * 3600000);
    const times  = json.hourly.time;
    let idx = 0, minD = Infinity;
    for (let i = 0; i < times.length; i++) {
      const d = Math.abs(new Date(times[i] + ':00Z') - target);
      if (d < minD) { minD = d; idx = i; }
    }

    const h   = json.hourly;
    const get = k => (h[k] ? h[k][idx] : null);
    const sfcPres = get('surface_pressure');
    const sfcElev = json.elevation || 0;
    const snd = [];

    const sfcT = get('temperature_2m'), sfcTd = get('dewpoint_2m');
    const sfcWS = get('wind_speed_10m'), sfcWD = get('wind_direction_10m');
    if (sfcT != null) {
      snd.push({
        pres: sfcPres || 1000,
        hght: sfcElev + 10,
        temp: sfcT,
        dwpt: sfcTd,
        relh: sfcTd != null ? Math.round(100 * es(sfcTd) / es(sfcT)) : null,
        sknt: sfcWS != null ? sfcWS * KMH_TO_KT : null,
        drct: sfcWD,
      });
    }

    for (const p of LEVELS) {
      if (sfcPres && p > sfcPres + 10) continue;
      const T  = get(`temperature_${p}hPa`);
      const RH = get(`relative_humidity_${p}hPa`);
      const WS = get(`wind_speed_${p}hPa`);
      const WD = get(`wind_direction_${p}hPa`);
      const GH = get(`geopotential_height_${p}hPa`);
      if (T == null || GH == null) continue;
      snd.push({
        pres: p, hght: GH, temp: T,
        dwpt: _dwptFromRH(T, RH), relh: RH,
        sknt: WS != null ? WS * KMH_TO_KT : null, drct: WD,
      });
    }
    snd.sort((a, b) => b.pres - a.pres);
    return { snd, validTime: times[idx] };
  }

  function _computeTREP(snd) {
    const { cape, cin } = capeCin(snd);
    const srh1 = stormRelHelicity(snd, 1000);  // m²/s²
    const shr6 = bulkShear(snd, 6000);          // knots
    const lclM = _lclHeightAGL(snd);            // m AGL

    // Thompson et al. 2003/2012 STP factors
    const capeFac = Math.max(cape - 100, 0) / 1500;
    const srhFac  = Math.max(srh1 || 0,  0) / 150;
    const shrFac  = ((shr6 || 0) * 0.51444) / 20;
    const lclFac  = lclM != null ? (lclM < 2000 ? (2000 - lclM) / 1500 : 0) : 0.5;
    const cinFac  = Math.min(1, Math.max(0, (150 + cin) / 125));
    const rawSTP  = Math.max(capeFac * srhFac * shrFac * lclFac * cinFac, 0);

    // Scale to 1–10: STP ~0 → 1, STP ~8+ → 10
    const score = Math.round(Math.min(1 + rawSTP * (9 / 8), 10));

    return { score, rawSTP, cape, cin, srh1, shr6, lclM };
  }

  function _trepColor(s) {
    if (s >= 9) return '#ff1111';
    if (s >= 7) return '#ff4400';
    if (s >= 5) return '#ff8800';
    if (s >= 3) return '#cccc22';
    return '#6db56d';
  }

  async function _runTREP() {
    const locEl    = document.getElementById('snd-trep-loc');
    const hrSel    = document.getElementById('snd-trep-hour');
    const modelSel = document.getElementById('snd-trep-model');
    const statEl   = document.getElementById('snd-trep-status');
    const resEl    = document.getElementById('snd-trep-result');
    const query    = locEl ? locEl.value.trim() : '';
    const hrOff    = hrSel ? parseInt(hrSel.value) || 0 : 0;
    const model    = modelSel ? modelSel.value : 'gfs_seamless';
    const MODEL_LABELS = { gfs_seamless: 'GFS', gfs_hrrr: 'HRRR' };
    const modelLabel   = MODEL_LABELS[model] || 'GFS';

    if (!query) {
      statEl.textContent = 'Enter a CONUS location.';
      statEl.className   = 'snd-status error';
      return;
    }
    statEl.textContent  = 'Geocoding location\u2026';
    statEl.className    = 'snd-status loading';
    resEl.style.display = 'none';

    try {
      const geo = await _trepGeocode(query);
      statEl.textContent = `Fetching ${modelLabel} data for ${geo.name}\u2026`;

      const { snd, validTime } = await _fetchModelSounding(geo.lat, geo.lon, hrOff, model);
      if (snd.length < 4) throw new Error(`Insufficient ${modelLabel} pressure levels returned \u2014 try again.`);

      const { score, cape, cin, srh1, shr6, lclM } = _computeTREP(snd);
      const color = _trepColor(score);
      const fmt   = (v, d, u) => v != null && isFinite(v) ? v.toFixed(d) + (u || '') : '\u2014';

      const scoreEl  = document.getElementById('snd-trep-score');
      const paramsEl = document.getElementById('snd-trep-params');
      const validEl  = document.getElementById('snd-trep-valid');

      if (scoreEl)  { scoreEl.textContent = score; scoreEl.style.color = color; }
      if (validEl)  {
        const label = hrOff === 0 ? 'Analysis (Now)' : `+${hrOff} hr forecast`;
        validEl.textContent = `${geo.name}  \u00b7  ${validTime} UTC  \u00b7  ${modelLabel}  \u00b7  ${label}`;
      }
      if (paramsEl) paramsEl.innerHTML = [
        ['CAPE',    fmt(cape, 0, ' J/kg')],
        ['CIN',     fmt(cin,  0, ' J/kg')],
        ['SRH\u2080\u208b\u2081', fmt(srh1, 0, ' m\u00b2s\u207b\u00b2')],
        ['SHR\u2080\u208b\u2086', fmt(shr6, 0, ' kt')],
        ['LCL AGL', fmt(lclM != null ? lclM * 3.28084 : null, 0, ' ft')],
      ].map(([n, v]) =>
        `<div class="snd-trep-param-row"><span>${n}</span><span>${v}</span></div>`
      ).join('');

      resEl.style.display = '';
      statEl.textContent  = `TREP analysis complete \u00b7 ${geo.name}`;
      statEl.className    = 'snd-status good';
    } catch (err) {
      statEl.textContent = `Error: ${err.message}`;
      statEl.className   = 'snd-status error';
    }
  }

  function initTrep() {
    const btn = document.getElementById('snd-trep-btn');
    const inp = document.getElementById('snd-trep-loc');
    if (btn) btn.addEventListener('click', _runTREP);
    if (inp) inp.addEventListener('keydown', e => { if (e.key === 'Enter') _runTREP(); });
  }

  // ══ WSR-88D VAD Wind Profile (VWP) ══════════════════════════════
  const VWP_STATIONS = [
    // Northeast
    { id: 'BOX', name: 'Boston, MA (KBOX)' },
    { id: 'GYX', name: 'Portland, ME (KGYX)' },
    { id: 'CBW', name: 'Caribou, ME (KCBW)' },
    { id: 'BGM', name: 'Binghamton, NY (KBGM)' },
    { id: 'BUF', name: 'Buffalo, NY (KBUF)' },
    { id: 'ENX', name: 'Albany, NY (KENX)' },
    { id: 'OKX', name: 'New York City, NY (KOKX)' },
    { id: 'TYX', name: 'Fort Drum, NY (KTYX)' },
    { id: 'DIX', name: 'Mt. Holly, NJ (KDIX)' },
    { id: 'DOX', name: 'Dover, DE (KDOX)' },
    { id: 'CCX', name: 'State College, PA (KCCX)' },
    { id: 'PBZ', name: 'Pittsburgh, PA (KPBZ)' },
    { id: 'CXX', name: 'Burlington, VT (KCXX)' },
    // Mid-Atlantic / Appalachian
    { id: 'AKQ', name: 'Wakefield, VA (KAKQ)' },
    { id: 'LWX', name: 'Sterling, VA (KLWX)' },
    { id: 'FCX', name: 'Roanoke, VA (KFCX)' },
    { id: 'RLX', name: 'Charleston, WV (KRLX)' },
    { id: 'MHX', name: 'Morehead City, NC (KMHX)' },
    { id: 'RAX', name: 'Raleigh-Durham, NC (KRAX)' },
    { id: 'GSP', name: 'Greenville-Spartanburg, SC (KGSP)' },
    { id: 'CAE', name: 'Columbia, SC (KCAE)' },
    { id: 'CLX', name: 'Charleston, SC (KCLX)' },
    { id: 'LTX', name: 'Wilmington, NC (KLTX)' },
    // Southeast / Florida
    { id: 'FFC', name: 'Atlanta, GA (KFFC)' },
    { id: 'JGX', name: 'Robins AFB, GA (KJGX)' },
    { id: 'VAX', name: 'Valdosta, GA (KVAX)' },
    { id: 'JAX', name: 'Jacksonville, FL (KJAX)' },
    { id: 'MLB', name: 'Melbourne, FL (KMLB)' },
    { id: 'TBW', name: 'Tampa Bay, FL (KTBW)' },
    { id: 'TLH', name: 'Tallahassee, FL (KTLH)' },
    { id: 'EVX', name: 'Eglin AFB, FL (KEVX)' },
    { id: 'BYX', name: 'Key West, FL (KBYX)' },
    // Deep South
    { id: 'MOB', name: 'Mobile, AL (KMOB)' },
    { id: 'BMX', name: 'Birmingham, AL (KBMX)' },
    { id: 'HTX', name: 'Huntsville, AL (KHTX)' },
    { id: 'MXX', name: 'Maxwell AFB, AL (KMXX)' },
    { id: 'EOX', name: 'Fort Rucker, AL (KEOX)' },
    { id: 'GWX', name: 'Columbus, MS (KGWX)' },
    { id: 'DGX', name: 'Jackson, MS (KDGX)' },
    { id: 'LCH', name: 'Lake Charles, LA (KLCH)' },
    { id: 'SHV', name: 'Shreveport, LA (KSHV)' },
    { id: 'POE', name: 'Fort Polk, LA (KPOE)' },
    // Texas / Southern Plains
    { id: 'HGX', name: 'Houston, TX (KHGX)' },
    { id: 'CRP', name: 'Corpus Christi, TX (KCRP)' },
    { id: 'BRO', name: 'Brownsville, TX (KBRO)' },
    { id: 'EWX', name: 'San Antonio, TX (KEWX)' },
    { id: 'GRK', name: 'Fort Hood, TX (KGRK)' },
    { id: 'FWS', name: 'Dallas-Fort Worth, TX (KFWS)' },
    { id: 'DYX', name: 'Abilene, TX (KDYX)' },
    { id: 'SJT', name: 'San Angelo, TX (KSJT)' },
    { id: 'LBB', name: 'Lubbock, TX (KLBB)' },
    { id: 'AMA', name: 'Amarillo, TX (KAMA)' },
    { id: 'MAF', name: 'Midland-Odessa, TX (KMAF)' },
    { id: 'EPZ', name: 'El Paso, TX (KEPZ)' },
    { id: 'DFX', name: 'Laughlin AFB, TX (KDFX)' },
    // Central Plains
    { id: 'TLX', name: 'Oklahoma City, OK (KTLX)' },
    { id: 'INX', name: 'Tulsa, OK (KINX)' },
    { id: 'VNX', name: 'Enid, OK (KVNX)' },
    { id: 'FDR', name: 'Frederick, OK (KFDR)' },
    { id: 'SRX', name: 'Fort Smith, AR (KSRX)' },
    { id: 'LZK', name: 'Little Rock, AR (KLZK)' },
    { id: 'DDC', name: 'Dodge City, KS (KDDC)' },
    { id: 'ICT', name: 'Wichita, KS (KICT)' },
    { id: 'TWX', name: 'Topeka, KS (KTWX)' },
    { id: 'EAX', name: 'Kansas City, MO (KEAX)' },
    { id: 'SGF', name: 'Springfield, MO (KSGF)' },
    { id: 'LSX', name: 'St. Louis, MO (KLSX)' },
    // Great Lakes / Midwest
    { id: 'IWX', name: 'Fort Wayne, IN (KIWX)' },
    { id: 'IND', name: 'Indianapolis, IN (KIND)' },
    { id: 'VWX', name: 'Evansville, IN (KVWX)' },
    { id: 'JKL', name: 'Jackson, KY (KJKL)' },
    { id: 'HPX', name: 'Fort Campbell, KY (KHPX)' },
    { id: 'LVX', name: 'Louisville, KY (KLVX)' },
    { id: 'PAH', name: 'Paducah, KY (KPAH)' },
    { id: 'MRX', name: 'Knoxville, TN (KMRX)' },
    { id: 'OHX', name: 'Nashville, TN (KOHX)' },
    { id: 'NQA', name: 'Memphis, TN (KNQA)' },
    { id: 'ILN', name: 'Cincinnati, OH (KILN)' },
    { id: 'CLE', name: 'Cleveland, OH (KCLE)' },
    { id: 'DTX', name: 'Detroit, MI (KDTX)' },
    { id: 'GRR', name: 'Grand Rapids, MI (KGRR)' },
    { id: 'APX', name: 'Gaylord, MI (KAPX)' },
    { id: 'MQT', name: 'Marquette, MI (KMQT)' },
    { id: 'LOT', name: 'Chicago, IL (KLOT)' },
    { id: 'ILX', name: 'Lincoln, IL (KILX)' },
    { id: 'DVN', name: 'Davenport, IA (KDVN)' },
    { id: 'DMX', name: 'Des Moines, IA (KDMX)' },
    { id: 'ARX', name: 'La Crosse, WI (KARX)' },
    { id: 'MKX', name: 'Milwaukee, WI (KMKX)' },
    { id: 'GRB', name: 'Green Bay, WI (KGRB)' },
    { id: 'DLH', name: 'Duluth, MN (KDLH)' },
    { id: 'MPX', name: 'Minneapolis, MN (KMPX)' },
    // Northern Plains
    { id: 'OAX', name: 'Omaha, NE (KOAX)' },
    { id: 'UEX', name: 'Hastings, NE (KUEX)' },
    { id: 'LNX', name: 'North Platte, NE (KLNX)' },
    { id: 'FSD', name: 'Sioux Falls, SD (KFSD)' },
    { id: 'ABR', name: 'Aberdeen, SD (KABR)' },
    { id: 'UDX', name: 'Rapid City, SD (KUDX)' },
    { id: 'MVX', name: 'Grand Forks, ND (KMVX)' },
    { id: 'BIS', name: 'Bismarck, ND (KBIS)' },
    { id: 'MBX', name: 'Minot, ND (KMBX)' },
    { id: 'GGW', name: 'Glasgow, MT (KGGW)' },
    { id: 'TFX', name: 'Great Falls, MT (KTFX)' },
    { id: 'MSX', name: 'Missoula, MT (KMSX)' },
    { id: 'BLX', name: 'Billings, MT (KBLX)' },
    // Mountain West
    { id: 'RIW', name: 'Riverton, WY (KRIW)' },
    { id: 'CYS', name: 'Cheyenne, WY (KCYS)' },
    { id: 'FTG', name: 'Denver, CO (KFTG)' },
    { id: 'PUX', name: 'Pueblo, CO (KPUX)' },
    { id: 'GJX', name: 'Grand Junction, CO (KGJX)' },
    { id: 'GLD', name: 'Goodland, KS (KGLD)' },
    { id: 'ICX', name: 'Cedar City, UT (KICX)' },
    { id: 'MTX', name: 'Salt Lake City, UT (KMTX)' },
    { id: 'SFX', name: 'Pocatello, ID (KSFX)' },
    { id: 'CBX', name: 'Boise, ID (KCBX)' },
    { id: 'ABX', name: 'Albuquerque, NM (KABX)' },
    { id: 'HDX', name: 'Holloman AFB, NM (KHDX)' },
    { id: 'FDX', name: 'Cannon AFB, NM (KFDX)' },
    { id: 'FSX', name: 'Flagstaff, AZ (KFSX)' },
    { id: 'EMX', name: 'Tucson, AZ (KEMX)' },
    { id: 'IWA', name: 'Phoenix, AZ (KIWA)' },
    { id: 'YUX', name: 'Yuma, AZ (KYUX)' },
    // West Coast
    { id: 'LGX', name: 'Langley Hill, WA (KLGX)' },
    { id: 'ATX', name: 'Seattle-Tacoma, WA (KATX)' },
    { id: 'OTX', name: 'Spokane, WA (KOTX)' },
    { id: 'PDT', name: 'Pendleton, OR (KPDT)' },
    { id: 'RTX', name: 'Portland, OR (KRTX)' },
    { id: 'MAX', name: 'Medford, OR (KMAX)' },
    { id: 'RGX', name: 'Reno, NV (KRGX)' },
    { id: 'ESX', name: 'Las Vegas, NV (KESX)' },
    { id: 'LRX', name: 'Elko, NV (KLRX)' },
    { id: 'BBX', name: 'Beale AFB, CA (KBBX)' },
    { id: 'DAX', name: 'Sacramento, CA (KDAX)' },
    { id: 'MUX', name: 'San Francisco, CA (KMUX)' },
    { id: 'HNX', name: 'San Joaquin Valley, CA (KHNX)' },
    { id: 'VTX', name: 'Los Angeles, CA (KVTX)' },
    { id: 'SOX', name: 'Santa Ana Mtns, CA (KSOX)' },
    { id: 'NKX', name: 'San Diego, CA (KNKX)' },
    { id: 'VBX', name: 'Vandenberg AFB, CA (KVBX)' },
    { id: 'EYX', name: 'Edwards AFB, CA (KEYX)' },
    { id: 'BHX', name: 'Eureka, CA (KBHX)' },
  ];

  // Fetch helper that falls back to CORS proxy for THREDDS
  async function _vwpFetch(url, mode) {
    mode = mode || 'text';
    const proxies = [
      url,
      'https://api.allorigins.win/raw?url=' + encodeURIComponent(url),
      'https://corsproxy.io/?url=' + encodeURIComponent(url),
    ];
    for (const p of proxies) {
      try {
        const resp = await fetch(p, { signal: AbortSignal.timeout(14000) });
        if (!resp.ok) continue;
        return mode === 'buffer' ? await resp.arrayBuffer() : await resp.text();
      } catch (e) { /* try next */ }
    }
    throw new Error('All fetch attempts failed for: ' + url);
  }

  // Populate the VWP station dropdown
  function _vwpPopulateStations() {
    const sel = document.getElementById('snd-vwp-station');
    if (!sel) return;
    sel.innerHTML = '<option value="">&#9013; select radar site</option>';
    VWP_STATIONS.forEach(function (s) {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.name;
      sel.appendChild(opt);
    });
  }

  // Set the VWP status message
  function _vwpStatus(msg, cls) {
    const el = document.getElementById('snd-vwp-status');
    if (!el) return;
    el.textContent = msg;
    el.className = 'snd-status' + (cls ? ' ' + cls : '');
  }

  // Fetch available scans for a station + date from UCAR THREDDS
  async function _vwpListScans() {
    const staSel = document.getElementById('snd-vwp-station');
    const datEl  = document.getElementById('snd-vwp-date');
    const scanRow = document.getElementById('snd-vwp-scan-row');
    const scanSel = document.getElementById('snd-vwp-scan-sel');
    if (!staSel || !datEl) return;

    const sid  = staSel.value.trim().toUpperCase();
    const date = datEl.value.replace(/-/g, '');  // YYYYMMDD

    if (!sid) { _vwpStatus('Select a radar site first.', 'error'); return; }
    if (!date || date.length !== 8) { _vwpStatus('Enter a valid date.', 'error'); return; }

    _vwpStatus('Querying THREDDS for ' + sid + ' · ' + date + '…', 'loading');
    if (scanRow) scanRow.style.display = 'none';

    const catalogUrl = 'https://thredds.ucar.edu/thredds/catalog/nexrad/level3/NVW/'
      + sid + '/' + date + '/catalog.html';

    let html;
    try {
      html = await _vwpFetch(catalogUrl, 'text');
    } catch (e) {
      _vwpStatus('Could not reach THREDDS catalog. Check station / date and try again.', 'error');
      return;
    }

    // Parse filenames: Level3_DMX_NVW_20260415_1620.nids
    const re = /Level3_[A-Z]{3}_NVW_\d{8}_\d{4}\.nids/g;
    const files = [...new Set(html.match(re) || [])];

    if (files.length === 0) {
      _vwpStatus('No NVW scans found for ' + sid + ' on ' + date + '. Try a different date.', 'error');
      return;
    }

    // Sort descending (most recent first)
    files.sort(function (a, b) { return b > a ? 1 : -1; });

    scanSel.innerHTML = '';
    files.forEach(function (f) {
      // Extract HHMM from filename
      const m = f.match(/_(\d{4})\.nids$/);
      const hhmm = m ? m[1].slice(0, 2) + ':' + m[1].slice(2) + ' UTC' : f;
      const opt = document.createElement('option');
      opt.value = f;
      opt.textContent = hhmm + ' — ' + f;
      scanSel.appendChild(opt);
    });

    if (scanRow) scanRow.style.display = '';
    _vwpStatus(files.length + ' scans available · select a time and click Load VWP', 'good');
  }

  // Download & parse a specific NVW NIDS file, then render
  async function _vwpLoadProfile() {
    const staSel = document.getElementById('snd-vwp-station');
    const datEl  = document.getElementById('snd-vwp-date');
    const scanSel = document.getElementById('snd-vwp-scan-sel');
    const canWrap = document.getElementById('snd-vwp-canvas-wrap');
    if (!staSel || !datEl || !scanSel) return;

    const sid      = staSel.value.trim().toUpperCase();
    const date     = datEl.value.replace(/-/g, '');
    const filename = scanSel.value;

    if (!sid || !date || !filename) { _vwpStatus('Select a station, date and scan first.', 'error'); return; }

    _vwpStatus('Downloading ' + filename + '…', 'loading');
    if (canWrap) canWrap.style.display = 'none';

    const fileUrl = 'https://thredds.ucar.edu/thredds/fileServer/nexrad/level3/NVW/'
      + sid + '/' + date + '/' + filename;

    let buf;
    try {
      buf = await _vwpFetch(fileUrl, 'buffer');
    } catch (e) {
      _vwpStatus('Download failed: ' + e.message, 'error');
      return;
    }

    let data;
    try {
      data = _vwpParseNids(buf, sid);
    } catch (e) {
      _vwpStatus('Parse error: ' + e.message, 'error');
      return;
    }

    if (!data || data.levels.length === 0) {
      _vwpStatus('No wind data found in this scan.', 'error');
      return;
    }

    _vwpRenderCanvas(data);
    _vwpStatus(
      'K' + sid + '  ·  ' + data.levels.length + ' levels  ·  '
      + (data.scanTime || filename.match(/_(\d{4})\.nids/)?.[1]?.replace(/(\d{2})(\d{2})/, '$1:$2') || '') + ' UTC',
      'good'
    );
  }

  // Parse NEXRAD Level-3 NVW (Product 48) binary NIDS file
  // Strategy: decode binary as Latin-1, search for ASCII wind-profile text sections
  function _vwpParseNids(buffer, stationId) {
    const bytes = new Uint8Array(buffer);
    // Decode entire file as Latin-1 (preserves all byte values)
    let raw = '';
    for (let i = 0; i < bytes.length; i++) raw += String.fromCharCode(bytes[i]);

    // Extract station metadata from text header pattern in file
    const staMeta = raw.match(/VAD +Station:\s*(\w+)\s+Lat:\s*([-\d.]+)\s+Lon:\s*([-\d.]+)\s+Alt:\s*(\d+)\s*ft\s+MSL/);
    const aglMeta = raw.match(/Hgh\s*=\s*(\d+)\s*ft\s+AGL/);

    // Extract scan time from binary MHB: bytes 4-7 = ms past midnight (uint32 big-endian)
    // bytes 2-3 = days since Jan 1, 1970 (uint16 big-endian) → but we have the time from filename too
    let scanTime = null;
    if (bytes.length >= 8) {
      const view = new DataView(buffer);
      const days = view.getUint16(2, false);   // big-endian
      const msec = view.getUint32(4, false);   // big-endian
      if (days > 0 && msec < 86400000) {
        const epoch = (days - 1) * 86400000 + msec;
        const d = new Date(epoch);
        const pad2 = n => String(n).padStart(2, '0');
        scanTime = pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + 'Z';
      }
    }

    // Wind profile data line pattern:
    // "  0.5   25  270   1.2   GS" or "  2.0   MM   MM   MM"
    const lineRe = /(?:^|\n)\s{1,4}(\d+\.\d)\s+(MM|\d+)\s+(MM|\d+)\s+(MM|\d+\.?\d*)\s*([A-Z]*)/gm;
    const levels = [];
    let m;
    while ((m = lineRe.exec(raw)) !== null) {
      const hgt  = parseFloat(m[1]);
      const spd  = m[2] === 'MM' ? null : parseInt(m[2], 10);
      const dir  = m[3] === 'MM' ? null : parseInt(m[3], 10);
      const rms  = m[4] === 'MM' ? null : parseFloat(m[4]);
      const edit = (m[5] || '').trim();

      // Sanity: height must be a valid VWP altitude
      if (hgt < 0.4 || hgt > 71) continue;
      // Speed can be null (missing) but if present must be reasonable
      if (spd !== null && (spd < 0 || spd > 300)) continue;
      // Direction must be 0-360
      if (dir !== null && (dir < 0 || dir > 360)) continue;

      levels.push({ hgt, spd, dir, rms, edit });
    }

    // Deduplicate by altitude (keep last occurrence)
    const seen = new Map();
    for (const lvl of levels) seen.set(lvl.hgt, lvl);
    const uniqueLevels = [...seen.values()].sort((a, b) => a.hgt - b.hgt);

    return {
      station:  staMeta ? staMeta[1] : ('K' + stationId),
      lat:      staMeta ? parseFloat(staMeta[2]) : null,
      lon:      staMeta ? parseFloat(staMeta[3]) : null,
      altMSL:   staMeta ? parseInt(staMeta[4], 10) : null,
      altAGL:   aglMeta ? parseInt(aglMeta[1], 10) : null,
      scanTime: scanTime,
      levels:   uniqueLevels,
    };
  }

  // Render the VWP wind-barb chart onto the canvas
  function _vwpRenderCanvas(data) {
    const canvas  = document.getElementById('snd-vwp-canvas');
    const canWrap = document.getElementById('snd-vwp-canvas-wrap');
    if (!canvas) return;

    const levels = data.levels;
    const maxHgt = Math.max(70, levels.length > 0 ? Math.ceil(levels[levels.length - 1].hgt) : 70);
    const DPR    = Math.min(window.devicePixelRatio || 1, 2);

    // Layout constants (logical px)
    const W  = 700, H = 780;
    const ML = 68,  MR = 20, MT = 44, MB = 36;   // margins
    const plotH = H - MT - MB;
    const AXIS_X = ML;
    const BARB_X = ML + 80;   // x-center of the barb column

    canvas.width  = W * DPR;
    canvas.height = H * DPR;
    canvas.style.width  = W + 'px';
    canvas.style.height = H + 'px';

    const ctx = canvas.getContext('2d');
    ctx.scale(DPR, DPR);

    // Background
    ctx.fillStyle = 'rgba(8, 4, 18, 0.97)';
    ctx.fillRect(0, 0, W, H);

    // Helper: altitude → y pixel
    function hy(hgt) {
      return H - MB - (hgt / maxHgt) * plotH;
    }

    // Speed → color
    function spColor(spd) {
      if (spd === null) return '#444';
      if (spd <  15)   return '#4caf50';   // calm/light: green
      if (spd <  30)   return '#ccd000';   // moderate: yellow
      if (spd <  50)   return '#ff8800';   // strong: orange
      if (spd <  80)   return '#e53935';   // very strong: red
      return '#cc00ee';                    // jet: purple
    }

    // ── Grid lines & altitude labels ──────────────────────────
    for (let h = 0; h <= maxHgt; h += 5) {
      const y = hy(h);
      const isMajor = h % 10 === 0;
      ctx.strokeStyle = isMajor ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.04)';
      ctx.lineWidth   = isMajor ? 0.8 : 0.4;
      ctx.beginPath();
      ctx.moveTo(ML, y);
      ctx.lineTo(W - MR, y);
      ctx.stroke();
      if (isMajor) {
        ctx.fillStyle  = 'rgba(200,180,255,0.5)';
        ctx.font       = '10px Consolas, monospace';
        ctx.textAlign  = 'right';
        ctx.fillText(h + ' kft', ML - 4, y + 3.5);
      }
    }

    // ── Axis line ──────────────────────────────────────────────
    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(AXIS_X, MT);
    ctx.lineTo(AXIS_X, H - MB);
    ctx.stroke();

    // ── Axis label (rotated) ───────────────────────────────────
    ctx.save();
    ctx.translate(14, (MT + H - MB) / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillStyle  = 'rgba(255,255,255,0.3)';
    ctx.font       = '10px Inter, sans-serif';
    ctx.textAlign  = 'center';
    ctx.fillText('ALTITUDE  (kft AGL)', 0, 0);
    ctx.restore();

    // ── Title ──────────────────────────────────────────────────
    ctx.fillStyle = 'rgba(180,110,255,0.9)';
    ctx.font      = 'bold 12px Inter, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(data.station + '  VAD Wind Profile', ML + 4, 18);
    if (data.scanTime) {
      ctx.fillStyle = 'rgba(255,255,255,0.4)';
      ctx.font      = '10px Consolas, monospace';
      ctx.fillText(data.scanTime, ML + 4, 30);
    }

    // ── Column headers ─────────────────────────────────────────
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.font      = '9px Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('kft', ML - 30, MT - 12);
    ctx.fillText('↑ Wind', BARB_X + 2, MT - 12);
    ctx.textAlign = 'left';
    ctx.fillText('Spd / Dir    RMS', BARB_X + 45, MT - 12);

    // ── Wind barbs & labels ────────────────────────────────────
    for (const lvl of levels) {
      const y     = hy(lvl.hgt);
      const color = spColor(lvl.spd);

      if (lvl.spd === null || lvl.dir === null) {
        // Missing: dot + M
        ctx.fillStyle = '#333';
        ctx.beginPath();
        ctx.arc(BARB_X, y, 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle  = '#444';
        ctx.font       = '8px Consolas, monospace';
        ctx.textAlign  = 'center';
        ctx.fillText('M', BARB_X + 25, y + 3);
      } else {
        _vwpDrawBarb(ctx, BARB_X, y, lvl.spd, lvl.dir, color);

        // Speed / direction text
        const spdStr = String(lvl.spd).padStart(3, ' ');
        const dirStr = String(lvl.dir).padStart(3, ' ');
        const rmsStr = lvl.rms != null ? lvl.rms.toFixed(1) : ' -- ';
        ctx.fillStyle  = 'rgba(255,255,255,0.55)';
        ctx.font       = '9.5px Consolas, monospace';
        ctx.textAlign  = 'left';
        ctx.fillText(spdStr + 'kt ' + dirStr + '\u00b0   ' + rmsStr, BARB_X + 44, y + 3.5);
      }

      // Small tick on axis
      ctx.strokeStyle = 'rgba(255,255,255,0.15)';
      ctx.lineWidth   = 0.5;
      ctx.beginPath();
      ctx.moveTo(AXIS_X - 3, y);
      ctx.lineTo(AXIS_X + 3, y);
      ctx.stroke();
    }

    // ── Speed legend ───────────────────────────────────────────
    const legend = [
      { color: '#4caf50', label: '< 15 kt' },
      { color: '#ccd000', label: '15–30 kt' },
      { color: '#ff8800', label: '30–50 kt' },
      { color: '#e53935', label: '50–80 kt' },
      { color: '#cc00ee', label: '≥ 80 kt' },
    ];
    let lx = ML + 4;
    const ly = H - 10;
    ctx.font = '9px Inter, sans-serif';
    for (const leg of legend) {
      ctx.fillStyle = leg.color;
      ctx.fillRect(lx, ly - 5, 18, 3);
      ctx.fillStyle = 'rgba(255,255,255,0.4)';
      ctx.textAlign = 'left';
      ctx.fillText(leg.label, lx + 22, ly);
      lx += 85;
    }

    if (canWrap) canWrap.style.display = '';
  }

  // Draw a single wind barb at (cx, cy) for given speed (kt) and direction (deg from)
  function _vwpDrawBarb(ctx, cx, cy, spd, dir, color) {
    const STAFF = 32;  // staff length in pixels
    const dirRad = dir * Math.PI / 180;  // direction wind comes FROM → staff points toward source

    const staffX = cx + Math.sin(dirRad) * STAFF;
    const staffY = cy - Math.cos(dirRad) * STAFF;

    ctx.strokeStyle = color;
    ctx.lineWidth   = 1.5;

    // Origin circle
    ctx.beginPath();
    ctx.arc(cx, cy, spd < 3 ? 4 : 2.5, 0, Math.PI * 2);
    if (spd < 3) {
      ctx.stroke();  // calm: open circle
      return;
    }
    ctx.fillStyle = color;
    ctx.fill();

    // Staff
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(staffX, staffY);
    ctx.stroke();

    // Barbs drawn along the staff, on the right side (looking from tip toward cx,cy)
    // Perpendicular-right direction: rotate dir 90° clockwise = dir + 90°
    const perpR = (dir + 90) * Math.PI / 180;
    const bpX = Math.sin(perpR);  // x component of right-perp unit vector
    const bpY = -Math.cos(perpR); // y component

    let remaining = Math.round(spd / 5) * 5;  // round to nearest 5 kt
    let pos = 0;  // distance along staff from cx,cy where next barb goes

    function barbPt(t) {
      return {
        x: cx + Math.sin(dirRad) * t,
        y: cy - Math.cos(dirRad) * t,
      };
    }

    // Pennants first (50 kt each) — filled triangle
    while (remaining >= 50) {
      const b0 = barbPt(pos);
      const b1 = barbPt(pos + 9);
      const tip = { x: b0.x + bpX * 11, y: b0.y + bpY * 11 };
      ctx.beginPath();
      ctx.moveTo(b0.x, b0.y);
      ctx.lineTo(b1.x, b1.y);
      ctx.lineTo(tip.x, tip.y);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
      pos += 10;
      remaining -= 50;
    }

    // Full barbs (10 kt each)
    while (remaining >= 10) {
      const bp = barbPt(pos);
      const ep = { x: bp.x + bpX * 10, y: bp.y + bpY * 10 };
      ctx.beginPath();
      ctx.moveTo(bp.x, bp.y);
      ctx.lineTo(ep.x, ep.y);
      ctx.stroke();
      pos += 7;
      remaining -= 10;
    }

    // Half barb (5 kt)
    if (remaining >= 5) {
      const startPos = Math.max(pos, 5);
      const bp = barbPt(startPos);
      const ep = { x: bp.x + bpX * 5.5, y: bp.y + bpY * 5.5 };
      ctx.beginPath();
      ctx.moveTo(bp.x, bp.y);
      ctx.lineTo(ep.x, ep.y);
      ctx.stroke();
    }
  }

  // Initialize VWP module
  function initVwp() {
    _vwpPopulateStations();

    // Set default date to today UTC
    const today = new Date();
    const pad2  = n => String(n).padStart(2, '0');
    const todayStr = today.getUTCFullYear() + '-'
      + pad2(today.getUTCMonth() + 1) + '-'
      + pad2(today.getUTCDate());
    const datEl = document.getElementById('snd-vwp-date');
    if (datEl) datEl.value = todayStr;

    const listBtn = document.getElementById('snd-vwp-list-btn');
    const loadBtn = document.getElementById('snd-vwp-load-btn');
    if (listBtn) listBtn.addEventListener('click', _vwpListScans);
    if (loadBtn) loadBtn.addEventListener('click', _vwpLoadProfile);
  }

  // ══ Public init ═════════════════════════════════════════════════
  let _initialized = false;
  window.soundingInit = function () {
    if (!_initialized) {
      _initialized = true;
      initDom();
      wireEvents();
      _init3DInteraction();
      initTrep();
      initVwp();
      showEmpty();
      setStatus('', 'Select a station and date, then click Fetch or try the Demo sounding.');
    }
  };

})();
