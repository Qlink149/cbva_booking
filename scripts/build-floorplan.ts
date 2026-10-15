/**
 * npm run build:floorplan
 *
 * One command, two halves. The Python half reads the architect's PDF and
 * writes the geometry JSON plus an intermediate SVG of the whole drawing; this
 * half rasterises that SVG into the two webp textures the app actually ships,
 * then validates every JSON file against the same zod schemas the app parses
 * them with, so a bad build fails here rather than at runtime.
 *
 * The outputs are committed. Nobody needs to run this to work on the app.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

import {
  detectionReportSchema,
  floorplanMetaSchema,
  furnitureSchema,
  seatAnchorsSchema,
  wallsSchema,
  zonesSchema,
} from "../src/lib/floorplan-schema";
import { BAYS, TOTAL_SEATS, seatCodes } from "../src/lib/seed-data/inventory";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "src", "data", "floorplan");
const PUBLIC = path.join(ROOT, "public", "floorplan");
const TEXTURE_WIDTHS = [2048, 4096] as const;

function python(): string {
  for (const candidate of ["python", "python3", "py"]) {
    const probe = spawnSync(candidate, ["--version"], { encoding: "utf8" });
    if (probe.status === 0) return candidate;
  }
  throw new Error("no python interpreter on PATH — needed to read the CAD PDF");
}

const PY_SCRIPT = path.join(ROOT, "tools", "cad", "build_floorplan.py");

/**
 * The audit runs FIRST and its exit status is the build's.
 *
 * It asserts five things that can each go wrong without producing any visible
 * error: the exact count of paths the legend-swatch EXCLUDE boxes remove, that
 * no wall-class geometry is among them, that all eleven embedded bitmaps are
 * present, that no CAD layer is switched off in the PDF's own default view,
 * and that the plan mask still floods to the same interior coverage.
 *
 * The exact count is the load-bearing one and it is exact on purpose. An
 * earlier, over-wide set of EXCLUDE boxes deleted 4,650 paths of real building
 * geometry, and every individual path in that region was small -- so a
 * per-path size threshold could not have caught the very bug it was written
 * for. Volume was the only signal that worked.
 */
function audit() {
  const bin = python();
  const run = spawnSync(bin, [PY_SCRIPT, "--audit"], { stdio: "inherit" });
  if (run.status !== 0) {
    throw new Error(
      `CAD audit failed (exit ${run.status}). The extractor has silently lost ` +
        `content, or a constant needs re-verifying against the PDF. Nothing ` +
        `was written.`,
    );
  }
}

function extract() {
  const bin = python();
  const run = spawnSync(bin, [PY_SCRIPT], { stdio: "inherit" });
  if (run.status !== 0) {
    throw new Error(`${bin} ${PY_SCRIPT} exited ${run.status}`);
  }
}

/**
 * ASSUMPTIONS A24 (closed with R009), and the reason this step exists at all.
 *
 * Under R009 every desk is numbered on the plan and snaps onto its own chair
 * block, so nothing is interpolated and this step is a no-op that still runs:
 * it is the guard that says so, and a future revision that leaves a desk
 * without a chair goes through the same de-collide it always did.
 *
 * Under R007 the extractor could not place eleven of the 141 desks -- those
 * bays yield fewer chair blocks than the schedule calls for -- so it
 * interpolates them by dividing up the bay. That spacing is not the drawing's,
 * and it put fifteen pairs of desks closer together than a desk is wide, the
 * worst 6 cm apart. Phase 5 fixed it by running
 * `scripts/fix-interpolated-anchors.mjs --write` BY HAND, once, over the
 * committed file.
 *
 * Which quietly broke the build. From that moment `npm run build:floorplan`
 * regenerated seats.json from the PDF and reverted all eleven, and nothing
 * said so: the phase gate compared two consecutive BUILDS to each other and
 * they always agreed. It was proving the build deterministic, never that it
 * produced the file in the repository. That is a false green, which is worse
 * than a red -- it is a check that reports success for a property nobody is
 * testing. Verified by reproducing it: a Phase 6 build reverted exactly those
 * eleven anchors and took the floor from 0 colliding pairs back to 15.
 *
 * So the de-collide is part of the pipeline now rather than a thing somebody
 * remembered to do. It is deterministic -- each interpolated desk is re-placed
 * along its own bay's axis at the drawing's measured 23.02-unit (1,624 mm)
 * pitch, then relaxed a step at a time until it clears every other desk -- and
 * it refuses to write if any collision remains, so it is its own safety net.
 *
 * It must run on FRESH extractor output and exactly once. Run over its own
 * result, the relaxation pass would be measuring against already-moved
 * neighbours rather than the ones the extractor produced.
 */
