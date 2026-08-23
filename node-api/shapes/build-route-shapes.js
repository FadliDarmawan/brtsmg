#!/usr/bin/env node
/**
 * build-route-shapes.js
 *
 * Enriches one route GeoJSON file (./routes/<id>.json) with a flat
 * `coordinates` array and a `stops: [{ name, vertex }]` list, so the
 * browser can later draw "the path from stop A to stop B" with a single
 * array .slice() instead of any runtime nearest-point-on-line geometry.
 *
 * This is meant to run ONCE per route file, offline, whenever you add or
 * update route geometry — not in the browser. Matching a stop to a vertex
 * only needs to happen once; there's no reason to repeat that work on
 * every click.
 *
 * USAGE:
 *   node build-route-shapes.js <routeId> <routeFile> <stopsFile> [outFile] [--start="Stop Name"] [--order=order.txt]
 *
 * EXAMPLE:
 *   node build-route-shapes.js 1A ./routes/1a.json ./stops/stops.json ./routes/1a.json --start="Terminal Prambanan"
 *
 * <routeId>    e.g. "1A" — must match the `route` value used in stops.json
 * <routeFile>  the existing GeoJSON for that route (LineString,
 *              MultiLineString, FeatureCollection, or the legacy
 *              { data: {...} } / { lines: [...] } envelope)
 * <stopsFile>  your stops.json (used to find which stops belong to this
 *              route and where they are)
 * [outFile]    defaults to overwriting <routeFile> in place
 * [--start]    the stop name that ROUTE_DIRECTIONS in index.html declares
 *              as this route's `start` (== `end`). Strongly recommended —
 *              see NOTE ON DIRECTION below. Omit only if you don't have
 *              it handy; the script will warn instead of failing.
 * [--order]    a text file, one stop name per line, in the KNOWN CORRECT
 *              travel order (the shared start/end terminus listed once,
 *              at the top only — not repeated at the bottom). When given,
 *              matching switches from "nearest point anywhere on the
 *              line" to "nearest point at or after where the previous
 *              stop in this list landed" — see NOTE ON ORDERED MATCHING.
 *              Any stop in <stopsFile> for this route that's missing from
 *              this list gets appended at the end with a warning, rather
 *              than silently dropped; any name in this list that isn't a
 *              real candidate stop is also warned about and skipped.
 * [--patch]    a text file, one "lon lat" pair per line, tracing a piece
 *              of road that's flat-out MISSING from <routeFile> — not
 *              just mis-sampled, but never traced at all (e.g. an
 *              out-and-back spur to a terminal that the source export
 *              skipped). List the points in real travel order. The first
 *              and last points are matched onto the existing line (the
 *              last one searched only forward from the first, so the
 *              two splice points can't land out of order) and whatever
 *              the original line did between those two points is
 *              replaced with the patch — see NOTE ON PATCHING.
 *
 * NOTE ON PATCHING: --order and --start can only rearrange or verify how
 * stops map onto geometry that already exists; they can't invent a road
 * segment the source trace never drew. If a stop is consistently hundreds
 * of meters from the nearest point on the line no matter what you do with
 * --order, that's usually this — the fix belongs in the geometry, not the
 * stop list. --patch lets you supply just the missing stretch instead of
 * re-tracing (or hand-editing the JSON of) the whole route file.
 *
 * [--reverse]  flips the winding direction of the whole closed loop
 *              (keeping it closed — this is NOT the same as swapping
 *              start/end). Use this when EVERY stop's vertex number
 *              decreases as you walk through --order instead of
 *              increasing (check with a few stops spread across the
 *              route before reaching for this) — that pattern means the
 *              source line was traced in the opposite rotational
 *              direction from how the vehicle actually travels it, which
 *              looks superficially like the wrong-pass/duplicate-stop
 *              problem --order already handles, but isn't: it affects
 *              EVERY stop, not just ones served from both directions,
 *              and no amount of --patch or reordering candidateStops
 *              fixes it, because the entire array needs to be walked
 *              the other way. Runs before --patch, --order, --start, and
 *              the main matching pass, so all of them see the corrected
 *              direction.
 *
 * NOTE ON ORDERED MATCHING: independent nearest-point matching (the
 * default, no --order given) can mis-assign a stop when its outbound and
 * return legs run close together — e.g. two poles on a divided road, or
 * parallel one-way streets a block apart. A "-B" (return-leg) pole can
 * end up snapping onto the outbound pass simply because it's a few
 * meters closer there than at the correct point on the return pass,
 * scrambling the resulting vertex order with no error or warning, since
 * nothing about that individual match looks wrong in isolation. --order
 * removes the ambiguity entirely: each stop can only match a point at or
 * beyond the PREVIOUS stop's matched position, so a "-B" pole physically
 * near the outbound pass simply can't be selected once the search cursor
 * has already moved past that point.
 *
 * NOTE ON DIRECTION: this script assumes the input line's vertices are
 * already ordered along the actual direction of travel for that file
 * (true for a proper road-following export of the full round trip, e.g.
 * 1A = Prambanan -> Malioboro -> Prambanan). It does NOT reverse or
 * reorder the line — it only finds where each stop sits along it.
 *
 * NOTE ON THE ROUND-TRIP REQUIREMENT: index.html now treats EVERY route
 * as a closed round trip — it reads a route's "end" (== "start") stop as
 * whatever sits at `coordinates.length - 1`, not via a second name
 * lookup. That's only correct if this file's raw line actually closes
 * back on itself. This script verifies that (see isClosedLoopShape
 * below) and now REFUSES to write a file that doesn't close — a route
 * file that silently isn't closed used to produce a shape that looked
 * fine on disk but sliced wrong in the browser for the whole "way back"
 * leg, with no error anywhere pointing at why.
 *
 * NOTE ON MATCHING: a stop is matched to the nearest POINT ON THE LINE
 * (perpendicular projection onto whichever segment is closest), not just
 * to the nearest existing vertex. Road-following exports are often very
 * unevenly sampled — long straight stretches may only have two vertices
 * a kilometer or more apart — so "nearest vertex" alone can miss a stop
 * by hundreds of meters even when the road itself passes right by it.
 * Once the true nearest point is found, it's inserted into the
 * coordinates array as a new vertex (unless it lands on an existing
 * vertex already), so slicing by index in the browser still lines up
 * exactly with where the stop really is.
 */

