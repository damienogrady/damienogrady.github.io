# Fitted-NDVI demonstration bundle

This is a static, local-only demonstration, not the observed-NDVI handoff
dataset. It is not a mining-impact estimate or rehabilitation verdict. Each
sensor remains separate; no cross-sensor calibration was performed. There are
no annual observed values in this bundle, and none are synthesized.

## Files and integrity

- `index.html`, `app.js`, and `style.css` implement the standalone viewer.
- `manifest.json` identifies the inputs, parameters, counts, each file's size
  and SHA-256, and the locked 2022 and temporal-policy disclosures.
  `manifest.sha256` records the manifest hash. These hashes detect changes but
  do not authenticate the manifest or guarantee licensing clearance.
- `examples.json` lists one T1 impact/control example per sensor. Its impact
  `pixel_row`, `pixel_col`, `pixel_id`, `event_id`, and onset year link the
  selected source-grid cell to the event and pair data.
- `<sensor>/provenance.json` records per-sensor source hashes and output
  hashes. Restricted Earth Engine asset identifiers are not emitted.
- `<sensor>/frames/<year>.png` is the annual map display, not source-resolution
  data. Each RGBA pixel is the arithmetic mean of valid fitted NDVI in a
  4 × 4 source-cell block; alpha is the number of valid source cells divided
  by 16. The same fixed −1 to +1 color scale applies to both sensors. The
  spatially reduced values must not be used as individual pixel observations.
- `<sensor>/tiles/<tile-row>_<tile-col>.bin.gz` stores lossless source-grid
  values for all cells, including all mapped events and controls. Gzip is
  decompressed before interpreting the packed, unaligned, little-endian
  records in row-major order. Each tile is at most 128 × 128 cells; edge tile
  dimensions are derived from `manifest.json`.
- `<sensor>/pairs/<tile-row>_<tile-col>.json.gz` stores the primary-caliper
  0.050, floor-2 matching records for impacts in that tile. A missing pair
  file means there are no such matching records in the tile. JSON rows are
  `[impact_pixel_id, control_pixel_id, onset_year, cohort_tier,
  window_gapped, band, hand_stratum]`.

## Tile record layout

Let `N = end_year - start_year + 1`; every year has an explicit entry. Records
occupy `7 + 6*N` bytes:

| Offset | Type | Field |
|---:|---|---|
| 0 | uint16 | Mapped disturbance onset year; `0` means no mapped event. |
| 2 | int32 | Phase 4 `event_id`; `-1` means not retained in the Phase 4 floor-2 event records. |
| 6 | uint8 | Flags: bit 0 QA-only, bit 1 gapped cohort, bit 2 same-year recovery candidate. |
| 7 | N × float32 | Fitted NDVI, dimensionless, with sign reversed from the source negated-NDVI raster; `-9999` is missing. |
| 7 + 4*N | N × uint16 | Per-pixel effective QA-valid scene count; `65535` is outside coverage. |

`pixel_id = pixel_row * grid_width + pixel_col`; row and column are zero-based
in the shared EPSG:7855, 30 m grid. Sensor is part of every identity. Phase 4
event IDs and flags join to same-sensor event records by pixel and onset;
other mapped event pixels remain available by their raster keys.

The Sentinel-2 2015 entry is explicitly present as `-9999` with count zero
because the historical record reports no scenes. Landsat 2000 and 2012 are
also explicitly missing under the fewer-than-five-scenes policy. Other
pixel-specific years can be missing. A count below five means the input was
masked; a missing fitted value with a higher count is reported as no fit.
No missing values are filled or represented as a valid zero.

The pair identity is the tuple `sensor:onset_year:primary_caliper_0.050:
floor2:band:hand_stratum:impact_pixel_id:control_pixel_id`. Each control option
represents one specific recorded pair. T1, T2 provisional, gapped windows and
T3 QA-only restrictions are retained; the 2022 T3 caption remains binding.
Phase 4 event window-gap flags and Phase 3 pair window-gap flags disagree for
some records. Both are retained independently, discrepancies are counted in
the manifest, and the viewer flags a disagreement for the selected pair.
Selecting a control does not calculate an effect or establish causality.
Recovery onset T >= 1 remains the accepted rule; same-year candidates are not
reclassified as accepted recovery.

## Downstream use

Serve the bundle over localhost or HTTPS: it requires browser gzip
`DecompressionStream`, Web Crypto SHA-256, and ordinary static file requests.
The map picks a 4 × 4 display cell and then an exact source event pixel;
control pixels are selected from the matched records. Source-grid fitted
values and QA are loaded on demand, not taken from the reduced PNG.

The manifest records event-row counts and fitted counts by year, plus
pair-specific control counts. Full pixel values are indexed in tiles rather
than stored as one row per year; absent fitted values remain explicit in each
record. The source rasters, Phase 4 events and Phase 3 pair table are verified
against their recorded hashes before building. The builder checks grid
alignment, event identity, pair identity, QA policy and fitted ranges.

The underlying sources remain subject to licensing and tenure revalidation.
