"use strict";

(() => {
  const app = document.getElementById("app");
  const loading = document.getElementById("loading");
  const error = document.getElementById("error");
  const navButtons = Array.from(document.querySelectorAll("[data-view]"));
  const numberFormat = new Intl.NumberFormat("en-AU");
  const tenureReview = "The frozen 15 November 2026 tenure snapshot is retained for this demonstration. A 19 November comparison found one 30 m cell outside the refreshed analysis area that appears as a control in eight matching records, including four primary floor-2 records. Results were not recalculated. Lease renewal status is not legally verified; this is not a current-tenure or regulatory determination.";
  const dashboardDataUrl = new URL(window.DASH_DATA_URL, document.baseURI);
  const validViews = new Set([
    "overview",
    "manage",
    "reporting",
    "maps",
    "science",
    "events",
    "cohorts",
    "bands",
    "controls",
    "methods",
    "ndvi",
  ]);
  const requestedView = new URLSearchParams(window.location.search).get("view");
  const mapAssetCache = new Map();
  let intakeManifestPromise;
  let ndviResizeObserver;
  let mapNavigationObserver;
  let ndviMapObserver;
  let data;
  let currentView = validViews.has(requestedView) ? requestedView : "overview";
  let currentSensor = "landsat";
  let selectedEvent = null;

  const escapeHtml = (value) =>
    String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");

  const number = (value) =>
    typeof value === "number" ? numberFormat.format(value) : escapeHtml(value);
  const year = (value) => escapeHtml(value);
  const updateViewUrl = () => {
    const url = new URL(window.location.href);
    if (currentView === "overview") url.searchParams.delete("view");
    else url.searchParams.set("view", currentView);
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  };

  const panel = (title, body, extraClass = "") => `
    <section class="panel ${extraClass}">
      <h2>${escapeHtml(title)}</h2>
      ${body}
    </section>`;

  const metric = (label, value, note = "") => `
    <article class="metric-card">
      <span class="metric-label">${escapeHtml(label)}</span>
      <strong class="metric-value">${value}</strong>
      <span class="metric-note">${escapeHtml(note)}</span>
    </article>`;

  const table = (headers, rows, rowRenderer) => {
    if (!rows.length) {
      return '<p class="notice">No rows are available for this view.</p>';
    }
    return `
      <div class="table-wrap">
        <table>
          <thead><tr>${headers.map((h) => `<th scope="col">${escapeHtml(h)}</th>`).join("")}</tr></thead>
          <tbody>${rows.map(rowRenderer).join("")}</tbody>
        </table>
      </div>`;
  };

  const setupMapNavigation = ({ viewport, content, stage, scale, marker, zoom, grid, onZoom }) => {
    let zoomed = false;
    const sourceWidth = grid.width;
    const metresPerPixel = Math.hypot(grid.transform[0], grid.transform[3]);
    const updateScale = () => {
      const pixelsPerMetre = stage.getBoundingClientRect().width / (sourceWidth * metresPerPixel);
      if (!pixelsPerMetre) return;
      const target = 100 / pixelsPerMetre;
      const power = 10 ** Math.floor(Math.log10(target));
      const distance = [1, 2, 5, 10].map((factor) => factor * power)
        .reduce((best, candidate) =>
          Math.abs(candidate - target) < Math.abs(best - target) ? candidate : best);
      scale.querySelector("span").style.width = `${distance * pixelsPerMetre}px`;
      scale.querySelector("strong").textContent = distance >= 1000
        ? `${number(distance / 1000)} km`
        : `${number(distance)} m`;
    };
    const setWidth = (width, x = 0.5, y = 0.5) => {
      if (!zoomed) viewport.style.height = `${viewport.clientHeight}px`;
      zoomed = true;
      content.style.width = "max-content";
      content.style.padding = `${viewport.clientHeight / 2}px ${viewport.clientWidth / 2}px`;
      stage.style.width = `${width}px`;
      content.style.padding = `${viewport.clientHeight / 2}px ${viewport.clientWidth / 2}px`;
      viewport.scrollLeft = x * stage.offsetWidth;
      viewport.scrollTop = y * stage.offsetHeight;
      updateScale();
    };
    const fit = () => {
      zoomed = false;
      viewport.style.height = "";
      content.style.width = "";
      content.style.padding = "";
      stage.style.width = "";
      viewport.scrollLeft = 0;
      viewport.scrollTop = 0;
      if (zoom) zoom.value = "1";
      if (zoom) zoom.dataset.previous = "1";
      updateScale();
      onZoom?.(1);
    };
    const zoomTo = (x, y) => {
      const baseWidth = zoomed
        ? stage.getBoundingClientRect().width / Number(zoom.dataset.previous || 1)
        : stage.getBoundingClientRect().width;
      const ratio = sourceWidth / baseWidth;
      if (zoom) {
        zoom.min = String(Math.min(1, ratio));
        zoom.max = String(Math.max(3, ratio));
        zoom.value = String(ratio);
      }
      marker.style.left = `${x * 100}%`;
      marker.style.top = `${y * 100}%`;
      marker.hidden = false;
      setWidth(sourceWidth, x, y);
      onZoom?.(ratio);
    };
    if (zoom) {
      zoom.addEventListener("input", () => {
        const bounds = stage.getBoundingClientRect();
        const viewportBounds = viewport.getBoundingClientRect();
        const x = Math.max(0, Math.min(1, (viewportBounds.left + viewport.clientWidth / 2 - bounds.left) / bounds.width));
        const y = Math.max(0, Math.min(1, (viewportBounds.top + viewport.clientHeight / 2 - bounds.top) / bounds.height));
        const baseWidth = zoomed ? bounds.width / Number(zoom.dataset.previous || 1) : bounds.width;
        const ratio = Number(zoom.value);
        zoom.dataset.previous = String(ratio);
        if (ratio === 1) fit();
        else {
          setWidth(baseWidth * ratio, x, y);
          onZoom?.(ratio);
        }
      });
    }
    const observer = new ResizeObserver(() => {
      if (zoomed) {
        const left = viewport.scrollLeft;
        const top = viewport.scrollTop;
        content.style.padding = `${viewport.clientHeight / 2}px ${viewport.clientWidth / 2}px`;
        viewport.scrollLeft = left;
        viewport.scrollTop = top;
      }
      updateScale();
    });
    observer.observe(stage);
    observer.observe(viewport);
    mapNavigationObserver = observer;
    updateScale();
    return {
      fit,
      zoomTo: (x, y) => {
        zoomTo(x, y);
        if (zoom) zoom.dataset.previous = zoom.value;
      },
    };
  };

  const renderNdvi = () => `
    ${pageHeading(
      "Fitted vegetation through time",
      "Explore annual NDVI patterns",
      "Select a season, map cell and event pixel to inspect the fitted vegetation signal. This static, pinned view does not estimate a mining impact."
    )}
    <div class="notice">
      <p><strong>What is NDVI?</strong> The Normalised Difference Vegetation Index is a satellite-based indicator of vegetation condition. Healthy vegetation typically absorbs red light for photosynthesis and reflects much of the near-infrared light, largely due to leaf structure. NDVI compares these reflected wavelengths on a scale from −1 to +1; higher values generally indicate more vigorous or denser vegetation. Changes can highlight areas worth investigating, but NDVI alone cannot diagnose plant health, assess the whole ecosystem or establish the cause of change.</p>
    </div>
    <div class="notice warning ndvi-shell-note">
      <p><strong>Interpretation limits:</strong> these are fitted values, not observations. Missing years remain gaps, Landsat and Sentinel-2 are not cross-calibrated, and matched controls provide context—not a causal estimate. The 2022 cohort remains internal QA-only.</p>
    </div>
    <div class="notice">
      <p><strong>How do controls help?</strong> BACI means <em>Before–After, Control–Impact</em>: it compares change at a location of interest with change over the same period at a reference location, helping distinguish local change from broader conditions.</p>
      <p>Here, controls are non-event pixels in natural vegetation classes, matched within the same sensor, cohort and distance and landscape strata. The matching process seeks a similar pre-event NDVI baseline and accepts a difference of at most 0.050. Not every event pixel has a match. The paired curves provide context only; they do not themselves establish cause or measure impact. <a href="./approach-report.html#baci">More about BACI and its limits</a>.</p>
    </div>
    <p id="ndvi-interaction-status" class="ndvi-interaction-status" role="status" aria-live="polite">
      Click a map cell to look for event pixels. If none are recorded in that cell, try a nearby cell.
    </p>
    <iframe
      id="ndvi-viewer"
      class="ndvi-viewer-frame"
      src="./ndvi/viewer/index.html"
      title="Interactive fitted NDVI map and event time-series viewer"
      loading="eager"
    ></iframe>`;

  const prepareNdviViewer = () => {
    const frame = document.getElementById("ndvi-viewer");
    ndviResizeObserver?.disconnect();
    frame.addEventListener("load", () => {
      const doc = frame.contentDocument;
      if (!doc) {
        throw new Error("The fitted-NDVI viewer could not be accessed.");
      }
      doc.querySelector(".hero")?.remove();
      doc.querySelector(".footer-note")?.remove();
      doc.body.style.background = "transparent";
      doc.body.classList.add("ndvi-embedded");
      const main = doc.querySelector("main");
      main.style.maxWidth = "none";
      main.style.margin = "0";
      main.style.padding = "0.75rem 0 1rem";
      const mapWrap = doc.querySelector(".map-wrap");
      mapWrap.style.maxHeight = "none";
      mapWrap.style.background = "#e8eee7";
      const map = doc.getElementById("map");
      const paintMap = frame.contentWindow.paintMap;
      frame.contentWindow.paintMap = () => {
        const context = map.getContext("2d");
        const strokeRect = context.strokeRect;
        // The embedded viewer's white cell outline duplicates our transparent marker.
        context.strokeRect = () => {};
        try {
          paintMap();
        } finally {
          context.strokeRect = strokeRect;
        }
      };
      const chart = doc.getElementById("chart");
      const chartLegend = doc.createElement("div");
      chartLegend.className = "ndvi-chart-legend";
      chartLegend.setAttribute("aria-label", "Chart series");
      chartLegend.innerHTML = `
        <span><i class="ndvi-chart-key impact" aria-hidden="true"></i>Event pixel (impact)</span>
        <span class="ndvi-control-key" hidden><i class="ndvi-chart-key control" aria-hidden="true"></i>Matched control</span>`;
      chart.before(chartLegend);
      const controlKey = chartLegend.querySelector(".ndvi-control-key");
      const drawChart = frame.contentWindow.drawChart;
      frame.contentWindow.drawChart = () => {
        const context = chart.getContext("2d");
        const fillRect = context.fillRect;
        const points = [];
        context.fillRect = (x, y, width, height) => {
          if (width === 4 && height === 4) {
            points.push({ x: x + 2, y: y + 2, color: context.fillStyle });
          } else {
            fillRect.call(context, x, y, width, height);
          }
        };
        try {
          drawChart();
        } finally {
          context.fillRect = fillRect;
        }
        context.save();
        for (const point of points) {
          context.beginPath();
          context.arc(point.x, point.y, 7, 0, 2 * Math.PI);
          context.fillStyle = point.color;
          context.fill();
          context.lineWidth = 2.5;
          context.strokeStyle = "#fff";
          context.stroke();
        }
        context.restore();
        controlKey.hidden = !doc.getElementById("chart-note").textContent.includes("amber:");
      };
      const stylesheet = doc.createElement("link");
      stylesheet.rel = "stylesheet";
      stylesheet.href = new URL("./assets/map-navigation.css", document.baseURI).href;
      doc.head.append(stylesheet);
      mapWrap.classList.add("map-nav-window", "ndvi-map-window");
      const viewport = doc.createElement("div");
      viewport.className = "map-viewport";
      const content = doc.createElement("div");
      content.className = "map-scroll-content";
      const stage = doc.createElement("div");
      stage.className = "ndvi-map-stage";
      const marker = doc.createElement("div");
      marker.className = "map-click-marker";
      marker.hidden = true;
      marker.setAttribute("aria-hidden", "true");
      const scale = doc.createElement("div");
      scale.className = "map-scale";
      scale.setAttribute("aria-label", "Map distance scale");
      scale.innerHTML = "<span></span><strong></strong>";
      mapWrap.append(viewport, scale);
      viewport.append(content);
      content.append(stage);
      stage.append(map, marker);
      const grid = data.sensors.sentinel2.class_map.grid;
      stage.style.aspectRatio = `${grid.width} / ${grid.height}`;
      const zoomLabel = doc.createElement("label");
      zoomLabel.textContent = "Map zoom";
      const zoom = doc.createElement("input");
      zoom.type = "range";
      zoom.min = "1";
      zoom.max = "3";
      zoom.step = "any";
      zoom.value = "1";
      zoom.setAttribute("aria-label", "Zoom the fitted NDVI map");
      zoomLabel.append(zoom);
      doc.querySelector(".controls").append(zoomLabel);
      const navigation = setupMapNavigation({ viewport, content, stage, scale, marker, zoom, grid });
      ndviMapObserver = new MutationObserver(() => {
        stage.style.aspectRatio = `${map.width} / ${map.height}`;
      });
      ndviMapObserver.observe(map, { attributes: true, attributeFilter: ["width", "height"] });
      let selectionRequest = 0;
      doc.getElementById("sensor").addEventListener("change", () => {
        selectionRequest += 1;
        navigation.fit();
        marker.hidden = true;
        const status = document.getElementById("ndvi-interaction-status");
        status.classList.remove("error-text");
        status.textContent = "Click a map cell to look for event pixels. If none are recorded in that cell, try a nearby cell.";
      });
      const explanation = doc.createElement("p");
      explanation.className = "muted small";
      explanation.textContent = "Click to centre at one 30 m source cell per screen pixel. The map remains an average of up to 4 × 4 source cells; zooming does not reveal individual-cell NDVI values. Use the zoom slider and scroll to explore.";
      mapWrap.after(explanation);
      const status = document.getElementById("ndvi-interaction-status");
      const error = doc.getElementById("error");
      const details = doc.getElementById("details");
      const selection = doc.getElementById("selection");
      const pixels = doc.getElementById("pixel");
      const pairs = doc.getElementById("pair");
      const pairExplanation = doc.createElement("p");
      pairExplanation.id = "pair-explanation";
      pairExplanation.className = "muted small";
      pairExplanation.textContent = "Some event pixels have recorded matched-control pixels for comparison. When available, the first is shown automatically; you can choose another or select no control. This provides context, not a causal estimate.";
      pairs.closest("label").before(pairExplanation);
      const pairStatus = doc.createElement("p");
      pairStatus.id = "pair-availability";
      pairStatus.className = "muted small";
      pairStatus.setAttribute("role", "status");
      pairs.closest("label").after(pairStatus);
      pairs.setAttribute("aria-describedby", "pair-explanation pair-availability");
      const updatePairAvailability = () => {
        if (details.hidden) {
          pairs.disabled = true;
          pairStatus.textContent = "Checking for matched controls…";
          const selectPixel = frame.contentWindow.selectPixel;
          frame.contentWindow.selectPixel = async (pixel) => {
            const request = ++selectionRequest;
            await selectPixel(pixel);
            if (request !== selectionRequest || !frame.isConnected || details.hidden) return;
            const firstControl = Array.from(pairs.options).find((option) => option.value !== "");
            if (firstControl) {
              pairs.value = firstControl.value;
              pairs.dispatchEvent(new frame.contentWindow.Event("change", { bubbles: true }));
            }
          };
          return;
        }
        const available = Array.from(pairs.options).some((option) => option.value !== "");
        pairs.disabled = !available;
        if (available) {
          pairStatus.textContent = "Matched controls are available for this event pixel.";
        } else if (!error.hidden && error.textContent.trim()) {
          pairStatus.textContent = "Matched controls could not be loaded. See the error message.";
        } else if (pairs.options.length > 1) {
          pairStatus.textContent = "No matched control is recorded for this event pixel.";
        } else {
          pairStatus.textContent = "Checking for matched controls…";
        }
      };
      pairs.disabled = true;
      pairStatus.textContent = "Checking for matched controls…";
      pixels.addEventListener("change", () => {
        pairs.disabled = true;
        pairStatus.textContent = "Checking for matched controls…";
      }, true);
      const pairObserver = new MutationObserver(updatePairAvailability);
      pairObserver.observe(pairs, { childList: true });
      const updateErrorStatus = () => {
        if (error.hidden || !error.textContent.trim()) return false;
        status.classList.add("error-text");
        status.textContent = `${error.textContent.trim()}. Check that the site server is running, then click the map again to retry.`;
        return true;
      };
      map.addEventListener("click", (event) => {
        selectionRequest += 1;
        const bounds = map.getBoundingClientRect();
        const x = (event.clientX - bounds.left) / bounds.width;
        const y = (event.clientY - bounds.top) / bounds.height;
        requestAnimationFrame(() => {
          if (map.isConnected) navigation.zoomTo(x, y);
        });
        error.hidden = true;
        error.textContent = "";
        pairs.disabled = true;
        pairStatus.textContent = "Checking for matched controls…";
        details.hidden = true;
        selection.hidden = false;
        selection.textContent = "Checking the selected cell for event pixels…";
        status.classList.remove("error-text");
        status.textContent = "Checking this map cell for event pixels…";
      }, true);
      const observer = new MutationObserver(() => {
        updatePairAvailability();
        if (updateErrorStatus()) return;
        if (!details.hidden) {
          const count = pixels.options.length;
          status.textContent = `${count} mapped event ${count === 1 ? "pixel" : "pixels"} found. Choose one in the location panel.`;
        } else if (selection.textContent.startsWith("No mapped event pixel")) {
          status.textContent = "No event pixel is recorded in that cell. Try a nearby map cell.";
        }
      });
      observer.observe(details, { attributes: true, attributeFilter: ["hidden"] });
      observer.observe(selection, { childList: true, characterData: true, subtree: true });
      observer.observe(pixels, { childList: true });
      observer.observe(error, {
        attributes: true,
        attributeFilter: ["hidden"],
        childList: true,
        characterData: true,
        subtree: true,
      });
      updateErrorStatus();
      ndviResizeObserver = new ResizeObserver(() => {
        frame.style.height = `${Math.max(720, doc.documentElement.scrollHeight)}px`;
      });
      ndviResizeObserver.observe(doc.documentElement);
    }, { once: true });
  };

  const download = (url, label) =>
    `<a class="download-link" href="${escapeHtml(url)}" download>${escapeHtml(label)}</a>`;

  const pageHeading = (eyebrow, title, description, sensorSelector = false) => `
    <div class="page-heading">
      <div>
        <p class="eyebrow">${escapeHtml(eyebrow)}</p>
        <h1>${escapeHtml(title)}</h1>
        <p>${escapeHtml(description)}</p>
      </div>
      ${sensorSelector ? renderSensorSelector() : ""}
    </div>`;

  const renderSensorSelector = () => `
    <div class="sensor-switch" role="group" aria-label="Choose one sensor product">
      <button type="button" data-sensor="landsat" class="${currentSensor === "landsat" ? "active" : ""}" aria-pressed="${currentSensor === "landsat"}">Landsat</button>
      <button type="button" data-sensor="sentinel2" class="${currentSensor === "sentinel2" ? "active" : ""}" aria-pressed="${currentSensor === "sentinel2"}">Sentinel-2</button>
    </div>`;

  const sensor = () => data.sensors[currentSensor];
  const entityUrl = (kind) =>
    new URL(
      `${data.entity_paths[currentSensor][kind]}${kind === "distance_bands" ? ".zip" : ""}`,
      dashboardDataUrl
    ).href;
  const sourceUrl = (filename) =>
    new URL(`../sources/${filename}`, dashboardDataUrl).href;
  const manifestUrl = () =>
    new URL("../dashrepo_manifest.json", dashboardDataUrl).href;

  const loadIntakeManifest = () => {
    if (!intakeManifestPromise) {
      intakeManifestPromise = fetch(manifestUrl()).then((response) => {
        if (!response.ok) {
          throw new Error(`Intake manifest request failed (${response.status}).`);
        }
        return response.json();
      }).then((manifest) => {
        if (
          manifest.namespace !== data.namespace
          || manifest.source_phase4_manifest_sha256 !== data.source_phase4_manifest_sha256
        ) {
          throw new Error("Intake manifest does not match the displayed pinned namespace.");
        }
        return manifest;
      });
    }
    return intakeManifestPromise;
  };

  const renderHashGateReport = () => {
    const target = document.getElementById("hash-gate-report");
    if (!target) return;
    loadIntakeManifest().then(async (manifest) => {
      const derivedRows = await Promise.all(
        Object.entries(manifest.derived_artifacts_sha256).map(
          async ([path, metadata]) => {
            const sidecarUrl = new URL(metadata.provenance_sidecar, manifestUrl());
            const response = await fetch(sidecarUrl);
            if (!response.ok) {
              throw new Error(`Derived provenance request failed (${response.status}) for ${path}.`);
            }
            const sidecar = await response.json();
            return {
              path,
              ...metadata,
              derivation: sidecar.derivation,
              parents: Object.entries(
                sidecar.derived_from_phase4_outputs_sha256
              ).map(([name, hash]) => `${name}: ${hash}`).join("; "),
            };
          }
        )
      );
      target.innerHTML = `
        <p>Verified the accepted Phase 4 manifest and all ${number(Object.keys(manifest.source_phase4_outputs_sha256).length)} Phase 4 output/sidecar hashes. The six display extracts below carry their parent-output hashes.</p>
        <details><summary>Phase 4 output and sidecar SHA-256 values</summary>${table(
          ["Pinned output", "SHA-256"],
          Object.entries(manifest.source_phase4_outputs_sha256),
          (row) => `<tr><td class="mono">${escapeHtml(row[0])}</td><td class="mono">${escapeHtml(row[1])}</td></tr>`
        )}</details>
        <details><summary>Verified supporting-source SHA-256 values</summary>${table(
          ["Pinned source", "SHA-256"],
          Object.entries({
            ...manifest.source_entities_sha256,
            ...manifest.verified_auxiliary_hashes,
          }),
          (row) => `<tr><td class="mono">${escapeHtml(row[0])}</td><td class="mono">${escapeHtml(row[1])}</td></tr>`
        )}</details>
        <details><summary>Derived artifact and parent hash chain</summary>${table(
          ["Derived artifact", "Derivation", "Artifact SHA-256", "Sidecar SHA-256", "Pinned parents"],
          derivedRows,
          (row) => `<tr><td class="mono">${escapeHtml(row.path)}</td><td>${escapeHtml(row.derivation)}</td><td class="mono">${escapeHtml(row.artifact_sha256)}</td><td class="mono">${escapeHtml(row.provenance_sidecar_sha256)}</td><td class="mono">${escapeHtml(row.parents)}</td></tr>`
        )}</details>`;
    }).catch((cause) => {
      target.classList.add("error-text");
      target.textContent = `The pinned hash-gate report could not be loaded: ${cause.message}`;
    });
  };

  const tierNames = { 1: "T1", 2: "T2 · provisional", 3: "T3 · QA only" };
  const bandNames = { 1: "near", 2: "transition", 3: "far" };
  const eventRecordBytes = 20;

  const coordinateFor = (row, col, grid) => {
    const [a, b, c, d, e, f] = grid.transform;
    return {
      easting: a * (col + 0.5) + b * (row + 0.5) + c,
      northing: d * (col + 0.5) + e * (row + 0.5) + f,
    };
  };

  const renderTrajectorySchematic = () => `
    <figure class="trajectory-schematic">
      <svg viewBox="0 0 760 220" role="img" aria-labelledby="trajectory-title trajectory-desc">
        <title id="trajectory-title">Conceptual disturbance and recovery trajectory</title>
        <desc id="trajectory-desc">A method schematic, not a Curragh data series, showing a disturbance decline, recovery start, and relative magnitude.</desc>
        <path class="schematic-axis" d="M58 25V176H724"></path>
        <path class="schematic-guide" d="M58 76H724"></path>
        <path class="schematic-line" d="M72 74H245L294 150L342 158L388 144L438 116L500 94L580 78L710 69"></path>
        <path class="schematic-mark" d="M294 147V181M388 139V181M294 190H388"></path>
        <text x="66" y="52">NDVI (conceptual)</text>
        <text x="66" y="205">time</text>
        <text x="250" y="205">disturbance onset</text>
        <text x="365" y="205">recovery start</text>
        <text x="309" y="183">magnitude</text>
      </svg>
      <figcaption>Method schematic only — not Curragh data; no measured series or values are shown.</figcaption>
    </figure>`;

  const renderAnnualChart = (item) => {
    const onset = item.timeline.cohorts.filter((row) => row.cohort_tier === "T1");
    const recovery = item.timeline.recovery_onset_years.filter(
      (row) => row.cohort_tier === "T1"
    );
    const onsetByYear = new Map(
      onset.map((row) => [row.onset_year, row.event_pixel_area_equivalent_m2 / 10_000])
    );
    const recoveryByYear = new Map(
      recovery.map((row) => [row.recovery_onset_year, row.pixel_area_equivalent_m2 / 10_000])
    );
    const years = [...new Set([...onsetByYear.keys(), ...recoveryByYear.keys()])]
      .sort((a, b) => a - b);
    if (!years.length) return '<p class="notice">No T1 annual records are available.</p>';
    const maxHectares = Math.max(
      1,
      ...years.flatMap((value) => [
        onsetByYear.get(value) ?? 0,
        recoveryByYear.get(value) ?? 0,
      ])
    );
    const width = Math.max(640, years.length * 38);
    const height = 220;
    const chartBottom = 174;
    const chartTop = 18;
    const plotLeft = 48;
    const plotWidth = width - plotLeft - 10;
    const groupWidth = plotWidth / years.length;
    const barWidth = Math.min(10, groupWidth * 0.32);
    const bars = years.map((value, index) => {
      const x = plotLeft + index * groupWidth + groupWidth / 2;
      const onsetArea = onsetByYear.get(value) ?? 0;
      const recoveryArea = recoveryByYear.get(value) ?? 0;
      const onsetHeight = (onsetArea / maxHectares) * (chartBottom - chartTop);
      const recoveryHeight = (recoveryArea / maxHectares) * (chartBottom - chartTop);
      return `
        <rect class="chart-onset" x="${x - barWidth - 1}" y="${chartBottom - onsetHeight}" width="${barWidth}" height="${onsetHeight}">
          <title>${value} cohort onset: ${onsetArea.toFixed(2)} ha cell-area equivalent</title>
        </rect>
        <rect class="chart-recovery" x="${x + 1}" y="${chartBottom - recoveryHeight}" width="${barWidth}" height="${recoveryHeight}">
          <title>${value} recovery onset: ${recoveryArea.toFixed(2)} ha cell-area equivalent</title>
        </rect>
        <text class="chart-year" x="${x}" y="198">${value}</text>`;
    }).join("");
    return `
      <div class="chart-scroll">
        <svg class="annual-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="T1 cohort onset and recovery onset area by year in 30-metre cell-area-equivalent hectares">
          <path class="chart-axis" d="M44 ${chartTop}V${chartBottom}H${width - 10}"></path>
          <text class="chart-scale" x="2" y="${chartTop + 4}">${maxHectares.toFixed(0)} ha</text>
          <text class="chart-scale" x="20" y="${chartBottom}">0</text>
          ${bars}
        </svg>
      </div>
      <div class="chart-legend">
        <span><i class="chart-swatch onset"></i>T1 cohort onset</span>
        <span><i class="chart-swatch recovery"></i>T1 recovery onset</span>
      </div>
      <p class="caption">T1 onset and recovery-onset areas are shown as hectares of 30 m cell-area equivalents; these are not surveyed or statutory areas. T2 and T3 remain separate.</p>`;
  };

  const renderMapWorkspace = (management = false) => {
    const item = sensor();
    const grid = item.class_map.grid;
    const mapUrl = new URL(item.class_map.path, dashboardDataUrl).href;
    const bandLabels = item.distance_bands.edges
      .map((edge) => {
        const upper = edge.upper_m_exclusive == null
          ? "and beyond"
          : `to ${number(edge.upper_m_exclusive)} m`;
        return `<span><i class="band-key ${escapeHtml(edge.band)}"></i>${escapeHtml(edge.band)} · ${number(edge.lower_m_inclusive)} m ${upper}</span>`;
      }).join("");
    const exemplarMarkers = grid.exemplars.map((entry) => `
      <button
        type="button"
        class="exemplar-marker class-${entry.code}"
        data-exemplar="${entry.code}"
        style="left:${((entry.pixel_col + 0.5) / grid.width) * 100}%;top:${((entry.pixel_row + 0.5) / grid.height) * 100}%"
        aria-label="Open class ${entry.code} example: ${escapeHtml(entry.plain_language)}"
        title="Class ${entry.code} example"
      >${entry.code}</button>`).join("");
    const classes = item.class_map.legend.map((entry) => `
      <li><span class="swatch" style="background:rgb(${entry.color.join(",")})"></span>
        <span><strong>${escapeHtml(entry.label.split(" - ")[0])}</strong> — ${escapeHtml(entry.plain_language)}
          ${entry.code === 5 || entry.code === 6 ? `<small>${escapeHtml(item.fragility.interpretation)} Fragility: Landsat ${number(data.sensors.landsat.fragility.percent)}%; Sentinel-2 ${number(data.sensors.sentinel2.fragility.percent)}%.</small>` : ""}
        </span>
      </li>`).join("");
    const years = [...new Set(item.timeline.cohorts
      .filter((row) => row.cohort_tier === "T1")
      .map((row) => row.onset_year))].sort((a, b) => a - b);
    const sizeMb = (item.events.interactive_bytes / (1024 * 1024)).toFixed(1);
    return `
      <div class="map-workspace">
        <div class="map-controls" aria-label="Map controls">
          <div class="map-sensor-control"><span>Sensor</span>${renderSensorSelector()}</div>
          <label>Tier
            <select id="map-tier">
              <option value="1" selected>T1 · primary</option>
              <option value="2">T2 · provisional</option>
              <option value="3">T3 · QA only</option>
            </select>
          </label>
          <label>Onset cohort
            <select id="map-year">
              <option value="all">All T1 cohorts</option>
              ${years.map((value) => `<option value="${value}">${value}</option>`).join("")}
            </select>
          </label>
          <label>View
            <select id="map-mode">
              <option value="class" ${management ? "" : "selected"}>Canonical class map</option>
              <option value="events" ${management ? "selected" : ""}>Class-coded event locations</option>
              <option value="onset">Onset-year gradient</option>
              <option value="recovery">Recovery-onset gradient</option>
            </select>
          </label>
          <label>Map zoom
            <input id="map-zoom" type="range" min="1" max="3" step="any" value="1" aria-label="Zoom the map">
          </label>
        </div>
        <p class="caption fixed-floor-note">Click the map to centre the location at one 30 m grid cell per screen pixel. Use the zoom slider and scroll to explore. Display floor: 2 cells, fixed; floors 4 and 9 are sensitivities.</p>
        <p id="map-status" class="map-status" role="status">Loading the full pinned event population…</p>
        <div class="grid map-layout">
          <section>
            <div class="map-nav-window">
            <div class="map-viewport">
              <div class="map-scroll-content">
              <div class="map-stage" style="aspect-ratio:${grid.width}/${grid.height}">
                <img class="map-raster" src="${escapeHtml(mapUrl)}" alt="${escapeHtml(item.label)} canonical six-class map of the Curragh analysis AOI">
                <canvas id="band-layer" width="${grid.width}" height="${grid.height}" aria-hidden="true"></canvas>
                <canvas id="event-layer" width="${grid.width}" height="${grid.height}" aria-label="Interactive pinned event locations"></canvas>
                <canvas id="footprint-layer" width="${grid.width}" height="${grid.height}" aria-hidden="true"></canvas>
                <div class="exemplar-markers">${exemplarMarkers}</div>
                <div class="map-north" aria-label="North">N<span>↑</span></div>
                <div class="map-click-marker" hidden aria-hidden="true"></div>
              </div>
              </div>
            </div>
            <div class="map-scale" aria-label="Map distance scale"><span></span><strong></strong></div>
            </div>
            <ul class="legend map-legend">${classes}</ul>
            <div class="map-key">${bandLabels}</div>
            <p class="caption">Distance-band outlines show dissolved floor-2 administrative geometries across cohorts; these are strata only, not ecological boundaries or lease limits. Grid references use MGA2020 Zone 55.</p>
            <div class="notice warning geometry-disclosure">
              Lease-union outline and Queensland/region locator geometry are not present in the accepted pinned inputs, so they are not drawn here.
            </div>
          </section>
          <aside class="map-side-panel">
            <section class="panel selected-cohort" aria-live="polite">
              <h2>Selected cohort</h2>
              <div id="cohort-details"></div>
            </section>
            <section class="panel selected-location" aria-live="polite">
              <h2>${management ? "Selected location" : "Map inspection"}</h2>
              <div id="location-details"><p>Select a point or a class example on the map.</p></div>
            </section>
            ${management ? `
              <section class="panel referral-panel">
                <h2>Field follow-up checklist</h2>
                <ol>
                  <li>Record the selected point's grid reference and mapped cohort.</li>
                  <li>Check the location on the ground and document what is actually present.</li>
                  <li>Compare the observation with later monitoring and other site evidence.</li>
                </ol>
                <p class="caption">Detect → locate → inspect → re-assess. This display does not send an email, raise an alert, or connect to a live system.</p>
              </section>` : `
              <section class="panel">
                <h2>Class examples</h2>
                <p>Each marker is an actual pixel selected from the pinned class raster; it is a class-pattern example, not a separate event or field observation.</p>
                <div class="exemplar-list">${grid.exemplars.map((entry) => `
                  <button type="button" class="exemplar-link" data-exemplar="${entry.code}">
                    <span class="swatch" style="background:rgb(${item.class_map.legend.find((row) => row.code === entry.code).color.join(",")})"></span>
                    ${escapeHtml(entry.label.split(" - ")[0])}: ${escapeHtml(entry.plain_language)}
                  </button>`).join("")}
                </div>
              </section>`}
            <section class="panel capability-panel">
              <h2>Inspect fitted NDVI through time</h2>
              <p>The separate fitted-NDVI viewer lets you select a map cell and inspect an exact event pixel through the annual record. Choose the same sensor and event pixel to continue from this view. The chart shows fitted values, keeps gaps explicit, and is not an impact estimate.</p>
              <button type="button" class="text-action" data-go-view="ndvi">Open the fitted NDVI viewer →</button>
            </section>
          </aside>
        </div>
        <p class="payload-note">Full population: ${number(item.events.interactive_records)} event pixels · ${sizeMb} MiB static point payload for this sensor. Counts are preserved; no population subset is used.</p>
      </div>`;
  };

  const loadMapAssets = (item) => {
    const sensorKey = currentSensor;
    if (!mapAssetCache.has(sensorKey)) {
      const eventUrl = new URL(`${item.events.interactive_path}.gz`, dashboardDataUrl);
      const orientationUrl = new URL(item.orientation_path, dashboardDataUrl);
      const promise = Promise.all([
        fetch(eventUrl).then((response) => {
          if (!response.ok) throw new Error(`Event payload request failed (${response.status}).`);
          if (typeof DecompressionStream === "undefined") {
            throw new Error("This browser does not support gzip decompression.");
          }
          return new Response(response.body.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
        }),
        fetch(orientationUrl).then((response) => {
          if (!response.ok) throw new Error(`Orientation payload request failed (${response.status}).`);
          return response.json();
        }),
      ]).then(([buffer, orientation]) => {
        const view = new DataView(buffer);
        const magic = new TextDecoder().decode(new Uint8Array(buffer, 0, 8));
        const count = view.getUint32(8, true);
        const recordBytes = view.getUint16(12, true);
        if (magic !== "DASH-EV1" || recordBytes !== eventRecordBytes) {
          throw new Error("The pinned event payload has an unknown binary format.");
        }
        if (buffer.byteLength !== 16 + count * recordBytes || count !== item.events.interactive_records) {
          throw new Error("The pinned event payload length does not match its verified record count.");
        }
        return { buffer, view, count, orientation };
      });
      mapAssetCache.set(sensorKey, promise);
    }
    return mapAssetCache.get(sensorKey);
  };

  const eventAt = (view, index) => {
    const offset = 16 + index * eventRecordBytes;
    return {
      eventId: view.getUint32(offset, true),
      row: view.getUint16(offset + 4, true),
      col: view.getUint16(offset + 6, true),
      onsetYear: view.getUint16(offset + 8, true),
      recoveryYear: view.getUint16(offset + 10, true),
      classCode: view.getUint8(offset + 12),
      tier: view.getUint8(offset + 13),
      flags: view.getUint8(offset + 14),
      componentCells: view.getUint32(offset + 15, true),
      band: view.getUint8(offset + 19),
    };
  };

  const drawBandGeometry = (canvas, features, grid) => {
    const context = canvas.getContext("2d");
    const [a, b, c, d, e, f] = grid.transform;
    const determinant = a * e - b * d;
    const point = ([x, y]) => ({
      x: (e * (x - c) - b * (y - f)) / determinant,
      y: (-d * (x - c) + a * (y - f)) / determinant,
    });
    const polygon = (rings) => {
      for (const ring of rings) {
        if (!ring.length) continue;
        const first = point(ring[0]);
        context.moveTo(first.x, first.y);
        for (let index = 1; index < ring.length; index += 1) {
          const next = point(ring[index]);
          context.lineTo(next.x, next.y);
        }
        context.closePath();
      }
    };
    context.clearRect(0, 0, grid.width, grid.height);
    for (const feature of features) {
      context.beginPath();
      const geometry = feature.geometry;
      if (geometry.type === "Polygon") polygon(geometry.coordinates);
      if (geometry.type === "MultiPolygon") {
        geometry.coordinates.forEach(polygon);
      }
      context.strokeStyle = {
        near: "#e9ab4e",
        transition: "#3d8e82",
        far: "#5578a8",
      }[feature.properties.band];
      context.lineWidth = 2;
      context.stroke();
    }
  };

  const yearColor = (value, min, max) => {
    const ratio = max === min ? 0.5 : (value - min) / (max - min);
    const hue = 225 - Math.max(0, Math.min(1, ratio)) * 190;
    return [Math.round(45 + ratio * 170), Math.round(103 + (1 - ratio) * 55), Math.round(205 - ratio * 145)];
  };

  const drawEvents = (assets, item, controls) => {
    const canvas = document.getElementById("event-layer");
    const status = document.getElementById("map-status");
    if (!canvas || !status) return;
    const { grid } = item.class_map;
    const context = canvas.getContext("2d");
    const image = context.createImageData(grid.width, grid.height);
    const view = assets.view;
    const tier = Number(controls.tier.value);
    const selectedYear = controls.year.value;
    const mode = controls.mode.value;
    const observedYears = mode === "recovery"
      ? item.timeline.recovery_onset_years.filter((row) => row.cohort_tier === tierNames[tier].slice(0, 2)).map((row) => row.recovery_onset_year)
      : item.timeline.cohorts.filter((row) => row.cohort_tier === tierNames[tier].slice(0, 2)).map((row) => row.onset_year);
    const minYear = Math.min(...(observedYears.length ? observedYears : [0]));
    const maxYear = Math.max(...(observedYears.length ? observedYears : [0]));
    const colorByClass = new Map(item.class_map.legend.map((entry) => [
      entry.code,
      entry.color,
    ]));
    let visible = 0;
    let matchingRecords = 0;

    for (let index = 0; index < assets.count; index += 1) {
      const record = eventAt(view, index);
      if (record.tier !== tier) continue;
      if (selectedYear !== "all" && record.onsetYear !== Number(selectedYear)) continue;
      matchingRecords += 1;
      if (mode === "class") continue;
      const colorYear = mode === "recovery" ? record.recoveryYear : record.onsetYear;
      if (mode === "recovery" && colorYear === 0) continue;
      const pixelOffset = (record.row * grid.width + record.col) * 4;
      const color = mode === "class"
        ? colorByClass.get(record.classCode)
        : yearColor(colorYear, minYear, maxYear);
      image.data[pixelOffset] = color[0];
      image.data[pixelOffset + 1] = color[1];
      image.data[pixelOffset + 2] = color[2];
      image.data[pixelOffset + 3] = 220;
      visible += 1;
    }
    context.putImageData(image, 0, 0);
    drawBandGeometry(
      document.getElementById("band-layer"),
      assets.orientation.features,
      grid
    );
    status.textContent = mode === "class"
      ? `Canonical six-class raster shown. ${number(matchingRecords)} ${tierNames[tier]} event pixels are available; choose an event or timing overlay to render them from the full pinned population.`
      : `${number(visible)} matching event pixels shown from the full pinned population.`;
    if (tier === 2) status.textContent += " T2/2013 is provisional and is not mixed with T1.";
    if (tier === 3) status.textContent += ` ${data.disclosures.r_d_caption}`;
    if (mode === "onset" || mode === "recovery") {
      status.textContent += ` Gradient range follows the observed ${mode === "onset" ? "cohort onset" : "recovery onset"} years for ${tierNames[tier]}.`;
    }
    status.dataset.baseMessage = status.textContent;
  };

  const drawSelectedFootprint = (record, assets, item, zoom) => {
    const canvas = document.getElementById("footprint-layer");
    const status = document.getElementById("map-status");
    if (!canvas) return;
    const context = canvas.getContext("2d");
    const { width, height } = item.class_map.grid;
    context.clearRect(0, 0, width, height);
    if (status?.dataset.baseMessage) {
      status.textContent = status.dataset.baseMessage;
    }
    if (!record || record.isExemplar || zoom < 2) {
      if (record && !record.isExemplar && zoom < 2 && status) {
        status.textContent += " Zoom to 2× or more to view the selected component footprint.";
      }
      return;
    }

    const cells = new Set();
    for (let index = 0; index < assets.count; index += 1) {
      const candidate = eventAt(assets.view, index);
      if (candidate.eventId === record.eventId) {
        cells.add(candidate.row * width + candidate.col);
      }
    }
    if (cells.size !== record.componentCells) {
      throw new Error(
        `Selected event ${record.eventId} has ${cells.size} pixel records; expected ${record.componentCells}.`
      );
    }
    context.beginPath();
    for (const cell of cells) {
      const row = Math.floor(cell / width);
      const col = cell % width;
      if (row === 0 || !cells.has((row - 1) * width + col)) {
        context.moveTo(col, row);
        context.lineTo(col + 1, row);
      }
      if (col === width - 1 || !cells.has(row * width + col + 1)) {
        context.moveTo(col + 1, row);
        context.lineTo(col + 1, row + 1);
      }
      if (row === height - 1 || !cells.has((row + 1) * width + col)) {
        context.moveTo(col + 1, row + 1);
        context.lineTo(col, row + 1);
      }
      if (col === 0 || !cells.has(row * width + col - 1)) {
        context.moveTo(col, row + 1);
        context.lineTo(col, row);
      }
    }
    context.strokeStyle = "#b9473d";
    context.lineWidth = 2;
    context.stroke();
    if (status) {
      status.textContent += " Selected component outline follows its pinned 30 m event pixels.";
    }
  };

  const renderEventDetails = (record, item) => {
    const details = document.getElementById("location-details");
    if (!details) return;
    if (!record) {
      details.innerHTML = "<p>Select a point or a class example on the map.</p>";
      return;
    }
    const coord = coordinateFor(record.row, record.col, item.class_map.grid);
    const classInfo = item.class_map.legend.find(
      (entry) => entry.code === record.classCode
    );
    if (record.isExemplar) {
      details.innerHTML = `
        <p><strong>Class ${record.classCode}</strong> · ${escapeHtml(record.plainLanguage)}</p>
        <p>${escapeHtml(classInfo.label)}. This is a real class-raster pixel selected as an example, not an event, field check, or independent observation.</p>
        <p class="mono">MGA2020 Zone 55 · E ${number(Math.round(coord.easting))} m · N ${number(Math.round(coord.northing))} m</p>`;
      return;
    }
    const flags = [
      record.flags & 2 ? "same-year flag" : "",
      record.flags & 4 ? "window gap" : "",
      record.flags & 8 ? "overlaps prior cohort" : "",
    ].filter(Boolean);
    const floors = [2, 4, 9].filter((value) => record.componentCells >= value);
    details.innerHTML = `
      <p><strong>Event ${number(record.eventId)}</strong> · ${escapeHtml(classInfo.label)}</p>
      <p>${escapeHtml(classInfo.plain_language)} · cohort ${record.onsetYear} · <span class="badge ${record.tier === 3 ? "qa" : ""}">${escapeHtml(tierNames[record.tier])}</span></p>
      <p>Distance stratum: ${escapeHtml(bandNames[record.band])}. Component: ${number(record.componentCells)} event pixels; included at floors ${floors.join(", ") || "none"}.</p>
      <p>MGA2020 Zone 55 · E ${number(Math.round(coord.easting))} m · N ${number(Math.round(coord.northing))} m</p>
      <p>Recovery onset: ${record.recoveryYear ? year(record.recoveryYear) : "not recorded"} · QA flags: ${flags.length ? escapeHtml(flags.join(", ")) : "none recorded"}.</p>
      ${record.tier === 3 ? `<div class="caption-box">${escapeHtml(data.disclosures.r_d_caption)}</div>` : ""}
      <p class="caption">No mining-attribution or causal claim is made. These are pinned trajectory records, not field observations.</p>`;
  };

  const renderCohortDetails = (item, controls) => {
    const target = document.getElementById("cohort-details");
    if (!target) return;
    const tier = tierNames[Number(controls.tier.value)].slice(0, 2);
    const matchingTier = item.timeline.cohorts.filter(
      (row) => row.cohort_tier === tier
    );
    if (controls.year.value === "all") {
      target.innerHTML = `
        <p>${number(matchingTier.length)} ${escapeHtml(tier)} cohort years are available. Choose a year to inspect its event/pixel counts, window status and matched-control gate rows; gate results are not pooled across years.</p>
        <p class="caption">${escapeHtml(item.timeline.matching_gate_note)}</p>
        <p class="caption">${escapeHtml(item.timeline.fragility_note)}</p>`;
      return;
    }
    const row = matchingTier.find(
      (entry) => entry.onset_year === Number(controls.year.value)
    );
    if (!row) {
      target.textContent = `No pinned cohort record is available for ${tier}/${controls.year.value}.`;
      return;
    }
    const arms = Object.entries(row.matching_gate.by_matching_arm).map(
      ([matchingArm, values]) => ({
        matchingArm,
        ...values,
      })
    );
    const armTable = table(
      ["Matching arm", "Gate rows", "Eligible", "Flagged", "Evidence permitted"],
      arms,
      (arm) => `<tr><td>${escapeHtml(arm.matchingArm)}</td><td>${number(arm.matching_cell_rows)}</td><td>${number(arm.gate_eligible_rows)}</td><td>${number(arm.flagged_rows)}</td><td>${number(arm.evidence_permitted_rows)}</td></tr>`
    );
    target.innerHTML = `
      <p><strong>${year(row.onset_year)} · ${escapeHtml(row.cohort_tier)}</strong>${row.provisional ? " · provisional" : ""}${row.qa_only ? " · QA only" : ""}</p>
      <p>${number(row.event_components)} event components · ${number(row.event_pixels)} event pixels · ${number(row.event_pixel_area_equivalent_m2)} m² cell-area equivalent.</p>
      <p>Window: ${row.window_gapped ? `gapped (${escapeHtml(row.window_gapped_years)})` : "complete"} · cohort status: ${escapeHtml(row.tier_status)} · matching participation references: ${number(row.matching_participation_reference_count)}.</p>
      <p>Matched-control gate rows at floor 2: ${number(row.matching_gate.gate_eligible_rows)} eligible, ${number(row.matching_gate.flagged_rows)} flagged, ${number(row.matching_gate.evidence_permitted_rows)} evidence-permitted of ${number(row.matching_gate.matching_cell_rows)} source rows. Results are reported by arm, not pooled across years.</p>
      ${armTable}
      ${row.qa_only ? `<div class="caption-box">${escapeHtml(row.r_d_caption)}</div>` : ""}
      <p class="caption">${escapeHtml(item.timeline.fragility_note)}</p>`;
  };

  const bindMapWorkspace = () => {
    const sensorKey = currentSensor;
    const item = sensor();
    const controls = {
      tier: document.getElementById("map-tier"),
      year: document.getElementById("map-year"),
      mode: document.getElementById("map-mode"),
    };
    if (!controls.tier) return;
    controls.tier.addEventListener("change", () => {
      const validYears = item.timeline.cohorts
        .filter((row) => row.cohort_tier === tierNames[Number(controls.tier.value)].slice(0, 2))
        .map((row) => row.onset_year);
      controls.year.innerHTML = `<option value="all">All ${escapeHtml(tierNames[Number(controls.tier.value)])} cohorts</option>${[...new Set(validYears)].sort((a, b) => a - b).map((value) => `<option value="${value}">${value}</option>`).join("")}`;
      renderCohortDetails(item, controls);
    });
    controls.year.addEventListener("change", () => renderCohortDetails(item, controls));
    for (const control of Object.values(controls)) {
      control.addEventListener("change", () => {
        selectedEvent = null;
        renderEventDetails(null, item);
        const footprint = document.getElementById("footprint-layer");
        if (footprint) footprint.getContext("2d").clearRect(0, 0, footprint.width, footprint.height);
        if (window.currentMapAssets) drawEvents(window.currentMapAssets, item, controls);
      });
    }
    const zoomControl = document.getElementById("map-zoom");
    const navigation = setupMapNavigation({
      viewport: document.querySelector(".map-viewport"),
      content: document.querySelector(".map-scroll-content"),
      stage: document.querySelector(".map-stage"),
      scale: document.querySelector(".map-scale"),
      marker: document.querySelector(".map-click-marker"),
      zoom: zoomControl,
      grid: item.class_map.grid,
      onZoom: (zoom) => {
        if (!window.currentMapAssets || !selectedEvent) return;
        try {
          drawSelectedFootprint(selectedEvent, window.currentMapAssets, item, zoom);
        } catch (cause) {
          const status = document.getElementById("map-status");
          if (status) status.textContent = `The selected footprint could not be drawn: ${cause.message}`;
        }
      },
    });
    document.getElementById("event-layer").addEventListener("click", (event) => {
      const canvas = event.currentTarget;
      const bounds = canvas.getBoundingClientRect();
      const x = (event.clientX - bounds.left) / bounds.width;
      const y = (event.clientY - bounds.top) / bounds.height;
      requestAnimationFrame(() => {
        if (canvas.isConnected) navigation.zoomTo(x, y);
      });
    });
    document.querySelectorAll(".exemplar-marker").forEach((marker) => {
      marker.addEventListener("click", () => {
        const exemplar = item.class_map.grid.exemplars.find(
          (entry) => entry.code === Number(marker.dataset.exemplar)
        );
        navigation.zoomTo(
          (exemplar.pixel_col + 0.5) / item.class_map.grid.width,
          (exemplar.pixel_row + 0.5) / item.class_map.grid.height
        );
      });
    });
    renderCohortDetails(item, controls);
    loadMapAssets(item).then((assets) => {
      if (currentSensor !== sensorKey || !document.getElementById("event-layer")) return;
      window.currentMapAssets = assets;
      drawEvents(assets, item, controls);
      document.querySelectorAll("[data-exemplar]").forEach((button) => {
        button.addEventListener("click", () => {
          const exemplar = item.class_map.grid.exemplars.find(
            (entry) => entry.code === Number(button.dataset.exemplar)
          );
          selectedEvent = {
            row: exemplar.pixel_row,
            col: exemplar.pixel_col,
            classCode: exemplar.code,
            plainLanguage: exemplar.plain_language,
            isExemplar: true,
          };
          drawSelectedFootprint(
            selectedEvent,
            assets,
            item,
            Number(zoomControl.value)
          );
          renderEventDetails(selectedEvent, item);
          document.querySelectorAll(".exemplar-marker").forEach((marker) => {
            marker.classList.toggle(
              "selected",
              Number(marker.dataset.exemplar) === exemplar.code
            );
          });
        });
      });
      document.getElementById("event-layer").addEventListener("click", (event) => {
        const canvas = event.currentTarget;
        const bounds = canvas.getBoundingClientRect();
        const col = Math.floor(((event.clientX - bounds.left) / bounds.width) * item.class_map.grid.width);
        const row = Math.floor(((event.clientY - bounds.top) / bounds.height) * item.class_map.grid.height);
        let nearest = null;
        let distance = 64;
        for (let index = 0; index < assets.count; index += 1) {
          const candidate = eventAt(assets.view, index);
          if (candidate.tier !== Number(controls.tier.value)) continue;
          if (controls.year.value !== "all" && candidate.onsetYear !== Number(controls.year.value)) continue;
          if (controls.mode.value === "recovery" && candidate.recoveryYear === 0) continue;
          const candidateDistance = (candidate.row - row) ** 2 + (candidate.col - col) ** 2;
          if (candidateDistance < distance) {
            nearest = candidate;
            distance = candidateDistance;
          }
        }
        selectedEvent = nearest;
        renderEventDetails(nearest, item);
        try {
          drawSelectedFootprint(
            nearest,
            assets,
            item,
            Number(zoomControl.value)
          );
        } catch (cause) {
          const status = document.getElementById("map-status");
          if (status) status.textContent = `The selected footprint could not be drawn: ${cause.message}`;
        }
      });
    }).catch((cause) => {
      if (currentSensor !== sensorKey) return;
      const status = document.getElementById("map-status");
      if (status) {
        status.classList.add("error-text");
        status.textContent = `The pinned map interaction data could not be loaded: ${cause.message}`;
      }
    });
  };

  const renderOverview = () => {
    return `
      ${pageHeading(
        "Welcome",
        "Satellite monitoring to guide rehabilitation decisions",
        "Mine rehabilitation spans large areas and many years. This demonstration uses satellite time series to show where vegetation patterns change and when, helping managers target follow-up and helping regulators inspect the evidence. It is a monitoring aid—not proof of cause or a pass/fail test of rehabilitation."
      )}
      <div class="notice site-selection-note">
        <p><strong>Why Curragh?</strong> Curragh coal mine, in Queensland’s Bowen Basin, was selected deliberately as a research-informed case study. Yang et al. (2018) analysed Landsat-based disturbance and recovery at Curragh, providing a relevant published precedent—not direct validation or a like-for-like comparison of this dashboard. The pinned data include Landsat events reaching back to 1988 and Sentinel-2 events from 2016, allowing the demonstration to examine vegetation trajectories over time. The paper’s published accuracy results may inform a future validation plan, but they are not accuracy benchmarks for this monitoring demonstration; validation here requires its own reference data and assessment. <a href="https://doi.org/10.1016/j.jclepro.2018.01.050">Read Yang et al. (2018)</a>.</p>
      </div>
      <section class="orientation-panel" aria-labelledby="orientation-title">
        <div class="orientation-intro">
          <p class="eyebrow">Executive summary · Curragh, Queensland</p>
          <h2 id="orientation-title">A clearer view of where to look next</h2>
          <p>Satellite records can reveal patterns of vegetation disturbance and later change across large areas. The goal is to help rehabilitation teams decide <strong>where to look, what to investigate, and how to track change over time</strong>—with evidence that managers and regulators can inspect.</p>
          <p>This is a static, hash-pinned demonstration for one site. It does not prove that mining caused a change, verify rehabilitation on the ground, or replace field checks and regulatory criteria.</p>
          <p>Beyond mining, the underlying approach could be adapted relatively quickly to monitor vegetation in other areas, subject to suitable imagery, site-specific configuration and validation. This site displays Curragh only; it does not run a new analysis on demand.</p>
          <p>As a future enhancement, higher-resolution imagery could help scrutinise locations flagged for management. It is not included in this demonstration and would complement, not replace, field assessment.</p>
        </div>
        <div class="orientation-actions">
          <h2>Where would you like to go?</h2>
          <button type="button" class="start-action" data-go-view="maps"><span>01</span><strong>Explore the maps</strong><small>See vegetation classes and when mapped events begin.</small></button>
          <button type="button" class="start-action" data-go-view="manage"><span>02</span><strong>Follow up a location</strong><small>Select an event point to guide ground-truthing.</small></button>
          <button type="button" class="start-action" data-go-view="reporting"><span>03</span><strong>Review the evidence</strong><small>Inspect cohort summaries, control gates and audit tables.</small></button>
          <button type="button" class="start-action" data-go-view="ndvi"><span>04</span><strong>Explore fitted NDVI</strong><small>Scrub annual maps and inspect an event pixel through time.</small></button>
        </div>
      </section>
      <section class="page-purpose ndvi-promotion" aria-label="Fitted NDVI time-series viewer">
        <strong>See the signal behind a mapped event</strong>
        <p>Explore annual fitted-NDVI maps and inspect a selected event pixel alongside an available matched control. This is a separate, static viewer of fitted values—not observed NDVI, an impact estimate, or a rehabilitation verdict.</p>
        <button type="button" class="text-action" data-go-view="ndvi">Open the fitted NDVI time-series viewer →</button>
      </section>
      <section class="research-foundations" aria-labelledby="research-foundations-title">
        <div class="research-foundations-heading">
          <div>
            <p class="eyebrow">The science behind the demonstration</p>
            <h2 id="research-foundations-title">Built from research, tested with site data</h2>
          </div>
          <button type="button" class="text-action" data-go-view="science">See how the research is used →</button>
        </div>
        <div class="citation-grid">
          <article class="citation-card">
            <span>Study design</span>
            <a href="https://doi.org/10.2307/1942110"><strong>Underwood (1994)</strong><cite>On Beyond BACI: Sampling Designs that Might Reliably Detect Environmental Disturbances</cite></a>
            <small>Why suitable controls and replication matter.</small>
          </article>
          <article class="citation-card">
            <span>Satellite time series</span>
            <a href="https://doi.org/10.1016/j.rse.2010.07.008"><strong>Kennedy, Yang & Cohen (2010)</strong><cite>LandTrendr temporal segmentation algorithms</cite></a>
            <small>Foundation for summarizing long-term change trajectories.</small>
          </article>
          <article class="citation-card">
            <span>Curragh precedent</span>
            <a href="https://doi.org/10.1016/j.jclepro.2018.01.050"><strong>Yang et al. (2018)</strong><cite>Landsat disturbance and recovery at the Curragh coal mine</cite></a>
            <small>A peer-reviewed mining-landscape case study at this site.</small>
          </article>
          <article class="citation-card">
            <span>Mining trajectories</span>
            <a href="https://doi.org/10.1016/j.envres.2026.123868"><strong>Hui & Cheng (2026)</strong><cite>Time-series framework for disturbance and recovery in mining landscapes</cite></a>
            <small>Informs event ordering and trajectory-based interpretation.</small>
          </article>
        </div>
        <p class="citation-caveat">These papers inform the design; they do not validate this implementation or transfer their accuracy results to this dashboard. <a href="./approach-report.html#research-foundations">Full references and explanation</a>.</p>
      </section>
      <section class="plain-methods" aria-label="How the monitoring works">
        <details>
          <summary>How does the before-and-after comparison work?</summary>
          <p><strong>BACI</strong> means Before–After, Control–Impact. In plain terms, compare vegetation change before and after a time of interest in the area being monitored, then compare that change with suitable control areas. This helps separate a local pattern from changes that may also happen across the wider landscape or over time.</p>
          <p>Good controls, enough independent locations, and checks for other causes matter. This demonstration shows matched-control eligibility and quality gates; it does not present a causal effect estimate or prove a mining impact.</p>
        </details>
        <details>
          <summary>How was the vegetation stability threshold chosen?</summary>
          <p>NDVI is a satellite-based indicator of vegetation condition, not a direct measure of species, overall ecological condition, or rehabilitation success. For each sensor separately, the pipeline measures the absolute net change across fitted NDVI histories for a selected calibration group of pixels without an accepted disturbance or recovery event. The 95th percentile of that movement sets the width of the stability band; 90th and 99th percentile alternatives are also checked.</p>
          <p>For this pinned run, the 95th-percentile band widths are 0.2563 for Landsat and 0.2439 for Sentinel-2. They are data-derived, sensor-specific settings for this Curragh demonstration—not universal or regulatory thresholds.</p>
        </details>
        <p class="approach-link"><a href="./approach-report.html">Read the monitoring approach report</a> for the purpose, BACI principles, research foundations, threshold method and limitations.</p>
      </section>
      <div class="spacer"></div>
      ${renderTrajectorySchematic()}
      ${renderMapWorkspace()}
      <div class="spacer"></div>
      ${panel(`${sensor().label} annual disturbance and recovery timing`, renderAnnualChart(sensor()))}
    `;
  };

  const renderMaps = () => {
    const item = sensor();
    const rows = Object.entries(item.class_map.sensitivity_90_95_99).map(
      ([percentile, record]) => ({ percentile, ...record })
    );
    const sensitivity = table(
      ["Percentile", "Band width", "NVG", "NVF", "NVB", "Population"],
      rows,
      (row) => `<tr>
        <td>${escapeHtml(row.percentile)}th</td>
        <td>${Number(row.band_width_absolute_net_fitted_ndvi_change).toFixed(6)}</td>
        <td>${number(row.NVG_count)}</td>
        <td>${number(row.NVF_count)}</td>
        <td>${number(row.NVB_count)}</td>
        <td>${number(row.population_count)}</td>
      </tr>`
    );
    return `
      ${pageHeading(
        "Class and timing maps",
        `${item.label} class and occurrence timing`,
        "Use this page to understand the broad spatial pattern: what vegetation-trajectory class was mapped, and when disturbance or recovery signals began. Compare map modes and years before deciding which locations merit closer review."
      )}
      <div class="notice">The map answers “where and when is a pattern visible?” It does not establish cause or confirm field condition. The threshold table below shows how sensitive the vegetation classes are to alternative, sensor-specific settings.</div>
      <p class="caption">A future version could use higher-resolution imagery to examine flagged locations more closely; this demonstration does not include that imagery.</p>
      <div class="spacer"></div>
      ${renderMapWorkspace()}
      <div class="spacer"></div>
      ${panel("Sensitivity by threshold", `${sensitivity}<p>Population: ${number(item.class_map.population_count)} valid observations. Sensitivity values are copied from the pinned sensor run summary; this page performs no classification or threshold calculation.</p>`)}
      <div class="spacer"></div>
      ${panel("Classification limits", `<p>${escapeHtml(data.disclosures.class_label)}</p><p>DHR/DLR disagreement: ${number(item.fragility.disagreements)} of ${number(item.fragility.accepted_recoveries)} accepted recoveries (${item.fragility.percent.toFixed(2)}%). ${escapeHtml(item.fragility.interpretation)}</p><div class="caption-box">${escapeHtml(data.disclosures.r_d_caption)}</div>`)}
    `;
  };

  const renderManage = () => `
    ${pageHeading(
      "Manage a problem",
      "Turn a mapped signal into a field follow-up",
      "This is the operational follow-up view, not another map-comparison page. Use it when a location has already caught your attention and you need to inspect a point and plan what to check on site."
    )}
    <section class="workflow-panel" aria-label="Suggested field follow-up workflow">
      <div><span>1</span><strong>Choose a sensor and cohort</strong><small>Keep products separate and review the year/tier you need.</small></div>
      <div><span>2</span><strong>Switch to event locations</strong><small>Select an event point to see its mapped class, timing, QA state and grid reference.</small></div>
      <div><span>3</span><strong>Verify on the ground</strong><small>Use the point as a lead for inspection; record field observations through your normal process.</small></div>
    </section>
    <p class="notice warning">A satellite point is not a field observation or a confirmed rehabilitation problem. This demonstration does not create alerts, work orders or field records.</p>
    <p class="caption">Higher-resolution imagery could be added in future to help scrutinise flagged areas before or alongside field follow-up. It is not available in this demonstration.</p>
    ${renderMapWorkspace(true)}
  `;

  const renderReporting = () => {
    const item = sensor();
    const cohortRows = item.timeline.cohorts;
    const cohortLedger = table(
      ["Year", "Tier", "Status", "Event components", "Event pixels", "30 m cell-area equivalent", "Matching refs", "Window / QA note"],
      cohortRows,
      (row) => `<tr>
        <td>${year(row.onset_year)}</td>
        <td><span class="badge ${row.qa_only ? "qa" : ""}">${escapeHtml(row.cohort_tier)}${row.provisional ? " · provisional" : ""}</span></td>
        <td>${escapeHtml(row.tier_status)}${row.tier_flag ? `<br>${escapeHtml(row.tier_flag)}` : ""}</td>
        <td>${number(row.event_components)}</td>
        <td>${number(row.event_pixels)}</td>
        <td>${number(row.event_pixel_area_equivalent_m2)} m²</td>
        <td>${number(row.matching_participation_reference_count)}</td>
        <td>${row.qa_only ? `<span class="caption-cell">${escapeHtml(row.r_d_caption)}</span>` : row.window_gapped ? `Gapped ${escapeHtml(row.window_gapped_years)}` : "Complete"}</td>
      </tr>`
    );
    const audit = item.control_audit;
    const sensitivityRows = Object.entries(item.class_map.sensitivity_90_95_99)
      .map(([percentile, record]) => ({ percentile, ...record }));
    const sensitivity = table(
      ["Threshold percentile", "Band width", "NVG", "NVF", "NVB", "Population"],
      sensitivityRows,
      (row) => `<tr><td>${escapeHtml(row.percentile)}th</td><td>${Number(row.band_width_absolute_net_fitted_ndvi_change).toFixed(6)}</td><td>${number(row.NVG_count)}</td><td>${number(row.NVF_count)}</td><td>${number(row.NVB_count)}</td><td>${number(row.population_count)}</td></tr>`
    );
    const caliperTable = table(
      ["Year", "Matching arm", "Floor", "Band", "HAND label", "Excluded", ">0.02 differences"],
      item.matching_metrics.caliper_exclusion_preview,
      (row) => `<tr><td>${year(row.onset_year)}</td><td>${escapeHtml(row.matching_arm)}</td><td>${number(row.floor)}</td><td>${escapeHtml(row.band)}</td><td>${escapeHtml(row.hand_stratum)}</td><td>${number(Number(row.caliper_excluded))}</td><td>${row.matching_arm === "sensitivity_caliper_0.020" ? number(Number(row.baseline_difference_over_0_02)) : "—"}</td></tr>`
    );
    const reuseTable = table(
      ["Year", "Floor", "Band", "HAND label", "Unique controls", "Repeated controls", "Share repeated", "Max uses"],
      item.matching_metrics.control_reuse_preview,
      (row) => `<tr><td>${year(row.onset_year)}</td><td>${number(row.floor)}</td><td>${escapeHtml(row.band)}</td><td>${escapeHtml(row.hand_stratum)}</td><td>${number(row.unique_controls_in_cell)}</td><td>${number(row.controls_used_in_multiple_cohort_bands)}</td><td>${row.share_controls_used_in_multiple_cohort_bands === "" ? "—" : escapeHtml(row.share_controls_used_in_multiple_cohort_bands)}</td><td>${number(row.max_control_uses)}</td></tr>`
    );
    return `
      ${pageHeading(
        "Regulator reporting",
        "Pinned evidence for a reporting submission",
        "A compact review pack for checking what the pinned monitoring outputs say, how the controls performed, and what remains uncertain. These records can support a submission workflow; they are not a completed regulatory report or a compliance finding.",
        true
      )}
      <a class="report-author" href="https://damienogrady.github.io/">
        <img src="./branding/favicon.svg" width="32" height="32" alt="">
        <span><strong>Damien O’Grady</strong>
          <small>Independent remote sensing and GIS consultant</small></span>
      </a>
      <div class="page-purpose"><strong>Why these tables matter</strong><p>Cohort summaries show which mapped years and tiers are represented. Threshold sensitivities show how classification responds to alternative settings. Control gates show whether a comparison met pre-set quality requirements. Together, they let a reviewer trace a conclusion back to its limits instead of relying on a map alone.</p></div>
      <div class="notice warning">All figures below are copied or counted from hash-pinned entities. No new analysis or synthesized result is presented.</div>
      <div class="spacer"></div>
      ${panel("Cohort ledger · fixed 2-cell display floor", `${cohortLedger}<p>${escapeHtml(item.timeline.fragility_note)}</p>`)}
      <div class="spacer"></div>
      ${panel("Sensitivity by threshold", `${sensitivity}<p>Population: ${number(item.class_map.population_count)} valid observations. Sensitivity values are copied from the pinned sensor run summary; this page performs no classification or threshold calculation.</p>`)}
      <div class="spacer"></div>
      <div class="grid four">
        ${metric("Matching cells", number(audit.rows), "Pinned control-summary rows")}
        ${metric("Gate-eligible rows", number(audit.primary_gate_eligible_rows), "Eligibility is not an effect claim")}
        ${metric("Flagged rows", number(audit.flagged_rows), "Never evidence")}
        ${metric("T3/2022 rows", number(audit.qa_only_rows), "QA-only")}
      </div>
      <div class="spacer"></div>
      ${panel("Matched-control gate audit", `${table(
        ["Year", "Tier", "Arm", "Band", "Pairs / n*", "Flags", "Gate", "Evidence"],
        audit.preview,
        (row) => `<tr><td>${year(row.onset_year)}</td><td>${escapeHtml(row.cohort_tier)}</td><td>${escapeHtml(row.matching_arm)}</td><td>${escapeHtml(row.band)}</td><td>${number(row.achieved_pairs)} / ${row.required_n_star == null ? "—" : number(row.required_n_star)}</td><td>${escapeHtml(row.flags)}</td><td>${row.primary_gate_eligible ? "eligible" : "ineligible"}</td><td>${row.evidence_of_effect_permitted ? "permitted" : "not permitted"}</td></tr>`
      )}${download(entityUrl("control_pairs_summary"), "Download pinned control-summary Parquet")}`)}
      <div class="spacer"></div>
      ${panel("Caliper exclusion audit", `<p>${number(item.matching_metrics.caliper_exclusion_rows)} pinned source rows. The sensitivity-arm >0.02 baseline-difference counts are reported only for that arm.</p>${caliperTable}${download(sourceUrl("full_run_caliper_exclusions.csv"), "Download pinned caliper-exclusion CSV")}`)}
      <div class="spacer"></div>
      ${panel("Control reuse audit", `<p>${number(item.matching_metrics.control_reuse_rows)} pinned source rows; no pooled reuse rate is computed.</p>${reuseTable}${download(sourceUrl("full_run_control_reuse.csv"), "Download pinned control-reuse CSV")}`)}
      <div class="spacer"></div>
      ${panel("Tenure and analysis area", `<p>${escapeHtml(data.disclosures.aoi_disclosure)}</p><p>${escapeHtml(tenureReview)}</p><p>${escapeHtml(data.disclosures.generalisation_caveat)}</p>`)}
      <div class="spacer"></div>
      ${panel("Data provenance", `<p>Catalog snapshot: ${escapeHtml(data.catalog_snapshots[currentSensor].effective_scene_count_query_date_utc)} effective-scene query; historical retrieval ${escapeHtml(data.catalog_snapshots[currentSensor].historical_catalog_retrieved_at_utc)}.</p><p>Source hashes and the derived-artifact hash chain are available in Data quality & provenance.</p><p>${escapeHtml(data.disclosures.class_label)}</p>`)}
    `;
  };

  const renderBands = () => {
    const item = sensor();
    const rows = item.distance_bands.fragments_by_tier_floor_band;
    return `
      ${pageHeading(
        "Administrative distance strata",
        `${item.label} distance-band entities`,
        "These records describe how mapped event areas are organized by distance from disturbance for analysis. They help reviewers check which spatial strata contributed to comparisons; they are not a map of ecological zones or lease boundaries.",
        true
      )}
      <div class="page-purpose"><strong>How to read the counts</strong><p>The table counts connected polygon pieces in the pinned GeoPackage for each tier, patch-size floor and distance band. One event or cohort can produce multiple pieces, so a fragment count is not an event count. The 2-cell floor is used for display; 4- and 9-cell floors are sensitivity variants.</p><p><strong>Why managers and regulators need this:</strong> distance is one way the design groups locations for impact–control comparisons. Showing the group definitions and their geometry record helps a reviewer see how those comparisons were spatially organized.</p></div>
      <div class="grid three">
        ${metric("Distance-band fragments", number(item.rows.distance_bands), "Rows in the pinned GeoPackage")}
        ${metric("Cohort × floor rows", number(item.rows.cohorts), "Source cohort records")}
        ${metric("Sensor bands", "3", "Near, transition, far")}
      </div>
      <div class="spacer"></div>
      ${panel(
        "Polygon-fragment row counts",
        `${table(
          ["Tier", "Patch floor (cells)", "Band", "Polygon-fragment rows", "QA note"],
          rows,
          (row) => `<tr>
            <td><span class="badge ${row.cohort_tier === "T3" ? "qa" : ""}">${escapeHtml(row.cohort_tier)}</span></td>
            <td>${number(row.patch_floor_cells)}</td>
            <td>${escapeHtml(row.band)}</td>
            <td>${number(row.polygon_fragment_rows)}</td>
            <td class="caption-cell">${row.cohort_tier === "T3" ? escapeHtml(data.disclosures.r_d_caption) : "—"}</td>
          </tr>`
        )}
        ${download(entityUrl("distance_bands"), "Download pinned GeoPackage (ZIP)")}`
      )}
      <div class="spacer"></div>
      ${panel(
        "Band interpretation",
        `<p>${currentSensor === "sentinel2" ? escapeHtml(data.disclosures.known_s2_far_band_gradient) : "No sensor-specific regional gradient claim is made for Landsat."}</p><p>Band edges are sensor-specific administrative strata. Do not interpret them as ecological boundaries.</p>`
      )}
    `;
  };

  const renderEvents = () => {
    const item = sensor();
    const samples = item.events.schema_preview;
    const eventTable = table(
      ["Event ID", "Pixel ID", "Onset", "Tier", "Class", "Same-year flag", "Gapped window", "Overlap"],
      samples.non_qa_schema_preview,
      (row) => `<tr>
        <td>${number(row.event_id)}</td>
        <td>${number(row.pixel_id)}</td>
        <td>${year(row.onset_year)}</td>
        <td><span class="badge">${escapeHtml(row.cohort_tier)}</span></td>
        <td>${escapeHtml(row.class)}</td>
        <td>${row.same_year_flag ? "true" : "false"}</td>
        <td>${row.window_gapped ? "true" : "false"}</td>
        <td>${row.overlaps_prior_cohort ? "true" : "false"}</td>
      </tr>`
    );
    const qaRows = samples.t3_qa_only_preview;
    const qaTable = table(
      ["Event ID", "Pixel ID", "Onset", "Class", "QA state", "Caption"],
      qaRows,
      (row) => `<tr>
        <td>${number(row.event_id)}</td>
        <td>${number(row.pixel_id)}</td>
        <td>${year(row.onset_year)}</td>
        <td>${escapeHtml(row.class)}</td>
        <td><span class="badge qa">QA only · no inference</span></td>
        <td class="caption-cell">${escapeHtml(row.r_d_caption)}</td>
      </tr>`
    );
    return `
      ${pageHeading(
        "Pinned event records",
        `${item.label} disturbance and recovery event pixels`,
        "An event record is a satellite-mapped pixel associated with a disturbance or recovery trajectory. This page previews the fields behind the map; it is not a list of confirmed field incidents.",
        true
      )}
      <div class="page-purpose"><strong>Why inspect event records?</strong><p>Event identifiers and pixel identifiers let analysts trace a mapped point back to its source record. Onset year and class describe the detected trajectory; tier, same-year flag, window gaps and overlap provide context for judging whether it is ready to interpret. Managers can use locations to plan a field check. Regulators can inspect the QA context. Neither use turns a satellite record into proof of cause.</p><p>The table is a small schema preview, not the full population. Use the map for interactive point inspection or download the pinned Parquet entity for the complete event records.</p></div>
      ${panel("Non-QA schema preview", `${eventTable}${download(entityUrl("trajectory_events"), "Download full trajectory-event Parquet")}`)}
      <div class="spacer"></div>
      ${panel("T3/2022 QA-only rows", `<div class="notice warning"><p>These rows are retained for QA and are never evidence. Mining-impact inference is prohibited.</p><div class="caption-box">${escapeHtml(data.disclosures.r_d_caption)}</div></div><div class="spacer"></div>${qaTable}`)}
      <div class="spacer"></div>
      ${panel("Inspect fitted NDVI through time", `      <p>The event table does not embed annual NDVI values. Open the separate fitted-NDVI viewer and select the same sensor and event pixel to inspect its annual fitted signal and, where available, a recorded matched control. Values are fitted rather than observed; gaps remain explicit, and the comparison is not an impact estimate.</p>`)}
    `;
  };

  const renderCohorts = () => {
    const item = sensor();
    return `
      ${pageHeading(
        "Cohort ledger",
        `${item.label} cohort table`,
        "A cohort groups mapped pixels by the year their disturbance trajectory begins, along with its analysis tier and patch-size setting. The ledger shows which groups are included and the status attached to each one.",
        true
      )}
      <div class="page-purpose"><strong>Why keep a cohort ledger?</strong><p>Year-by-year records stop different event periods from being blended together. Tier indicates whether a group is primary, provisional, or QA-only; patch floor indicates the minimum connected event size used in that source record. Counts by distance band and matching-participation references help analysts and reviewers follow how cohorts enter downstream comparisons. They are source summaries, not recalculated effect estimates.</p></div>
      ${panel(
        "Cohorts × patch floors",
        `${table(
          ["Year", "Tier", "Floor", "Components by band", "Pixels by band", "Matching refs", "Status / caption"],
          item.cohorts.rows,
          (row) => `<tr>
            <td>${year(row.onset_year)}</td>
            <td><span class="badge ${row.qa_only ? "qa" : ""}">${escapeHtml(row.cohort_tier)}${row.provisional ? " · provisional" : ""}</span></td>
            <td>${number(row.patch_floor_cells)}</td>
            <td class="mono">${escapeHtml(row.event_component_count_by_band)}</td>
            <td class="mono">${escapeHtml(row.event_pixel_count_by_band)}</td>
            <td>${number(row.matching_participation_reference_count)}</td>
            <td class="caption-cell">${row.cohort_tier === "T3" ? escapeHtml(row.r_d_caption) : escapeHtml(row.tier_status)}</td>
          </tr>`
        )}
        ${download(entityUrl("cohorts"), "Download full cohort Parquet")}`
      )}
    `;
  };

  const renderControls = () => {
    const item = sensor();
    const audit = item.control_audit;
    const matching = item.matching_metrics;
    const preview = table(
      ["Year", "Tier", "Arm", "Floor", "Band", "HAND label", "Achieved / n*", "Flags", "Gate", "Evidence"],
      audit.preview,
      (row) => `<tr>
        <td>${year(row.onset_year)}</td>
        <td><span class="badge ${row.qa_only ? "qa" : ""}">${escapeHtml(row.cohort_tier)}</span></td>
        <td>${escapeHtml(row.matching_arm)}</td>
        <td>${number(row.patch_floor_cells)}</td>
        <td>${escapeHtml(row.band)}</td>
        <td>${escapeHtml(row.hand_stratum)}</td>
        <td>${number(row.achieved_pairs)} / ${row.required_n_star == null ? "—" : number(row.required_n_star)}</td>
        <td><span class="badge ${row.flagged ? "flagged" : ""}">${row.flagged ? "flagged" : "clear"}</span><br>${escapeHtml(row.flags)}</td>
        <td>${row.primary_gate_eligible ? "eligible" : "ineligible"}</td>
        <td>${row.evidence_of_effect_permitted ? "permitted" : "not permitted"}</td>
      </tr>`
    );
    const reuse = table(
      ["Year", "Floor", "Band", "HAND label", "Unique controls", "Repeated controls", "Share repeated", "Max uses"],
      matching.control_reuse_preview,
      (row) => `<tr>
        <td>${year(row.onset_year)}</td>
        <td>${number(row.floor)}</td>
        <td>${escapeHtml(row.band)}</td>
        <td>${escapeHtml(row.hand_stratum)}</td>
        <td>${number(row.unique_controls_in_cell)}</td>
        <td>${number(row.controls_used_in_multiple_cohort_bands)}</td>
        <td>${row.share_controls_used_in_multiple_cohort_bands === "" ? "—" : escapeHtml(row.share_controls_used_in_multiple_cohort_bands)}</td>
        <td>${number(row.max_control_uses)}</td>
      </tr>`
    );
    const caliper = table(
      ["Year", "Arm", "Floor", "Band", "HAND label", "Caliper excluded", ">0.02 differences"],
      matching.caliper_exclusion_preview,
      (row) => `<tr>
        <td>${year(row.onset_year)}</td>
        <td>${escapeHtml(row.matching_arm)}</td>
        <td>${number(row.floor)}</td>
        <td>${escapeHtml(row.band)}</td>
        <td>${escapeHtml(row.hand_stratum)}</td>
        <td>${number(Number(row.caliper_excluded))}</td>
        <td>${row.matching_arm === "sensitivity_caliper_0.020" ? number(Number(row.baseline_difference_over_0_02)) : "—"}</td>
      </tr>`
    );
    return `
      ${pageHeading(
        "Matched-control gates, not effect claims",
        `${item.label} control audit`,
        "Before comparing vegetation change, the analysis checks whether impact and reference pixels have enough suitable matches and pass quality rules. This page shows those checks—not the size of an environmental effect.",
        true
      )}
      <div class="page-purpose"><strong>Why managers and regulators need this audit</strong><p>A comparison is only useful if its reference locations are credible and the data are adequate. The gate table exposes where matching succeeded, where it did not, and why rows were flagged. A flagged or ineligible row must not be used as evidence; even an eligible row is not, by itself, proof of impact.</p>
        ${currentSensor === "sentinel2" ? `<p class="notice warning"><strong>Sentinel-2 result:</strong> all ${number(audit.rows)} pinned control-summary rows are flagged and none are gate-eligible. This is consistent with the pinned run's cluster-starved status (insufficient independent cohort clusters at all floors). The dashboard therefore presents no Sentinel-2 matched-control effect evidence.</p>` : `<p>The Landsat summary also contains flagged rows. Review the cohort, window and flag details rather than interpreting the overall row count as a result.</p>`}
      </div>
      <div class="grid four">
        ${metric("Control summary rows", number(audit.rows), "One row per matching cell")}
        ${metric("Flagged rows", number(audit.flagged_rows), "Ineligible for evidence")}
        ${metric("Gate-eligible rows", number(audit.primary_gate_eligible_rows), "Machine-checkable state")}
        ${metric("QA-only rows", number(audit.qa_only_rows), "T3/2022")}
      </div>
      <div class="spacer"></div>
      <p class="caption">The caliper tables below are selected previews of matching-cell rows, not complete sensor-wide totals. A zero in a preview row does not mean that no exclusions or baseline differences occurred elsewhere; use the downloadable pinned CSV for the full audit.</p>
      ${panel("Gate-state preview", `${preview}${download(entityUrl("control_pairs_summary"), "Download pinned control-summary Parquet")}`)}
      <div class="spacer"></div>
      ${panel("Caliper exclusion audit", `<p>Matching uses a baseline-NDVI caliper: a rule limiting how different a proposed control can be from an impact pixel before the comparison is accepted. The primary arm uses 0.050; the stricter 0.020 arm is a sensitivity check. The >0.02 difference count is shown only for that sensitivity arm. Source rows: ${number(matching.caliper_exclusion_rows)}.</p>${caliper}${download(sourceUrl("full_run_caliper_exclusions.csv"), "Download complete pinned caliper-exclusion CSV")}`)}
      <div class="spacer"></div>
      ${panel("Control reuse audit", `<p>Reuse rates accompany the matching-cell display. The table shows source rows verbatim; no pooled reuse rate is computed.</p>${reuse}${download(sourceUrl("full_run_control_reuse.csv"), "Download pinned control-reuse CSV")}`)}
      <div class="spacer"></div>
      ${panel("HAND strata", `<p>${escapeHtml(data.disclosures.hand_disclaimer)} Only categorical H1–H10 labels are displayed; no numeric HAND values or cutpoints are included.</p>`)}
    `;
  };

  const renderMethods = () => {
    const catalog = data.catalog_snapshots.landsat;
    const derivedHashes = Object.entries(data.derived_artifact_hashes)
      .map(([path, hashes]) => `<li><span class="mono">${escapeHtml(path)}</span> · SHA-256 <span class="mono">${escapeHtml(hashes.artifact_sha256)}</span> · sidecar SHA-256 <span class="mono">${escapeHtml(hashes.provenance_sidecar_sha256)}</span></li>`)
      .join("");
    return `
      ${pageHeading(
        "Data quality & provenance",
        "Pinned inputs and boundaries",
        "The displayed products are hash-linked to the accepted monitoring-pipeline Phase 4 manifest. No live analysis or catalog service is used."
      )}
      <div class="page-purpose"><strong>Why this page matters</strong><p>Managers need to know which data version a map came from; regulators and reviewers need to be able to check that the displayed files match their recorded sources. The hash-gate record below supports that traceability. The boundary notes explain what this demonstration cannot establish and which release conditions remain open.</p></div>
      <div class="grid two">
        ${panel(
          "Pinned lineage",
          `<p>Demonstration build namespace: <span class="mono">${escapeHtml(data.namespace)}</span></p>
           <p>Monitoring-pipeline Phase 4 namespace: <span class="mono">${escapeHtml(data.source_phase4_namespace)}</span></p>
           <p>Accepted Phase 3 source commit: <span class="mono">${escapeHtml(data.source_phase3_commit_sha)}</span></p>
           <p>Phase 4 manifest SHA-256: <span class="mono">${escapeHtml(data.source_phase4_manifest_sha256)}</span></p>
           <p>Intake checks the source manifest and all 16 output/sidecar hashes. The added interaction extracts are separately hash-gated and linked to their Phase 4 parent outputs.</p>
           <p>Derived artifact hashes:</p><ul>${derivedHashes}</ul>
           ${download(manifestUrl(), "Download intake manifest")}`
        )}
        ${panel(
          "Catalog snapshot",
          `<p>Historical catalog retrieval: <span class="mono">${escapeHtml(catalog.historical_catalog_retrieved_at_utc)}</span></p>
           <p>Effective-scene-count query date: <span class="mono">${escapeHtml(catalog.effective_scene_count_query_date_utc)}</span></p>
           <p>${escapeHtml(catalog.version)}</p>
           <p>Determinism is relative to this pinned snapshot. <span class="mono">OPEN:T2-CATALOG-METADATA-DRIFT</span> remains; metadata is not a scene-selection filter.</p>`
        )}
        ${panel(
          "Boundaries",
          `<ul>
            <li>Per-sensor outputs remain separate; switching sensors changes the view, not a combined analysis.</li>
            <li>Patch floor 2 is fixed; floors 4 and 9 are precomputed sensitivities.</li>
            <li>2022/T3 is QA-only; mining-impact inference is prohibited.</li>
            <li>Distance bands are administrative strata, not ecological claims.</li>
            <li>No per-event NDVI time-series entity exists in this payload; the drawer is an explicitly marked capability affordance only.</li>
            <li>No new analysis, Earth Engine request, or live catalog lookup runs in this demonstration build.</li>
            <li>Lease-union and nested locator geometries are absent from accepted pinned inputs and are not illustrated as if measured.</li>
          </ul>`
        )}
        ${panel(
          "License and release status",
          `<p>The project code uses the MIT licence; third-party data and derived outputs have separate terms. The owner selected the ODbL option for MERIT Hydro and accepted the data-sharing arrangements for this demonstration. This demonstration is not launch-authorized; legal verification of tenure status has not been completed.</p>
           <p>No MERIT-derived raster is included in the website package. HAND-informed categorical strata and matching outputs are included. See <a href="./data-licensing.html">data licensing and downloads</a>.</p>`
        )}
      </div>
      <div class="spacer"></div>
      ${panel(
        "Hash-gate report",
        `<div id="hash-gate-report" role="status">Loading the verified intake hash-gate record…</div>`
      )}
      <div class="spacer"></div>
      ${panel(
        "Rulings and context riders",
        `<ul class="ruling-list">
          <li>${escapeHtml(data.disclosures.aoi_disclosure)}</li>
          <li>${escapeHtml(data.disclosures.hand_disclaimer)}</li>
          <li>${escapeHtml(tenureReview)}</li>
          <li>${escapeHtml(data.disclosures.generalisation_caveat)}</li>
          <li>${escapeHtml(data.disclosures.class_label)}</li>
          <li>${escapeHtml(data.disclosures.r_d_caption)}</li>
          <li>${escapeHtml(data.disclosures.same_year_state)}</li>
          <li>${escapeHtml(data.disclosures.known_s2_far_band_gradient)}</li>
          <li>${escapeHtml(data.capacity.pooled_inference)}</li>
          <li>${escapeHtml(data.capacity["2025_cohort_note"])}</li>
          <li>DHR/DLR fragility: Landsat ${number(data.sensors.landsat.fragility.percent)}%; Sentinel-2 ${number(data.sensors.sentinel2.fragility.percent)}%. These are trajectory-rate labels only, not rehabilitation-quality or completion-criteria verdicts.</li>
        </ul>`
      )}
    `;
  };

  const renderScience = () => `
    ${pageHeading(
      "Science & references",
      "Research foundations and how they are used",
      "The dashboard applies established ideas from remote sensing and environmental study design to a site-specific monitoring workflow. This page separates what the research contributes from what this demonstration itself has established."
    )}
    <div class="notice warning"><strong>Research is a foundation, not a validation stamp.</strong> The cited studies motivate methods and interpretation. They do not establish that this monitoring demonstration is accurate, that its mapped changes were caused by mining, or that rehabilitation meets a completion standard.</div>
    <section class="science-principles">
      <article>
        <span>01 · Observe change</span>
        <h2>Turn a long image record into trajectories</h2>
        <p>Annual satellite observations can be summarized as a time trajectory. Temporal segmentation represents that record as periods and changes rather than treating every noisy observation as a separate event. The system uses a LandTrendr-style time-series process as an upstream method; this dashboard displays its pinned outputs and does not rerun it.</p>
        <p><a href="https://doi.org/10.1016/j.rse.2010.07.008"><strong>Kennedy, Yang & Cohen (2010).</strong> “Detecting trends in forest disturbance and recovery using yearly Landsat time series: 1. LandTrendr — Temporal segmentation algorithms.” <em>Remote Sensing of Environment</em>, 114(12), 2897–2910.</a></p>
      </article>
      <article>
        <span>02 · Compare fairly</span>
        <h2>Use before/after and control/impact logic</h2>
        <p>BACI asks whether change over time in an area of interest differs from change in suitable controls over the same period. The project organizes candidate matches by HAND stratum and applies a baseline-NDVI caliper (0.050 primary; 0.020 sensitivity). Appropriate controls, independent replication and a design matched to the possible scale of change remain essential. This dashboard exposes matching records and eligibility gates; it does not display a causal effect estimate.</p>
        <p><a href="https://doi.org/10.2307/1942110"><strong>Underwood (1994).</strong> “On Beyond BACI: Sampling Designs that Might Reliably Detect Environmental Disturbances.” <em>Ecological Applications</em>, 4(1), 3–15.</a></p>
      </article>
      <article>
        <span>03 · Apply in a mining landscape</span>
        <h2>Build on mine-monitoring and Curragh research</h2>
        <p>Published Landsat work at Curragh shows the relevance of long time series for describing disturbance and recovery patterns in a mining landscape. Hui and Cheng's six trajectory labels (NVG, NVF, NVB, DNR, DHR and DLR) are adapted here as rule-based classes, with recovery required to begin after disturbance. This adaptation is unvalidated pending M4 supervised validation. The studies are precedents and methodological inputs—not validation of the current maps.</p>
        <p><a href="https://doi.org/10.1016/j.jclepro.2018.01.050"><strong>Yang, Erskine, Lechner, Mulligan, Zhang & Wang (2018).</strong> “Detecting the dynamics of vegetation disturbance and recovery in surface mining area via Landsat imagery and LandTrendr algorithm.” <em>Journal of Cleaner Production</em>, 178, 353–362.</a></p>
        <p><a href="https://doi.org/10.1016/j.envres.2026.123868"><strong>Hui & Cheng (2026).</strong> “Detecting disturbance and recovery in mining landscapes: A novel time-series framework based on improved LandTrendr and machine learning.” <em>Environmental Research</em>, 295, article 123868.</a></p>
      </article>
      <article>
        <span>04 · Set and test thresholds</span>
        <h2>Calibrate stability to each sensor's fitted record</h2>
        <p>For each sensor separately, the upstream run measures absolute net fitted NDVI movement in its eligible calibration population. The 95th percentile sets the stability-band width; 90th and 99th percentiles are reported as sensitivity checks. This is a data-derived, site-specific setting, not a threshold prescribed by any one paper or a regulatory limit.</p>
        <p>At the 95th percentile the pinned widths are 0.2563 for Landsat and 0.2439 for Sentinel-2. The sensors are not cross-calibrated. See <a href="./approach-report.html#threshold-method">the report's plain-language threshold explanation and sensitivity table</a>.</p>
      </article>
    </section>
    <p class="science-report-link"><a href="./approach-report.html">Read the full plain-language monitoring approach report →</a></p>
    <div class="page-purpose">
      <strong>What remains to be demonstrated</strong>
      <p>The six-class output is a rule-based adaptation, unvalidated pending the planned M4 supervised validation. Satellite trajectories are indicators of vegetation change; they do not identify cause or directly measure ecological condition. Field observations and fit-for-purpose study design remain necessary for any impact or rehabilitation conclusion.</p>
    </div>
    <p class="approach-link"><a href="./approach-report.html#research-foundations">Open the full monitoring approach report and references →</a></p>
  `;

  const render = () => {
    mapNavigationObserver?.disconnect();
    ndviMapObserver?.disconnect();
    ndviResizeObserver?.disconnect();
    const views = {
      overview: renderOverview,
      manage: renderManage,
      reporting: renderReporting,
      maps: renderMaps,
      science: renderScience,
      bands: renderBands,
      events: renderEvents,
      cohorts: renderCohorts,
      controls: renderControls,
      methods: renderMethods,
      ndvi: renderNdvi,
    };
    app.innerHTML = views[currentView]();
    app.querySelectorAll("[data-go-view]").forEach((button) => {
      button.addEventListener("click", () => {
        currentView = button.dataset.goView;
        updateViewUrl();
        render();
        document.getElementById("main").focus({ preventScroll: true });
      });
    });
    navButtons.forEach((button) => {
      const active = button.dataset.view === currentView;
      button.classList.toggle("active", active);
      if (active) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
    app.querySelectorAll("[data-sensor]").forEach((button) => {
      button.addEventListener("click", () => {
        currentSensor = button.dataset.sensor;
        selectedEvent = null;
        window.currentMapAssets = null;
        render();
      });
    });
    if (["overview", "manage", "maps"].includes(currentView)) {
      bindMapWorkspace();
    }
    if (currentView === "methods") {
      renderHashGateReport();
    }
    if (currentView === "ndvi") {
      prepareNdviViewer();
    }
  };

  navButtons.forEach((button) => {
    button.addEventListener("click", () => {
      currentView = button.dataset.view;
      updateViewUrl();
      render();
      document.getElementById("main").focus({ preventScroll: true });
    });
  });

  fetch(dashboardDataUrl)
    .then((response) => {
      if (!response.ok) throw new Error(`Dashboard data request failed (${response.status}).`);
      return response.json();
    })
    .then((payload) => {
      data = payload;
      loading.hidden = true;
      app.hidden = false;
      render();
    })
    .catch((cause) => {
      loading.hidden = true;
      error.hidden = false;
      if (window.location.protocol === "file:") {
        error.textContent =
          "Chrome blocks loading the pinned dashboard data when this page is opened directly as a file. From the project folder, run `python3 -m http.server 8000`, then open http://localhost:8000/.";
        return;
      }
      error.textContent = `The pinned dashboard data could not be loaded: ${cause.message}`;
    });
})();
