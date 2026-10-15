#!/usr/bin/env python3
"""
CBVA Workspace -- floor plan build step.

Reads the architect's PDF and writes everything the app needs into
src/data/floorplan/. Run it through `npm run build:floorplan`, which also
rasterises the texture; this script on its own writes JSON and one SVG.

Nothing here is traced by hand. The drawing was plotted from AutoCAD 2021 and
kept all 44 CAD layers as PDF optional content groups, so every path knows the
layer it came from and we filter rather than guess.

What the layers turned out to mean, measured rather than assumed:

  W-WALL / K-WALL / P-FULLHEIGHT PARTITION / C- COLOUMN   the shell
  F-FURNITURE            47k paths, mostly the fine detail of desk assemblies
  F-FURNITURE HATCH      the hatched desktop surfaces
  0                      AutoCAD's default layer, and where the *chair* blocks
                         live -- block geometry drawn on layer 0 inherits the
                         insertion layer in CAD but plots as "0"
  F-LOOSE FURNITURE      loose chairs, mostly the passage runs and meeting rooms

Seat detection keys off the chair, not the desk, because there is exactly one
chair per seat and chairs do not touch each other, whereas desks in a 9-pax bay
are drawn as one continuous run and refuse to segment.

R009 (ADR-049, generator 5). The architect re-issued the layout on 17-06-2025
with every desk NUMBERED 1-158 on the plan and every bay tagged with a
circled letter A-T. That changes what the drawing is evidence of. Under R007
a seat was inferred -- a chair block, assigned to the nearest bay tag under a
capacity read off a PAX annotation, interpolated where the count came up
short -- and eleven of 141 could not be placed at all. Under R009 a seat is
STATED: the number is the architect's own desk identity, its position is the
architect's own label, and the chair block beside it supplies the facing. So
the number labels now drive placement and the chair detector only snaps
them; the bay tags and PAX annotations R007 relied on are gone from the
sheet, replaced by the letters and the numbers, and the PAX schedule in the
title block (which still uses the old bay names) is read as a cross-check
rather than as the source.

R009 is an A3 layout where R007 was an A2 model-space plot. cadparse fits it
onto the R007 frame, so every coordinate here is still in the frame the rest
of the product was built on.
"""
import argparse
import collections
import hashlib
import json
import math
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cadparse as C  # noqa: E402
from planmask import PlanMask, wedge_classifier  # noqa: E402
import texture  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
PDF = os.path.join(HERE, "CBVA - FURNITURE LAYOUT - R009 - 17-06-2025.pdf")
OUT = os.path.join(ROOT, "src", "data", "floorplan")

GENERATOR_VERSION = 5

# The shell. I-DOOR is deliberately absent: those are the swing arcs, and they
# are noise in 2D and wrong in 3D.
WALL_LAYERS = {
    "W-WALL", "K-WALL", "P-FULLHEIGHT PARTITION", "C- COLOUMN", "K-COLS",
    "I-WALL", "I-PART-FULL", "B- BEAM",
}
GLAZING_LAYERS = {"G-GLASS", "W-WINDOW"}

# Generator 3 splits the shell into three classes, because Phase 4 extrudes
# them at different heights and in different materials. Chaining runs PER
# CLASS, so a partition never welds itself onto a structural wall and inherit
# its height. Glazing was previously dropped entirely -- it only reached the
# baked texture -- because in 2D it is a line like any other. In 3D it is the
# difference between a room and a box.
#
# The budgets are per class so one noisy class cannot eat the allowance and
# silently truncate another. Generator 2's single budget was 400; the classes
# chain to 97 / 157 / 280 naturally, and truncating glazing to fit 400 threw
# away 45% of its length -- a curtain wall with holes in it. The 400 existed
# because SVGLoader and ExtrudeGeometry choke on CAD complexity; Phase 4
# extrudes these as merged segment boxes (ADR-030), where 534 chains is three
# draw calls and ~25k triangles. So the ceiling moves to 600 and stays honest.
#
# THE PARTITION FILTER (ADR-042). P-FULLHEIGHT PARTITION is 6,444 paths and
# 97% of them are not partitions. Measured from the PDF, by stroke colour:
#
#     #FF4405  5,012 paths  len 34,916  x 562-1263, y 355-996  (C and D only)
#     #0037DD  1,152 paths  len  1,473  a narrow vertical band
#     #000000    200 paths  len  9,347  x 169-1279, y 191-976  (whole floor)
#     #006EDD     52 paths  len    351
#     #8AB85C     28 paths  len    398  one 31x31 unit symbol
#
# The 200 black paths are the real full-height room dividers -- ~47 units each
# and spread over the whole floor. The orange is the dot fill of the solid
# rapid-rail benches, at 7 units a path; the blue is finer fill again. Flat on
# a drawing they are texture. Extruded to 1.35 m they are a thicket of walls
# through the middle of every workstation bay.
#
# The filter runs on the class's INPUT, not inside build_walls(): by the time
# that function is chaining, paths have been dissolved into an edge graph keyed
# only on coordinate and the colour is gone.
#
# Only the extruded shell filters. The baked texture still paints every colour
# on this layer -- it is the architect's drawing and nothing is deleted from
# it -- and planmask still rasterises the whole layer, because narrowing the
# flood fill's input would move interiorCoverage and with it coreCentre and
# every zone hull.
# Scoped to P-FULLHEIGHT PARTITION alone. I-PART-FULL is 12 paths stroked
# #595959, all of them real partition, and a blanket black test would drop
# them -- the colour key belongs to the one layer that carries a key.
#
# R009 re-keyed the layer. It is plotted colour-by-layer, every width is 0,
# and the 6,444 paths became 997 as the hatch segments were joined into
# polylines. Measured on the calibrated sheet against R007's 198 black
# partition paths:
#
#     #BF7FFF    333 paths  len 10,358   70% of vertices ON the R007 black
#                                        partitions, 3% on the bench fill
#     #FF4405     53 paths  len  6,122   83% on the bench fill (and painted
#                                        as fills, not strokes)
#     #0037DD    482 paths  len  1,474   100% bench fill
#     #006EDD    101 paths  len    564   51% bench fill
#     #8AB85C     28 paths  len    398   98% bench fill (the one symbol)
#
# So the real dividers are #BF7FFF on R009 and black on R007. Both are kept:
# the colour is the key, and the key is per sheet.
PARTITION_STROKES = {"#000000", "#BF7FFF"}


def real_partitions(path):
    if path.layer != "P-FULLHEIGHT PARTITION":
        return True
    return path.stroke_hex() in PARTITION_STROKES


