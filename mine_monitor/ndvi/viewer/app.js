"use strict";

const $ = id => document.getElementById(id);
let manifest, sensor = "sentinel2", selectedPixel = null, selectedControl = null;
let currentFrame = null, chosenBlock = null, timer = null, requestNumber = 0;
const cache = new Map();

function showError(error) {
  $("error").textContent = `Unable to load demonstration data: ${error.message}`;
  $("error").hidden = false;
  console.error(error);
}

async function digest(bytes) {
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), x => x.toString(16).padStart(2, "0")).join("");
}

async function fetchChecked(path) {
  const record = manifest.files[path];
  if (!record) throw new Error(`Missing manifest entry: ${path}`);
  const response = await fetch(path, { cache: "no-cache" });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength !== record.bytes || await digest(bytes) !== record.sha256)
    throw new Error(`Hash or size mismatch for ${path}`);
  return bytes;
}

async function decompress(bytes) {
  if (typeof DecompressionStream === "undefined")
    throw new Error("This browser does not support gzip decompression.");
  return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
}

async function tileFor(which, row, col) {
  const size = manifest.tile_size, info = manifest.sensors[which];
  const tr = Math.floor(row / size), tc = Math.floor(col / size);
  const path = `${which}/tiles/${tr}_${tc}.bin.gz`;
  if (!cache.has(path)) cache.set(path, decompress(await fetchChecked(path)));
  const bytes = await cache.get(path);
  const height = Math.min(size, info.height - tr * size), width = Math.min(size, info.width - tc * size);
  const years = info.end_year - info.start_year + 1, stride = 7 + years * 6;
  if (bytes.byteLength !== height * width * stride) throw new Error(`Invalid tile length: ${path}`);
  return {view: new DataView(bytes), width, tr, tc, years, stride};
}

function readPixel(tile, row, col, which) {
  const info = manifest.sensors[which], size = manifest.tile_size;
  const offset = ((row - tile.tr * size) * tile.width + col - tile.tc * size) * tile.stride;
  const view = tile.view, onset = view.getUint16(offset, true), event = view.getInt32(offset + 2, true);
  const flags = view.getUint8(offset + 6), fitted = [], counts = [];
  for (let i = 0; i < tile.years; i++) {
    const value = view.getFloat32(offset + 7 + i * 4, true);
    const count = view.getUint16(offset + 7 + tile.years * 4 + i * 2, true);
    fitted.push(value === -9999 ? null : value);
    counts.push(count === 65535 ? null : count);
  }
  return {row, col, id: row * info.width + col, onset, event, flags, fitted, counts};
}

async function pixelAt(which, row, col) {
  return readPixel(await tileFor(which, row, col), row, col, which);
}

async function pairsFor(pixel) {
  const size = manifest.tile_size;
  const path = `${sensor}/pairs/${Math.floor(pixel.row / size)}_${Math.floor(pixel.col / size)}.json.gz`;
  if (!manifest.files[path]) return [];
  if (!cache.has(path)) cache.set(path, decompress(await fetchChecked(path)));
  const rows = JSON.parse(new TextDecoder().decode(await cache.get(path)));
  return rows.filter(row => row[0] === pixel.id && row[2] === pixel.onset);
}

function paintMap() {
  if (!currentFrame) return;
  const canvas = $("map"), ctx = canvas.getContext("2d");
  canvas.width = currentFrame.width; canvas.height = currentFrame.height;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(currentFrame, 0, 0);
  if (chosenBlock) {
    ctx.strokeStyle = "#fff"; ctx.lineWidth = 2;
    ctx.strokeRect(chosenBlock.col - 1, chosenBlock.row - 1, 3, 3);
  }
}

async function showFrame() {
  const which = sensor, year = Number($("year").value), token = ++requestNumber;
  $("year-label").textContent = year;
  $("coverage").textContent = which === "landsat"
    ? "Landsat 1988–2026 · 2000 and 2012 fully masked · no cross-sensor calibration"
    : "Sentinel-2 2015–2026 · 2015 had no scenes · no cross-sensor calibration";
  const bytes = await fetchChecked(`${which}/frames/${year}.png`);
  const image = await createImageBitmap(new Blob([bytes], {type: "image/png"}));
  if (token !== requestNumber) { image.close(); return; }
  if (currentFrame) currentFrame.close();
  currentFrame = image;
  paintMap();
}

