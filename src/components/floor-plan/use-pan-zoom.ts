"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { FULL_FLOOR_BOUNDS, PLAN_BOUNDS } from "@/lib/floorplan";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Transform {
  scale: number;
  x: number;
  y: number;
}

/** Bounds on *manual* zoom. Fitting is allowed below MIN_SCALE — see fitTo. */
export const MIN_SCALE = 0.35;
export const MAX_SCALE = 6;
/** Absolute floor, so "fit to floor" always genuinely fits. */
const FIT_MIN_SCALE = 0.12;

/**
 * How far a pointer may move before a press-on-a-seat becomes a pan instead
 * of a tap. In CSS pixels, so it means the same thing on a hi-DPI phone as on
 * a mouse.
 */
const DRAG_SLOP_PX = 8;

/**
 * Pan and zoom over the plan.
 *
 * The whole layer moves as one CSS transform. Nothing is re-laid-out on pan or
 * zoom and no per-seat work happens, which is what keeps 141 interactive nodes
 * at 60fps on a mid-range laptop. `fitTo` returns the transform that frames a
 * plan-space rectangle; the caller animates towards it.
 */
export function usePanZoom(initial?: Rect) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [transform, setTransform] = useState<Transform>({ scale: 1, x: 0, y: 0 });
  const drag = useRef<{ id: number; x: number; y: number; tx: number; ty: number } | null>(
    null,
  );
  /**
   * The active touch points on the plan. Pointer events are used instead of
   * touch events so the gesture has the same event path as the existing
   * one-finger pan and keeps working through the seat buttons.
   */
  const pointers = useRef(new Map<number, { x: number; y: number; type: string }>());
  const pinch = useRef<{
    ids: [number, number];
    distance: number;
    midX: number;
    midY: number;
    transform: Transform;
  } | null>(null);
  /**
   * A press that landed on a SEAT, not yet proven to be a drag.
   *
   * Pointer capture is deliberately not requested for this pointer until it
   * crosses DRAG_SLOP_PX (see onPointerMove) — a seat is a real <button> and
   * a tap on it has to reach that button's own native click undisturbed. On a
   * phone at fit-to-floor the 141 seat markers nearly tile the surface, so
   * without this a touch that starts on a seat could never begin a pan at
   * all: the old behaviour bailed out of pan-tracking entirely for any
   * pointerdown on `[data-seat]`.
   */
  const pending = useRef<{ id: number; x: number; y: number } | null>(null);
  /**
   * Set the instant a pending press upgrades to a drag, so a stray native
   * `click` — should pointer capture and the click event disagree about which
   * element the pointer "belongs to", which is not something to assume either
   * way across browsers — is swallowed by onClickCapture below rather than
   * quietly activating whichever desk the pointer happened to end the drag
   * over.
   */
  const suppressClick = useRef(false);
  const framed = useRef(false);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box) setSize({ width: box.width, height: box.height });
    });
    ro.observe(el);
    setSize({ width: el.clientWidth, height: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const fitTo = useCallback(
    (rect: Rect, padding = 16): Transform => {
      if (size.width === 0 || size.height === 0) return { scale: 1, x: 0, y: 0 };
      const w = Math.max(1, size.width - padding * 2);
      const h = Math.max(1, size.height - padding * 2);
      // Fitting deliberately ignores MIN_SCALE. On a 390px phone the whole
      // cruciform needs about 0.3, and clamping that up to the manual-zoom
      // floor cropped both side wings off the screen.
      const scale = Math.min(w / rect.width, h / rect.height);
      const clamped = Math.min(MAX_SCALE, Math.max(FIT_MIN_SCALE, scale));
      // Layer coordinates are plan coordinates with PLAN_BOUNDS' origin at 0,0.
      const cx = rect.x + rect.width / 2 - PLAN_BOUNDS.x;
      const cy = rect.y + rect.height / 2 - PLAN_BOUNDS.y;
      return {
        scale: clamped,
        x: size.width / 2 - cx * clamped,
        y: size.height / 2 - cy * clamped,
      };
    },
    [size.width, size.height],
  );

  // Frame the floor once, as soon as the container has been measured.
  useEffect(() => {
    if (framed.current || size.width === 0) return;
    framed.current = true;
    setTransform(fitTo(initial ?? FULL_FLOOR_BOUNDS));
  }, [fitTo, initial, size.width]);

  /**
   * `setPointerCapture` throws `InvalidPointerId` if the browser no longer
   * considers this pointer active — reachable in the real world (a system
   * gesture cancelling mid-touch, a lost pointer on some Android WebViews),
   * not only in a synthetic test. Uncaught, that throw happens inside a React
   * event handler and inside a `setTransform` updater, which is not a place
   * this app can afford to crash from over a gesture that simply did not
   * pan. Failing closed — no capture, no drag started — is the safe answer:
   * the tap this pointer was probably trying to be still works normally,
   * because nothing here touched it.
   */
  const trySetPointerCapture = (el: HTMLElement, pointerId: number) => {
    try {
      el.setPointerCapture(pointerId);
      return true;
    } catch {
      return false;
    }
  };

  const zoomAt = useCallback((factor: number, originX?: number, originY?: number) => {
    setTransform((t) => {
      const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, t.scale * factor));
      const el = containerRef.current;
      const ox = originX ?? (el ? el.clientWidth / 2 : 0);
      const oy = originY ?? (el ? el.clientHeight / 2 : 0);
      const k = next / t.scale;
      return { scale: next, x: ox - (ox - t.x) * k, y: oy - (oy - t.y) * k };
    });
  }, []);

  const startPinch = useCallback((el: HTMLElement) => {
    const touches = [...pointers.current.entries()].filter(([, point]) => point.type === "touch");
    if (touches.length < 2) return;
    const [[firstId, first], [secondId, second]] = touches.slice(-2);
    const dx = second.x - first.x;
    const dy = second.y - first.y;
    const distance = Math.hypot(dx, dy);
    // Identical coordinates cannot define a scale. Wait for the first move
    // rather than allowing a divide-by-zero jump.
    if (distance < 1) return;

    pending.current = null;
    drag.current = null;
    suppressClick.current = true;
    trySetPointerCapture(el, firstId);
    trySetPointerCapture(el, secondId);
    setTransform((transform) => {
      pinch.current = {
        ids: [firstId, secondId],
        distance,
        midX: (first.x + second.x) / 2,
        midY: (first.y + second.y) / 2,
        transform,
      };
      return transform;
    });
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    // Real controls overlaid on the plan — zoom buttons, the editor's form
    // fields — must never start a pan-or-tap gesture. `button:not([data-seat])`
    // is what lets a SEAT (also a <button>) fall through to the branch below
    // instead of being excluded alongside them; the exclusion for everything
    // else is unchanged.
    const target = e.target as HTMLElement;
    if (target.closest("button:not([data-seat]), a, input, select, textarea")) {
      return;
    }
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
    if (e.pointerType === "touch") {
      const el = containerRef.current;
      if (el) startPinch(el);
      if (pinch.current) return;
    }
    suppressClick.current = false;

    if (target.closest("[data-seat]")) {
      // A press on a seat. Record it and wait — see the `pending` ref comment.
      pending.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
      return;
    }

    const el = containerRef.current;
    if (!el || !trySetPointerCapture(el, e.pointerId)) return;
    setTransform((t) => {
      drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, tx: t.x, ty: t.y };
      return t;
    });
  }, [startPinch]);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const point = pointers.current.get(e.pointerId);
    if (point) {
      point.x = e.clientX;
      point.y = e.clientY;
    }
    const activePinch = pinch.current;
    if (activePinch && activePinch.ids.includes(e.pointerId)) {
      const first = pointers.current.get(activePinch.ids[0]);
      const second = pointers.current.get(activePinch.ids[1]);
      if (!first || !second) return;
      const distance = Math.hypot(second.x - first.x, second.y - first.y);
      if (distance < 1) return;
      const scale = Math.min(
        MAX_SCALE,
        Math.max(MIN_SCALE, activePinch.transform.scale * (distance / activePinch.distance)),
      );
      const midX = (first.x + second.x) / 2;
      const midY = (first.y + second.y) / 2;
      const contentX = (activePinch.midX - activePinch.transform.x) / activePinch.transform.scale;
      const contentY = (activePinch.midY - activePinch.transform.y) / activePinch.transform.scale;
      setTransform({ scale, x: midX - contentX * scale, y: midY - contentY * scale });
      return;
    }
    const p = pending.current;
    if (p && p.id === e.pointerId) {
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      if (Math.hypot(dx, dy) < DRAG_SLOP_PX) return;
      // Crossed the slop: this press is a pan, not a tap. Capture from THIS
      // point — the current transform and the current pointer position —
      // rather than from where the press started, so the plan does not jump
      // by the slop distance the instant the drag is recognised.
      pending.current = null;
      const el = containerRef.current;
      if (!el || !trySetPointerCapture(el, e.pointerId)) return;
      suppressClick.current = true;
      setTransform((t) => {
        drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, tx: t.x, ty: t.y };
        return t;
      });
      return;
    }
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    setTransform((t) => ({
      ...t,
      x: d.tx + (e.clientX - d.x),
      y: d.ty + (e.clientY - d.y),
    }));
  }, []);

  const endDrag = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const activePinch = pinch.current;
    const wasPinching = activePinch?.ids.includes(e.pointerId) ?? false;
    pointers.current.delete(e.pointerId);
    if (wasPinching) {
      // A cancelled system gesture can revoke capture before this event is
      // delivered. Releasing an already-revoked capture throws in some mobile
      // browsers, which must not turn a finished pinch into an app error.
      try {
        containerRef.current?.releasePointerCapture?.(e.pointerId);
      } catch {
        // There is nothing left to capture or release.
      }
      const remaining = activePinch
        ? activePinch.ids.find((id) => id !== e.pointerId)
        : undefined;
      pinch.current = null;
      const point = remaining === undefined ? undefined : pointers.current.get(remaining);
      if (point) {
        // Continue naturally as a pan when one finger leaves the screen.
        setTransform((t) => {
          drag.current = { id: remaining!, x: point.x, y: point.y, tx: t.x, ty: t.y };
          return t;
        });
      }
      return;
    }
    if (pending.current?.id === e.pointerId) {
      // Released inside the slop radius: a genuine tap. This pointer was
      // never captured, so the seat's own native click fires on its own —
      // there is nothing to do here but stop tracking it.
      pending.current = null;
      return;
    }
    if (drag.current?.id !== e.pointerId) return;
    drag.current = null;
    containerRef.current?.releasePointerCapture?.(e.pointerId);
  }, []);

  /**
   * The safety net for the "did a click survive pointer capture" question
   * onPointerMove above deliberately does not answer by assumption. Capture
   * phase, so it runs before the click reaches a seat button underneath it.
   */
  const onClickCapture = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!suppressClick.current) return;
    suppressClick.current = false;
    e.stopPropagation();
    e.preventDefault();
  }, []);

  // Non-passive so ctrl+wheel pinch-zoom does not zoom the whole page instead.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey && Math.abs(e.deltaY) < 2) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - rect.left, e.clientY - rect.top);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  return {
    containerRef,
    size,
    transform,
    setTransform,
    fitTo,
    zoomAt,
    isDragging: drag.current !== null,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
      onClickCapture,
    },
  };
}
