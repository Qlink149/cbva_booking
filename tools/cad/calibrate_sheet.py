#!/usr/bin/env python3
"""
Derive -- and audit -- the similarity fit that puts a re-issued sheet onto the
R007 plan frame (cadparse.SHEET_FITS, ADR-049).

    python tools/cad/calibrate_sheet.py <new.pdf> [--reference <r007.pdf>]

Prints s, tx, ty at full precision and the residual distribution, then checks
the fit cadparse currently holds for that MediaBox against the one just
measured. Exit status is non-zero if they disagree by more than 0.05 pt at any
corner of the plan box, so this doubles as the regression test for the
constant: run it after any change to SHEET_FITS or when a new revision of the
drawing arrives.

How the fit is measured. The five structural layers -- K-COLS, C- COLOUMN,
W-WALL, K-WALL, I-WALL -- are the parts of the building the architect does
not redraw between furniture revisions, so their vertices are the same points
on both sheets. Bounding boxes give the initial scale and offset; four passes
of nearest-neighbour matching (within 4 pt) and least-squares similarity
refine it. No rotation term is solved for: both sheets are plotted upright,
and a fit that needed one would be a different drawing, not a re-plot.
"""
import argparse
import collections
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cadparse as C  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
REFERENCE = os.path.join(HERE, "09 -R8 - NB -FURNITURE LAYOUT - 12-06-2025.pdf")
FIT_LAYERS = ("K-COLS", "C- COLOUMN", "W-WALL", "K-WALL", "I-WALL")


def raw_points(pdf_path):
    """Structural vertices in the sheet's OWN y-down page space (no fit)."""
    with open(pdf_path, "rb") as fh:
        data = fh.read()
    w, h = C.media_box(data)
    saved = dict(C.SHEET_FITS)
    saved_box = C.PLAN_BOX
    try:
        C.SHEET_FITS[(round(w, 1), round(h, 1))] = (1.0, 0.0, 0.0)
        C.PLAN_BOX = (0.0, 0.0, w, h)
        paths, _ = C.read(data, want_text=False)
    finally:
        C.SHEET_FITS.clear()
        C.SHEET_FITS.update(saved)
        C.PLAN_BOX = saved_box
    pts = [pt for p in paths if p.layer in FIT_LAYERS for sp in p.subpaths for pt in sp]
    return (w, h), pts


def bbox_fit(a, b):
    ax = [p[0] for p in a]; ay = [p[1] for p in a]
    bx = [p[0] for p in b]; by = [p[1] for p in b]
    sx = (max(ax) - min(ax)) / (max(bx) - min(bx))
    sy = (max(ay) - min(ay)) / (max(by) - min(by))
    s = (sx + sy) / 2.0
    return s, min(ax) - s * min(bx), min(ay) - s * min(by)


def refine(a, b, s, tx, ty, iters=4, cell=6.0, radius=4.0):
    grid = collections.defaultdict(list)
    for p in a:
        grid[(int(p[0] // cell), int(p[1] // cell))].append(p)

    def nearest(x, y):
        best, bd = None, 1e18
        cx, cy = int(x // cell), int(y // cell)
        for i in range(cx - 1, cx + 2):
            for j in range(cy - 1, cy + 2):
                for q in grid.get((i, j), ()):
                    d = (q[0] - x) ** 2 + (q[1] - y) ** 2
                    if d < bd:
                        bd, best = d, q
        return best, math.sqrt(bd)

    residuals = []
    for _ in range(iters):
        P, Q = [], []
        for (x, y) in b:
            q, d = nearest(s * x + tx, s * y + ty)
            if q is not None and d < radius:
                P.append((x, y)); Q.append(q)
        n = len(P)
        if n < 50:
            raise SystemExit(f"only {n} structural points matched; not the same building")
        mx = sum(p[0] for p in P) / n; my = sum(p[1] for p in P) / n
        qx = sum(q[0] for q in Q) / n; qy = sum(q[1] for q in Q) / n
        num = sum((p[0] - mx) * (q[0] - qx) + (p[1] - my) * (q[1] - qy) for p, q in zip(P, Q))
        den = sum((p[0] - mx) ** 2 + (p[1] - my) ** 2 for p in P)
        s = num / den
        tx, ty = qx - s * mx, qy - s * my
        residuals = sorted(math.hypot(s * p[0] + tx - q[0], s * p[1] + ty - q[1])
                           for p, q in zip(P, Q))
    return s, tx, ty, residuals


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf")
    ap.add_argument("--reference", default=REFERENCE)
    a = ap.parse_args()

    ref_box, ref_pts = raw_points(a.reference)
    if tuple(round(v, 1) for v in ref_box) != C.PLAN_FRAME:
        raise SystemExit(f"reference sheet is {ref_box}, not the plan frame {C.PLAN_FRAME}")
    new_box, new_pts = raw_points(a.pdf)
    print(f"reference {os.path.basename(a.reference)}: {len(ref_pts)} structural vertices")
    print(f"candidate {os.path.basename(a.pdf)}: MediaBox {new_box[0]:g} x {new_box[1]:g}, "
          f"{len(new_pts)} structural vertices")

    s, tx, ty = bbox_fit(ref_pts, new_pts)
    s, tx, ty, res = refine(ref_pts, new_pts, s, tx, ty)
    n = len(res)
    print(f"\nfit: s={s!r} tx={tx!r} ty={ty!r}")
    print(f"matched {n} points; residual median {res[n // 2]:.3f} pt, "
          f"p90 {res[int(n * 0.9)]:.3f} pt, max {res[-1]:.3f} pt")

    key = tuple(round(v, 1) for v in new_box)
    held = C.SHEET_FITS.get(key)
    if held is None:
        print(f"\ncadparse.SHEET_FITS has no entry for {key}; add:\n"
              f"    {key}: ({s!r}, {tx!r}, {ty!r}),")
        raise SystemExit(2)
    hs, htx, hty = held
    worst = 0.0
    for (x, y) in ((0.0, 0.0), (new_box[0], 0.0), (0.0, new_box[1]), new_box):
        worst = max(worst, math.hypot((s * x + tx) - (hs * x + htx),
                                      (s * y + ty) - (hs * y + hty)))
    print(f"\nheld fit for {key}: s={hs!r} tx={htx!r} ty={hty!r}")
    print(f"largest disagreement over the sheet corners: {worst:.4f} pt")
    if worst > 0.05:
        print("FAIL: the held fit no longer reproduces the measurement")
        raise SystemExit(1)
    print("OK")


if __name__ == "__main__":
    main()