const fs = require("fs");

// Every route is treated as a two-leg round trip in the browser: start ->
// wayback -> end (same physical stop as start, pinned to coordinates[0]
// and coordinates[length-1] respectively). See the round-trip check
// below (isClosedLoopShape) and the --start cross-check for how this
// script now enforces that assumption instead of just hoping it's true.
const rawArgs = process.argv.slice(2);
let startStopArg = null;
let orderFileArg = null;
let patchFileArg = null;
let reverseFlag = false;
const positionalArgs = [];
for (const arg of rawArgs) {
  if (arg.startsWith("--start=")) {
    startStopArg = arg.slice("--start=".length);
  } else if (arg.startsWith("--order=")) {
    orderFileArg = arg.slice("--order=".length);
  } else if (arg.startsWith("--patch=")) {
    patchFileArg = arg.slice("--patch=".length);
  } else if (arg === "--reverse") {
    reverseFlag = true;
  } else {
    positionalArgs.push(arg);
  }
}
const [routeId, routeFilePath, stopsFilePath, outFilePathArg] = positionalArgs;

if (!routeId || !routeFilePath || !stopsFilePath) {
  console.error('Usage: node build-route-shapes.js <routeId> <routeFile> <stopsFile> [outFile] [--start="Stop Name"] [--order=order.txt] [--patch=patch.txt] [--reverse]');
  process.exit(1);
}

if (!startStopArg) {
  console.warn(`  ! No --start="Stop Name" given — skipping the check that this route's declared start stop actually lands on vertex 0. Recommended: pass the same name used in index.html's ROUTE_DIRECTIONS["${routeId}"].start.`);
}

const outFilePath = outFilePathArg || routeFilePath;

// ---- 1. Load + unwrap the route file, mirroring extractLines() in index.html ----
const rawRouteFile = JSON.parse(fs.readFileSync(routeFilePath, "utf8"));
const hasEnvelope = rawRouteFile && rawRouteFile.data && typeof rawRouteFile.data === "object";
const geo = hasEnvelope ? rawRouteFile.data : rawRouteFile;

function extractLines(raw) {
  const lines = [];
  const pushGeom = (geom) => {
    if (!geom) return;
    if (geom.type === "LineString") lines.push(geom.coordinates);
    else if (geom.type === "MultiLineString") lines.push(...geom.coordinates);
  };
  if (Array.isArray(raw.lines)) lines.push(...raw.lines);
  else if (raw.type === "FeatureCollection") (raw.features || []).forEach(f => pushGeom(f.geometry));
  else if (raw.type === "Feature") pushGeom(raw.geometry);
  else if (raw.type === "LineString" || raw.type === "MultiLineString") pushGeom(raw);
  return lines;
}