async function chooseBlock(event) {
  const rect = $("map").getBoundingClientRect(), reduction = manifest.map_reduction;
  const col = Math.min($("map").width - 1, Math.max(0, Math.floor((event.clientX - rect.left) / rect.width * $("map").width)));
  const row = Math.min($("map").height - 1, Math.max(0, Math.floor((event.clientY - rect.top) / rect.height * $("map").height)));
  const which = sensor, info = manifest.sensors[which], candidates = [];
  chosenBlock = {row, col}; paintMap();
  for (let r = row * reduction; r < Math.min(info.height, (row + 1) * reduction); r++) {
    for (let c = col * reduction; c < Math.min(info.width, (col + 1) * reduction); c++) {
      const pixel = await pixelAt(which, r, c);
      if (pixel.onset) candidates.push(pixel);
    }
  }
  if (which !== sensor || !chosenBlock || chosenBlock.row !== row || chosenBlock.col !== col) return;
  $("details").hidden = candidates.length === 0;
  $("selection").hidden = candidates.length > 0;
  if (!candidates.length) {
    $("selection").textContent = "No mapped event pixel in this cell. Choose another cell.";
    selectedPixel = null; selectedControl = null; return;
  }
  $("pixel").replaceChildren(...candidates.map((pixel, index) => {
    const option = document.createElement("option");
    option.value = index;
    option.textContent = `Row ${pixel.row}, column ${pixel.col} · onset ${pixel.onset}`;
    return option;
  }));
  $("pixel").onchange = () => selectPixel(candidates[Number($("pixel").value)]).catch(showError);
  await selectPixel(candidates[0]);
}

async function selectPixel(pixel) {
  const which = sensor;
  selectedPixel = pixel; selectedControl = null;
  $("pair-info").textContent = "";
  $("pixel-info").textContent = `Sensor: ${which} · pixel ID: ${pixel.id} · event ID: ${pixel.event < 0 ? "not retained in Phase 4 floor-2 events" : pixel.event}`;
  const warnings = [];
  if (pixel.onset === 2022 || (pixel.flags & 1)) warnings.push(manifest.r_d_2022_caption + " — internal QA only; no mining-impact inference.");
  if (pixel.flags & 2) warnings.push("The matching cohort has a gapped observation window.");
  if (pixel.flags & 4) warnings.push("Same-year recovery candidate: not accepted as recovery.");
  $("warning").textContent = warnings.join(" ");
  $("warning").hidden = warnings.length === 0;
  $("pair").replaceChildren(new Option("No control selected", ""));
  drawChart();
  const pairs = await pairsFor(pixel);
  if (which !== sensor || selectedPixel !== pixel) return;
  pairs.forEach((pair, index) => {
    const tier = pair[3] === "T2" ? "T2 provisional" : pair[3] === "T3" ? "T3 QA-only" : pair[3];
    $("pair").add(new Option(`Control ${pair[1]} · ${tier}${pair[4] ? ", gapped" : ""} · ${pair[5]} · ${pair[6]}`, String(index)));
  });
  if (!pairs.length) $("pair").add(new Option("No primary floor-2 match recorded", "", false, false));
  $("pair").onchange = async () => {
    try {
      const index = $("pair").value;
      selectedControl = null;
      $("pair-info").textContent = "";
      if (index !== "") {
        const pair = pairs[Number(index)], info = manifest.sensors[which];
        const control = await pixelAt(which, Math.floor(pair[1] / info.width), pair[1] % info.width);
        if (which !== sensor || selectedPixel !== pixel || $("pair").value !== index) return;
        selectedControl = control;
        $("pair-info").textContent = `Pair ID: ${which}:${pair[2]}:primary_caliper_0.050:floor2:${pair[5]}:${pair[6]}:${pair[0]}:${pair[1]}`;
        if (Boolean(pixel.flags & 2) !== Boolean(pair[4]))
          $("pair-info").textContent += " · Source discrepancy: Phase 4 event and Phase 3 pair window-gap flags differ; the pair option shows the Phase 3 flag.";
      }
      drawChart();
    } catch (error) { showError(error); }
  };
}

