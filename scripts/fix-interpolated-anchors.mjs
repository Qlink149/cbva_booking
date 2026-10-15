/**
 * ASSUMPTIONS A24 — re-place the eleven interpolated desks at the drawing's own
 * workstation pitch.
 *
 * THE DEFECT. Phase 2 located 130 of the 141 desks from the drawing's own
 * geometry by detecting the repeated chair block. The other eleven were
 * INTERPOLATED, and the interpolator spaced them by dividing up the bay rather
 * than by stepping at the pitch the drawing actually uses. The result is fifteen
 * pairs sitting closer than the 1.30 m a desk is wide, the worst being C7-04 at
 * 6 cm from PA-15 — effectively the same desk drawn twice.
 *
 * On a 90-metre floor at fit-to-floor zoom two anchors 6 cm apart are the same
 * pixel, so this was invisible on the 2D plan for two phases. Two solid desks
 * 6 cm apart in the 3D view are not.
 *
 * THE FIX, and its limits. Each interpolated desk is re-placed by continuing its
 * bay's own axis from the last DETECTED desk in that bay, stepping at the
 * measured pitch — 23.02 plan units, which meta.json's scale note records as
 * 1624 mm at 1:200. It then relaxes: while any desk is still inside another's
 * footprint, the interpolated one is nudged one further step along the axis.
 *
 * They stay flagged `interpolated`, NOT `manual`. This makes them no longer
 * overlap; it does not make them right. The drawing genuinely does not say where
 * these eleven chairs are, and marking them as a human correction would claim a
 * confidence nobody has. A24 stays open, and fifteen minutes in
 * /admin/floor-plan with somebody who knows the floor still closes it properly.
 *
 *   node scripts/fix-interpolated-anchors.mjs [--write]
 */
import fs from "node:fs";
import path from "node:path";

const SEATS = path.join("src", "data", "floorplan", "seats.json");
const META = path.join("src", "data", "floorplan", "meta.json");

const meta = JSON.parse(fs.readFileSync(META, "utf8"));
const doc = JSON.parse(fs.readFileSync(SEATS, "utf8"));

const MM_PER_UNIT = meta.mmPerUnit;
/** The drawing's own workstation pitch: 23.02pt = 1624 mm. See meta.scaleNote. */
const PITCH_UNITS = 1624 / MM_PER_UNIT;
/** A desk is 1.30 m wide; anything closer than that is an overlap. */
const MIN_UNITS = 1300 / MM_PER_UNIT;

const metres = (u) => (u * MM_PER_UNIT) / 1000;
// R009 seat codes ARE the desk numbers; R007's were `BAY-NN`.
const seatNo = (code) => Number(code.includes("-") ? code.split("-")[1] : code);
const dist = (a, b) => Math.hypot(a.planX - b.planX, a.planY - b.planY);

function collisions(seats) {
  const out = [];
  for (let i = 0; i < seats.length; i++) {
    for (let k = i + 1; k < seats.length; k++) {
      const d = dist(seats[i], seats[k]);
      if (d < MIN_UNITS) {
        out.push({ a: seats[i].seatCode, b: seats[k].seatCode, m: +metres(d).toFixed(3) });
      }
    }
  }
  return out.sort((x, y) => x.m - y.m);
}

const before = collisions(doc.seats);
console.log(
  `pitch ${PITCH_UNITS.toFixed(2)} units (${(PITCH_UNITS * MM_PER_UNIT).toFixed(0)} mm) · ` +
    `min gap ${MIN_UNITS.toFixed(2)} units (1300 mm)`,
);
console.log(`BEFORE: ${before.length} colliding pairs, closest ${before[0]?.m} m`);

/* ------------------------------------------------------------ the placement */

const byBay = new Map();
for (const s of doc.seats) {
  if (!byBay.has(s.bay)) byBay.set(s.bay, []);
  byBay.get(s.bay).push(s);
}

const moved = [];