const lines = extractLines(geo);
if (!lines.length) {
  console.error(`No line geometry found in ${routeFilePath}`);
  process.exit(1);
}
// Concatenate segments end-to-end. If your route file is split into
// multiple disconnected LineStrings that are NOT already in travel order,
// fix that upstream first — this script trusts the input order.
let coordinates = lines.reduce((acc, line) => acc.concat(line), []);

// ---- If --reverse was given, flip the loop's winding direction --------
// (keeping it closed). See NOTE ON --reverse above. This must be a real
// reversal of direction, not just a start/end swap: a closed loop reversed
// naively by slicing would still be wound the same way, just cut at a
// different point. Dropping the duplicated closing point, reversing the
// open ring, then re-closing against the new first point is what actually
// flips which way the array is walked.
if (reverseFlag) {
  const open = coordinates.slice(0, -1);
  open.reverse();
  open.push(open[0]);
  coordinates = open;
  console.log("  * Reversed the loop's winding direction (--reverse) before any other matching.");
}

// ---- 2. Find which stops belong to this route, from stops.json ----
const allStops = JSON.parse(fs.readFileSync(stopsFilePath, "utf8"));
const candidateStops = allStops.filter(s =>
  (s.services || []).some(sv => sv.route === routeId)
);

if (!candidateStops.length) {
  console.error(`No stops in ${stopsFilePath} reference route "${routeId}" — check the route id.`);
  process.exit(1);
}

// ---- 3. Nearest-point-on-segment match for each stop -------------------
// Unlike nearest-vertex matching, this projects the stop onto every
// SEGMENT of the line (not just its endpoints), so accuracy doesn't
// depend on how densely the source export happened to sample vertices.
//
// Distances are computed in local meters via a simple equirectangular
// projection (fine at city scale / non-polar latitudes) so warnings and
// comparisons are in real-world units, not degrees.
const EARTH_RADIUS_M = 6371000;
const refLat = coordinates[Math.floor(coordinates.length / 2)][1];
const mPerDegLat = (Math.PI / 180) * EARTH_RADIUS_M;
const mPerDegLon = mPerDegLat * Math.cos((refLat * Math.PI) / 180);

function toXY(lon, lat) {
  return [lon * mPerDegLon, lat * mPerDegLat];
}
function toLonLat(x, y) {
  return [x / mPerDegLon, y / mPerDegLat];
}

// Projects point P onto segment A-B (all in meters-space). Returns the
// clamped t in [0,1] along the segment and the projected point.
function projectPointOnSegment(px, py, ax, ay, bx, by) {
  const abx = bx - ax, aby = by - ay;
  const abLenSq = abx * abx + aby * aby;
  let t = abLenSq === 0 ? 0 : ((px - ax) * abx + (py - ay) * aby) / abLenSq;
  t = Math.max(0, Math.min(1, t));
  return { t, x: ax + t * abx, y: ay + t * aby };
}

function nearestPointOnLine(lon, lat) {
  return nearestPointOnLineFrom(lon, lat, 0);
}

// T_EPS: treat a projection landing within ~1mm-scale t of a segment end
// as "on that existing vertex" rather than inserting a near-duplicate point.
// (Declared here, rather than down near the main stop-matching pass, so the
// loop-rotation step below can reuse the exact same threshold.)
const T_EPS = 1e-9;

// GOOD_ENOUGH_MATCH_M: used only by --order's greedy forward search below.
// A road-level GPS match is normally single-digit-to-low-tens of meters;
// once we're clearly within that range there's no reason to keep scanning
// further ahead on the CHANCE something is a few meters closer still.
const GOOD_ENOUGH_MATCH_M = 40;

// Same projection logic as nearestPointOnLine, but only considers segments
// at index >= minSegIndex. Used for --order's sequential matching: each
// stop can only land at or after wherever the PREVIOUS stop in the known
// order landed, which is what actually rules out the wrong-pass mismatch
// (see NOTE ON ORDERED MATCHING above) rather than just usually avoiding it.
function nearestPointOnLineFrom(lon, lat, minSegIndex) {
  const [px, py] = toXY(lon, lat);
  let best = null;
  for (let i = minSegIndex; i < coordinates.length - 1; i++) {
    const [ax, ay] = toXY(coordinates[i][0], coordinates[i][1]);
    const [bx, by] = toXY(coordinates[i + 1][0], coordinates[i + 1][1]);
    const proj = projectPointOnSegment(px, py, ax, ay, bx, by);
    const dx = px - proj.x, dy = py - proj.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (!best || dist < best.dist) {
      best = { segIndex: i, t: proj.t, x: proj.x, y: proj.y, dist };
    }
  }
  const [lonOut, latOut] = toLonLat(best.x, best.y);
  return { segIndex: best.segIndex, t: best.t, lon: lonOut, lat: latOut, dist: best.dist };
}