function decollide() {
  const script = path.join(ROOT, "scripts", "fix-interpolated-anchors.mjs");
  const run = spawnSync(process.execPath, [script, "--write"], {
    stdio: "inherit",
    cwd: ROOT,
  });
  if (run.status !== 0) {
    throw new Error(`fix-interpolated-anchors exited ${run.status}`);
  }
}

/**
 * ONE SVG PER WIDTH, and the pairing is checked rather than trusted.
 *
 * A PDF stroke width of 0 means "one device pixel", and 49,196 of this
 * drawing's 79,827 in-plan paths are zero-width -- 62% of the linework. The
 * correct SVG stroke for those is therefore PLAN_WIDTH / target_pixels: 0.627
 * at 2048 and 0.314 at 4096. There is no single value that is right at both.
 *
 * Until Phase 7 one SVG was rasterised at both widths, so one of the two
 * textures was always wrong -- silently too faint or too bold, which looks
 * like a rendering preference rather than a defect. Each SVG now carries the
 * width it was generated for and this refuses to bake a mismatch.
 */
async function rasterise() {
  mkdirSync(PUBLIC, { recursive: true });

  for (const width of TEXTURE_WIDTHS) {
    const svgPath = path.join(DATA, `plan-texture-${width}.svg`);
    if (!existsSync(svgPath)) throw new Error(`missing ${svgPath}`);
    const svg = readFileSync(svgPath);

    const stamped = /data-raster-width="(\d+)"/.exec(svg.subarray(0, 512).toString());
    if (!stamped || Number(stamped[1]) !== width) {
      throw new Error(
        `${path.basename(svgPath)} was generated for raster width ` +
          `${stamped ? stamped[1] : "unknown"}, not ${width}. Baking it here ` +
          `would produce a texture whose hairlines are wrong at every ` +
          `pixel -- see tools/cad/texture.py hairline_for().`,
      );
    }

    const dest = path.join(PUBLIC, `plan-texture-${width}.webp`);
    // density scales librsvg's rasterisation of the source viewBox; without it
    // sharp renders at 72dpi and then upsamples, which smears the hairlines
    // that make a CAD drawing legible.
    const density = Math.round((72 * width) / 1285);
    await sharp(svg, { density, limitInputPixels: false })
      .resize({ width })
      .webp({ quality: 92, effort: 6 })
      .toFile(dest);
    const kb = statSync(dest).size / 1024;
    console.log(`  ${path.relative(ROOT, dest)}  ${kb.toFixed(0)} KB`);
    // The intermediates are ~5 MB of CAD linework each and are regenerable;
    // the webps are what ship.
    unlinkSync(svgPath);
  }
}

