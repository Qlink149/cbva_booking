"use client";

import { useEffect, useMemo, useRef } from "react";
import { Instance, Instances } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { MathUtils, type BufferGeometry, type Color, type Object3D, type Texture } from "three";

import { DIMENSIONS, planRotationToY, planToWorld } from "@/components/floor-plan/three/coords";
import {
  buildChairGeometry,
  buildDeskGeometry,
  buildGlyphPlateGeometry,
} from "@/components/floor-plan/three/furniture-geometry";
import { GLYPH_CELL_WIDTH, glyphCellOffset } from "@/components/floor-plan/three/glyph-atlas";
import {
  GLYPH_ORDER,
  glyphFor,
  isInteractive,
  type SeatPalette,
} from "@/components/floor-plan/three/seat-materials";
import type { FloorPlanSeat } from "@/components/floor-plan/types";
import type { LodLevel } from "@/lib/floor-plan-lod";
import type { SeatVisualStatus } from "@/components/seat/seat-status";

/**
 * 158 desks and 158 chairs in two draw calls.
 *
 * The furniture is NOT CAD geometry. Extruding the furniture layer would be
 * 49,342 paths of hatched desktop that cannot even be segmented into individual
 * desks (ADR-016); the drawing already carries that detail, baked into the floor
 * texture underneath. What the 3D view adds is the one thing the drawing cannot
 * show — which desks are free right now — so the furniture here exists to carry
 * colour, and simple instanced primitives carry it perfectly.
 *
 * Position and rotation come straight from `seats.json` through the same
 * FloorPlanSeat array the 2D plan renders. There is no second seat pipeline and
 * there must never be one.
 */

const HOVER_LIFT = 0.12;

interface SeatsProps {
  seats: FloorPlanSeat[];
  palette: SeatPalette;
  glyphAtlas: Texture;
  focusedSeatCode: string | null;
  selectedSeatCode: string | null;
  reduceMotion: boolean;
  onFocusSeat: (code: string | null) => void;
  onActivateSeat: (seat: FloorPlanSeat) => void;
  /**
   * "bay" means the camera is far enough out that a 0.34 m glyph plate is
   * sub-pixel. The plates are dropped there and BayPlates answers instead --
   * the desks themselves stay, in position and pickable, because a desk you
   * can see and click is still useful at that distance even when its status
   * is not readable.
   */
  lod: LodLevel;
}

function useGeometries() {
  const geometries = useMemo(
    () => ({
      desk: buildDeskGeometry(),
      chair: buildChairGeometry(),
      plate: buildGlyphPlateGeometry(),
    }),
    [],
  );
  useEffect(
    () => () => {
      geometries.desk.dispose();
      geometries.chair.dispose();
      geometries.plate.dispose();
    },
    [geometries],
  );
  return geometries;
}