// Used ONLY for --order's sequential matching (not the plain no-order
// case, and not --patch's splice-point search, both of which still want
// the true global nearest). Plain forward search picks whichever point
// anywhere ahead of the cursor is CLOSEST, with no regard for how far
// ahead that is — so a stop that legitimately sits right where the
// cursor already is can still lose to some unrelated duplicate's pole
// much further down the line, if that pole happens to be a few meters
// closer still (e.g. a stop serviced from both directions, where the
// return-leg pole is marginally nearer than the correct outbound-leg
// pole). That doesn't just mismatch this one stop — it drags the cursor
// past everything physically in between, breaking every stop after it
// too. Fix: stop scanning forward the moment a solidly good match
// (<= GOOD_ENOUGH_MATCH_M) is found, rather than continuing on the
// chance something slightly better exists further ahead. Falls back to
// the true global-forward-nearest if nothing forward ever gets that
// close, so the existing distance warning still fires correctly.
function nearestPointOnLineForward(lon, lat, minSegIndex) {
  const [px, py] = toXY(lon, lat);
  let best = null;
  for (let i = minSegIndex; i < coordinates.length - 1; i++) {
    const [ax, ay] = toXY(coordinates[i][0], coordinates[i][1]);
    const [bx, by] = toXY(coordinates[i + 1][0], coordinates[i + 1][1]);
    const proj = projectPointOnSegment(px, py, ax, ay, bx, by);
    const dx = px - proj.x, dy = py - proj.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (!best || dist < best.dist) {
      best = { segIndex: i, t: proj.t, x: proj.x, y: proj.y, dist };
    }
    if (best.dist <= GOOD_ENOUGH_MATCH_M) break;
  }
  const [lonOut, latOut] = toLonLat(best.x, best.y);
  return { segIndex: best.segIndex, t: best.t, lon: lonOut, lat: latOut, dist: best.dist };
}

// ---- 2a. If --patch was given, splice in a manually-supplied stretch ---
// of road that's genuinely missing from the source line (not just
// mis-sampled — never traced at all). See NOTE ON PATCHING above. This
// runs before any stop-matching so everything downstream (--order,
// --start, the main matching pass) sees the corrected geometry.
if (patchFileArg) {
  const patchCoords = fs.readFileSync(patchFileArg, "utf8")
    .split("\n")
    .map(l => l.trim())
    .filter(l => l && !l.startsWith("#"))
    .map(l => l.split(/\s+/).map(Number));

  if (patchCoords.length < 2 || patchCoords.some(c => c.length !== 2 || c.some(Number.isNaN))) {
    console.error(`--patch file "${patchFileArg}" must have at least 2 lines, each "lon lat" (two numbers separated by whitespace).`);
    process.exit(1);
  }

  const [pStartLon, pStartLat] = patchCoords[0];
  const [pEndLon, pEndLat] = patchCoords[patchCoords.length - 1];

  // Where the patch branches OFF the existing line: nearest point anywhere.
  const outPoint = nearestPointOnLine(pStartLon, pStartLat);
  // Where the patch rejoins: nearest point, searched only forward from the
  // branch point, so the two splice points can't come out in the wrong order.
  const inPoint = nearestPointOnLineFrom(pEndLon, pEndLat, outPoint.segIndex);

  if (outPoint.dist > 300) {
    console.warn(`  ! --patch's first point is ${outPoint.dist.toFixed(0)}m from the nearest point on the existing line — check it's meant to branch off near there.`);
  }
  if (inPoint.dist > 300) {
    console.warn(`  ! --patch's last point is ${inPoint.dist.toFixed(0)}m from the nearest point on the existing line — check it's meant to rejoin near there.`);
  }

  // Keep the line up to and including the branch point, drop whatever the
  // original line did between there and the rejoin point (that stretch is
  // exactly what's wrong or missing), splice in the patch, then keep the
  // line from the rejoin point onward.
  const before = coordinates.slice(0, outPoint.segIndex + 1).concat([[outPoint.lon, outPoint.lat]]);
  const after = [[inPoint.lon, inPoint.lat]].concat(coordinates.slice(inPoint.segIndex + 1));
  const removedCount = inPoint.segIndex + 1 - (outPoint.segIndex + 1);

  coordinates = before.concat(patchCoords, after);
  console.log(
    `  * Patched in ${patchCoords.length} coordinates from "${patchFileArg}": branched off ${outPoint.dist.toFixed(0)}m from the patch start, ` +
    `rejoined ${inPoint.dist.toFixed(0)}m from the patch end, replacing ${Math.max(removedCount, 0)} original vertices in between.`
  );
}

