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
    "home",
    "mapexplorer",
    "reporting",
    "timing",
    "events",
    "cohorts",
    "bands",
    "controls",
    "methods",
    "ndvi",
  ]);
  // Retired views whose content now lives in the newer pages; keeps old deep links working.
  const legacyViews = {
    overview: "home",
    manage: "mapexplorer",
    maps: "mapexplorer",
  };
  const requestedParam = new URLSearchParams(window.location.search).get("view");
  if (requestedParam === "science") window.location.replace("./approach-report.html#research-foundations");
  const requestedView = legacyViews[requestedParam] ?? requestedParam;
  let intakeManifestPromise;
  let ndviResizeObserver;
  let mapNavigationObserver;
  let ndviMapObserver;
  let destroyMapExplorer;
  let data;
  let currentView = validViews.has(requestedView) ? requestedView : "home";
  let currentSensor = "landsat";

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
    if (currentView === "home") url.searchParams.delete("view");
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

  const renderMapExplorer = () => `
    ${pageHeading(
      "Map explorer",
      "Start from the map",
      "Switch between the pinned outputs, step through the years and click any 30 m cell to read its fitted trajectory, mapped disturbance history and rule-based class together."
    )}
    <div class="notice warning demo-flag" role="note">
      <p><strong>Real pipeline output, pinned as a historical, unreconciled snapshot.</strong> These maps come from a working analysis pipeline that is still under development; this page only displays its pinned output (15 November 2026 tenure snapshot; results not recalculated after the 19 November discrepancy). ${escapeHtml(data.disclosures.generalisation_caveat)} This view supports targeting and record-keeping; it does not replace field verification or statutory assessment, and it is not a current-tenure or regulatory determination. Areas are 30 m cell equivalents.</p>
    </div>
    <div id="map-explorer" class="map-explorer"></div>
    <p class="muted small">Related technical evidence: <button type="button" class="text-action" data-go-view="ndvi">Standalone NDVI viewer</button> · <button type="button" class="text-action" data-go-view="events">Event records</button> · <button type="button" class="text-action" data-go-view="timing">Annual timing &amp; thresholds</button> · <button type="button" class="text-action" data-go-view="methods">Hash-gate &amp; lineage checks</button> · <a href="./methodology.html">Methodology &amp; provenance</a></p>`;

  const renderNdvi = () => `
    ${pageHeading(
      "Fitted vegetation through time",
      "Explore annual NDVI patterns",
      "Select a season, map cell and event pixel to inspect the fitted vegetation signal. This standalone viewer shows pinned pipeline output and does not estimate a mining impact. The Map explorer offers the same fitted values with the other layers."
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

  const enquiryEmail = "damien.ogrady@proton.me";
  const renderHome = () => `
    <section class="hero" aria-labelledby="hero-title">
      <p class="eyebrow">Independent remote sensing and GIS consultancy · Damien O’Grady</p>
      <h1 id="hero-title">Independent evidence for mine rehabilitation.</h1>
      <p class="hero-sub">Monitor vegetation recovery, identify potential disturbances and build a traceable record of change, using satellite remote sensing and spatial analysis.</p>
      <ul class="chip-row" aria-label="Methods and data">
        <li>Landsat</li><li>Sentinel-2</li><li>GIS</li><li>Time-series analysis</li>
      </ul>
      <div class="hero-actions">
        <button type="button" class="cta-primary" data-go-view="mapexplorer">Explore the Curragh map →</button>
        <a class="cta-secondary" href="mailto:${enquiryEmail}?subject=Monitoring%20project%20enquiry">Discuss a monitoring project</a>
      </div>
    </section>
    <div class="notice warning demo-flag" role="note">
      <p><strong>Real output from a working monitoring pipeline, still under development.</strong> This demo shows a pinned, historical snapshot of that output (<a href="https://github.com/damienogrady/mine-rehab-monitor">mine-rehab-monitor</a>): the web page does not run the analysis or query Earth Engine, and the classes are unvalidated. It retains a 15 November 2026 tenure snapshot; a 19 November comparison found a discrepancy (one 30 m cell outside the refreshed analysis area) and results have <strong>not been recalculated</strong>. Not for current-tenure or regulatory use.</p>
    </div>
    <section class="overview-block" aria-labelledby="overview-block-title">
      <h2 id="overview-block-title">Demonstration at a glance</h2>
      <dl class="stat-row">
        <div><dt>Tenure areas</dt><dd>14</dd></div>
        <div><dt>Observation record</dt><dd>Sentinel-2 2016–26<br><small>Landsat from 1988</small></dd></div>
        <div><dt>Satellite products</dt><dd>2<br><small>analysed separately</small></dd></div>
        <div><dt>Analysis grid</dt><dd>30 m</dd></div>
      </dl>
    </section>
    <section aria-labelledby="entry-title">
      <h2 id="entry-title">Start here</h2>
      <div class="entry-cards">
        <button type="button" class="start-action" data-go-view="mapexplorer"><span>01</span><strong>Map explorer</strong><small>Start from the map: fitted NDVI, potential-disturbance onset and rule-based classes by year, with a cell's history on click.</small></button>
        <a class="start-action" href="./curragh-case-study.html"><span>02</span><strong>Curragh case study</strong><small>Three real trajectories, with the limits of each.</small></a>
        <button type="button" class="start-action" data-go-view="reporting"><span>03</span><strong>Evidence and reporting</strong><small>Inspect cohort summaries, control gates and a traceable record.</small></button>
        <a class="start-action" href="./methodology.html"><span>04</span><strong>Methodology &amp; provenance</strong><small>Sources, parameters, versions and known limitations.</small></a>
      </div>
    </section>
    <section class="case-study-card" aria-labelledby="case-study-title">
      <h2 id="case-study-title">Case study: three trajectories at Curragh</h2>
      <p>A sustained improvement, a possible disturbance and an ambiguous 2022 signal, drawn from the pinned data, with the limits of each.</p>
      <a class="cta-secondary" href="./curragh-case-study.html">Read the Curragh case study →</a>
    </section>
    <section class="audience" aria-labelledby="audience-title">
      <h2 id="audience-title">Who it is for</h2>
      <p>Mining companies, environmental consultants, regulators and closure specialists who want an independent, traceable view of vegetation change. Satellite analysis supports targeting and record-keeping; it does not replace field verification or statutory assessment.</p>
    </section>
    <section class="limits-summary" aria-labelledby="limits-title">
      <h2 id="limits-title">Method and limitations in brief</h2>
      <ul>
        <li>One site (Curragh); thresholds are not general defaults and results do not transfer to other sites.</li>
        <li>Vegetation classes are a rule-based adaptation, unvalidated, pending supervised validation.</li>
        <li>NDVI-based patterns are monitoring signals, not proof of cause or a pass/fail rehabilitation verdict. 2022 attribution is under investigation (flood/wet-season confounding).</li>
        <li>Flood-prone areas are a HAND screening proxy, not a statutory flood extent. Areas are 30 m cell equivalents, not surveyed areas.</li>
        <li>Landsat and Sentinel-2 are not cross-calibrated; Sentinel-2 matched-control capacity is limited.</li>
      </ul>
      <p>
        <a href="./approach-report.html#limitations">Full monitoring approach and limitations</a> ·
        <button type="button" class="text-action" data-go-view="methods">Hash-gate &amp; lineage checks</button> ·
        <a href="./methodology.html">Methodology &amp; data provenance</a> ·
        <a href="./data-licensing.html">Data licensing</a> · full disclosures in the page footer.
      </p>
    </section>
    <section class="credentials" aria-labelledby="credentials-title">
      <h2 id="credentials-title">Why this approach</h2>
      <ul>
        <li><strong>Scientific foundation.</strong> Methods informed by peer-reviewed research; see the <a href="../publications.html">publications</a> and <a href="../background.html">background</a> on the main site.</li>
        <li><strong>Technical independence.</strong> Built on public satellite datasets (Landsat and Sentinel-2), with no dependence on proprietary imagery.</li>
        <li><strong>Auditability.</strong> Documented, reproducible and traceable outputs: see the <a href="./methodology.html">methodology and provenance</a>.</li>
      </ul>
    </section>
    <section class="enquiry" aria-labelledby="enquiry-title">
      <h2 id="enquiry-title">Interested in monitoring your mine site?</h2>
      <p>Engagements are scoped to the site and questions, at one of three levels: <strong>assessment</strong>, <strong>monitoring</strong> or <strong>integrated monitoring</strong> alongside your existing programme. A preliminary site assessment is a low-commitment way to start. Satellite analysis complements field verification and statutory assessment; it does not replace them. More on the <a href="../services.html">services page</a>.</p>
      <a class="cta-primary" href="mailto:${enquiryEmail}?subject=Monitoring%20project%20enquiry">Discuss a monitoring project</a>
    </section>
  `;

  const renderTiming = () => {
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
        "Technical evidence",
        `${item.label} annual timing and class thresholds`,
        "Site-wide annual disturbance and recovery timing, and how sensitive the rule-based classes are to alternative thresholds. The maps themselves are in the Map explorer.",
        true
      )}
      <div class="notice">These are summary tables for the whole analysis area. They do not establish cause or confirm field condition.
        <button type="button" class="text-action" data-go-view="mapexplorer">Open the Map explorer →</button></div>
      <div class="spacer"></div>
      ${panel(`${item.label} annual disturbance and recovery timing`, renderAnnualChart(item))}
      <div class="spacer"></div>
      ${panel("Sensitivity by threshold", `${sensitivity}<p>Population: ${number(item.class_map.population_count)} valid observations. Sensitivity values are copied from the pinned sensor run summary; this page performs no classification or threshold calculation.</p>`)}
      <div class="spacer"></div>
      ${panel("Classification limits", `<p>${escapeHtml(data.disclosures.class_label)}</p><p>DHR/DLR disagreement: ${number(item.fragility.disagreements)} of ${number(item.fragility.accepted_recoveries)} accepted recoveries (${item.fragility.percent.toFixed(2)}%). ${escapeHtml(item.fragility.interpretation)}</p><div class="caption-box">${escapeHtml(data.disclosures.r_d_caption)}</div>`)}
    `;
  };

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
      <div class="page-purpose"><strong>Why these tables matter</strong><p>Cohort summaries show which mapped years and tiers are represented. Threshold sensitivities (on the Annual timing &amp; thresholds page) show how classification responds to alternative settings. Control gates show whether a comparison met pre-set quality requirements. Together, they let a reviewer trace a conclusion back to its limits instead of relying on a map alone.</p></div>
      <div class="notice warning">All figures below are copied or counted from hash-pinned entities. No new analysis or synthesized result is presented.</div>
      <div class="spacer"></div>
      ${panel("Cohort ledger · fixed 2-cell display floor", `${cohortLedger}<p>${escapeHtml(item.timeline.fragility_note)}</p>`)}
      <div class="spacer"></div>
      ${panel("Threshold sensitivity", `<p>The sensitivity-by-threshold table (90th, 95th and 99th percentile stability bands) is kept on one page only.
        <button type="button" class="text-action" data-go-view="timing">Open Annual timing &amp; thresholds →</button></p>`)}
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
        "Technical evidence",
        "Hash-gate and lineage checks",
        "The displayed products are hash-linked to the accepted monitoring-pipeline Phase 4 manifest, and the checks below re-verify them in your browser. No live analysis or catalog service is used. Sources, parameters and limitations are in the Methodology page."
      )}
      <p class="muted small">For methods, validation status, sensor comparability, 2022 confounding and reproducibility gaps, see the <a href="./methodology.html">Methodology &amp; data provenance</a> reference (downloadable).</p>
      <div class="page-purpose"><strong>Why this page matters</strong><p>Managers need to know which data version a map came from; regulators and reviewers need to be able to check that the displayed files match their recorded sources. The hash-gate record below supports that traceability. The boundary notes explain what this demonstration cannot establish and which limitations remain open.</p></div>
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
          "Licensing and data status",
          `<p>The project code uses the MIT licence; third-party data and derived outputs have separate terms. The owner selected the ODbL option for MERIT Hydro and accepted the data-sharing arrangements for this demonstration.</p>
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

  const render = () => {
    mapNavigationObserver?.disconnect();
    ndviMapObserver?.disconnect();
    ndviResizeObserver?.disconnect();
    destroyMapExplorer?.();
    destroyMapExplorer = null;
    const views = {
      home: renderHome,
      mapexplorer: renderMapExplorer,
      reporting: renderReporting,
      timing: renderTiming,
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
        render();
      });
    });
    if (currentView === "methods") {
      renderHashGateReport();
    }
    if (currentView === "ndvi") {
      prepareNdviViewer();
    }
    if (currentView === "mapexplorer") {
      destroyMapExplorer = window.MapExplorer.mount(document.getElementById("map-explorer"), { data, dashboardUrl: dashboardDataUrl });
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
