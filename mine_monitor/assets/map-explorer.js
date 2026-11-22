"use strict";

// Map explorer: a map-led view over the pinned pipeline outputs. It reads the
// existing fitted-NDVI bundle (frames, per-cell tiles, matched-control pairs),
// the class raster, the retained event records and the distance-band polygons.
// It derives nothing analytical and makes no live catalog requests; the only
// external request is the Queensland aerial basemap (on by default, can be switched off).
(() => {
  const NDVI_BASE = new URL("./ndvi/viewer/", document.baseURI);
  const TILE_SIZE = 128;
  const EVENT_RECORD_BYTES = 20;
  const TIER_NAMES = { 1: "T1", 2: "T2 · provisional", 3: "T3 · QA only" };
  const BAND_NAMES = { 1: "near", 2: "transition", 3: "far" };
  const BAND_STYLE = {
    near: { color: "#ffd54f", dash: [] },
    transition: { color: "#ffffff", dash: [6, 4] },
    far: { color: "#8fc4ff", dash: [2, 4] },
  };
  const NDVI_RAMP = [
    [-0.33, [122, 86, 78]],
    [0.12, [181, 143, 86]],
    [0.25, [209, 182, 102]],
    [0.39, [166, 178, 96]],
    [0.51, [128, 173, 91]],
    [0.59, [99, 157, 91]],
  ];
  const ONSET_RAMP = [[84, 48, 140], [33, 145, 140], [253, 231, 37]];
  const BASEMAP_ZOOM = 13;
  const BASEMAP_URL = (z, x, y) =>
    `https://spatial-img.information.qld.gov.au/arcgis/rest/services/Basemaps/LatestStateProgram_AllUsers/ImageServer/tile/${z}/${y}/${x}`;
  const nf = new Intl.NumberFormat("en-AU");
  const esc = (v) =>
    String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  const INFO_TYPES = {
    observation: ["Satellite observation", "Imagery as acquired. Only the aerial basemap is of this type; no observed per-pixel NDVI is published here."],
    derived: ["Derived measurement", "Fitted annual NDVI trajectory. Fitted values, not observations; gaps stay gaps."],
    interpretation: ["Analytical interpretation", "Potential disturbance onset and recovery records. Signals for follow-up, not proof of cause."],
    rule: ["Rule-based classification", "Six-class rule-based adaptation, unvalidated, pending M4 supervised validation."],
    regulatory: ["Regulatory conclusion", "Requires independent assessment. None is made or implied here."],
  };
  const chip = (type, text) => `<span class="mx-chip mx-${type}">${esc(text || INFO_TYPES[type][0])}</span>`;

  // MGA2020 zone 55 (GRS80, central meridian 147°E) inverse projection.
  const tm = (() => {
    const a = 6378137, f = 1 / 298.257222101, k0 = 0.9996, fe = 500000, fn = 10000000, lon0 = 147;
    const n = f / (2 - f);
    const A = (a / (1 + n)) * (1 + n * n / 4 + n ** 4 / 64);
    const h = [n / 2 - 2 * n * n / 3 + 37 * n ** 3 / 96, n * n / 48 + n ** 3 / 15, 17 * n ** 3 / 480];
    const d = [2 * n - 2 * n * n / 3 - 2 * n ** 3, 7 * n * n / 3 - 8 * n ** 3 / 5, 56 * n ** 3 / 15];
    return {
      inverse(E, N) {
        const xi = (N - fn) / (k0 * A), eta = (E - fe) / (k0 * A);
        let xp = xi, ep = eta;
        h.forEach((hj, i) => {
          const j = 2 * (i + 1);
          xp -= hj * Math.sin(j * xi) * Math.cosh(j * eta);
          ep -= hj * Math.cos(j * xi) * Math.sinh(j * eta);
        });
        const chi = Math.asin(Math.sin(xp) / Math.cosh(ep));
        let phi = chi;
        d.forEach((dj, i) => { phi += dj * Math.sin(2 * (i + 1) * chi); });
        return { lat: phi * 180 / Math.PI, lon: lon0 + Math.atan2(Math.sinh(ep), Math.cos(xp)) * 180 / Math.PI };
      },
    };
  })();

  const lerpRamp = (ramp, t) => {
    const x = Math.min(1, Math.max(0, t)) * (ramp.length - 1), i = Math.min(ramp.length - 2, Math.floor(x)), u = x - i;
    return ramp[i].map((v, k) => Math.round(v + (ramp[i + 1][k] - v) * u));
  };

  const gunzip = async (response) => {
    if (typeof DecompressionStream === "undefined") throw new Error("This browser does not support gzip decompression.");
    return new Response(response.body.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
  };

  const shared = { manifest: null, tiles: new Map(), pairs: new Map(), frames: new Map(), sensors: new Map(), basemap: null };

  const getManifest = () => {
    shared.manifest ??= fetch(new URL("manifest.json", NDVI_BASE), { cache: "no-cache" }).then((r) => {
      if (!r.ok) throw new Error(`Fitted-NDVI manifest request failed (${r.status}).`);
      return r.json();
    });
    return shared.manifest;
  };

  const fetchGz = async (path, expectedBytes) => {
    const response = await fetch(new URL(path, NDVI_BASE), { cache: "no-cache" });
    if (!response.ok) throw new Error(`Request for ${path} failed (${response.status}).`);
    const buffer = await gunzip(response);
    if (expectedBytes !== undefined && buffer.byteLength !== expectedBytes) throw new Error(`Unexpected length for ${path}.`);
    return buffer;
  };

  const getTile = async (sensor, row, col) => {
    const manifest = await getManifest(), info = manifest.sensors[sensor];
    const tr = Math.floor(row / TILE_SIZE), tc = Math.floor(col / TILE_SIZE);
    const years = info.end_year - info.start_year + 1, stride = 7 + years * 6;
    const height = Math.min(TILE_SIZE, info.height - tr * TILE_SIZE), width = Math.min(TILE_SIZE, info.width - tc * TILE_SIZE);
    const path = `${sensor}/tiles/${tr}_${tc}.bin.gz`;
    if (!shared.tiles.has(path)) shared.tiles.set(path, fetchGz(path, height * width * stride));
    const view = new DataView(await shared.tiles.get(path));
    return { view, width, tr, tc, years, stride };
  };

  const readPixel = (tile, info, row, col) => {
    const offset = ((row - tile.tr * TILE_SIZE) * tile.width + (col - tile.tc * TILE_SIZE)) * tile.stride;
    const { view, years } = tile;
    const fitted = [], counts = [];
    for (let i = 0; i < years; i += 1) {
      const v = view.getFloat32(offset + 7 + i * 4, true), c = view.getUint16(offset + 7 + years * 4 + i * 2, true);
      fitted.push(v === -9999 ? null : v);
      counts.push(c === 65535 ? null : c);
    }
    return {
      row, col, id: row * info.width + col, onset: view.getUint16(offset, true),
      eventId: view.getInt32(offset + 2, true), flags: view.getUint8(offset + 6), fitted, counts,
    };
  };

  const getPairs = async (sensor, pixel) => {
    const manifest = await getManifest();
    const path = `${sensor}/pairs/${Math.floor(pixel.row / TILE_SIZE)}_${Math.floor(pixel.col / TILE_SIZE)}.json.gz`;
    if (!manifest.files[path] || !pixel.onset) return [];
    if (!shared.pairs.has(path)) shared.pairs.set(path, fetchGz(path).then((b) => JSON.parse(new TextDecoder().decode(b))));
    return (await shared.pairs.get(path)).filter((r) => r[0] === pixel.id && r[2] === pixel.onset);
  };

  const getFrame = (sensor, yr) => {
    const key = `${sensor}/${yr}`;
    if (!shared.frames.has(key)) {
      shared.frames.set(key, new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error(`Fitted-NDVI frame ${yr} could not be loaded.`));
        img.src = new URL(`${sensor}/frames/${yr}.png`, NDVI_BASE).href;
      }));
    }
    return shared.frames.get(key);
  };

  const getSensorAssets = (sensor, item, dashboardUrl) => {
    if (!shared.sensors.has(sensor)) {
      const grid = item.class_map.grid;
      const eventsPromise = fetch(new URL(`${item.events.interactive_path}.gz`, dashboardUrl)).then(async (r) => {
        if (!r.ok) throw new Error(`Event records request failed (${r.status}).`);
        const buffer = await gunzip(r), view = new DataView(buffer);
        const count = view.getUint32(8, true);
        if (new TextDecoder().decode(new Uint8Array(buffer, 0, 8)) !== "DASH-EV1" || view.getUint16(12, true) !== EVENT_RECORD_BYTES
          || buffer.byteLength !== 16 + count * EVENT_RECORD_BYTES) throw new Error("The event records have an unknown binary format.");
        const cells = grid.width * grid.height;
        const ev = {
          onset: new Uint16Array(cells), recovery: new Uint16Array(cells), cls: new Uint8Array(cells), tier: new Uint8Array(cells),
          band: new Uint8Array(cells), flags: new Uint8Array(cells), comp: new Uint32Array(cells), id: new Uint32Array(cells), count,
        };
        for (let i = 0; i < count; i += 1) {
          const o = 16 + i * EVENT_RECORD_BYTES, idx = view.getUint16(o + 4, true) * grid.width + view.getUint16(o + 6, true);
          ev.id[idx] = view.getUint32(o, true); ev.onset[idx] = view.getUint16(o + 8, true); ev.recovery[idx] = view.getUint16(o + 10, true);
          ev.cls[idx] = view.getUint8(o + 12); ev.tier[idx] = view.getUint8(o + 13); ev.flags[idx] = view.getUint8(o + 14);
          ev.comp[idx] = view.getUint32(o + 15, true); ev.band[idx] = view.getUint8(o + 19);
        }
        return ev;
      });
      const classPromise = new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const c = document.createElement("canvas");
          c.width = img.width; c.height = img.height;
          const x = c.getContext("2d", { willReadFrequently: true });
          x.drawImage(img, 0, 0);
          resolve({ image: x.getImageData(0, 0, img.width, img.height), width: img.width, height: img.height });
        };
        img.onerror = () => reject(new Error("The class raster could not be loaded."));
        img.src = new URL(item.class_map.path, dashboardUrl).href;
      });
      const bandsPromise = fetch(new URL(item.orientation_path, dashboardUrl)).then((r) => {
        if (!r.ok) throw new Error(`Distance-band request failed (${r.status}).`);
        return r.json();
      }).then((geo) => {
        const [a, , c, , e, f] = grid.transform;
        return geo.features.map((feat) => {
          const path = new Path2D();
          const polys = feat.geometry.type === "Polygon" ? [feat.geometry.coordinates] : feat.geometry.coordinates;
          for (const poly of polys) for (const ring of poly) {
            ring.forEach(([E, N], i) => {
              const x = (E - c) / a, y = (N - f) / e;
              if (i === 0) path.moveTo(x, y); else path.lineTo(x, y);
            });
            path.closePath();
          }
          return { band: feat.properties.band, path };
        });
      });
      shared.sensors.set(sensor, { events: eventsPromise, classRaster: classPromise, bands: bandsPromise });
    }
    return shared.sensors.get(sensor);
  };

  const loadBasemap = (grid, onProgress) => {
    if (shared.basemap) return shared.basemap;
    shared.basemap = (async () => {
      const [a, , c, , e, f] = grid.transform, step = 16, nx = Math.ceil(grid.width / step) + 1, ny = Math.ceil(grid.height / step) + 1;
      const world = 256 * 2 ** BASEMAP_ZOOM, mx = new Float64Array(nx * ny), my = new Float64Array(nx * ny);
      for (let j = 0; j < ny; j += 1) for (let i = 0; i < nx; i += 1) {
        const { lat, lon } = tm.inverse(c + a * i * step, f + e * j * step), phi = lat * Math.PI / 180;
        mx[j * nx + i] = (lon + 180) / 360 * world;
        my[j * nx + i] = (1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2 * world;
      }
      const minX = Math.floor(Math.min(...mx) / 256), maxX = Math.floor(Math.max(...mx) / 256);
      const minY = Math.floor(Math.min(...my) / 256), maxY = Math.floor(Math.max(...my) / 256);
      const mosaic = document.createElement("canvas");
      mosaic.width = (maxX - minX + 1) * 256; mosaic.height = (maxY - minY + 1) * 256;
      const mctx = mosaic.getContext("2d", { willReadFrequently: true });
      const jobs = [];
      let done = 0, loaded = 0;
      for (let ty = minY; ty <= maxY; ty += 1) for (let tx = minX; tx <= maxX; tx += 1) {
        jobs.push(new Promise((resolve) => {
          const img = new Image();
          img.crossOrigin = "anonymous";
          img.onload = () => { mctx.drawImage(img, (tx - minX) * 256, (ty - minY) * 256); loaded += 1; done += 1; onProgress(done, jobs.length); resolve(); };
          img.onerror = () => { done += 1; onProgress(done, jobs.length); resolve(); };
          img.src = BASEMAP_URL(BASEMAP_ZOOM, tx, ty);
        }));
      }
      await Promise.all(jobs);
      if (!loaded) throw new Error("No aerial imagery tiles could be loaded (offline or blocked).");
      const src = mctx.getImageData(0, 0, mosaic.width, mosaic.height).data;
      const scale = 2, W = grid.width * scale, H = grid.height * scale;
      const out = document.createElement("canvas");
      out.width = W; out.height = H;
      const octx = out.getContext("2d"), img = octx.createImageData(W, H), dst = img.data;
      for (let y = 0; y < H; y += 1) {
        const gy = (y + 0.5) / scale / step, j = Math.min(ny - 2, Math.floor(gy)), v = gy - j;
        for (let x = 0; x < W; x += 1) {
          const gx = (x + 0.5) / scale / step, i = Math.min(nx - 2, Math.floor(gx)), u = gx - i;
          const k = j * nx + i;
          const px = (mx[k] * (1 - u) + mx[k + 1] * u) * (1 - v) + (mx[k + nx] * (1 - u) + mx[k + nx + 1] * u) * v - minX * 256;
          const py = (my[k] * (1 - u) + my[k + 1] * u) * (1 - v) + (my[k + nx] * (1 - u) + my[k + nx + 1] * u) * v - minY * 256;
          const s = ((Math.floor(py) * mosaic.width) + Math.floor(px)) * 4, d = (y * W + x) * 4;
          dst[d] = src[s]; dst[d + 1] = src[s + 1]; dst[d + 2] = src[s + 2]; dst[d + 3] = src[s + 3] ? 255 : 0;
        }
      }
      octx.putImageData(img, 0, 0);
      return out;
    })();
    shared.basemap.catch(() => { shared.basemap = null; });
    return shared.basemap;
  };

  const sparkline = (years, series, { onset, current, startYear }) => {
    const W = 330, H = 190, m = { l: 36, r: 8, t: 10, b: 24 };
    const vals = series.flatMap((s) => s.values).filter((v) => v !== null);
    if (!vals.length) return '<p class="muted small">No fitted values are recorded for this cell.</p>';
    const lo = Math.max(-1, Math.min(...vals) - 0.05), hi = Math.min(1, Math.max(...vals) + 0.05);
    const x = (yr) => m.l + ((yr - years[0]) / (years[years.length - 1] - years[0])) * (W - m.l - m.r);
    const y = (v) => m.t + (1 - (v - lo) / (hi - lo)) * (H - m.t - m.b);
    let svg = `<svg class="mx-spark" viewBox="0 0 ${W} ${H}" role="img" aria-label="Fitted NDVI by year">`;
    for (let k = 0; k <= 4; k += 1) {
      const v = lo + ((hi - lo) * k) / 4;
      svg += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}" class="mx-grid"/><text x="${m.l - 4}" y="${y(v) + 3}" class="mx-axis" text-anchor="end">${v.toFixed(2)}</text>`;
    }
    const step = years.length > 20 ? 5 : 2;
    years.forEach((yr) => { if ((yr - years[0]) % step === 0) svg += `<text x="${x(yr)}" y="${H - 6}" class="mx-axis" text-anchor="middle">${yr}</text>`; });
    if (onset) svg += `<line x1="${x(onset)}" x2="${x(onset)}" y1="${m.t}" y2="${H - m.b}" class="mx-onset"/><text x="${x(onset) + 3}" y="${m.t + 9}" class="mx-axis mx-onset-label">onset ${onset}</text>`;
    if (current >= years[0] && current <= years[years.length - 1]) svg += `<line x1="${x(current)}" x2="${x(current)}" y1="${m.t}" y2="${H - m.b}" class="mx-current"/>`;
    for (const s of series) {
      let d = "";
      s.values.forEach((v, i) => { d += v === null ? "" : `${d && s.values[i - 1] !== null && s.values[i - 1] !== undefined ? "L" : "M"}${x(years[i]).toFixed(1)},${y(v).toFixed(1)}`; });
      svg += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2"${s.dash ? ' stroke-dasharray="5 3"' : ""}/>`;
      s.values.forEach((v, i) => { if (v !== null) svg += `<circle cx="${x(years[i])}" cy="${y(v)}" r="2.2" fill="${s.color}"/>`; });
    }
    return `${svg}</svg>`;
  };

  const mount = (root, { data, dashboardUrl }) => {
    const abort = new AbortController();
    const state = {
      sensor: "landsat", layer: "ndvi", year: 2020, tier: 1, bands: true, base: false, opacity: 0.6,
      view: { x: 0, y: 0, s: 0.4 }, selected: null, panelToken: 0, hitContext: document.createElement("canvas").getContext("2d"), playing: null, baseCanvas: null, layerCanvas: document.createElement("canvas"), token: 0,
    };
    const item = () => data.sensors[state.sensor];
    const grid = () => item().class_map.grid;
    root.innerHTML = `
      <div class="mx-types" aria-label="Information types">
        ${Object.keys(INFO_TYPES).map((k) => `<div>${chip(k)}<span>${esc(INFO_TYPES[k][1])}</span></div>`).join("")}
      </div>
      <div class="mx-shell">
        <div class="mx-main">
          <div class="mx-toolbar">
            <div class="sensor-switch" role="group" aria-label="Choose one sensor product">
              <button type="button" data-mx-sensor="landsat">Landsat</button>
              <button type="button" data-mx-sensor="sentinel2">Sentinel-2</button>
            </div>
            <fieldset class="mx-layers"><legend>Map layer</legend>
              <label><input type="radio" name="mx-layer" value="ndvi" checked> Fitted NDVI ${chip("derived")}</label>
              <label><input type="radio" name="mx-layer" value="onset"> Potential disturbance onset ${chip("interpretation")}</label>
              <label><input type="radio" name="mx-layer" value="class"> Rule-based class ${chip("rule")}</label>
            </fieldset>
            <fieldset class="mx-overlays"><legend>Overlays</legend>
              <label><input type="checkbox" id="mx-bands" checked> Administrative distance strata</label>
              <label><input type="checkbox" id="mx-base"> Aerial imagery basemap ${chip("observation")}</label>
              <label>Layer opacity <input type="range" id="mx-opacity" min="0.2" max="1" step="0.05" value="0.6"></label>
              <label id="mx-tier-wrap" hidden>Event cohorts
                <select id="mx-tier"><option value="1">T1 only</option><option value="2">T1 + T2 provisional</option><option value="3">All incl. T3 QA-only</option></select>
              </label>
            </fieldset>
          </div>
          <div class="mx-timebar">
            <button type="button" id="mx-play" aria-label="Play years">▶ Play</button>
            <label>Year <input type="range" id="mx-year" min="1988" max="2026" step="1" value="2020" aria-describedby="mx-year-note"></label>
            <output id="mx-year-out" for="mx-year">2020</output>
            <span id="mx-year-note" class="muted small"></span>
          </div>
          <div class="mx-stage">
            <canvas id="mx-canvas" tabindex="0" role="application" aria-label="Map of the Curragh analysis area. Drag to pan, scroll or use plus and minus to zoom, click or press Enter to inspect the centre cell."></canvas>
            <div class="mx-zoom">
              <button type="button" data-mx-zoom="1" aria-label="Zoom in">+</button>
              <button type="button" data-mx-zoom="-1" aria-label="Zoom out">−</button>
              <button type="button" data-mx-zoom="0" aria-label="Fit whole area">⤢</button>
            </div>
            <div class="mx-scale" id="mx-scale"></div>
            <div class="mx-status" id="mx-status" role="status" aria-live="polite">Loading…</div>
          </div>
          <div class="mx-legend" id="mx-legend"></div>
          <p class="muted small mx-foot" id="mx-basemap-note" hidden>Aerial imagery: Queensland Imagery Latest State Program Public Basemap Service, © State of Queensland (Department of Resources), licensed CC BY 4.0; includes Planet Labs imagery reproduced under licence. Requested from the Queensland Government when switched on. Capture dates vary and are not the monitoring period; context only. Tiles are re-projected from Web Mercator to the MGA2020 zone 55 analysis grid for display.</p>
          <p class="muted small mx-foot">Not yet shown: lease boundaries and rehabilitation-area polygons are not in the pinned snapshot, so no polygon-level history is offered. Click any 30 m cell for its own history.</p>
        </div>
        <aside class="mx-panel" aria-label="Selected location" aria-live="polite" id="mx-panel"></aside>
      </div>`;
    const $ = (id) => root.querySelector(id);
    const canvas = $("#mx-canvas"), ctx = canvas.getContext("2d"), statusEl = $("#mx-status"), panelEl = $("#mx-panel");
    const setStatus = (text, isError = false) => { statusEl.textContent = text; statusEl.classList.toggle("mx-error", isError); statusEl.hidden = !text; };

    const resize = () => {
      const r = canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(r.width * dpr)); canvas.height = Math.max(1, Math.round(r.height * dpr));
      if (!state.fitted && r.width > 0) { fit(); state.fitted = true; }
      draw();
    };
    const fit = () => {
      const r = canvas.getBoundingClientRect(), g = grid();
      const s = Math.min(r.width / g.width, r.height / g.height);
      state.view = { s, x: g.width / 2, y: g.height / 2, fit: s };
    };
    const toScreen = (gx, gy) => {
      const r = canvas.getBoundingClientRect();
      return [(gx - state.view.x) * state.view.s + r.width / 2, (gy - state.view.y) * state.view.s + r.height / 2];
    };
    const toGrid = (sx, sy) => {
      const r = canvas.getBoundingClientRect();
      return [(sx - r.width / 2) / state.view.s + state.view.x, (sy - r.height / 2) / state.view.s + state.view.y];
    };

    const draw = () => {
      const dpr = window.devicePixelRatio || 1, g = grid(), v = state.view, r = canvas.getBoundingClientRect();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = "#e6ece4"; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(dpr * v.s, 0, 0, dpr * v.s, dpr * (r.width / 2 - v.x * v.s), dpr * (r.height / 2 - v.y * v.s));
      if (state.base && state.baseCanvas) { ctx.imageSmoothingEnabled = true; ctx.drawImage(state.baseCanvas, 0, 0, g.width, g.height); }
      else { ctx.fillStyle = "#f7f9f5"; ctx.fillRect(0, 0, g.width, g.height); }
      ctx.imageSmoothingEnabled = false;
      ctx.globalAlpha = state.opacity;
      ctx.drawImage(state.layerCanvas, 0, 0, g.width, g.height);
      ctx.globalAlpha = 1;
      if (state.bands && state.bandPaths) {
        for (const { band, path } of state.bandPaths) {
          const style = BAND_STYLE[band] ?? BAND_STYLE.far;
          ctx.lineWidth = 1.6 / v.s; ctx.strokeStyle = style.color;
          ctx.setLineDash(style.dash.map((d) => d / v.s));
          ctx.stroke(path);
        }
        ctx.setLineDash([]);
      }
      if (state.selected) {
        const { row, col } = state.selected;
        ctx.lineWidth = 2 / v.s; ctx.strokeStyle = "#fff"; ctx.strokeRect(col - 2, row - 2, 5, 5);
        ctx.lineWidth = 1 / v.s; ctx.strokeStyle = "#172522"; ctx.strokeRect(col - 2, row - 2, 5, 5);
        ctx.strokeStyle = "#d22d32"; ctx.lineWidth = 2 / v.s; ctx.strokeRect(col, row, 1, 1);
      }
      const metres = 30 / v.s * 80, pow = 10 ** Math.floor(Math.log10(metres)), nice = [1, 2, 5, 10].map((k) => k * pow).find((k) => k >= metres / 1.6) ?? pow;
      $("#mx-scale").innerHTML = `<span style="width:${(nice / 30) * v.s}px"></span><strong>${nice >= 1000 ? `${nice / 1000} km` : `${nice} m`}</strong>`;
    };

    const paintLayer = async () => {
      const token = ++state.token, g = grid(), it = item();
      const lc = state.layerCanvas;
      lc.width = g.width; lc.height = g.height;
      const lctx = lc.getContext("2d");
      lctx.imageSmoothingEnabled = false;
      const manifest = await getManifest(), info = manifest.sensors[state.sensor];
      const assets = getSensorAssets(state.sensor, it, dashboardUrl);
      try {
        if (state.layer === "ndvi") {
          setStatus(`Loading ${state.year} fitted NDVI…`);
          const frame = await getFrame(state.sensor, state.year);
          if (token !== state.token) return;
          lctx.drawImage(frame, 0, 0, frame.width * 4, frame.height * 4);
        } else if (state.layer === "class") {
          setStatus("Loading class raster…");
          const cr = await assets.classRaster;
          if (token !== state.token) return;
          const tmp = document.createElement("canvas");
          tmp.width = cr.width; tmp.height = cr.height;
          const img = new ImageData(new Uint8ClampedArray(cr.image.data), cr.width, cr.height), px = img.data;
          for (let i = 0; i < px.length; i += 4) if (!px[i] && !px[i + 1] && !px[i + 2]) px[i + 3] = 0;
          tmp.getContext("2d").putImageData(img, 0, 0);
          lctx.drawImage(tmp, 0, 0, g.width, g.height);
        } else {
          setStatus("Loading event records…");
          const ev = await assets.events;
          if (token !== state.token) return;
          const img = lctx.createImageData(g.width, g.height), px = img.data, span = info.end_year - info.start_year || 1;
          const colours = new Map();
          for (let i = 0; i < ev.onset.length; i += 1) {
            const on = ev.onset[i];
            if (!on || on > state.year || ev.tier[i] > state.tier) continue;
            if (!colours.has(on)) colours.set(on, lerpRamp(ONSET_RAMP, (on - info.start_year) / span));
            const c = colours.get(on), o = i * 4;
            px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; px[o + 3] = 255;
          }
          lctx.putImageData(img, 0, 0);
        }
        setStatus("");
      } catch (cause) {
        setStatus(cause.message, true);
      }
      draw();
    };

    const updateLegend = () => {
      const it = item(), info = shared.info;
      let html = "";
      if (state.layer === "ndvi") {
        html = `<div>${chip("derived")} Fitted annual NDVI, ${state.year}</div><div class="mx-ramp" style="background:linear-gradient(90deg,${NDVI_RAMP.map(([, c]) => `rgb(${c})`).join(",")})"></div><div class="mx-ramp-labels"><span>lower</span><span>higher</span></div><p class="muted small">Same fixed −1 to +1 colour scale as the Fitted NDVI view. Each map pixel averages up to 4 × 4 source cells; transparent = no valid fitted value. Fitted, not observed.</p>`;
      } else if (state.layer === "onset") {
        html = `<div>${chip("interpretation")} Potential disturbance onset, cohorts up to ${state.year}</div><div class="mx-ramp" style="background:linear-gradient(90deg,${ONSET_RAMP.map((c) => `rgb(${c})`).join(",")})"></div><div class="mx-ramp-labels"><span>${info.start_year}</span><span>${info.end_year}</span></div><p class="muted small">Colour = onset year of retained Phase 4 event pixels. Potential disturbance for follow-up; cause is not established. ${esc(data.disclosures.r_d_caption)}.</p>`;
      } else {
        html = `<div>${chip("rule")} ${esc(data.disclosures.class_label)}</div><ul class="mx-classes">${it.class_map.legend.map((l) => `<li><span class="swatch" style="background:rgb(${l.color})"></span>${esc(l.label)}</li>`).join("")}</ul><p class="muted small">Not time-varying: one class map for the whole record, so the year slider does not apply. Rate labels only, not rehabilitation-quality verdicts.</p>`;
      }
      html += `<div class="mx-bandkey">${Object.entries(BAND_STYLE).map(([b, s]) => `<span><i style="border-top:2px ${s.dash.length ? "dashed" : "solid"} ${s.color}; background:#4a5a55"></i>${b}</span>`).join("")}<small>Administrative distance strata (derived geometry, not lease boundaries)</small></div>`;
      $("#mx-legend").innerHTML = html;
    };

    const updateTime = async () => {
      const manifest = await getManifest(), info = shared.info = manifest.sensors[state.sensor];
      const slider = $("#mx-year");
      slider.min = info.start_year; slider.max = info.end_year;
      state.year = Math.min(info.end_year, Math.max(info.start_year, state.year));
      slider.value = state.year;
      $("#mx-year-out").textContent = state.year;
      slider.disabled = state.layer === "class";
      $("#mx-play").disabled = state.layer === "class";
      const valid = info.valid_pixels_by_year ?? {}, peak = Math.max(...Object.values(valid), 1), n = valid[state.year];
      let note = "";
      if (state.layer === "class") note = "Class map has no time dimension.";
      else if (state.layer === "ndvi" && n !== undefined && n < peak * 0.05) note = `Sparse or no fitted coverage in ${state.year} (${nf.format(n)} cells); gaps are left blank, not filled.`;
      else if (state.layer === "ndvi") note = `${nf.format(n ?? 0)} cells with a fitted value in ${state.year}.`;
      else note = `Cumulative to ${state.year}.`;
      $("#mx-year-note").textContent = note;
      $("#mx-tier-wrap").hidden = state.layer !== "onset";
      updateLegend();
    };

    const refresh = async () => { await updateTime(); await paintLayer(); if (state.selected) renderPanel(); };

    const setSensor = async (sensor) => {
      state.sensor = sensor;
      root.querySelectorAll("[data-mx-sensor]").forEach((b) => { b.classList.toggle("active", b.dataset.mxSensor === sensor); b.setAttribute("aria-pressed", b.dataset.mxSensor === sensor); });
      state.bandPaths = null;
      getSensorAssets(sensor, item(), dashboardUrl).bands.then((paths) => { if (state.sensor === sensor) { state.bandPaths = paths; draw(); } }).catch((e) => setStatus(e.message, true));
      await refresh();
    };

    const stopPlay = () => { clearInterval(state.playing); state.playing = null; $("#mx-play").textContent = "▶ Play"; };

    // Selection ------------------------------------------------------------
    const renderPanel = async () => {
      const sel = state.selected;
      if (!sel) {
        panelEl.innerHTML = `<h2>Selected location</h2><p>Click any cell on the map to see its fitted NDVI trajectory, mapped disturbance history and rule-based class together.</p>
          <div class="mx-block">${chip("regulatory")}<p class="small">No regulatory, compliance or rehabilitation-completion conclusion is drawn by this tool. Satellite analysis supports targeting and record-keeping; it does not replace field verification or statutory assessment.</p></div>`;
        return;
      }
      const token = ++state.panelToken;
      const { row, col } = sel, g = grid(), [a, b, c, d, e, f] = g.transform, E = a * (col + 0.5) + c, N = e * (row + 0.5) + f;
      const ll = tm.inverse(E, N);
      let html = `<h2>Selected cell</h2><p class="mono small">Row ${row}, col ${col} · MGA2020 zone 55 E ${nf.format(Math.round(E))} m, N ${nf.format(Math.round(N))} m · ${ll.lat.toFixed(5)}°, ${ll.lon.toFixed(5)}° · 30 m cell, ${esc(item().label)}</p>`;
      panelEl.innerHTML = `${html}<p class="muted">Loading history…</p>`;
      try {
        const manifest = await getManifest(), info = manifest.sensors[state.sensor];
        const pixel = readPixel(await getTile(state.sensor, row, col), info, row, col);
        const years = Array.from({ length: pixel.fitted.length }, (_, i) => info.start_year + i);
        const assets = getSensorAssets(state.sensor, item(), dashboardUrl);
        const [ev, cr, bands] = await Promise.allSettled([assets.events, assets.classRaster, assets.bands]).then((r) => r.map((x) => (x.status === "fulfilled" ? x.value : null)));
        const idx = row * g.width + col;
        const pairs = await getPairs(state.sensor, pixel).catch(() => []);
        let control = null;
        if (pairs.length) {
          const cid = pairs[0][1], crow = Math.floor(cid / info.width), ccol = cid % info.width;
          control = { row: crow, col: ccol, pixel: readPixel(await getTile(state.sensor, crow, ccol), info, crow, ccol), n: pairs.length, tier: pairs[0][3], gapped: pairs[0][4], band: pairs[0][5], hand: pairs[0][6] };
        }
        if (token !== state.panelToken || state.selected !== sel) return;

        const series = [{ values: pixel.fitted, color: "#1b6d56" }];
        if (control) series.push({ values: control.pixel.fitted, color: "#c98a12", dash: true });
        const have = pixel.fitted.filter((v) => v !== null).length;
        html += `<section class="mx-block">${chip("derived", "Derived measurement · fitted trajectory")}
          ${sparkline(years, series, { onset: pixel.onset, current: state.year })}
          <p class="mx-keyline"><i style="background:#1b6d56"></i>Selected cell${control ? ' <i class="mx-dashed" style="border-color:#c98a12"></i>Matched control (context only)' : ""}${state.layer !== "class" ? ' <i class="mx-vline"></i>Slider year' : ""}</p>
          <p class="small">${have} of ${years.length} years have a fitted value; gaps are policy/QA gaps, not zeros. ${state.year >= info.start_year && pixel.fitted[state.year - info.start_year] !== null ? `${state.year}: fitted NDVI ${pixel.fitted[state.year - info.start_year].toFixed(3)}${pixel.counts[state.year - info.start_year] !== null ? `, ${pixel.counts[state.year - info.start_year]} QA-valid scenes` : ""}.` : `${state.year}: no fitted value.`}</p>
          <details><summary>Values by year</summary><table class="mx-table"><thead><tr><th>Year</th><th>Fitted NDVI</th><th>QA scenes</th>${control ? "<th>Control</th>" : ""}</tr></thead><tbody>${years.map((yr, i) => `<tr><td>${yr}</td><td>${pixel.fitted[i] === null ? "—" : pixel.fitted[i].toFixed(3)}</td><td>${pixel.counts[i] ?? "—"}</td>${control ? `<td>${control.pixel.fitted[i] === null ? "—" : control.pixel.fitted[i].toFixed(3)}</td>` : ""}</tr>`).join("")}</tbody></table></details>
          <p class="muted small">Fitted, not observed; ${esc(item().label)} and the other sensor product are not cross-calibrated.${control ? ` ${control.n} matched control record${control.n === 1 ? "" : "s"} for this cell (first shown: row ${control.row}, col ${control.col}, ${esc(control.tier)}, ${esc(control.band)}, ${esc(control.hand)}${control.gapped ? ", gapped window" : ""}). Context only, not a causal estimate.` : ""}</p></section>`;

        const flags = [pixel.flags & 1 ? "QA-only" : "", pixel.flags & 2 ? "gapped cohort" : "", pixel.flags & 4 ? "same-year recovery candidate (not accepted)" : ""].filter(Boolean);
        if (pixel.onset) {
          const recovery = ev?.recovery[idx];
          const tier = ev?.tier[idx];
          html += `<section class="mx-block">${chip("interpretation", "Analytical interpretation · potential disturbance")}
            <p><strong>Disturbance onset ${pixel.onset}</strong>${pixel.eventId >= 0 ? ` · event ${nf.format(pixel.eventId)}` : " · not retained in the Phase 4 floor-2 event records"}${tier ? ` · <span class="badge ${tier === 3 ? "qa" : ""}">${esc(TIER_NAMES[tier])}</span>` : ""}</p>
            <p class="small">${recovery ? `Recovery onset recorded: ${recovery}.` : "No recovery onset recorded."} ${flags.length ? `Flags: ${esc(flags.join(", "))}.` : "No QA flags recorded."} ${ev?.comp[idx] ? `Connected event component: ${nf.format(ev.comp[idx])} pixels.` : ""}</p>
            ${pixel.onset === 2022 || tier === 3 ? `<div class="caption-box">${esc(data.disclosures.r_d_caption)} <a href="./methodology.html#confounding">Why this matters</a></div>` : ""}
            <p class="muted small">A potential disturbance for follow-up and ground-truthing; no mining attribution or cause is claimed.</p></section>`;
        } else {
          html += `<section class="mx-block">${chip("interpretation", "Analytical interpretation · potential disturbance")}<p>No disturbance onset is mapped for this cell in the pinned record.</p></section>`;
        }

        let classLine = "No class recorded for this cell.", source = "";
        if (ev?.cls[idx]) {
          const l = item().class_map.legend.find((x) => x.code === ev.cls[idx]);
          classLine = `<strong>${esc(l.label)}</strong> — ${esc(l.plain_language)}`; source = "from the retained event record";
        } else if (cr) {
          const px = Math.min(cr.width - 1, Math.floor(((col + 0.5) / g.width) * cr.width)), py = Math.min(cr.height - 1, Math.floor(((row + 0.5) / g.height) * cr.height));
          const o = (py * cr.width + px) * 4, rgb = [cr.image.data[o], cr.image.data[o + 1], cr.image.data[o + 2]];
          const l = item().class_map.legend.find((x) => x.color.every((v, i) => v === rgb[i]));
          if (l) { classLine = `<strong>${esc(l.label)}</strong> — ${esc(l.plain_language)}`; source = "sampled from the reduced display raster; approximate at cell level"; }
        }
        const band = bands ? (() => { const cx = col + 0.5, cy = row + 0.5, hit = bands.find((bd) => state.hitContext.isPointInPath(bd.path, cx, cy, "evenodd")); return hit?.band; })() : null;
        html += `<section class="mx-block">${chip("rule", "Rule-based classification · unvalidated")}
          <p>${classLine}</p>${source ? `<p class="muted small">Class ${source}.</p>` : ""}
          <p class="muted small">${esc(data.disclosures.class_label)}. Rate labels only, not a rehabilitation-quality verdict. <a href="./methodology.html#status">Method status</a></p></section>
          <section class="mx-block"><h3>Context</h3><p class="small">Administrative distance stratum: ${band ? esc(band) : "outside the mapped strata"}. This is a distance classification, not a lease boundary.</p></section>
          <section class="mx-block">${chip("regulatory")}<p class="small">Whether this location meets any rehabilitation, completion or compliance criterion cannot be concluded from this view. It requires independent assessment, field verification and statutory process.</p></section>`;
        panelEl.innerHTML = html;
      } catch (cause) {
        panelEl.innerHTML = `${html}<p class="error-text">${esc(cause.message)}</p>`;
      }
    };

    const select = (row, col) => {
      const g = grid();
      if (row < 0 || col < 0 || row >= g.height || col >= g.width) return;
      state.selected = { row, col };
      draw();
      renderPanel();
    };

    // Interaction ----------------------------------------------------------
    const zoomAt = (factor, sx, sy) => {
      const r = canvas.getBoundingClientRect(), [gx, gy] = toGrid(sx ?? r.width / 2, sy ?? r.height / 2), v = state.view;
      v.s = Math.min(24, Math.max(v.fit * 0.8, v.s * factor));
      v.x = gx - ((sx ?? r.width / 2) - r.width / 2) / v.s; v.y = gy - ((sy ?? r.height / 2) - r.height / 2) / v.s;
      draw();
    };
    let drag = null;
    canvas.addEventListener("pointerdown", (ev) => { canvas.setPointerCapture(ev.pointerId); drag = { x: ev.clientX, y: ev.clientY, moved: false, vx: state.view.x, vy: state.view.y }; }, { signal: abort.signal });
    canvas.addEventListener("pointermove", (ev) => {
      if (!drag) return;
      const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
      if (drag.moved) { state.view.x = drag.vx - dx / state.view.s; state.view.y = drag.vy - dy / state.view.s; draw(); }
    }, { signal: abort.signal });
    canvas.addEventListener("pointerup", (ev) => {
      if (drag && !drag.moved) {
        const r = canvas.getBoundingClientRect(), [gx, gy] = toGrid(ev.clientX - r.left, ev.clientY - r.top);
        select(Math.floor(gy), Math.floor(gx));
      }
      drag = null;
    }, { signal: abort.signal });
    canvas.addEventListener("wheel", (ev) => {
      ev.preventDefault();
      const r = canvas.getBoundingClientRect();
      zoomAt(ev.deltaY < 0 ? 1.25 : 0.8, ev.clientX - r.left, ev.clientY - r.top);
    }, { passive: false, signal: abort.signal });
    canvas.addEventListener("keydown", (ev) => {
      const pan = 60 / state.view.s;
      const handled = { ArrowLeft: () => { state.view.x -= pan; }, ArrowRight: () => { state.view.x += pan; }, ArrowUp: () => { state.view.y -= pan; }, ArrowDown: () => { state.view.y += pan; },
        "+": () => zoomAt(1.25), "=": () => zoomAt(1.25), "-": () => zoomAt(0.8), Enter: () => select(Math.floor(state.view.y), Math.floor(state.view.x)) }[ev.key];
      if (handled) { ev.preventDefault(); handled(); draw(); }
    }, { signal: abort.signal });
    root.querySelectorAll("[data-mx-zoom]").forEach((b) => b.addEventListener("click", () => {
      if (b.dataset.mxZoom === "0") { fit(); draw(); } else zoomAt(b.dataset.mxZoom === "1" ? 1.5 : 1 / 1.5);
    }, { signal: abort.signal }));
    root.querySelectorAll("[data-mx-sensor]").forEach((b) => b.addEventListener("click", () => { stopPlay(); setSensor(b.dataset.mxSensor); }, { signal: abort.signal }));
    root.querySelectorAll('input[name="mx-layer"]').forEach((r) => r.addEventListener("change", () => { stopPlay(); state.layer = r.value; refresh(); }, { signal: abort.signal }));
    $("#mx-bands").addEventListener("change", (ev) => { state.bands = ev.target.checked; draw(); }, { signal: abort.signal });
    $("#mx-opacity").addEventListener("input", (ev) => { state.opacity = Number(ev.target.value); draw(); }, { signal: abort.signal });
    $("#mx-tier").addEventListener("change", (ev) => { state.tier = Number(ev.target.value); paintLayer(); }, { signal: abort.signal });
    $("#mx-year").addEventListener("input", (ev) => { state.year = Number(ev.target.value); $("#mx-year-out").textContent = state.year; updateTime().then(paintLayer).then(() => state.selected && renderPanel()); }, { signal: abort.signal });
    $("#mx-play").addEventListener("click", () => {
      if (state.playing) { stopPlay(); return; }
      $("#mx-play").textContent = "❚❚ Pause";
      state.playing = setInterval(() => {
        const info = shared.info, slider = $("#mx-year");
        state.year = state.year >= info.end_year ? info.start_year : state.year + 1;
        slider.value = state.year; slider.dispatchEvent(new Event("input"));
      }, 900);
    }, { signal: abort.signal });
    $("#mx-base").addEventListener("change", async (ev) => {
      state.base = ev.target.checked;
      $("#mx-basemap-note").hidden = !state.base;
      if (state.base && !state.baseCanvas) {
        try {
          setStatus("Loading aerial imagery…");
          state.baseCanvas = await loadBasemap(grid(), (done, total) => setStatus(`Loading aerial imagery… ${done}/${total}`));
          setStatus("");
        } catch (cause) {
          state.base = false; ev.target.checked = false; $("#mx-basemap-note").hidden = true;
          setStatus(`Aerial basemap unavailable: ${cause.message}`, true);
        }
      }
      draw();
    }, { signal: abort.signal });
    const baseBox = $("#mx-base");
    baseBox.checked = true;
    baseBox.dispatchEvent(new Event("change"));
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);

    fit();
    renderPanel();
    setSensor("landsat").then(() => { resize(); });
    return () => { abort.abort(); observer.disconnect(); stopPlay(); };
  };

  window.MapExplorer = { mount };
})();