// ---- 2b. If --order was given, reorder candidateStops to match it ------
// (and reconcile the two lists, warning about any mismatch instead of
// silently dropping or misplacing a stop).
let orderedStopNames = null;
if (orderFileArg) {
  orderedStopNames = fs.readFileSync(orderFileArg, "utf8")
    .split("\n")
    .map(l => l.trim())
    .filter(Boolean);

  const byName = new Map(candidateStops.map(s => [s.stop_name.trim(), s]));
  const seen = new Set();
  const repeatCounts = new Map();
  const reordered = [];
  for (const name of orderedStopNames) {
    const s = byName.get(name);
    if (!s) {
      console.warn(`  ! --order lists "${name}", but no stop by that exact name is registered for route "${routeId}" in ${stopsFilePath} — skipped.`);
      continue;
    }
    // A repeated name is usually intentional now — a stop can genuinely
    // sit on the line twice (e.g. a junction the route passes on both
    // its outbound and return legs, like Ngabean on route 15), which
    // needs two distinct vertices, not one. The ONE case this doesn't
    // apply to is the shared start/end terminus, which should still only
    // be listed once at the top of the file (matching --start folds it
    // onto vertex 0 on its own; see the loop-closing note above).
    seen.add(name);
    repeatCounts.set(name, (repeatCounts.get(name) || 0) + 1);
    reordered.push(s);
  }
  for (const [name, count] of repeatCounts) {
    if (count > 1) {
      console.log(`  i "${name}" appears ${count}x in --order — each occurrence will be matched to its own point, found sequentially forward along the line.`);
    }
  }
  const missing = candidateStops.filter(s => !seen.has(s.stop_name.trim()));
  if (missing.length) {
    console.warn(`  ! ${missing.length} stop(s) registered for route "${routeId}" are missing from --order and will be appended at the end (best-effort placement — verify these manually):`);
    missing.forEach(s => console.warn(`      - ${s.stop_name}`));
    reordered.push(...missing);
  }
  candidateStops.length = 0;
  candidateStops.push(...reordered);
}

// ---- Closed-loop / round-trip requirement --------------------------------
// index.html now treats EVERY route as a two-leg round trip: it reads the
// "end" stop (same name as "start") as whatever sits at the very last
// coordinate in this file, not via a second stopIndex lookup. That's only
// correct if this file's line actually closes back on itself — coordinates[0]
// and the last coordinate need to be the *same physical spot*, down to
// survey noise. This also matters for stop-matching: the stop at that shared
// terminus (e.g. one named end-to-end with no "-A"/"-B" split) can genuinely
// be CLOSER to the line's LAST few segments than to its first — real
// terminals/roundabouts often route the departure and arrival lanes along
// physically different pavement, and the closest matching segment isn't
// always literally the very last one (there can be several vertices near
// the terminus loop). Plain nearest-distance matching then correctly finds
// the true nearest point, but on the wrong END of the array — which breaks
// any code that assumes "vertex 0 is this route's start".
//
// Fix: this used to be a fixed-distance threshold (SEAM_EPS_M) applied to
// EVERY candidate stop, but that has two problems — (1) no single meters
// value covers every terminal's lane separation (19.5m at Terminal Jombor,
// 34m at Park and Ride Gamping, and Terminal Condongcatur's true nearest
// segment on route 2A isn't even the literal last one), and (2) applying it
// to every stop risks folding some OTHER legitimate stop that just happens
// to sit near the terminus too. Instead: only the stop matching the
// declared --start name gets folded, and only using a deliberately GENEROUS
// distance cutoff (SAME_TERMINUS_MAX_M) against the shape's own closing
// coordinate — generous because at this point we only need to tell "this is
// the same terminus, just the other lane" (tens of meters) apart from "this
// is actually a different place entirely, e.g. --start was given the
// wayback point's name by mistake" (hundreds of meters to kilometers) — a
// large enough gap that the exact cutoff value doesn't need per-route
// tuning the way the old tight threshold did.
//
// If the line doesn't close at all, FAIL LOUDLY instead of silently writing
// a file that looks fine on disk but slices wrong for the entire "way back"
// leg in the browser, with no error anywhere pointing at why — that used to
// be exactly how this went wrong.
const CLOSURE_EPS_M = 25; // how close the raw line's own first/last coordinate must be to count as "closed" at all
const SAME_TERMINUS_MAX_M = 500; // generous: only needs to separate "other lane of the same terminus" from "an actually different place"
function distanceMeters(lon1, lat1, lon2, lat2) {
  const [x1, y1] = toXY(lon1, lat1);
  const [x2, y2] = toXY(lon2, lat2);
  return Math.sqrt((x1 - x2) ** 2 + (y1 - y2) ** 2);
}
let [startLon, startLat] = coordinates[0];
let [endLon, endLat] = coordinates[coordinates.length - 1];
let isClosedLoopShape = distanceMeters(startLon, startLat, endLon, endLat) < CLOSURE_EPS_M;