WALL_CLASSES = (
    ("wall", {"W-WALL", "K-WALL", "C- COLOUMN", "K-COLS", "I-WALL", "B- BEAM"}, 150, None),
    ("partition", {"P-FULLHEIGHT PARTITION", "I-PART-FULL"}, 200, real_partitions),
    ("glazing", GLAZING_LAYERS, 300, None),
)

# ---------------------------------------------------------------------------
# STATIC FURNITURE (ADR-044)
#
# The renderer draws a mesh only where a BOOKABLE SEAT exists, so zones A and B
# -- a 25-person boardroom, four meeting rooms, two lounges, eight foldable
# tables on castors and a run of storage credenzas -- come out as bare floor.
# That is a rendering gap, not a data gap: there are no seats to add.
#
# So: massing for the furniture that is not a desk, from the drawing's own
# layers rather than modelled by hand.
#
#   F-LOOSE FURNITURE   A 1035  B 427   the soft furniture, and the tables
#   LANDSCAPE           A 3341  D 916   planters
#   I-FURN-MODU         B   67           zone B's modular furniture
#
# Each chain is reduced to its minimum-area ORIENTED bounding box. Massing, not
# outline extrusion: ExtrudeGeometry needs a simple closed shape and most of
# these chains are open polylines, which is the same reason ADR-030 gives for
# the walls. A slab is enough -- the baked drawing underneath already carries
# the real linework at full fidelity, so each box sits on its own drawn
# footprint and reads as the thing it covers.
#
# The one non-obvious rule is the size split inside F-LOOSE FURNITURE. A
# boardroom table and a visitor's chair are the same layer and want different
# heights, and the drawing does not label them. 40 plan units (2.82 m) is the
# threshold: nothing anybody sits ON is that long, and every table in zones A
# and B is longer. It is a guess about height only -- see ASSUMPTIONS A23.
FURNITURE_TABLE_UNITS = 40.0

FURNITURE_CLASSES = (
    ("loose", {"F-LOOSE FURNITURE"}, 600),
    ("planter", {"LANDSCAPE"}, 300),
    ("modular", {"I-FURN-MODU"}, 100),
)

PAX_RE = re.compile(r"^(\d+)\s*PAX\.?$", re.I)
DESK_RE = re.compile(r"^\d{1,3}$")
LETTER_RE = re.compile(r"^[A-T]$")

# THE BAY SCHEDULE, R009. Twenty bays, each a circled letter on the plan, in
# the order the architect numbered the desks: A holds desks 1-4, B 5-8, C
# 9-25 and so on through T, 143-158. The counts are what the plan shows --
# exactly that many numbered desks sit beside each letter, verified by the
# build below -- and they are what src/lib/seed-data/inventory.ts encodes, so
# the two are asserted against each other rather than one trusted.
#
# The title block still lists the bays under the R007 names (A1, D1-D8,
# PASSAGE, C1-C7, B1, B2) and sums them to 158. Those names are not on the
# plan any more; the letters are. The plan is what a person standing on the
# floor can see, so the letters are the bay vocabulary (ASSUMPTIONS A32).
SCHEDULE = {
    "A": 4, "B": 4,
    "C": 17,
    "D": 6, "E": 4, "F": 9, "G": 9, "H": 9, "I": 9, "J": 4,
    "K": 9, "L": 9, "M": 9, "N": 9, "O": 1, "P": 4, "Q": 4, "R": 4,
    "S": 18, "T": 16,
}

# First desk number of each bay: the numbering is contiguous in schedule
# order, which is the property the build checks before it believes it.
BAY_FIRST = {}
_n = 1
for _bay, _count in SCHEDULE.items():
    BAY_FIRST[_bay] = _n
    _n += _count
del _n, _bay, _count

# Which wing each bay sits in. The wings keep the R007 zone letters A-D
# (zone A: cabins and the meeting rooms; B: the former flexible room, now 17
# workstations; C and D: the two open wings) because the whole product keys
# on them. The bay LETTERS are the architect's and the ZONE letters are the
# architect's too, from a different revision -- bay C is in zone B. That is
# awkward to read and correct to keep: renaming either would mean inventing
# a label the drawing does not carry.
BAY_ZONE = {}
for _bay in SCHEDULE:
    if _bay in ("A", "B"):
        BAY_ZONE[_bay] = "A"
    elif _bay == "C":
        BAY_ZONE[_bay] = "B"
    elif _bay in ("D", "E", "F", "G", "H", "I", "J", "T"):
        BAY_ZONE[_bay] = "C"
    else:
        BAY_ZONE[_bay] = "D"
del _bay

# A desk label is snapped to the chair block drawn for it when one lies
# within this many plan units (22 units = 1.55 m). Measured on R009: 150 of
# the 158 labels have a chair within 10 units; the eight executive desks in
# bays A and B have theirs 17-20 units away, across a wider desk; no label is
# further than 20.3 from a chair, and no chair is nearest to two labels.
SNAP_UNITS = 22.0

# R009 dropped the four 52 pt zone letters R007 set on the drawing, which is
# what `build_zones` aimed its wedges at. These are those letters' positions
# as the R007 build recorded them in zones.json, retained so the wings keep
# exactly the outlines they had. Used only when the sheet carries no letters.
ZONE_ANCHORS_R007 = {
    "A": (186.77, 995.40),
    "B": (195.11, 205.83),
    "C": (1291.46, 218.16),
    "D": (1301.57, 995.40),
}

# R009 also dropped zone A's room tags (A3-A9) and their PAX annotations.
# The rooms themselves are unchanged -- the shell is identical and the
# boardroom chairs are still drawn -- so the schedule R007 stated is carried
# forward verbatim, flagged in the report as carried rather than read
# (ASSUMPTIONS A33). Used only when the sheet carries no room tags.
ROOMS_R007 = [
    {"bayCode": "A3", "pax": 25, "planX": 386.09, "planY": 767.46},
    {"bayCode": "A4", "pax": None, "planX": 223.13, "planY": 889.47},
    {"bayCode": "A5", "pax": None, "planX": 112.25, "planY": 861.57},
    {"bayCode": "A6", "pax": 5, "planX": 188.84, "planY": 692.01},
    {"bayCode": "A7", "pax": 5, "planX": 242.36, "planY": 638.49},
    {"bayCode": "A8", "pax": 7, "planX": 285.32, "planY": 595.59},
    {"bayCode": "A9", "pax": 10, "planX": 443.03, "planY": 625.65},
]