function validate() {
  const read = (name: string) =>
    JSON.parse(readFileSync(path.join(DATA, name), "utf8")) as unknown;

  const meta = floorplanMetaSchema.parse(read("meta.json"));
  const walls = wallsSchema.parse(read("walls.json"));
  const zones = zonesSchema.parse(read("zones.json"));
  const furniture = furnitureSchema.parse(read("furniture.json"));
  const seats = seatAnchorsSchema.parse(read("seats.json"));
  const report = detectionReportSchema.parse(read("detection-report.json"));

  const problems: string[] = [];
  if (seats.seats.length !== TOTAL_SEATS) {
    problems.push(`expected ${TOTAL_SEATS} seat anchors, got ${seats.seats.length}`);
  }
  // The anchors and the seed inventory must name exactly the same desks, in
  // the same bays: R009's desk numbers are the join between the two, and a
  // bay boundary that moved in one and not the other is a desk that books
  // against the wrong wing.
  const expected = new Map(BAYS.flatMap((b) => seatCodes(b).map((c) => [c, b] as const)));
  for (const s of seats.seats) {
    const bay = expected.get(s.seatCode);
    if (!bay) problems.push(`seats.json has desk ${s.seatCode}, which inventory.ts does not`);
    else if (bay.bay !== s.bay || bay.zone !== s.zone) {
      problems.push(
        `desk ${s.seatCode} is bay ${s.bay} / zone ${s.zone} in seats.json but ` +
          `bay ${bay.bay} / zone ${bay.zone} in inventory.ts`,
      );
    }
  }
  if (walls.polygons.length > 600) {
    problems.push(`expected under 600 wall polygons, got ${walls.polygons.length}`);
  }
  // Per-class budgets, so one noisy class cannot eat the whole allowance and
  // silently truncate another. They sum to the 400 the extrusion is sized for.
  const WALL_BUDGETS = { wall: 150, partition: 200, glazing: 300 } as const;
  for (const [layer, budget] of Object.entries(WALL_BUDGETS)) {
    const n = walls.polygons.filter((p) => p.layer === layer).length;
    if (n > budget) problems.push(`expected under ${budget} ${layer} polygons, got ${n}`);
    if (n === 0) problems.push(`no ${layer} polygons were produced`);
  }
  if (zones.zones.length !== 4) {
    problems.push(`expected 4 zones, got ${zones.zones.length}`);
  }
  // Static furniture (ADR-044). The point of the layer is that zones A and B
  // stop rendering as bare plate, so an empty class there is a silent
  // regression of the only thing it was built for.
  const FURNITURE_BUDGETS = { table: 60, seating: 400, planter: 300, modular: 100 } as const;
  for (const [kind, budget] of Object.entries(FURNITURE_BUDGETS)) {
    const n = furniture.items.filter((f) => f.kind === kind).length;
    if (n > budget) problems.push(`expected under ${budget} ${kind} boxes, got ${n}`);
    if (n === 0) problems.push(`no ${kind} furniture was produced`);
  }
  if (furniture.items.length === 0) problems.push("no static furniture was produced");
  const codes = new Set(seats.seats.map((s) => s.seatCode));
  if (codes.size !== seats.seats.length) problems.push("duplicate seat codes");

  // No two desks inside a desk width of each other (A24). The de-collide step
  // above is what makes this true; asserting it here is what stops the two
  // drifting apart again. 1.30 m at meta.mmPerUnit.
  if (meta.mmPerUnit) {
    const minUnits = 1300 / meta.mmPerUnit;
    let worst: { a: string; b: string; m: number } | null = null;
    for (let i = 0; i < seats.seats.length; i++) {
      for (let k = i + 1; k < seats.seats.length; k++) {
        const p = seats.seats[i];
        const q = seats.seats[k];
        const d = Math.hypot(p.planX - q.planX, p.planY - q.planY);
        if (d < minUnits && (worst === null || d < worst.m)) {
          worst = { a: p.seatCode, b: q.seatCode, m: d };
        }
      }
    }
    if (worst) {
      const metres = ((worst.m * meta.mmPerUnit) / 1000).toFixed(3);
      problems.push(
        `desks overlap: ${worst.a} and ${worst.b} are ${metres} m apart (A24)`,
      );
    }
  }

  const b = meta.planBounds;
  for (const s of seats.seats) {
    if (
      s.planX < b.x ||
      s.planX > b.x + b.width ||
      s.planY < b.y ||
      s.planY > b.y + b.height
    ) {
      problems.push(`${s.seatCode} lies outside the plan bounds`);
      break;
    }
  }
  if (Object.keys(report.scheduleDrift).length > 0) {
    problems.push(
      `the drawing's PAX annotations disagree with the seed schedule: ${JSON.stringify(
        report.scheduleDrift,
      )}`,
    );
  }

  if (problems.length) {
    throw new Error(`floor plan build failed validation:\n  - ${problems.join("\n  - ")}`);
  }

  writeFileSync(
    path.join(DATA, "README.md"),
    [
      "# Generated — do not edit by hand",
      "",
      "`npm run build:floorplan` writes every file in this directory from",
      `\`tools/cad/${meta.source}\`.`,
      "",
      `Source SHA-256: \`${meta.sourceSha256}\``,
      `Generator version: ${meta.generatorVersion}`,
      "",
      "`seats.json` is the source of truth for seat geometry: `npm run seed`",
      "reads it, and the editor at `/admin/floor-plan` writes back to it.",
      "",
    ].join("\n"),
  );

  console.log(
    `\nvalidated: ${seats.seats.length} seats, ${walls.polygons.length} wall polygons, ` +
      `${furniture.items.length} furniture boxes, ` +
      `${zones.zones.length} zones, scale ${meta.mmPerUnit ?? "unresolved"} mm/unit`,
  );
}

async function main() {
  audit();
  extract();
  decollide();
  await rasterise();
  validate();
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