// Some source traces "overshoot" a closed loop: after genuinely arriving
// back at the start point, the export keeps going and re-draws the first
// few vertices of the loop again before stopping (seen from at least one
// map-drawing tool's polygon-closing behavior). When that's what happened,
// the TRUE closing vertex sits a few positions before the literal last
// coordinate, not at the last coordinate itself — so before failing
// outright, search backward through (at most) the last quarter of the
// array for the LAST vertex that's essentially exactly on top of
// coordinates[0], and trim the overshoot instead of erroring. Restricted
// to a tight distance and a bounded search window so this can't mistake a
// route that legitimately passes near its own start mid-route (a real
// self-intersection, not an export artifact) for this specific pattern.
const RETRACE_EPS_M = 12;
if (!isClosedLoopShape) {
  const searchFloor = Math.max(1, coordinates.length - Math.ceil(coordinates.length / 4));
  let retraceIdx = -1;
  for (let i = coordinates.length - 2; i >= searchFloor; i--) {
    if (distanceMeters(coordinates[i][0], coordinates[i][1], startLon, startLat) < RETRACE_EPS_M) {
      retraceIdx = i;
      break;
    }
  }
  if (retraceIdx !== -1) {
    const trimmedCount = coordinates.length - 1 - retraceIdx;
    coordinates = coordinates.slice(0, retraceIdx + 1);
    [endLon, endLat] = coordinates[coordinates.length - 1];
    isClosedLoopShape = distanceMeters(startLon, startLat, endLon, endLat) < CLOSURE_EPS_M;
    console.log(
      `  * Trimmed ${trimmedCount} trailing vertex(es) that re-traced the start of the loop after it had already closed ` +
      `(source export overshoot) — the line now ends ${distanceMeters(endLon, endLat, startLon, startLat).toFixed(1)}m from the start point.`
    );
  }
}

if (!isClosedLoopShape) {
  const gapM = distanceMeters(startLon, startLat, endLon, endLat);
  console.error(
    `This route's line does not close back on itself: the first and last coordinates are ${gapM.toFixed(0)}m apart (need < ${CLOSURE_EPS_M}m). ` +
    `index.html treats every route as a round trip and reads the "end" stop from the very last coordinate — an unclosed line will produce a file ` +
    `that loads fine but slices wrong for the entire way-back leg. Fix the source geometry so it actually traces all the way back to the start ` +
    `point (${startLon},${startLat}), then re-run.`
  );
  process.exit(1);
}

// ---- Rotate the loop so it begins at the declared --start stop ---------
// A closed loop has no inherently "correct" first vertex in the source
// file — the export could have started tracing anywhere around it. This
// used to be handled by REQUIRING vertex 0 to already be near --start
// (see the startFraction check further down, which failed loudly
// otherwise). That's unnecessarily strict: since the shape is confirmed
// closed above, we can just cut it open at whichever point is nearest to
// the start stop's own coordinate and re-splice the array so that point
// becomes vertex 0 — no re-tracing of the source geometry required.
if (startStopArg) {
  const startStopRecord = candidateStops.find(s => s.stop_name === startStopArg);
  if (!startStopRecord) {
    console.error(
      `--start="${startStopArg}" isn't among the stops registered for route "${routeId}" in ${stopsFilePath} — ` +
      `can't find its coordinate to rotate the loop onto. Check the spelling matches stops.json exactly.`
    );
    process.exit(1);
  }
  const [startStopLon, startStopLat] = startStopRecord.point.split(" ").map(Number);
  const cut = nearestPointOnLine(startStopLon, startStopLat);

  if (cut.dist > 300) {
    console.warn(`  ! --start="${startStopArg}" is ${cut.dist.toFixed(0)}m from the nearest point on this route's line — double check this route file actually covers this stop.`);
  }

  // Figure out which array index the cut lands on, inserting a precise
  // new vertex if it falls mid-segment (same t-based logic the main
  // stop-insertion pass below uses), then rotate so that index is vertex 0.
  let head;
  if (cut.t <= T_EPS) {
    head = cut.segIndex; // lands exactly on an existing vertex
  } else if (cut.t >= 1 - T_EPS) {
    head = cut.segIndex + 1;
  } else {
    coordinates.splice(cut.segIndex + 1, 0, [cut.lon, cut.lat]);
    head = cut.segIndex + 1;
  }

  if (head !== 0) {
    // coordinates is a closed loop, so coordinates[0] === coordinates[last]
    // (down to survey noise). Drop that duplicated closing point, rotate
    // the remaining open ring, then re-close it against the new vertex 0.
    const open = coordinates.slice(0, -1);
    const rotated = open.slice(head).concat(open.slice(0, head));
    rotated.push(rotated[0]);
    coordinates = rotated;
    [startLon, startLat] = coordinates[0];
    console.log(`  * Rotated the loop so "${startStopArg}" (${cut.dist.toFixed(1)}m from the line) sits at vertex 0 — the source file no longer needs to start there itself.`);
  } else {
    console.log(`  \u2713 "${startStopArg}" already sits at vertex 0 — no rotation needed.`);
  }
}