# --------------------------------------------------------------------------
# geometry helpers
# --------------------------------------------------------------------------

def dist2(a, b):
    return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2


def rdp(points, eps):
    """Ramer-Douglas-Peucker."""
    if len(points) < 3:
        return points
    ax, ay = points[0]
    bx, by = points[-1]
    dx, dy = bx - ax, by - ay
    norm = math.hypot(dx, dy)
    worst, wi = -1.0, 0
    for i in range(1, len(points) - 1):
        px, py = points[i]
        if norm < 1e-9:
            d = math.hypot(px - ax, py - ay)
        else:
            d = abs(dy * px - dx * py + bx * ay - by * ax) / norm
        if d > worst:
            worst, wi = d, i
    if worst <= eps:
        return [points[0], points[-1]]
    return rdp(points[:wi + 1], eps)[:-1] + rdp(points[wi:], eps)


def drop_collinear(points, tol_deg=0.5):
    if len(points) < 3:
        return points
    out = [points[0]]
    for i in range(1, len(points) - 1):
        ax, ay = out[-1]
        bx, by = points[i]
        cx, cy = points[i + 1]
        a1 = math.atan2(by - ay, bx - ax)
        a2 = math.atan2(cy - by, cx - bx)
        if abs(math.degrees(a2 - a1)) % 180.0 > tol_deg:
            out.append(points[i])
    out.append(points[-1])
    return out


def oriented_box(points):
    """
    Minimum-area oriented bounding box, by rotating calipers over the polygon's
    own edge directions. Returns (cx, cy, w, h, deg) or None.

    Axis-aligned boxes are wrong here: this building is a cruciform and its two
    side wings are drawn at 45 degrees, so an axis-aligned box round a sofa in
    zone B is half again too big and points the wrong way.
    """
    if len(points) < 2:
        return None
    best = None
    seen = set()
    for i in range(len(points)):
        ax, ay = points[i]
        bx, by = points[(i + 1) % len(points)]
        dx, dy = bx - ax, by - ay
        if math.hypot(dx, dy) < 1e-6:
            continue
        a = round(math.atan2(dy, dx) % math.pi, 4)
        if a in seen:
            continue
        seen.add(a)
        c, sn = math.cos(-a), math.sin(-a)
        us = [(x * c - y * sn, x * sn + y * c) for x, y in points]
        x0 = min(u[0] for u in us); x1 = max(u[0] for u in us)
        y0 = min(u[1] for u in us); y1 = max(u[1] for u in us)
        area = (x1 - x0) * (y1 - y0)
        if best is None or area < best[0]:
            cx, cy = (x0 + x1) / 2.0, (y0 + y1) / 2.0
            c2, s2 = math.cos(a), math.sin(a)
            best = (area, cx * c2 - cy * s2, cx * s2 + cy * c2,
                    x1 - x0, y1 - y0, math.degrees(a))
    return best[1:] if best else None


def build_furniture(paths, mask):
    """Static furniture massing: one oriented box per chained outline."""
    out = []
    for name, layers, budget in FURNITURE_CLASSES:
        chains = build_walls(paths, layers=layers, snap=1.0, simplify=1.0,
                             min_length=6.0, max_polys=100000)
        boxes = []
        for ch in chains:
            box = oriented_box(ch["points"])
            if box is None:
                continue
            cx, cy, w, h, deg = box
            # Outside the shell is the sheet's legend and title block.
            if not mask.contains(cx, cy):
                continue
            # Sub-100 mm slivers are linework, not furniture.
            if w < 2.0 or h < 2.0:
                continue
            kind = name
            if name == "loose":
                kind = "table" if max(w, h) >= FURNITURE_TABLE_UNITS else "seating"
            boxes.append({
                "kind": kind,
                "x": round(cx, 2), "y": round(cy, 2),
                "w": round(w, 2), "h": round(h, 2),
                "rotationDeg": round(deg % 180.0, 1),
            })
        if len(boxes) > budget:
            raise SystemExit(
                f"furniture class {name} produced {len(boxes)} boxes (budget {budget})")
        out.extend(boxes)
        print(f"  furniture {name}: {len(boxes)} boxes (budget {budget})",
              file=sys.stderr)
    out.sort(key=lambda b: (b["kind"], b["x"], b["y"]))
    return out


# --------------------------------------------------------------------------
# walls
# --------------------------------------------------------------------------

def is_hatch(points, min_points=6, reversal_share=0.8):
    """
    A chain that doubles back on itself at nearly every vertex is a hatch fill,
    not a wall.

    Generator 2 shipped one of these as the LONGEST polygon in walls.json: 61
    points and 971 plan units of 45-degree zig-zag inside a 35-unit box, in
    zone A. Flat on the drawing it is invisible; extruded it is a thicket.

    Measured over all 252 polygons the two populations do not overlap. That
    chain reverses at 100% of its vertices; the five longest real walls
    (598-908 units) reverse at 0-40%. Short three-point "out and back" stubs
    are left alone -- as extruded ribbons they harmlessly overlap themselves,
    and they are real wall.
    """
    if len(points) < min_points:
        return False
    total = reversals = 0
    for a, b, c in zip(points, points[1:], points[2:]):
        ux, uy = b[0] - a[0], b[1] - a[1]
        vx, vy = c[0] - b[0], c[1] - b[1]
        lu, lv = math.hypot(ux, uy), math.hypot(vx, vy)
        if lu < 1e-9 or lv < 1e-9:
            continue
        total += 1
        if (ux * vx + uy * vy) / (lu * lv) < -0.7:   # turn sharper than 135 deg
            reversals += 1
    return total > 0 and reversals / total >= reversal_share