for (const [bay, list] of byBay) {
  const detected = list
    .filter((s) => s.source === "detected")
    .sort((a, b) => seatNo(a.seatCode) - seatNo(b.seatCode));
  const interpolated = list
    .filter((s) => s.source === "interpolated")
    .sort((a, b) => seatNo(a.seatCode) - seatNo(b.seatCode));
  if (interpolated.length === 0) continue;

  if (detected.length < 2) {
    console.warn(`  ! ${bay}: only ${detected.length} detected desk(s); left alone`);
    continue;
  }

  // The bay's axis, from its first detected desk to its last. A run of desks in
  // this drawing is a straight line, so two points define it; using the extremes
  // rather than adjacent pairs averages out the detector's per-chair jitter.
  const first = detected[0];
  const last = detected[detected.length - 1];
  const span = seatNo(last.seatCode) - seatNo(first.seatCode);
  let ax = (last.planX - first.planX) / span;
  let ay = (last.planY - first.planY) / span;
  const axisLen = Math.hypot(ax, ay);
  if (axisLen < 1e-6) {
    console.warn(`  ! ${bay}: detected desks are coincident; left alone`);
    continue;
  }
  // Normalise to the DRAWING's pitch rather than trusting the detected spacing,
  // which varies by a few percent chair to chair.
  ax = (ax / axisLen) * PITCH_UNITS;
  ay = (ay / axisLen) * PITCH_UNITS;

  for (const seat of interpolated) {
    const steps = seatNo(seat.seatCode) - seatNo(last.seatCode);
    // An interpolated desk numbered BELOW the last detected one would be being
    // placed backwards through occupied positions; step forward from the first
    // detected desk instead.
    const anchor = steps > 0 ? last : first;
    const n = steps > 0 ? steps : seatNo(seat.seatCode) - seatNo(first.seatCode);

    const from = { planX: seat.planX, planY: seat.planY };
    let k = n;
    let next = { planX: anchor.planX + ax * k, planY: anchor.planY + ay * k };

    // Relaxation. Continuing a bay's axis can walk into a NEIGHBOURING bay —
    // C7 runs straight at the PA passage — so keep stepping until the desk is
    // clear of every other desk on the floor, not just its own bay.
    const others = doc.seats.filter((s) => s.seatCode !== seat.seatCode);
    let guard = 0;
    while (
      others.some((o) => Math.hypot(next.planX - o.planX, next.planY - o.planY) < MIN_UNITS) &&
      guard++ < 12
    ) {
      k += 1;
      next = { planX: anchor.planX + ax * k, planY: anchor.planY + ay * k };
    }

    seat.planX = +next.planX.toFixed(2);
    seat.planY = +next.planY.toFixed(2);
    // Rotation follows the bay, so a re-placed desk faces the way its
    // neighbours do rather than keeping an angle from a position it no longer
    // occupies.
    seat.rotationDeg = anchor.rotationDeg;

    moved.push({
      seatCode: seat.seatCode,
      from: [from.planX, from.planY],
      to: [seat.planX, seat.planY],
      shifted: +metres(Math.hypot(seat.planX - from.planX, seat.planY - from.planY)).toFixed(2),
      extraSteps: k - n,
    });
  }
}

const after = collisions(doc.seats);

console.log(`\nmoved ${moved.length} desks:`);
for (const m of moved) {
  console.log(
    `  ${m.seatCode.padEnd(7)} ${m.from[0]},${m.from[1]} → ${m.to[0]},${m.to[1]}` +
      `  (${m.shifted} m${m.extraSteps ? `, +${m.extraSteps} step to clear neighbours` : ""})`,
  );
}
console.log(`\nAFTER: ${after.length} colliding pairs${after.length ? `, closest ${after[0].m} m` : ""}`);
for (const p of after) console.log(`  ${p.a} ↔ ${p.b} ${p.m} m`);

if (process.argv.includes("--write")) {
  if (after.length > 0) {
    console.error("\nrefusing to write: collisions remain");
    process.exit(1);
  }
  fs.writeFileSync(SEATS, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`\nwrote ${SEATS}`);
} else {
  console.log("\n(dry run — pass --write to save)");
}