function drawChart() {
  if (!selectedPixel) return;
  const canvas = $("chart"), ctx = canvas.getContext("2d"), info = manifest.sensors[sensor];
  canvas.width = 900; canvas.height = 360;
  const left = 60, top = 25, width = 805, height = 265, n = selectedPixel.fitted.length;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.font = "16px system-ui"; ctx.fillStyle = "#536c5f";
  for (const v of [-1, -0.5, 0, 0.5, 1]) {
    const y = top + (1 - v) * height / 2;
    ctx.strokeStyle = "#e0e9e1"; ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(left + width, y); ctx.stroke();
    ctx.fillText(v.toFixed(1), 8, y + 5);
  }
  function line(pixel, color) {
    ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 3;
    let active = false;
    pixel.fitted.forEach((value, i) => {
      if (value === null) { active = false; return; }
      const x = left + i * width / Math.max(1, n - 1), y = top + (1 - value) * height / 2;
      if (!active) { ctx.beginPath(); ctx.moveTo(x, y); active = true; }
      else { ctx.lineTo(x, y); ctx.stroke(); }
      ctx.fillRect(x - 2, y - 2, 4, 4);
    });
  }
  line(selectedPixel, "#167256");
  if (selectedControl) line(selectedControl, "#d18b36");
  ctx.fillStyle = "#536c5f"; ctx.fillText(String(info.start_year), left, 320);
  ctx.fillText(String(info.end_year), left + width - 36, 320);
  $("chart-note").textContent = `Green: impact pixel${selectedControl ? " · amber: selected control pixel" : ""}. Gaps are missing fitted values; no observations are shown.`;
  $("rows").replaceChildren(...selectedPixel.fitted.map((value, i) => {
    const tr = document.createElement("tr");
    const display = v => v === null || v === undefined ? "Missing" : typeof v === "number" && !Number.isInteger(v) ? v.toFixed(3) : String(v);
    const qa = (pixel, index) => {
      if (!pixel) return null;
      const count = pixel.counts[index];
      if (count === null) return "Outside coverage";
      if (pixel.fitted[index] !== null) return `${count} valid scenes`;
      if (info.no_scene_years.includes(info.start_year + index)) return "No scenes";
      return count < 5 ? `${count} valid scenes · masked (<5)` : `${count} valid scenes · no fit`;
    };
    const values = [info.start_year + i, value, qa(selectedPixel, i), selectedControl?.fitted[i], qa(selectedControl, i)];
    values.forEach(v => { const td = document.createElement("td"); td.textContent = display(v); tr.append(td); });
    return tr;
  }));
}

async function start() {
  if (!crypto.subtle) throw new Error("Open via localhost or HTTPS for hash verification.");
  const [response, checksum] = await Promise.all([fetch("manifest.json", { cache: "no-cache" }), fetch("manifest.sha256", { cache: "no-cache" })]);
  if (!response.ok || !checksum.ok) throw new Error("Manifest is unavailable.");
  const bytes = await response.arrayBuffer(), expected = (await checksum.text()).trim().split(/\s+/)[0];
  if (await digest(bytes) !== expected) throw new Error("Manifest hash mismatch.");
  manifest = JSON.parse(new TextDecoder().decode(bytes));
  if (manifest.schema_version !== 1 || manifest.status !== "complete") throw new Error("Unsupported or incomplete manifest.");
  function setupSensor() {
    sensor = $("sensor").value; const info = manifest.sensors[sensor];
    $("year").min = info.start_year; $("year").max = info.end_year; $("year").value = info.end_year;
    selectedPixel = null; selectedControl = null; chosenBlock = null;
    $("details").hidden = true; $("selection").hidden = false;
    $("selection").textContent = "Click the map to find mapped event pixels in that cell.";
    showFrame().catch(showError);
  }
  $("sensor").onchange = setupSensor;
  $("year").oninput = () => showFrame().catch(showError);
  $("map").onclick = event => chooseBlock(event).catch(showError);
  $("play").onclick = () => {
    if (timer) { clearInterval(timer); timer = null; $("play").textContent = "Play years"; return; }
    $("play").textContent = "Pause";
    timer = setInterval(() => {
      $("year").value = Number($("year").value) >= Number($("year").max) ? $("year").min : Number($("year").value) + 1;
      showFrame().catch(showError);
    }, 850);
  };
  setupSensor();
}

start().catch(showError);