def build_walls(paths, layers=WALL_LAYERS, snap=1.0, simplify=1.2,
                min_length=10.0, max_polys=400, keep=None):
    """
    The raw wall layers are 8,603 paths of CAD noise. Chain them into
    polylines and simplify hard: Phase 4 extrudes these, and SVGLoader chokes
    on unsimplified CAD geometry.
    """
    def key(p):
        return (round(p[0] / snap), round(p[1] / snap))

    adj = collections.defaultdict(set)
    coords = {}
    seen = set()
    for p in paths:
        if p.layer not in layers:
            continue
        if keep is not None and not keep(p):
            continue
        for sp in p.subpaths:
            for a, b in zip(sp, sp[1:]):
                ka, kb = key(a), key(b)
                if ka == kb:
                    continue
                e = (ka, kb) if ka < kb else (kb, ka)
                if e in seen:
                    continue
                seen.add(e)
                coords.setdefault(ka, (ka[0] * snap, ka[1] * snap))
                coords.setdefault(kb, (kb[0] * snap, kb[1] * snap))
                adj[ka].add(kb)
                adj[kb].add(ka)

    used = set()
    polys = []

    def walk(start, first):
        chain = [start, first]
        used.add((start, first) if start < first else (first, start))
        while True:
            cur, prev = chain[-1], chain[-2]
            nxt = None
            for cand in adj[cur]:
                if cand == prev:
                    continue
                e = (cur, cand) if cur < cand else (cand, cur)
                if e in used:
                    continue
                nxt = cand
                break
            if nxt is None:
                break
            used.add((cur, nxt) if cur < nxt else (nxt, cur))
            chain.append(nxt)
            if nxt == start:
                break
        return chain

    # start from junctions and endpoints first so chains break sensibly
    order = sorted(adj, key=lambda k: (len(adj[k]) == 2, k))
    for node in order:
        for nb in list(adj[node]):
            e = (node, nb) if node < nb else (nb, node)
            if e in used:
                continue
            chain = walk(node, nb)
            pts = [coords[k] for k in chain]
            pts = drop_collinear(pts)
            if len(pts) > 2:
                pts = rdp(pts, simplify)
            if len(pts) < 2:
                continue
            length = sum(math.dist(a, b) for a, b in zip(pts, pts[1:]))
            if length < min_length:
                continue
            if is_hatch(pts):
                continue
            closed = math.dist(pts[0], pts[-1]) < snap * 2
            polys.append({"points": pts, "length": length, "closed": closed})

    polys.sort(key=lambda p: -p["length"])
    if len(polys) > max_polys:
        polys = polys[:max_polys]
    return polys


# --------------------------------------------------------------------------
# seat detection
# --------------------------------------------------------------------------

CHAIR_LAYERS = ("0", "F-LOOSE FURNITURE", "I-FURN-MODU")


