"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";

import { FloorPlan } from "@/components/floor-plan/floor-plan";
import {
  DateStrip,
  Legend,
  ModeToggle,
  OccupancyCount,
  SlotToggle,
  ViewToggle,
  ZoneFilter,
} from "@/components/floor-plan/controls";
import { BookingDialog } from "@/components/floor-plan/booking-dialog";
import { useClock } from "@/components/app-shell/session";
import type { ZoneCode } from "@/lib/floorplan";
import type {
  BookableDay,
  FloorPlanMode,
  FloorPlanView,
  SlotKey,
  FloorPlanPayload,
  FloorPlanSeat,
  SlotDefinition,
} from "@/components/floor-plan/types";
import { Card, CardBody } from "@/components/ui/primitives";
import { Switch } from "@/components/ui/switch";
import { useUiStore } from "@/lib/store/ui";

interface DatesPayload {
  timezone: string;
  bookingWindowDays: number;
  bookingWindowWorkingDays: number;
  cutoffMinutes: number;
  days: BookableDay[];
  slots: SlotDefinition[];
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Request to ${url} failed with ${res.status}`);
  return res.json() as Promise<T>;
}

export function FloorClient() {
  const {
    activeDate,
    setActiveDate,
    activeSlot,
    setActiveSlot,
    activeZone,
    setActiveZone,
    focusedSeatCode,
    setFocusedSeatCode,
    view,
    setView,
    mode,
    setMode,
    selectedSeatCode,
    setSelectedSeatCode,
    showOccupancyLabels,
    setShowOccupancyLabels,
    showRoomLabels,
    setShowRoomLabels,
  } = useUiStore();

  const [intent, setIntent] = useState<FloorPlanSeat | null>(null);
  const reduceMotion = useReducedMotion() ?? false;

  /* ---- the URL is the shareable copy of what is on screen ----
     "Have a look at Zone C on Tuesday afternoon" has to be a link, not a list
     of instructions. Date, slot, zone and view all round-trip through the
     query string; the store stays the single reader for the rest of the UI. */
  const pathname = usePathname();
  const params = useSearchParams();
  const hydrated = useRef(false);
  /** Armed by any control below; see the URL sync effect for why it exists. */
  const userChanged = useRef(false);

  useEffect(() => {
    if (hydrated.current) return;
    hydrated.current = true;
    const date = params.get("date");
    const slot = params.get("slot");
    const zone = params.get("zone");
    const v = params.get("view");
    const m = params.get("mode");
    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) setActiveDate(date);
    if (slot === "AM" || slot === "PM") setActiveSlot(slot);
    if (zone === "A" || zone === "B" || zone === "C" || zone === "D") setActiveZone(zone);
    if (v === "list" || v === "plan") setView(v);
    if (m === "2d" || m === "3d") setMode(m);
  }, [params, setActiveDate, setActiveSlot, setActiveZone, setView, setMode]);

  /**
   * Writing the state back to the URL, WITHOUT the router.
   *
   * `router.replace()` is a navigation, and a navigation cancels whatever
   * navigation is already in flight. The default date arrives from
   * /api/floor/dates about a second after the page loads, so if somebody clicks
   * "My Bookings" in that window the resulting replace to /floor?date=… aborts
   * their click and they stay put. It is a race, so it looked like flakiness
   * rather than a bug — the shell's navigation spec caught it.
   *
   * `history.replaceState` is the right tool: this is a URL sync, not a route
   * change. Next 15 keeps `useSearchParams()` in step with it, and nothing here
   * re-renders from the query string after the hydrate-once effect above.
   */
  useEffect(() => {
    // ONLY SYNC WHAT THE USER ACTUALLY CHANGED. This is the third attempt, and
    // the first two are worth recording because both were fixes to the symptom.
    //
    // Phase 3: the effect used `router.replace`, and a navigation cancels the
    // navigation already in flight — clicking "My Bookings" in the wrong second
    // aborted the click. Fixed by dropping to `history.replaceState`.
    //
    // Phase 4, first attempt: guard on `pathname !== "/floor"`. It fails the
    // same spec, because `usePathname()` only updates when the new route
    // COMMITS. Reading `window.location.pathname` instead does not help either:
    // during a soft navigation the address bar has not changed yet, so at the
    // moment of the write the browser also still says "/floor". Every version
    // of "am I still on this page?" is blind in exactly the window that races.
    //
    // The window is not the point. The WRITE is. There is exactly one URL sync
    // that fires without anybody doing anything — the one triggered by the
    // default date arriving from /api/floor/dates, about a second after load —
    // and that is the one landing on top of the click. On a warm machine the
    // date arrives before the user can click and nothing goes wrong, which is
    // why this reads as flakiness rather than as a race.
    //
    // So: sync in response to a user action, and never otherwise. The default
    // date is a default, not a choice, and a bare `/floor` resolves to the same
    // screen anyway. The moment anybody touches a control the URL starts
    // tracking everything, date included, so the shareable link is unaffected.
    if (!userChanged.current || activeDate === null) return;
    const next = new URLSearchParams();
    next.set("date", activeDate);
    next.set("slot", activeSlot);
    if (activeZone) next.set("zone", activeZone);
    if (view !== "plan") next.set("view", view);
    // "Look at Zone C in 3D" has to be a link too, so mode rides the URL with
    // everything else. Omitted at the default, to keep the common link short.
    if (mode !== "2d") next.set("mode", mode);
    const query = next.toString();
    if (query !== params.toString()) {
      // replaceState, not pushState: changing slot should not stack up history
      // entries somebody then has to press Back through.
      window.history.replaceState(null, "", `${pathname}?${query}`);
    }
  }, [activeDate, activeSlot, activeZone, view, mode, params, pathname]);

  /**
   * The controls, wrapped so that using one arms the URL sync above. Nothing
   * else may set this — that is the whole mechanism.
   */
  const onChangeDate = useCallback(
    (d: string) => {
      userChanged.current = true;
      setActiveDate(d);
    },
    [setActiveDate],
  );
  const onChangeSlot = useCallback(
    (sl: SlotKey) => {
      userChanged.current = true;
      setActiveSlot(sl);
    },
    [setActiveSlot],
  );
  const onChangeZone = useCallback(
    (z: ZoneCode | null) => {
      userChanged.current = true;
      setActiveZone(z);
    },
    [setActiveZone],
  );
  const onChangeView = useCallback(
    (v: FloorPlanView) => {
      userChanged.current = true;
      setView(v);
    },
    [setView],
  );
  const onChangeMode = useCallback(
    (m: FloorPlanMode) => {
      userChanged.current = true;
      setMode(m);
    },
    [setMode],
  );

  const dates = useQuery({
    queryKey: ["floor", "dates"],
    queryFn: () => getJson<DatesPayload>("/api/floor/dates"),
  });

  // The first bookable day is chosen by the server from the shared Clock, not
  // by the browser's own Date.
  useEffect(() => {
    if (activeDate === null && dates.data?.days[0]) {
      setActiveDate(dates.data.days[0].date);
    }
  }, [activeDate, dates.data, setActiveDate]);

  const floor = useQuery({
    queryKey: ["floor", activeDate, activeSlot],
    queryFn: () => getJson<FloorPlanPayload>(`/api/floor?date=${activeDate}&slot=${activeSlot}`),
    enabled: activeDate !== null,
    // Seat availability changes under you as colleagues book, so this cannot
    // ride the app-wide 30s staleTime.
    staleTime: 5_000,
    refetchInterval: 30_000,
    placeholderData: (previous) => previous,
  });

  const seats = useMemo(() => floor.data?.seats ?? [], [floor.data]);

  const counts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const seat of seats) {
      if (activeZone !== null && seat.zone !== activeZone) continue;
      out[seat.status] = (out[seat.status] ?? 0) + 1;
    }
    return out;
  }, [seats, activeZone]);

  const visible = useMemo(
    () => (activeZone === null ? seats : seats.filter((s) => s.zone === activeZone)),
    [seats, activeZone],
  );

  /**
   * One activate path for both renderings. A seat clicked in 3D and a seat
   * clicked on the plan arrive here identically, which is what makes the
   * selection genuinely shared rather than mirrored: switch to 2D after
   * picking a desk in 3D and the same desk is still the selected one.
   */
  const onActivateSeat = useCallback(
    (seat: FloorPlanSeat) => {
      setIntent(seat);
      setSelectedSeatCode(seat.seatCode);
    },
    [setSelectedSeatCode],
  );

  const onCloseDialog = useCallback(() => {
    setIntent(null);
    setSelectedSeatCode(null);
  }, [setSelectedSeatCode]);

  /**
   * The dialog needs two things the plan does not carry: the shared clock and
   * the cut-off. Both come from the server rather than being inferred — reading "now" from the
   * browser's Date would let the client and the server disagree about whether a
   * slot has started.
   */
  const clock = useClock();

  /**
   * The seat the dialog is showing, taken from the LIVE query rather than the
   * snapshot captured on click. After a booking succeeds the refetch changes
   * that seat's status, and the dialog has to follow — otherwise it goes on
   * offering "Confirm booking" for a desk that is already yours.
   */
  const intentSeat = useMemo(
    () => (intent ? (seats.find((s) => s.seatCode === intent.seatCode) ?? intent) : null),
    [intent, seats],
  );

  const slots = dates.data?.slots ?? [];
  const loading = dates.isLoading || (floor.isLoading && !floor.data);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs tracking-wide text-ink-subtle uppercase">
            Occupancy, this slot
          </p>
          {floor.data ? (
            <OccupancyCount
              occupied={floor.data.occupied}
              capacity={floor.data.capacity}
              reduceMotion={reduceMotion}
            />
          ) : (
            <div className="h-8 w-32 rounded-sm bg-surface-sunken" />
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {view === "plan" ? <ModeToggle mode={mode} onChange={onChangeMode} /> : null}
          <ViewToggle view={view} onChange={onChangeView} />
        </div>
      </div>

      <Card>
        <CardBody className="space-y-4">
          {dates.data ? (
            <>
              <DateStrip
                days={dates.data.days}
                active={activeDate}
                onChange={onChangeDate}
              />
              <SlotToggle slots={slots} active={activeSlot} onChange={onChangeSlot} />
            </>
          ) : (
            <div className="h-20 rounded-sm bg-surface-sunken" />
          )}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <ZoneFilter active={activeZone} onChange={onChangeZone} />
            <Legend counts={counts} />
          </div>
          {/* Two independent toggles (Phase 8 / A1) — not one "labels" switch,
              because they answer different questions. Occupancy labels are the
              Phase 7 density read at whole-floor zoom, off by default: the
              plan starts quieter and the seat markers' own fill still shows a
              busy wing from an empty one. Room labels are Phase 6 wayfinding
              for the two wings with no bookable desks at all, on by default —
              without them those wings read as broken rather than furnished.
              List view has neither layer, so the row is plan/3D only. */}
          {view === "plan" ? (
            <div className="flex flex-wrap items-center gap-6 border-t border-hairline pt-3">
              <Switch
                id="show-occupancy-labels"
                label="Occupancy labels"
                description="Bay counts, e.g. “A1 0/2”, at whole-floor zoom."
                checked={showOccupancyLabels}
                onCheckedChange={setShowOccupancyLabels}
              />
              <Switch
                id="show-room-labels"
                label="Room labels"
                description="Names the boardroom and meeting rooms on the plan."
                checked={showRoomLabels}
                onCheckedChange={setShowRoomLabels}
              />
            </div>
          ) : null}
        </CardBody>
      </Card>

      {floor.isError ? (
        <Card>
          <CardBody>
            <p className="text-sm text-danger">
              The floor could not be loaded. {String(floor.error)}
            </p>
          </CardBody>
        </Card>
      ) : loading ? (
        <div
          className="h-[clamp(26rem,70vh,50rem)] rounded-md border border-hairline bg-surface-sunken"
          role="status"
          aria-label="Loading the floor plan"
        />
      ) : (
        /* The swap between renderings is a crossfade, not a cut: both show the
           same floor at the same framing, so a hard replace reads as the page
           breaking rather than as one object turning. 160ms is enough to say
           "the same thing, seen differently" without making the toggle drag. */
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={view === "list" ? "list" : mode}
            initial={reduceMotion ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={reduceMotion ? { opacity: 1 } : { opacity: 0 }}
            transition={{ duration: reduceMotion ? 0 : 0.16 }}
          >
            <FloorPlan
              seats={visible}
              mode={mode}
              view={view}
              activeZone={activeZone}
              focusedSeatCode={focusedSeatCode}
              selectedSeatCode={selectedSeatCode}
              crossfadeKey={`${activeDate}-${activeSlot}`}
              onFocusSeat={setFocusedSeatCode}
              onActivateSeat={onActivateSeat}
              showOccupancyLabels={showOccupancyLabels}
              showRoomLabels={showRoomLabels}
              className={view === "plan" ? "h-[clamp(26rem,70vh,50rem)] w-full" : undefined}
            />
          </motion.div>
        </AnimatePresence>
      )}

      <BookingDialog
        seat={intentSeat}
        date={activeDate}
        slot={activeSlot}
        slotDefinition={slots.find((s) => s.key === activeSlot) ?? null}
        now={clock.data?.now ?? null}
        cutoffMinutes={dates.data?.cutoffMinutes ?? 60}
        onClose={onCloseDialog}
      />
    </div>
  );
}