let matchCursor = 0;
let startAlreadyFolded = false;
const stopMatches = candidateStops.map(s => {
  const [lon, lat] = s.point.split(" ").map(Number);
  let m = orderedStopNames ? nearestPointOnLineForward(lon, lat, matchCursor) : nearestPointOnLine(lon, lat);

  // Fold the declared --start stop onto vertex 0 right here, BEFORE it can
  // poison matchCursor for every stop that follows it in --order. The
  // terminus's true nearest point can legitimately sit on the arrival side
  // of the loop (a few tens of meters closer than the literal departure
  // vertex — different lanes of the same terminal) — fine for a one-off
  // distance report, but if left in place as "the last thing we matched",
  // every subsequent --order stop gets searched only from THAT point
  // onward and can never reach its real, much-earlier location. This has
  // to happen inline, not in a later pass over the finished stopMatches
  // array, because by then matchCursor has already been advanced past it.
  if (
    orderedStopNames &&
    startStopArg &&
    isClosedLoopShape &&
    s.stop_name === startStopArg &&
    !startAlreadyFolded &&
    m.segIndex !== 0
  ) {
    const distToStart = distanceMeters(m.lon, m.lat, startLon, startLat);
    if (distToStart <= SAME_TERMINUS_MAX_M) {
      console.warn(`  * "${startStopArg}" matched on the arrival side of this loop's terminus (${distToStart.toFixed(1)}m from the closing point) — folding it onto vertex 0 since it's the same physical stop as the route's start.`);
      m = { segIndex: 0, t: 0, lon: startLon, lat: startLat, dist: distToStart };
      startAlreadyFolded = true;
    }
  }

  if (orderedStopNames) matchCursor = m.segIndex;

  if (m.dist > 300) {
    console.warn(`  ! "${s.stop_name}" is ${m.dist.toFixed(0)}m from the nearest point on the line — check this route file covers this stop.`);
  }
  return { name: s.stop_name, ...m };
});

// Fallback for the no-order case (or if --start wasn't first in --order,
// so the inline fold above never got a chance to run): still fold the
// reported entry so the OUTPUT looks right, even though this path can't
// retroactively fix a cursor that's already been used for earlier stops.
if (startStopArg && isClosedLoopShape && !startAlreadyFolded) {
  const startMatchIdx = stopMatches.findIndex(m => m.name === startStopArg);
  if (startMatchIdx !== -1) {
    const m = stopMatches[startMatchIdx];
    const distToStart = distanceMeters(m.lon, m.lat, startLon, startLat);
    if (m.segIndex !== 0 && distToStart <= SAME_TERMINUS_MAX_M) {
      console.warn(`  * "${startStopArg}" matched on the arrival side of this loop's terminus (${distToStart.toFixed(1)}m from the closing point) — folding it onto vertex 0 since it's the same physical stop as the route's start.`);
      stopMatches[startMatchIdx] = { name: startStopArg, segIndex: 0, t: 0, lon: startLon, lat: startLat, dist: distToStart };
    }
  }
}

// Group insertions by the segment they fall on, ordered by how far along
// the segment they sit, so multiple stops sharing a segment come out in
// the correct travel order.
const bySegment = new Map();
stopMatches.forEach((m, stopIdx) => {
  if (m.t <= T_EPS || m.t >= 1 - T_EPS) return; // snaps to an existing vertex, no insertion needed
  if (!bySegment.has(m.segIndex)) bySegment.set(m.segIndex, []);
  bySegment.get(m.segIndex).push(stopIdx);
});
for (const list of bySegment.values()) {
  list.sort((a, b) => stopMatches[a].t - stopMatches[b].t);
}