def find_chairs(paths, mask=None):
    """
    Chair blocks: 7-point closed polylines with a 6-10.5pt bounding box. That
    is the repeated block AutoCAD emitted for a task chair, at every one of the
    wing rotations. Verified by shape-hashing: the top eight normalised shapes
    in the drawing are all this footprint.
    """
    out = []
    for p in paths:
        if p.layer not in CHAIR_LAYERS:
            continue
        for sp in p.subpaths:
            if len(sp) != 7:
                continue
            xs = [q[0] for q in sp]
            ys = [q[1] for q in sp]
            w, h = max(xs) - min(xs), max(ys) - min(ys)
            if not (6.0 <= w <= 10.5 and 6.0 <= h <= 10.5):
                continue
            cx, cy = (max(xs) + min(xs)) / 2.0, (max(ys) + min(ys)) / 2.0
            if mask is not None and not mask.contains(cx, cy):
                continue
            # facing: from the polygon centroid towards the midpoint of its
            # longest edge -- the chair's back, consistently, for every
            # rotation of the same block.
            best, bmid = -1.0, (cx, cy)
            for a, b in zip(sp, sp[1:]):
                d = math.dist(a, b)
                if d > best:
                    best, bmid = d, ((a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0)
            gx = sum(xs[:-1]) / 6.0
            gy = sum(ys[:-1]) / 6.0
            facing = math.degrees(math.atan2(bmid[1] - gy, bmid[0] - gx)) % 360.0
            out.append({"x": cx, "y": cy, "facing": facing, "layer": p.layer,
                        "w": w, "h": h})

    # the same chair is often stroked twice
    out.sort(key=lambda c: (c["x"], c["y"]))
    dedup = []
    for c in out:
        if any(dist2((c["x"], c["y"]), (d["x"], d["y"])) < 9.0 for d in dedup[-60:]):
            continue
        dedup.append(c)
    return dedup


def desk_labels(spans):
    """
    The architect's desk numbers: every `1`..`158` set on the plan, once each.

    They sit on layer 0 and F-FURNITURE TEXT at 2.8 pt. Anything else that is
    a bare integer inside the plan box -- there is nothing on R009, and the
    build fails rather than guesses if a revision adds some -- would collide
    with a desk number, so the check is for the exact set, not a count.
    """
    labels = {}
    dup = []
    for s in spans:
        if not s.in_plan or s.layer not in ("0", "F-FURNITURE TEXT"):
            continue
        t = s.text.strip()
        if not DESK_RE.match(t):
            continue
        n = int(t)
        if n in labels:
            dup.append(n)
        labels[n] = (s.x, s.y)
    want = set(range(1, sum(SCHEDULE.values()) + 1))
    if dup or set(labels) != want:
        raise SystemExit(
            f"desk number labels do not read 1..{len(want)} exactly once: "
            f"missing {sorted(want - set(labels))[:10]}, "
            f"extra {sorted(set(labels) - want)[:10]}, duplicated {sorted(set(dup))[:10]}"
        )
    return labels


def bay_letters(spans):
    """The circled bay letters A-T on F-FURNITURE TEXT, exactly the schedule's."""
    found = {}
    for s in spans:
        if s.in_plan and s.layer == "F-FURNITURE TEXT" and LETTER_RE.match(s.text.strip()):
            if s.text.strip() in found:
                raise SystemExit(f"bay letter {s.text.strip()} appears twice on the plan")
            found[s.text.strip()] = (s.x, s.y)
    if set(found) != set(SCHEDULE):
        raise SystemExit(
            f"bay letters on the plan {sorted(found)} are not the schedule's "
            f"{sorted(SCHEDULE)}"
        )
    return found


def check_numbering(labels, letters):
    """
    The build's one inference, and its proof.

    Desk numbers are assigned to bays by contiguous range in schedule order
    (A = 1-4, B = 5-8, ...). That is a claim about how the architect counted,
    so it is checked against the plan: the centroid of every range must be
    nearer its own bay letter than any other letter. On R009 the nearest other
    letter is at least 60 units further in every case; a revision that
    renumbers will fail here, loudly, with the bay named.
    """
    for bay, first in BAY_FIRST.items():
        rng = range(first, first + SCHEDULE[bay])
        cx = sum(labels[n][0] for n in rng) / len(rng)
        cy = sum(labels[n][1] for n in rng) / len(rng)
        ranked = sorted(letters, key=lambda L: math.hypot(letters[L][0] - cx, letters[L][1] - cy))
        if ranked[0] != bay:
            raise SystemExit(
                f"desks {rng.start}-{rng.stop - 1} were expected to be bay {bay} but "
                f"their centroid is nearest letter {ranked[0]}; the numbering is "
                f"not contiguous in schedule order any more"
            )


def snap_to_chairs(labels, chairs, max_dist=SNAP_UNITS):
    """
    Pair each desk label with the chair block drawn for it: globally nearest
    first, each chair claimed once, within `max_dist`. Returns {n: chair_index}.
    Labels left unpaired are placed on the label itself, and reported.
    """
    pairs = []
    for n, (lx, ly) in labels.items():
        for ci, c in enumerate(chairs):
            d = math.hypot(c["x"] - lx, c["y"] - ly)
            if d <= max_dist:
                pairs.append((d, n, ci))
    pairs.sort()
    taken, used = {}, set()
    for d, n, ci in pairs:
        if n in taken or ci in used:
            continue
        taken[n] = ci
        used.add(ci)
    return taken


def place_seats(labels, chairs):
    """
    One seat per desk number, in number order. Position and facing come from
    the snapped chair block; a label with no chair within SNAP_UNITS keeps the
    label's own position, takes the facing of its nearest bay-mate, and is
    marked `interpolated` so the editor surfaces it.
    """
    snapped = snap_to_chairs(labels, chairs)
    seats, report = [], []
    for bay, first in BAY_FIRST.items():
        rng = range(first, first + SCHEDULE[bay])
        facings = [chairs[snapped[n]]["facing"] for n in rng if n in snapped]
        detected = made = 0
        for n in rng:
            if n in snapped:
                c = chairs[snapped[n]]
                x, y, facing, source = c["x"], c["y"], c["facing"], "detected"
                detected += 1
            else:
                x, y = labels[n]
                facing = facings[0] if facings else 0.0
                source = "interpolated"
                made += 1
            seats.append({
                "seatCode": str(n),
                "bay": bay,
                "zone": BAY_ZONE[bay],
                "planX": round(x, 2),
                "planY": round(y, 2),
                "rotationDeg": int(round(facing)) % 360,
                "source": source,
            })
        report.append({
            "bay": bay, "zone": BAY_ZONE[bay], "expected": SCHEDULE[bay],
            # Every desk in the bay is numbered on the plan, so the drawing
            # states the count directly; there is no PAX annotation to pair.
            "drawingPax": SCHEDULE[bay],
            "detected": detected, "placed": len(rng),
            "interpolated": made, "surplusDropped": 0,
        })
    return seats, report, set(snapped.values())


ROOM_TAG_RE = re.compile(r"^A[3-9]$")


def room_labels(spans):
    """
    Zone A's room tags and their PAX, read off the sheet when it carries them.

    R007 did: every tag paired to a PAX annotation within 33 plan units
    (A3 -> 25, A9 -> 10, A8 -> 7, A7 -> 5, A6 -> 5; A4 and A5 none). R009 does
    not -- the tags and the room PAX were dropped with the rest of the
    annotation -- so this returns None and the caller falls back to ROOMS_R007.
    Never feeds seat detection either way.
    """
    spans = [s for s in spans if s.in_plan]
    tags = {}
    for s in spans:
        t = s.text.strip()
        if ROOM_TAG_RE.match(t) and s.layer == "F-FURNITURE TEXT":
            tags[t] = (s.x, s.y)
    if not tags:
        return None

    pax = []
    for s in spans:
        m = PAX_RE.match(s.text.strip())
        if m:
            pax.append((int(m.group(1)), s.x, s.y))

    out, used = [], set()
    for tag in sorted(tags):
        tx, ty = tags[tag]
        best, bi = None, None
        for i, (n, px, py) in enumerate(pax):
            if i in used:
                continue
            d = math.hypot(px - tx, py - ty)
            if d < 35.0 and (best is None or d < best):
                best, bi = d, i
        n = None
        if bi is not None:
            used.add(bi)
            n = pax[bi][0]
        out.append({"bayCode": tag, "pax": n,
                    "planX": round(tx, 2), "planY": round(ty, 2)})
    return out


SHEET_TOTAL_RE = re.compile(r"TOTAL WORKING PEOPLE", re.I)
PAX_ONLY_RE = re.compile(r"^(\d+)\s*PAX\.?$", re.I)
SCHEDULE_ROW_RE = re.compile(r"^(\d+)\.\s*(.+?)\s*=\s*(?:(\d+)\s*PAX)?\.?$", re.I)


def sheet_headcount(spans):
    """
    The drawing's own headline figure, from the title block:

        TOTAL WORKING PEOPLE =   158 PAX
        NOTE: CONFERENCE AREA AND CAFETERIA NOT INCLUDED.

    An independent confirmation of the schedule total, in the client's own
    words, with the reason the boardroom and conference rooms are not in it.
    """
    label = next((s for s in spans if SHEET_TOTAL_RE.search(s.text)), None)
    if label is None:
        return None, None
    # The figure is set as a separate run on the same baseline.
    best, total = None, None
    for s in spans:
        m = PAX_ONLY_RE.match(s.text)
        if not m or abs(s.y - label.y) > 3.0 or s.x < label.x:
            continue
        d = s.x - label.x
        if best is None or d < best:
            best, total = d, int(m.group(1))
    note = next(
        (s.text for s in spans if "NOT INCLUDED" in s.text.upper()), None
    )
    return total, note


def sheet_schedule(spans):
    """
    The bay schedule as the title block states it: `N. NAME = K PAX` rows,
    with the figure either in the same text run or in a second run on the
    same baseline. On R009 the rows above TOTAL WORKING PEOPLE still use the
    R007 bay names (A1, D1-D8, PASSAGE, C1-C7, B1, B2); the rows below it are
    the headcount by grade. Both are returned, in sheet order, so the report
    can show that the sheet's own arithmetic reaches the same 158 the plan's
    numbered desks do -- by a different grouping (ASSUMPTIONS A32).
    """
    rows = []
    off_plan = [s for s in spans if not s.in_plan and s.layer == "F-FURNITURE TEXT"]
    for s in off_plan:
        m = SCHEDULE_ROW_RE.match(s.text.strip())
        if not m:
            continue
        value = m.group(3)
        if value is None:
            same_line = [q for q in off_plan
                         if abs(q.y - s.y) < 2.0 and q.x > s.x
                         and PAX_ONLY_RE.match(q.text.strip())]
            if same_line:
                q = min(same_line, key=lambda q: q.x)
                value = PAX_ONLY_RE.match(q.text.strip()).group(1)
        rows.append({"label": m.group(2).strip(),
                     "pax": int(value) if value is not None else None,
                     "y": s.y})
    rows.sort(key=lambda r: r["y"])
    return [{"label": r["label"], "pax": r["pax"]} for r in rows]


# --------------------------------------------------------------------------
# zones
# --------------------------------------------------------------------------

def hull(points):
    pts = sorted(set(points))
    if len(pts) < 3:
        return pts

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    lower = []
    for p in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    upper = []
    for p in reversed(pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    return lower[:-1] + upper[:-1]


def zone_containing(zones, x, y):
    """Which wing a point falls in, or None."""
    for zone in zones:
        poly = zone["polygon"]
        n, inside_poly, j = len(poly), False, len(poly) - 1
        for i in range(n):
            xi, yi = poly[i]
            xj, yj = poly[j]
            if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi + 1e-12) + xi:
                inside_poly = not inside_poly
            j = i
        if inside_poly:
            return zone["code"]
    return None


def build_zones(mask, spans, seats):
    """
    Wing outlines for zone highlighting and hit testing, taken from the
    building interior rather than from the raw linework, and split into
    angular wedges aimed at the four 52pt zone letters the architect set on
    the drawing -- so the split is the architect's, not ours.

    R009 carries no zone letters, so the wedges aim at the positions R007's
    letters had (ZONE_ANCHORS_R007), which keeps every wing outline where it
    was. A sheet that DOES carry four big letters wins over the constants.
    """
    letters = {}
    for s_ in (s for s in spans if s.in_plan):
        if s_.text in ("A", "B", "C", "D") and s_.size > 30:
            letters[s_.text] = (s_.x, s_.y)
    if not letters:
        letters = dict(ZONE_ANCHORS_R007)
        print("  zone letters: none on this sheet; wedges aimed at the R007 "
              "anchors", file=sys.stderr)
    if len(letters) != 4:
        raise SystemExit(f"expected four zone letters, found {sorted(letters)}")

    pts = mask.inside_points(step=2)
    cx = sum(p[0] for p in pts) / len(pts)
    cy = sum(p[1] for p in pts) / len(pts)
    classify = wedge_classifier((cx, cy), letters)

    buckets = collections.defaultdict(list)
    for (x, y) in pts:
        buckets[classify(x, y)].append((round(x, 1), round(y, 1)))
    for s_ in seats:
        buckets[s_["zone"]].append((round(s_["planX"], 1), round(s_["planY"], 1)))

    out = []
    for code in ("A", "B", "C", "D"):
        pl = buckets.get(code, [])
        if not pl:
            continue
        out.append({
            "code": code,
            "labelAnchor": [round(letters[code][0], 2), round(letters[code][1], 2)],
            "polygon": [[round(x, 2), round(y, 2)] for x, y in hull(pl)],
        })
    return out, (cx, cy)


# --------------------------------------------------------------------------
# scale
# --------------------------------------------------------------------------

PT_MM = 25.4 / 72.0
PLOT_SCALES = (50, 75, 100, 150, 200, 250, 500)
NOMINAL_CHAIR_MM = 600.0     # plan footprint of a task chair
NOMINAL_PITCH_MM = 1500.0    # workstation pitch along a bench run


def derive_scale(chairs):
    """
    The drawing carries no dimension text we can read, so the scale is
    recovered by asking which standard architectural plot scale makes the two
    things we *did* measure come out to believable millimetres: the chair block
    footprint and the median chair-to-chair spacing along a bench run.

    Only one candidate is close on both, and it is not close by a little.
    """
    if not chairs:
        return None, "no chairs detected"
    chair_pt = sum((c["w"] + c["h"]) / 2.0 for c in chairs) / len(chairs)

    spacing = []
    for i, a in enumerate(chairs):
        best = None
        for j, b in enumerate(chairs):
            if i == j:
                continue
            d = math.dist((a["x"], a["y"]), (b["x"], b["y"]))
            if 4.0 < d < 60.0 and (best is None or d < best):
                best = d
        if best is not None:
            spacing.append(best)
    if not spacing:
        return None, "chair spacing could not be measured"
    spacing.sort()
    pitch_pt = spacing[len(spacing) // 2]

    scored = []
    for s in PLOT_SCALES:
        mm = PT_MM * s
        err = (abs(chair_pt * mm - NOMINAL_CHAIR_MM) / NOMINAL_CHAIR_MM
               + abs(pitch_pt * mm - NOMINAL_PITCH_MM) / NOMINAL_PITCH_MM) / 2.0
        scored.append((err, s, mm))
    scored.sort()
    err, best, mm = scored[0]
    runner = scored[1]
    note = (f"chair block {chair_pt:.2f}pt, median workstation pitch "
            f"{pitch_pt:.2f}pt; best fit 1:{best} gives a "
            f"{chair_pt * mm:.0f}mm chair and a {pitch_pt * mm:.0f}mm pitch "
            f"({err * 100:.0f}% mean deviation from nominal), next-best "
            f"1:{runner[1]} is {runner[0] * 100:.0f}% out")
    if err > 0.25:
        return None, note + " -- no plot scale fits well enough to publish"
    return round(mm, 4), note


# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pdf", default=PDF)
    ap.add_argument("--out", default=OUT)
    ap.add_argument("--max-walls", type=int, default=600)
    ap.add_argument("--palette", choices=["true", "muted"], default="muted",
                    help="muted pulls the drawing's colours towards the app "
                         "palette; true is the contractor's sheet verbatim")
    ap.add_argument("--raster-widths", default="2048,4096",
                    help="one SVG is written per width, because a PDF stroke "
                         "width of 0 means one DEVICE PIXEL and 62%% of this "
                         "drawing is zero-width")
    ap.add_argument("--audit", action="store_true",
                    help="verify nothing is silently lost; non-zero exit on "
                         "failure. Run by npm run build:floorplan.")
    a = ap.parse_args()

    with open(a.pdf, "rb") as fh:
        raw = fh.read()
    checksum = hashlib.sha256(raw).hexdigest()

    print(f"reading {os.path.basename(a.pdf)} ...", file=sys.stderr)
    paths, spans, images = C.read(raw, want_images=True)
    print(f"  {len(paths)} paths, {len(spans)} text spans, "
          f"{len(images)} placed bitmaps", file=sys.stderr)

    mask = PlanMask(paths)
    print(f"  building interior: {mask.coverage * 100:.1f}% of the plan box",
          file=sys.stderr)

    if a.audit:
        print()
        failures = texture.audit(paths, images, mask,
                                 C.hidden_layers(raw), mask.coverage)
        if failures:
            print()
            print("AUDIT FAILED")
            for f in failures:
                print(f"  FAIL: {f}")
            raise SystemExit(1)
        print()
        print("AUDIT PASSED")
        raise SystemExit(0)

    os.makedirs(a.out, exist_ok=True)

    # ---- walls, one chained run per class
    walls = []
    for name, layers, budget, keep in WALL_CLASSES:
        got = build_walls(paths, layers=layers, max_polys=budget, keep=keep)
        if len(got) > budget:
            raise SystemExit(f"{name} simplification produced {len(got)} polygons")
        for w in got:
            w["layer"] = name
        walls.extend(got)
        print(f"  {name}: {len(got)} polygons (budget {budget})", file=sys.stderr)
    if len(walls) > a.max_walls:
        raise SystemExit(f"wall simplification produced {len(walls)} polygons")
    print(f"  walls: {len(walls)} polygons", file=sys.stderr)

    # ---- static furniture, one oriented box per chained outline
    furniture = build_furniture(paths, mask)
    print(f"  furniture: {len(furniture)} boxes", file=sys.stderr)

    # ---- the architect's desk numbers and bay letters
    labels = desk_labels(spans)
    letters = bay_letters(spans)
    check_numbering(labels, letters)
    print(f"  desk numbers 1-{len(labels)} and bay letters "
          f"{''.join(sorted(letters))} read off the plan", file=sys.stderr)

    # ---- the sheet's own total, and its schedule under the old bay names
    sheet_total, sheet_note = sheet_headcount(spans)
    if sheet_total is not None and sheet_total != sum(SCHEDULE.values()):
        raise SystemExit(
            f"the drawing's title block says {sheet_total} working people but "
            f"the bay schedule sums to {sum(SCHEDULE.values())}"
        )
    schedule_rows = sheet_schedule(spans)
    # Rows above the total are bays; the grade headcount below it starts
    # again at "1. PARTNER". Both groups must reach the plan's total on their
    # own, or the sheet disagrees with itself.
    bay_rows, grade_rows, seen_total = [], [], False
    for row in schedule_rows:
        if row["label"].upper() == "PARTNER":
            seen_total = True
        (grade_rows if seen_total else bay_rows).append(row)
    for name, rows in (("bay", bay_rows), ("grade", grade_rows)):
        total = sum(r["pax"] or 0 for r in rows)
        if rows and total != sum(SCHEDULE.values()):
            raise SystemExit(
                f"the title block's {name} schedule sums to {total}, not "
                f"{sum(SCHEDULE.values())}: {rows}"
            )
    print(f"  title block: {len(bay_rows)} bay rows and {len(grade_rows)} grade "
          f"rows, both summing to {sheet_total}", file=sys.stderr)

    # ---- zone A's room schedule, kept apart from seat detection
    rooms = room_labels(spans)
    rooms_from_sheet = rooms is not None
    if rooms is None:
        rooms = [dict(r) for r in ROOMS_R007]
        print("  zone A rooms: no tags on this sheet; carrying the R007 "
              "schedule forward (A33)", file=sys.stderr)
    print("  zone A rooms: " + ", ".join(
        f"{r['bayCode']}={r['pax'] if r['pax'] is not None else '-'}" for r in rooms),
        file=sys.stderr)

    # ---- chairs, and the desks snapped onto them
    chairs = find_chairs(paths, mask)
    print(f"  chair blocks: {len(chairs)}", file=sys.stderr)

    seats, report, used_chairs = place_seats(labels, chairs)
    unassigned = [c for i, c in enumerate(chairs) if i not in used_chairs]
    drift = {}
    unconfirmed = []

    # ---- hand corrections outrank the drawing
    #
    # ADR-017 makes seats.json the source of truth for seat geometry, and
    # /admin/floor-plan writes corrections back into it marked `manual`. Until
    # Phase 7 this step did not exist, so `npm run build:floorplan` regenerated
    # every anchor from the PDF and silently discarded every one of them.
    #
    # That is the Phase 6 trap in its other direction. There, a hand fix run
    # once outside the pipeline was reverted by the next rebuild and the gate
    # said nothing because it compared two builds to each other. Here a hand
    # fix made in the editor -- the ONLY way A24 can actually be closed, because
    # the drawing genuinely does not say where those eleven chairs are -- would
    # have been reverted by the next rebuild just as quietly.
    #
    # So a `manual` anchor is preserved verbatim: position, rotation and flag.
    # It is a human who knows the floor overruling an inference, which is the
    # whole point of the editor existing. `detected` and `interpolated` anchors
    # are always regenerated, because those ARE the drawing's own answer.
    manual = {}
    seats_path = os.path.join(a.out, "seats.json")
    if os.path.exists(seats_path):
        try:
            with open(seats_path, encoding="utf-8") as fh:
                for row in json.load(fh).get("seats", []):
                    if row.get("source") == "manual":
                        manual[row["seatCode"]] = row
        except (ValueError, KeyError) as exc:
            raise SystemExit(
                f"could not read existing {seats_path} to preserve manual "
                f"anchors: {exc}. Refusing to overwrite it -- a corrupt file "
                f"here would silently discard hand corrections."
            )
    if manual:
        kept = 0
        for seat in seats:
            saved = manual.get(seat["seatCode"])
            if saved:
                seat["planX"] = saved["planX"]
                seat["planY"] = saved["planY"]
                seat["rotationDeg"] = saved["rotationDeg"]
                seat["source"] = "manual"
                kept += 1
        print(f"  preserved {kept} manual anchor(s) from the committed file",
              file=sys.stderr)
        orphans = set(manual) - {s["seatCode"] for s in seats}
        if orphans:
            raise SystemExit(
                f"manual anchors exist for seat codes the schedule no longer "
                f"has: {sorted(orphans)}. A correction would be lost silently."
            )

    seats_by_zone = collections.defaultdict(int)
    for s in seats:
        seats_by_zone[s["zone"]] += 1
    zones, centre = build_zones(mask, spans, seats)

    # Chairs no desk snapped onto, counted per zone against the real wing
    # polygons. Most are meeting room and lounge seating, which is why this is
    # broken out by zone rather than reported as one number: zone A's surplus
    # is its 25/10/7/5/5-pax rooms and the reception lounge; zone B's is the
    # modular lounge seating beside its 17 numbered workstations.
    unassigned_by_zone = collections.Counter()
    for c in unassigned:
        code = zone_containing(zones, c["x"], c["y"])
        unassigned_by_zone[code or "outside"] += 1
    zone_b_chairs = unassigned_by_zone.get("B", 0)
    zone_b_expected = sum(n for b, n in SCHEDULE.items() if BAY_ZONE[b] == "B")

    mm_per_unit, scale_note = derive_scale(chairs)

    x0, y0, x1, y1 = C.PLAN_BOX
    meta = {
        "generatorVersion": GENERATOR_VERSION,
        "source": os.path.basename(a.pdf),
        "sourceSha256": checksum,
        "planBounds": {"x": x0, "y": y0, "width": x1 - x0, "height": y1 - y0},
        "viewBox": f"{x0:g} {y0:g} {x1 - x0:g} {y1 - y0:g}",
        "coreCentre": [round(centre[0], 2), round(centre[1], 2)],
        "mmPerUnit": mm_per_unit,
        "scaleNote": scale_note,
        "texture": {
            "2048": "/floorplan/plan-texture-2048.webp",
            "4096": "/floorplan/plan-texture-4096.webp",
        },
        "counts": {
            "seats": len(seats),
            "wallPolygons": len(walls),
            "chairBlocksDetected": len(chairs),
            "chairBlocksUnassigned": len(unassigned),
            "furnitureBoxes": len(furniture),
            "interiorCoverage": round(mask.coverage, 4),
        },
    }

    def dump(name, obj):
        with open(os.path.join(a.out, name), "w", encoding="utf-8") as fh:
            json.dump(obj, fh, separators=(",", ":"))
            fh.write("\n")

    dump("meta.json", meta)
    dump("walls.json", {
        "viewBox": meta["viewBox"],
        "polygons": [{"layer": w["layer"], "closed": w["closed"],
                      "points": [[round(x, 2), round(y, 2)] for x, y in w["points"]]}
                     for w in walls],
    })
    dump("zones.json", {"viewBox": meta["viewBox"], "zones": zones})
    dump("furniture.json", {"viewBox": meta["viewBox"], "items": furniture})
    dump("rooms.json", {"viewBox": meta["viewBox"], "rooms": rooms})
    dump("seats.json", {"viewBox": meta["viewBox"], "seats": seats})
    dump("detected-modules.json", {
        "viewBox": meta["viewBox"],
        "modules": [{"x": round(c["x"], 2), "y": round(c["y"], 2),
                     "rotationDeg": int(round(c["facing"])) % 360}
                    for c in chairs],
    })
    dump("detection-report.json", {
        "generatedFrom": os.path.basename(a.pdf),
        "sourceSha256": checksum,
        "sheetTotalWorkingPeople": sheet_total,
        "sheetExclusionNote": sheet_note,
        "scheduleDrift": drift,
        "baysWithoutDrawingPax": unconfirmed,
        # R007's `8 PAX` on the A1/A2 run. R009 numbers those desks 1-8
        # instead, so there is no annotation to report.
        "workstationRunPax": None,
        # Every desk is numbered on the plan, so every bay's count is the
        # drawing's own statement rather than a PAX pairing.
        "seatsConfirmedByDrawingPax": sum(SCHEDULE.values()),
        "sheetSchedule": bay_rows,
        "sheetHeadcountByGrade": grade_rows,
        "roomsFromSheet": rooms_from_sheet,
        "zoneBChairsDetected": zone_b_chairs,
        "zoneBExpected": zone_b_expected,
        "unassignedChairs": len(unassigned),
        "unassignedChairsByZone": dict(sorted(unassigned_by_zone.items())),
        "bays": report,
    })

    # One SVG per raster width. The hairline stroke IS a function of the
    # target width -- see texture.hairline_for -- so a single SVG rasterised
    # at two sizes is wrong at one of them.
    assets = C.image_assets(raw, texture.visible_images(images, mask))
    for width in [int(w) for w in a.raster_widths.split(",")]:
        svg = os.path.join(a.out, f"plan-texture-{width}.svg")
        size, groups, n_img = texture.write_texture_svg(
            paths, images, assets, mask, svg, width, a.palette)
        print(f"  texture svg {width}px: {size / 1024:.0f} KB, "
              f"{groups} style groups, {n_img} bitmaps, "
              f"hairline {texture.hairline_for(width)}", file=sys.stderr)

    # ---- the honest table
    print()
    print(f"{'bay':<5}{'zone':<6}{'pax':>5}{'sched':>7}{'detected':>10}"
          f"{'placed':>8}{'interp':>8}{'dropped':>9}")
    print("-" * 58)
    for r in report:
        print(f"{r['bay']:<5}{r['zone']:<6}"
              f"{('-' if r['drawingPax'] is None else r['drawingPax']):>5}"
              f"{r['expected']:>7}{r['detected']:>10}{r['placed']:>8}"
              f"{r['interpolated']:>8}{r['surplusDropped']:>9}")
    print("-" * 58)
    td = sum(r["detected"] for r in report)
    ti = sum(r["interpolated"] for r in report)
    print(f"{'TOTAL':<5}{'':<6}{'':>5}{sum(r['expected'] for r in report):>7}"
          f"{td:>10}{sum(r['placed'] for r in report):>8}{ti:>8}"
          f"{sum(r['surplusDropped'] for r in report):>9}")
    print()
    print(f"detection accuracy: {td}/{len(seats)} numbered desks snapped onto a "
          f"chair block ({td / len(seats) * 100:.1f}%), {ti} left on the label")
    print(f"unassigned chair blocks by zone: "
          f"{dict(sorted(unassigned_by_zone.items()))}")
    print(f"  zone A's surplus is meeting room and lounge seating "
          f"(25/10/7/5/5 pax rooms, reception, sofa, swivel chairs)")
    print(f"  zone B: {zone_b_chairs} chairs beyond its {zone_b_expected} "
          f"numbered desks -- the modular lounge seating")
    if sheet_total is not None:
        print(f"the drawing's title block states TOTAL WORKING PEOPLE = "
              f"{sheet_total} PAX, matching the bay schedule")
    if sheet_note:
        print(f'  and, verbatim: "{sheet_note}"')
    print(f"schedule: every one of the {len(seats)} desks is numbered on the plan; "
          f"the title block's own bay schedule ({len(bay_rows)} rows under the "
          f"R007 names) and grade headcount ({len(grade_rows)} rows) both sum "
          f"to {sheet_total}")
    print(f"rooms: {'read off the sheet' if rooms_from_sheet else 'carried forward from R007 (A33)'}")
    print(f"scale: {mm_per_unit} mm per plan unit -- {scale_note}")


if __name__ == "__main__":
    main()
