import { BoxGeometry, BufferGeometry, CylinderGeometry, Matrix4 } from "three";
import * as BufferGeometryUtils from "three/examples/jsm/utils/BufferGeometryUtils.js";

import { DIMENSIONS } from "@/components/floor-plan/three/coords";

/**
 * A desk and a chair, built from primitives.
 *
 * Deliberately not a GLTF. This is a wayfinding tool at a 53-degree tilt, not a
 * product visualisation: at the scale a desk actually occupies on screen, a
 * modelled office chair and six boxes are indistinguishable, and the boxes cost
 * nothing to load, nothing to license and nothing to keep in the repo.
 *
 * Each is merged into ONE BufferGeometry so drei's <Instances> can draw all 158
 * in a single call. Both are built at the origin with their base on y=0 and
 * their occupant facing -Z, so a seat's `rotationDeg` is the only thing that
 * has to be right per instance.
 */

function merge(parts: BufferGeometry[]): BufferGeometry {
  const merged = BufferGeometryUtils.mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  return merged;
}

function box(w: number, h: number, d: number, x: number, y: number, z: number) {
  return new BoxGeometry(w, h, d).applyMatrix4(new Matrix4().makeTranslation(x, y, z));
}

export function buildDeskGeometry(): BufferGeometry {
  const { deskWidth: w, deskDepth: d, deskHeight: h, deskTopThickness: t } = DIMENSIONS;
  return merge([
    // the top
    box(w, t, d, 0, h - t / 2, 0),
    // two end panels, inset so the desk reads as furniture rather than a slab
    box(0.04, h - t, d * 0.85, -w / 2 + 0.06, (h - t) / 2, 0),
    box(0.04, h - t, d * 0.85, w / 2 - 0.06, (h - t) / 2, 0),
    // the modesty panel, on the far side from the occupant
    box(w * 0.9, (h - t) * 0.55, 0.03, 0, (h - t) * 0.4, d / 2 - 0.05),
  ]);
}

export function buildChairGeometry(): BufferGeometry {
  const { chairSeatHeight: s, chairWidth: w } = DIMENSIONS;
  const base = new CylinderGeometry(w * 0.42, w * 0.46, 0.04, 12).applyMatrix4(
    new Matrix4().makeTranslation(0, 0.02, 0),
  );
  const post = new CylinderGeometry(0.035, 0.035, s - 0.06, 8).applyMatrix4(
    new Matrix4().makeTranslation(0, (s - 0.06) / 2 + 0.04, 0),
  );
  return merge([
    base,
    post,
    // the seat pan
    box(w, 0.07, w * 0.92, 0, s, 0),
    // the back, behind the occupant, i.e. away from the desk
    box(w * 0.92, 0.42, 0.06, 0, s + 0.24, w * 0.42),
  ]);
}

/**
 * The status surface: a panel covering most of the desktop, in the status's
 * LINE colour, carrying its glyph.
 *
 * This started as a 0.34 m tile and it was the wrong idea twice over. The seven
 * FILL colours are tuned for a 2D chip that sits inside a coloured border next
 * to a glyph — as the body colour of a solid object seen from twenty metres up,
 * `available` paper and `booked` navy-tint are both simply pale, and the desks
 * read as a scattering of white blocks with no status at all. Enlarging the
 * tile to 0.62 m did not help either: at whole-floor zoom a desk is eight
 * pixels across, and a mark inside it is one.
 *
 * So the desktop IS the swatch. The panel takes the line colour, which is the
 * strong half of every token pair, and the glyph rides on it. It is the same
 * fill-plus-border-plus-glyph vocabulary the 2D plan uses, sized for a surface
 * being looked at rather than a chip being read.
 *
 * `available` has no glyph in the token table, and gets no panel at all — a
 * bare desktop, which is the same statement the 2D plan's plain outline makes,
 * and it keeps the free desks the lightest thing on the floor.
 */
/**
 * The status mark: a small square lying on the desktop, carrying the glyph.
 *
 * It was briefly grown to cover the whole desktop, on the theory that a bigger
 * mark reads better from further away. It does not — the atlas cell holds one
 * centred glyph, so stretching the plate stretches the glyph with it, and every
 * desk on the floor turned into an indistinct dark blob. The desktop itself is
 * the status swatch; this is the non-colour cue sitting on it, and it is sized
 * to be a mark rather than a surface.
 */
export function buildGlyphPlateGeometry(): BufferGeometry {
  const { deskDepth: d, deskHeight: h } = DIMENSIONS;
  const size = 0.34;
  const plate = new BoxGeometry(size, 0.004, size);
  // Toward the occupant's edge, so it is not hidden by anything on the far side
  // and stays clear of the desk's own centre line.
  plate.applyMatrix4(new Matrix4().makeTranslation(0, h + 0.005, -d * 0.16));
  return plate;
}