// ---- Rebuild the coordinates array, inserting precise stop vertices ----
const newCoordinates = [];
const vertexForStop = new Array(stopMatches.length);

for (let i = 0; i < coordinates.length; i++) {
  newCoordinates.push(coordinates[i]);
  const thisIdx = newCoordinates.length - 1;

  // Any stop that snapped exactly onto this existing vertex (t≈0 landing
  // on segment i, meaning vertex i itself)
  stopMatches.forEach((m, stopIdx) => {
    if (m.t <= T_EPS && m.segIndex === i) vertexForStop[stopIdx] = thisIdx;
    if (m.t >= 1 - T_EPS && m.segIndex === i - 1) vertexForStop[stopIdx] = thisIdx;
  });

  const insertions = bySegment.get(i);
  if (insertions) {
    for (const stopIdx of insertions) {
      const m = stopMatches[stopIdx];
      newCoordinates.push([m.lon, m.lat]);
      vertexForStop[stopIdx] = newCoordinates.length - 1;
    }
  }
}

const stopsOut = stopMatches
  .map((m, stopIdx) => ({ name: m.name, vertex: vertexForStop[stopIdx] }))
  .sort((a, b) => a.vertex - b.vertex);

const coordinatesOut = newCoordinates;

// ---- Cross-check the declared start stop against where it actually landed ----
// index.html reads "start" purely as vertex 0 — it never re-validates the
// name. If this file's line runs the opposite direction from what
// ROUTE_DIRECTIONS expects (e.g. someone traced it wayback-first), nothing
// about the shape itself looks wrong; you'd only find out by clicking
// around in the browser. Catch it here instead, when --start is given.
if (startStopArg) {
  const match = stopsOut.find(s => s.name === startStopArg);
  if (!match) {
    console.error(
      `--start="${startStopArg}" doesn't match any stop matched to this route. Check the spelling against stops.json exactly ` +
      `(this is a common source of silent failures — see build-route-shapes.js's NOTE ON MATCHING).`
    );
    process.exit(1);
  }
  // index.html doesn't require the start stop to sit at EXACTLY vertex 0 —
  // getRouteVertex() just needs it to resolve to a vertex that comes before
  // the wayback point (and the true seam-closing point is handled
  // separately, via the last coordinate). Landing 1-2 vertices in, from the
  // stop-insertion logic above, is normal and correct. What actually needs
  // catching is the line being traced in the WRONG direction entirely
  // (start stop ending up past the midpoint, near the wayback/end side).
  const startFraction = match.vertex / (coordinatesOut.length - 1);
  if (startFraction > 0.5) {
    console.error(
      `--start="${startStopArg}" landed at vertex ${match.vertex} of ${coordinatesOut.length - 1} (${(startFraction * 100).toFixed(0)}% along the line) ` +
      `— that's past the midpoint, so this file's line looks like it was traced starting from the WAYBACK point instead of "${startStopArg}". ` +
      `Reverse the source geometry (or double check --start matches index.html's ROUTE_DIRECTIONS for this route) and re-run; writing this file ` +
      `as-is would make the browser's "up" and "down" legs backwards.`
    );
    process.exit(1);
  }
  console.log(`  \u2713 --start="${startStopArg}" confirmed near the start of the line (vertex ${match.vertex} of ${coordinatesOut.length - 1}).`);
}

// ---- 4. Write the enriched file back out, preserving everything else ----
// isClosedLoopShape is guaranteed true here (see the hard-fail above), so
// this is no longer a hardcoded guess — it's kept only because older
// versions of index.html still read this field as a fallback.
const isLoop = isClosedLoopShape;
if (hasEnvelope) {
  rawRouteFile.data.coordinates = coordinatesOut;
  rawRouteFile.data.stops = stopsOut;
  rawRouteFile.data.loop = isLoop;
} else {
  rawRouteFile.coordinates = coordinatesOut;
  rawRouteFile.stops = stopsOut;
  rawRouteFile.loop = isLoop;
}

fs.writeFileSync(outFilePath, JSON.stringify(rawRouteFile));
console.log(`Wrote ${outFilePath}: ${coordinatesOut.length} vertices (${coordinatesOut.length - coordinates.length} inserted for precise stop matches), ${stopsOut.length} stops matched, loop=${isLoop}.`);