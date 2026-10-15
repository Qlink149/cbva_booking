/**
 * Bay-level occupancy in 3D, as floor decals — the far half of the LOD switch.
 *
 * WHY. At whole-floor framing a desk is a few pixels across and its status
 * glyph is sub-pixel, so the seven-status vocabulary is not merely hard to read
 * there, it is unreadable in principle. Phase 4 tried to fix that by enlarging
 * the glyph plate and smeared the atlas across all 158 desks, because the cell
 * holds one CENTRED glyph and a bigger plate stretches it. The answer is not a
 * bigger mark, it is a different question: how full is each bay.
 *
 * ONE DRAW CALL, by the same construction RoomLabels uses (ADR-045) and for the
 * same reason: every plate is a quad in world space, all of them merged into a
 * single BufferGeometry whose UVs already point at that bay's row of one strip
 * atlas. Thirteen bays or thirty, it stays one mesh and one texture.
 *
 * So this layer SUBTRACTS from the draw-call budget rather than adding to it —
 * it replaces up to six per-status glyph instance meshes with one.
 *
 * A decal, not a billboard, for RoomLabels' first reason: the top-down preset
 * is the acceptance test for this view, and a decal lies in the plan while a
 * billboard turns to face the camera and breaks it.
 *
 * NOT INTERACTIVE, like everything here that is not a desk.
 */
"use client";

import { useEffect, useMemo } from "react";
import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  LinearFilter,
  SRGBColorSpace,
  type Texture,
} from "three";

import type { FloorPlanSeat } from "@/components/floor-plan/types";
import {
  bayOccupancy,
  occupancyFraction,
  type BayOccupancy,
} from "@/lib/floor-plan-lod";

import { planToWorld } from "./coords";
import type { SeatPalette } from "./seat-materials";

const CELL_W = 512;
const CELL_H = 256;

/** Metres. About two desk pitches, so a plate sits over its own bench run. */
const PLATE_WIDTH = 6.4;
const PLATE_HEIGHT = (PLATE_WIDTH * CELL_H) / CELL_W;
/** Above the floor plane, its backing slab and the room-label decals. */
const LIFT = 0.05;
const RENDER_ORDER = 11;

/**
 * Depth testing off, render order last, exactly as the room labels are.
 *
 * With it on these were hidden by the desks they describe — a plate lying at
 * 0.05 m under a bank of 0.74 m desktops is buried by them, which is the same
 * defect the labels hit and for the same reason.
 */
function buildPlateAtlas(
  bays: BayOccupancy[],
  ink: string,
  muted: string,
  fill: string,
  rail: string,
): Texture | null {
  const canvas = document.createElement("canvas");
  canvas.width = CELL_W;
  canvas.height = CELL_H * bays.length;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  bays.forEach((bay, i) => {
    const top = i * CELL_H;
    const pad = 10;

    // The plate. Opaque, because it sits over the architect's drawing and the
    // numerals have to stay legible against whatever colour is underneath —
    // red workstation hatch, over most of C and D.
    ctx.fillStyle = "#FBFAF7";
    ctx.globalAlpha = 0.93;
    ctx.fillRect(pad, top + pad, CELL_W - pad * 2, CELL_H - pad * 2);
    ctx.globalAlpha = 1;

    // The fill IS the measure, drawn from the same two seat tokens a desk
    // uses. No new colour enters the product here.
    const fraction = occupancyFraction(bay) ?? 0;
    const railY = top + CELL_H - pad - 16;
    ctx.fillStyle = rail;
    ctx.fillRect(pad, railY, CELL_W - pad * 2, 16);
    ctx.fillStyle = fill;
    ctx.fillRect(pad, railY, (CELL_W - pad * 2) * fraction, 16);

    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    // The bay code in mono, which is what the type rules reserve it for.
    ctx.fillStyle = muted;
    ctx.font = `${Math.round(CELL_H * 0.22)}px ui-monospace, SFMono-Regular, monospace`;
    ctx.fillText(bay.bay, CELL_W / 2, top + CELL_H * 0.38);
    // The count is the non-colour differentiator, and a fraction rather than a
    // percentage so a one-desk bay cannot report "100%" and read as a crisis.
    ctx.fillStyle = ink;
    ctx.font = `600 ${Math.round(CELL_H * 0.32)}px ui-sans-serif, system-ui, sans-serif`;
    ctx.fillText(
      `${bay.occupied}/${bay.capacity}`,
      CELL_W / 2,
      top + CELL_H * 0.72,
    );
  });

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.generateMipmaps = false;
  return texture;
}

function buildPlateGeometry(bays: BayOccupancy[]): BufferGeometry {
  const n = bays.length;
  const pos = new Float32Array(n * 4 * 3);
  const uv = new Float32Array(n * 4 * 2);
  const index: number[] = [];
  const hw = PLATE_WIDTH / 2;
  const hh = PLATE_HEIGHT / 2;

  bays.forEach((bay, i) => {
    const [x, , z] = planToWorld(bay.planX, bay.planY);
    // Canvas rows run top-down; UV rows run bottom-up.
    const v1 = 1 - i / n;
    const v0 = 1 - (i + 1) / n;
    const corners: Array<[number, number, number, number]> = [
      [x - hw, z - hh, 0, v1],
      [x + hw, z - hh, 1, v1],
      [x + hw, z + hh, 1, v0],
      [x - hw, z + hh, 0, v0],
    ];
    corners.forEach(([cx, cz, u, v], k) => {
      const p = (i * 4 + k) * 3;
      pos[p] = cx;
      pos[p + 1] = LIFT;
      pos[p + 2] = cz;
      const q = (i * 4 + k) * 2;
      uv[q] = u;
      uv[q + 1] = v;
    });
    const b = i * 4;
    index.push(b, b + 2, b + 1, b, b + 3, b + 2);
  });

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(pos, 3));
  geometry.setAttribute("uv", new BufferAttribute(uv, 2));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  return geometry;
}

export function BayPlates({
  seats,
  palette,
}: {
  seats: FloorPlanSeat[];
  palette: SeatPalette;
}) {
  // Bays with no bookable supply are dropped, not drawn empty: C1, C2 and the
  // cabins are allocated in full to fixed-grade staff, and "0/0" is not a low
  // occupancy reading, it is not a question.
  const bays = useMemo(
    () => bayOccupancy(seats).filter((b) => b.capacity > 0),
    [seats],
  );

  const geometry = useMemo(() => buildPlateGeometry(bays), [bays]);
  const atlas = useMemo(
    () =>
      buildPlateAtlas(
        bays,
        // Navy, not ink: lying flat, a decal is foreshortened at every
        // camera angle but straight down, so it needs more contrast than
        // upright text would. Same reasoning as the room labels, and it
        // spends no gold.
        palette.chrome.navy.getStyle(),
        palette.chrome.inkSubtle.getStyle(),
        palette.status.booked.fill.getStyle(),
        palette.chrome.hairline.getStyle(),
      ),
    [bays, palette],
  );

  useEffect(() => {
    return () => {
      geometry.dispose();
      atlas?.dispose();
    };
  }, [geometry, atlas]);

  if (!atlas || bays.length === 0) return null;

  return (
    <mesh geometry={geometry} raycast={() => null} renderOrder={RENDER_ORDER}>
      <meshBasicMaterial
        map={atlas}
        transparent
        toneMapped={false}
        depthWrite={false}
        depthTest={false}
      />
    </mesh>
  );
}