export function Seats({
  seats,
  palette,
  glyphAtlas,
  focusedSeatCode,
  selectedSeatCode,
  reduceMotion,
  onFocusSeat,
  onActivateSeat,
  lod,
}: SeatsProps) {
  const geometries = useGeometries();

  /**
   * The hover lift, animated on ONE object rather than by re-rendering 158.
   * Re-rendering the instance list on every pointer move is what turns a 60fps
   * scene into a 20fps one; the raise is a transform, so it belongs in the
   * frame loop and not in React.
   */
  const deskRefs = useRef(new Map<string, Object3D>());
  const lift = useRef(0);
  const lifted = useRef<string | null>(null);

  useFrame((_, delta) => {
    const wanted = focusedSeatCode;
    if (lifted.current !== wanted) {
      const previous = lifted.current ? deskRefs.current.get(lifted.current) : undefined;
      if (previous) previous.position.y = 0;
      lifted.current = wanted;
      lift.current = 0;
    }
    if (!wanted) return;
    const mesh = deskRefs.current.get(wanted);
    if (!mesh) return;
    lift.current = reduceMotion ? 1 : MathUtils.damp(lift.current, 1, 9, Math.min(delta, 0.05));
    mesh.position.y = lift.current * HOVER_LIFT;
  });

  const byStatus = useMemo(() => {
    const out = new Map<SeatVisualStatus, FloorPlanSeat[]>();
    for (const seat of seats) {
      const list = out.get(seat.status);
      if (list) list.push(seat);
      else out.set(seat.status, [seat]);
    }
    return out;
  }, [seats]);

  return (
    <group>
      <Instances geometry={geometries.desk} limit={200} range={seats.length} castShadow>
        <meshStandardMaterial roughness={0.85} metalness={0} />
        {seats.map((seat) => {
          const [x, , z] = planToWorld(seat.planX, seat.planY);
          return (
            <Instance
              key={seat.seatCode}
              ref={(node: Object3D | null) => {
                if (node) deskRefs.current.set(seat.seatCode, node);
                else deskRefs.current.delete(seat.seatCode);
              }}
              position={[x, 0, z]}
              rotation={[0, planRotationToY(seat.rotationDeg), 0]}
              color={palette.status[seat.status].fill}
              onPointerOver={(e) => {
                e.stopPropagation();
                onFocusSeat(seat.seatCode);
              }}
              onPointerOut={() => onFocusSeat(null)}
              onClick={(e) => {
                e.stopPropagation();
                // The same guard the 2D marker applies. A booked desk is
                // readable but not actionable, in both renderings.
                if (isInteractive(seat.status)) onActivateSeat(seat);
              }}
            />
          );
        })}
      </Instances>

      {/* Chairs are deliberately uncoloured. Status lives on the desktop, where
          it reads from above; a coloured chair would double the signal and, for
          `your_booking`, would put gold on a whole object rather than a rule. */}
      <Instances
        geometry={geometries.chair}
        limit={200}
        range={seats.length}
        castShadow
        // Chairs are scenery. Excluding them from the raycast keeps hit testing
        // to one instanced mesh and stops a chair back stealing a desk's click.
        raycast={() => null}
      >
        <meshStandardMaterial color={palette.chrome.inkSubtle} roughness={0.9} metalness={0} />
        {seats.map((seat) => {
          const angle = planRotationToY(seat.rotationDeg);
          const offset = DIMENSIONS.deskDepth * 0.78;
          const [x, , z] = planToWorld(seat.planX, seat.planY);
          return (
            <Instance
              key={seat.seatCode}
              position={[x - Math.sin(angle) * offset, 0, z - Math.cos(angle) * offset]}
              rotation={[0, angle, 0]}
            />
          );
        })}
      </Instances>

      {/* The non-colour cue. One instanced mesh per status that HAS a glyph, so
          six draw calls at most, each sampling its own cell of the atlas.

          Dropped entirely at bay detail. NOT scaled up to compensate -- that
          is Phase 4 defect 7, where growing the plate to chase legibility
          stretched the atlas cell's centred glyph with it and turned all 158
          desks into smears. A mark that cannot resolve should not be drawn. */}
      {lod === "seat" && GLYPH_ORDER.map((status, index) => {
        const list = byStatus.get(status);
        if (!list || list.length === 0 || !glyphFor(status)) return null;
        return (
          <GlyphPlates
            key={status}
            seats={list}
            geometry={geometries.plate}
            atlas={glyphAtlas}
            cell={index}
            ink={palette.status[status].line}
          />
        );
      })}

      <Rings seats={seats} selectedSeatCode={selectedSeatCode} gold={palette.chrome.gold} />
    </group>
  );
}

function GlyphPlates({
  seats,
  geometry,
  atlas,
  cell,
  ink,
}: {
  seats: FloorPlanSeat[];
  geometry: BufferGeometry;
  atlas: Texture;
  cell: number;
  ink: Color;
}) {
  const map = useMemo(() => {
    const t = atlas.clone();
    t.needsUpdate = true;
    t.repeat.set(GLYPH_CELL_WIDTH, 1);
    t.offset.set(glyphCellOffset(cell), 0);
    return t;
  }, [atlas, cell]);

  useEffect(() => () => map.dispose(), [map]);

  return (
    <Instances geometry={geometry} limit={200} range={seats.length} raycast={() => null}>
      {/* Opaque, and unlit. The panel is a status swatch, not a surface — it
          has to read as the same colour wherever on the floor the desk is, the
          way the 2D chip does, rather than shading with the light. */}
      <meshBasicMaterial map={map} color={ink} toneMapped={false} />
      {seats.map((seat) => {
        const [x, , z] = planToWorld(seat.planX, seat.planY);
        return (
          <Instance
            key={seat.seatCode}
            position={[x, 0, z]}
            rotation={[0, planRotationToY(seat.rotationDeg), 0]}
          />
        );
      })}
    </Instances>
  );
}

/**
 * THE GOLD RULE, in three dimensions.
 *
 * Gold appears exactly twice on this floor: a thin ring on the desk that is
 * yours, and a slightly heavier one on the desk whose dialog is open. Never a
 * fill, never a whole object. At 158 desks it stays far under the 5% of pixels
 * the design system allows.
 */
function Rings({
  seats,
  selectedSeatCode,
  gold,
}: {
  seats: FloorPlanSeat[];
  selectedSeatCode: string | null;
  gold: Color;
}) {
  const marked = useMemo(
    () => seats.filter((s) => s.status === "your_booking" || s.seatCode === selectedSeatCode),
    [seats, selectedSeatCode],
  );

  return (
    <>
      {marked.map((seat) => {
        const [x, , z] = planToWorld(seat.planX, seat.planY);
        const selected = seat.seatCode === selectedSeatCode;
        const radius = selected ? 1.05 : 0.85;
        return (
          <mesh
            key={seat.seatCode}
            position={[x, DIMENSIONS.deskHeight + 0.012, z]}
            rotation={[-Math.PI / 2, 0, 0]}
            raycast={() => null}
          >
            <ringGeometry args={[radius, radius + (selected ? 0.07 : 0.045), 40]} />
            <meshBasicMaterial color={gold} toneMapped={false} transparent opacity={0.95} />
          </mesh>
        );
      })}
    </>
  );
}
