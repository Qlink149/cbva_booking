#!/usr/bin/env python3
"""
Minimal, dependency-free PDF content-stream reader for the CBVA floor plan.

Why this exists instead of PyMuPDF: the extraction needs exactly three things
from this one drawing -- layer-tagged path geometry, layer-tagged text with
positions, and the block transforms -- and all three are recoverable from the
page content streams with nothing but zlib. Keeping it stdlib means
`npm run build:floorplan` works on a clean checkout with no pip step.

The drawing is CBVA - FURNITURE LAYOUT - R009 - 17-06-2025.pdf, plotted from
AutoCAD 2021 as an A3 layout, MediaBox [0 0 1191 842]. Its predecessor,
09 -R8 - NB -FURNITURE LAYOUT - 12-06-2025.pdf (R007), was an A2 model-space
plot, MediaBox [0 0 1684 1191], and every plan coordinate this project has
ever committed -- the viewBox, seats.json, zones, the 3D world transform --
is in THAT sheet's frame. The /Contents array of each MUST be concatenated in
declaration order because the graphics state carries across the streams.

Coordinate spaces, in order:
  content  raw operand numbers, ~0..53000, meaningless until the CTM is applied
  user     PDF user space, the sheet's own MediaBox, origin bottom-left, y UP
  plan     what everything downstream uses: y DOWN (so it matches SVG and the
           viewBox the Phase 1 assets already carry), cropped to PLAN_BOX, and
           ALWAYS in the R007 A2 frame -- see SHEET_FITS

THE PLAN FRAME IS R007's, AND STAYS R007's (ADR-049). When the architect
re-issued the drawing on an A3 layout the building itself did not move, but
every coordinate on the page did: the plot is 1/1.4649 the size and offset.
Rather than re-base the whole product on the new sheet (new viewBox, new
mmPerUnit, every committed anchor and zone hull and 3D constant re-derived)
the new sheet is fitted onto the old frame with one similarity transform,
measured from the structural layers that are identical in both revisions,
and applied inside `to_plan`. Nothing downstream can tell the sheet changed:
a wall in R009 lands on the same plan coordinate it had in R007 to within
0.2 pt. `tools/cad/calibrate_sheet.py` re-derives the fit and audits it.
"""
import base64
import binascii
import math
import re
import struct
import zlib

# The sheet currently being read. Set by `configure_sheet()` from the PDF's
# own MediaBox at the top of `read()`, so the y-flip in `to_plan` is always
# the sheet's own height and never a constant left over from another sheet.
MEDIA_W, MEDIA_H = 1684.0, 1191.0

# The frame every committed plan coordinate lives in: R007's A2 sheet.
PLAN_FRAME = (1684.0, 1191.0)

# Similarity fit (s, tx, ty) from a sheet's own y-down page space onto the
# R007 frame, keyed by MediaBox. plan = (s*x + tx, s*(MEDIA_H - y) + ty).
#
# Measured by `calibrate_sheet.py`: every vertex on K-COLS, C- COLOUMN,
# W-WALL, K-WALL and I-WALL of the new sheet matched to its nearest R007
# vertex, least-squares similarity, four ICP passes. R009 vs R007:
# 863 matched points, median residual 0.04 pt, worst 0.22 pt. The structural
# shell is byte-for-byte the same drawing, just re-plotted at A3.
#
# Identity for the R007 frame itself. An unlisted MediaBox is an error, not
# a guess -- the fix for a new sheet size is to run the calibration and add
# a row here, with its residuals in the commit message.
SHEET_FITS = {
    (1684.0, 1191.0): (1.0, 0.0, 0.0),
    (1191.0, 842.0): (1.4648516987782647, -30.318099293274145, -21.67738969533218),
}
_FIT = (1.0, 0.0, 0.0)


def media_box(data):
    m = re.search(rb"/MediaBox\s*\[\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s*\]", data)
    if not m:
        raise ValueError("no /MediaBox in the PDF")
    x0, y0, x1, y1 = (float(v) for v in m.groups())
    return (x1 - x0, y1 - y0)


def configure_sheet(data):
    """Select the y-flip height and the frame fit for the sheet about to be read."""
    global MEDIA_W, MEDIA_H, _FIT
    w, h = media_box(data)
    key = (round(w, 1), round(h, 1))
    if key not in SHEET_FITS:
        raise ValueError(
            f"MediaBox {w:g} x {h:g} has no fit onto the plan frame. Run "
            f"tools/cad/calibrate_sheet.py against the R007 sheet and add the "
            f"result to cadparse.SHEET_FITS."
        )
    MEDIA_W, MEDIA_H = w, h
    _FIT = SHEET_FITS[key]
    return _FIT


def sheet_fit():
    return _FIT


# Spelled without escape sequences deliberately. These are the only byte
# literals in the file, and a mangled one is a NUL in the source rather
# than a visible error.
FILTER_NONE = bytes(1)                        # PNG scanline filter 0
PNG_SIG = bytes.fromhex("89504E470D0A1A0A")   # the PNG magic number

# Plan region on the A2 sheet, in plan coordinates (y down). Excludes the
# title block on the right. Same box the Phase 1 assets were cut to, so the
# viewBox stays "85 95 1285 970" and nothing already committed shifts.
PLAN_BOX = (85.0, 95.0, 1370.0, 1065.0)


# --------------------------------------------------------------------------
# object soup
# --------------------------------------------------------------------------

def _streams_by_objnum(data):
    out = {}
    for m in re.finditer(rb"(?:^|[\r\n])(\d+) 0 obj(.*?)endobj", data, re.S):
        num, body = int(m.group(1)), m.group(2)
        s = re.search(rb"stream[\r\n]+(.*?)endstream", body, re.S)
        if not s:
            continue
        raw = s.group(1)
        if b"/FlateDecode" in body:
            try:
                raw = zlib.decompress(raw)
            except zlib.error:
                continue
        out[num] = raw
    return out


def page_content(data, streams=None):
    """The /Contents streams, concatenated in declaration order."""
    if streams is None:
        streams = _streams_by_objnum(data)
    m = re.search(rb"/Type\s*/Page[^s].{0,4000}?/Contents\s*\[([^\]]*)\]", data, re.S)
    if m:
        nums = [int(n) for n in re.findall(rb"(\d+) 0 R", m.group(1))]
    else:
        m = re.search(rb"/Type\s*/Page[^s].{0,4000}?/Contents\s*(\d+) 0 R", data, re.S)
        nums = [int(m.group(1))] if m else []
    return b"\n".join(streams[n] for n in nums if n in streams)


def layer_names(data):
    """'/ocN' -> CAD layer name, via the page /Properties dict and the OCGs."""
    ocg = {}
    for m in re.finditer(rb"(?:^|[\r\n])(\d+) 0 obj\s*<<([^>]*?)/Type\s*/OCG(.*?)>>", data, re.S):
        blk = m.group(2) + m.group(3)
        nm = re.search(rb"/Name\s*\(([^)]*)\)", blk)
        if nm:
            ocg[int(m.group(1))] = nm.group(1).decode("latin1")
    props = re.search(rb"/Properties\s*<<(.*?)>>", data, re.S)
    out = {}
    if props:
        for name, num in re.findall(rb"/(oc\d+)\s+(\d+) 0 R", props.group(1)):
            n = ocg.get(int(num))
            if n:
                out["/" + name.decode()] = n
    return out


def hidden_layers(data):
    """CAD layer names switched OFF in the PDF's default view configuration.

    This extractor draws every layer it is given, so a layer the architect
    turned off would appear in our texture and in nothing else. Empty on this
    drawing; audited so it stays that way.
    """
    ocg = {}
    for m in re.finditer(rb"(?:^|\s)(\d+) 0 obj\s*<<([^>]*?)/Type\s*/OCG(.*?)>>",
                         data, re.S):
        blk = m.group(2) + m.group(3)
        nm = re.search(rb"/Name\s*\(([^)]*)\)", blk)
        if nm:
            ocg[int(m.group(1))] = nm.group(1).decode("latin1")
    d = re.search(rb"/OCProperties\s*<<.*?/D\s*<<(.*?)/OCGs", data, re.S)
    blk = d.group(1) if d else b""
    off = re.search(rb"/OFF\s*\[([^\]]*)\]", blk)
    if not off:
        off = re.search(rb"/OCProperties\s*<<.*?/OFF\s*\[([^\]]*)\]", data, re.S)
    if not off:
        return set()
    return {ocg.get(int(n), "/oc" + n.decode())
            for n in re.findall(rb"(\d+) 0 R", off.group(1))}


def tounicode_cmap(data):
    """glyph id -> character, from the /ToUnicode CMap."""
    ref = re.search(rb"/ToUnicode\s*(\d+) 0 R", data)
    if not ref:
        return {}
    obj = re.search(rb"(?:^|[\r\n])" + ref.group(1) + rb" 0 obj(.*?)endobj", data, re.S)
    if not obj:
        return {}
    st = re.search(rb"stream[\r\n]+(.*?)endstream", obj.group(1), re.S)
    if not st:
        return {}
    raw = st.group(1)
    try:
        raw = zlib.decompress(raw)
    except zlib.error:
        pass
    text = raw.decode("latin1")
    uni = {}
    for blk in re.findall(r"beginbfchar(.*?)endbfchar", text, re.S):
        for a, b in re.findall(r"<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>", blk):
            uni[int(a, 16)] = "".join(chr(int(b[i:i + 4], 16)) for i in range(0, len(b), 4))
    for blk in re.findall(r"beginbfrange(.*?)endbfrange", text, re.S):
        for a, b, c in re.findall(r"<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>", blk):
            lo, hi, dst = int(a, 16), int(b, 16), int(c, 16)
            for k in range(lo, hi + 1):
                uni[k] = chr(dst + k - lo)
    return uni


def xobject_map(data):
    """'/XopN' -> object number, from the page /Resources /XObject dict."""
    m = re.search(rb"/XObject\s*<<(.*?)>>", data, re.S)
    if not m:
        return {}
    return {"/" + n.decode(): int(num)
            for n, num in re.findall(rb"/(\w+)\s+(\d+) 0 R", m.group(1))}


def _obj_head(data, num):
    """The dictionary text of object `num`, up to its stream keyword."""
    pat = rb"(?:^|\s)" + str(num).encode() + rb" 0 obj(.*?)endobj"
    m = re.search(pat, data, re.S)
    if not m:
        return b""
    body = m.group(1)
    cut = body.find(b"stream")
    return body[:cut] if cut >= 0 else body


def _grey_png(samples, width, height):
    """An 8-bit greyscale PNG from raw samples. Stdlib only.

    Used for the soft-mask channel. Writing a PNG by hand is a dozen lines and
    it is what removes the need for a JPEG decoder: the colour image goes into
    the SVG as its own untouched JPEG and this rides alongside it as an SVG
    <mask>, so the compositing a pixel renderer would do happens at render
    time instead.
    """
    if len(samples) < width * height:
        raise ValueError(f"soft mask short: {len(samples)} < {width * height}")
    raw = bytearray()
    for row in range(height):
        raw += FILTER_NONE                       # PNG scanline filter type 0
        raw += samples[row * width:(row + 1) * width]

    def chunk(tag, payload):
        return (struct.pack(">I", len(payload)) + tag + payload
                + struct.pack(">I", binascii.crc32(tag + payload) & 0xFFFFFFFF))

    return (PNG_SIG
            + chunk(b"IHDR",
                    struct.pack(">IIBBBBB", width, height, 8, 0, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
            + chunk(b"IEND", b""))


def _filters(head):
    return [f.decode() for f in re.findall(rb"/(\w+Decode)", head)]


def image_payload(data, streams, num):
    """One image XObject as (mime, bytes) plus its soft mask, or raise.

    This drawing's eleven in-plan bitmaps -- the solid B.P.G storage credenzas --
    are `/Filter [/FlateDecode /DCTDecode]` DeviceRGB with a
    `/Filter [/FlateDecode /ASCII85Decode]` DeviceGray `/SMask`. So one
    zlib pass leaves untouched JPEG bytes, and one zlib pass plus ASCII85
    leaves raw luminance. Neither needs a decoder.

    Anything else RAISES rather than returning None. get_drawings()-style
    vector extraction was structurally incapable of seeing these at all and
    their absence was completely silent for five phases; a decoder that
    silently skips an unfamiliar filter would reproduce exactly that.
    """
    head = _obj_head(data, num)
    if b"/Image" not in head:
        return None
    width = int(re.search(rb"/Width\s+(\d+)", head).group(1))
    height = int(re.search(rb"/Height\s+(\d+)", head).group(1))
    filters = _filters(head)
    body = streams.get(num)            # _streams_by_objnum already un-Flated
    if body is None:
        raise ValueError(f"image xobject {num} has no stream")

    if filters == ["FlateDecode", "DCTDecode"]:
        mime, payload = "image/jpeg", body
    elif filters == ["FlateDecode", "ASCII85Decode"]:
        a85 = b"".join(body.split())
        if a85.endswith(b"~>"):
            a85 = a85[:-2]
        grey = base64.a85decode(a85, adobe=False)
        mime, payload = "image/png", _grey_png(grey, width, height)
    else:
        raise ValueError(
            f"image xobject {num}: unhandled filter chain {filters!r}. "
            f"Add a branch rather than skipping it -- a silently dropped "
            f"bitmap is invisible in the output.")

    smask = re.search(rb"/SMask\s+(\d+) 0 R", head)
    return {
        "num": num, "mime": mime, "payload": payload,
        "width": width, "height": height,
        "smask": int(smask.group(1)) if smask else None,
    }


def image_assets(data, images):
    """{objnum: {mime, b64, mask_b64}} for a set of placed images.

    The colour image goes out as its own untouched JPEG and the soft mask as a
    greyscale PNG beside it, to be used as an SVG <mask>. That pairing is what
    lets a stdlib extractor composite these correctly: the credenzas are
    rotated shapes inside axis-aligned bitmaps, so their corners are
    transparent, and without the mask they composite solid black.
    """
    streams = _streams_by_objnum(data)
    out = {}
    for im in images:
        if im.num in out:
            continue
        info = image_payload(data, streams, im.num)
        if info is None:
            raise ValueError(f"xobject {im.num} was placed by Do but is not an image")
        rec = {"mime": info["mime"],
               "b64": base64.b64encode(info["payload"]).decode("ascii")}
        if info["smask"] is not None:
            m = image_payload(data, streams, info["smask"])
            if m is None or m["mime"] != "image/png":
                raise ValueError(f"soft mask {info['smask']} did not decode to a PNG")
            rec["mask_b64"] = base64.b64encode(m["payload"]).decode("ascii")
        out[im.num] = rec
    return out


class Image:
    """One placed raster image. `quad` is its four corners in PLAN space.

    A PDF image occupies the unit square under the CTM, so the placement is the
    CTM applied to (0,0) (1,0) (1,1) (0,1) -- which also means a rotated
    placement is recoverable rather than being flattened to a bounding box.
    """

    __slots__ = ("layer", "ctm", "num", "quad")

    def __init__(self, layer, ctm, num):
        self.layer = layer
        self.ctm = ctm
        self.num = num
        self.quad = [to_plan(*apply(ctm, x, y))
                     for x, y in ((0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0))]

    def bbox(self):
        xs = [p[0] for p in self.quad]
        ys = [p[1] for p in self.quad]
        return (min(xs), min(ys), max(xs), max(ys))

    def axis_aligned(self, tol=1e-6):
        return abs(self.ctm[1]) < tol and abs(self.ctm[2]) < tol

# --------------------------------------------------------------------------
# tokenizer
# --------------------------------------------------------------------------

_DELIM = b"()<>[]{}/%"
_WS = b"\x00\t\n\x0c\r "


def tokenize(buf):
    """Yield (kind, value). kind in {'num','name','str','hex','op','arr'}."""
    i, n = 0, len(buf)
    while i < n:
        c = buf[i:i + 1]
        if c in _WS:
            i += 1
            continue
        if c == b"%":
            j = i
            while j < n and buf[j:j + 1] not in b"\r\n":
                j += 1
            i = j
            continue
        if c == b"(":
            depth, j, out = 1, i + 1, bytearray()
            while j < n and depth:
                ch = buf[j:j + 1]
                if ch == b"\\":
                    out += buf[j:j + 2]
                    j += 2
                    continue
                if ch == b"(":
                    depth += 1
                elif ch == b")":
                    depth -= 1
                    if not depth:
                        j += 1
                        break
                out += ch
                j += 1
            yield ("str", bytes(out))
            i = j
            continue
        if buf[i:i + 2] == b"<<":
            yield ("op", b"<<")
            i += 2
            continue
        if buf[i:i + 2] == b">>":
            yield ("op", b">>")
            i += 2
            continue
        if c == b"<":
            j = buf.find(b">", i)
            if j < 0:
                break
            yield ("hex", buf[i + 1:j])
            i = j + 1
            continue
        if c in b"[]":
            yield ("arr", c)
            i += 1
            continue
        if c == b"/":
            j = i + 1
            while j < n and buf[j:j + 1] not in _WS and buf[j:j + 1] not in _DELIM:
                j += 1
            yield ("name", buf[i:j])
            i = j
            continue
        j = i
        while j < n and buf[j:j + 1] not in _WS and buf[j:j + 1] not in _DELIM:
            j += 1
        if j == i:
            i += 1
            continue
        word = buf[i:j]
        i = j
        try:
            yield ("num", float(word))
        except ValueError:
            yield ("op", word)


# --------------------------------------------------------------------------
# matrices
# --------------------------------------------------------------------------

IDENT = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)


def mul(m, n):
    a, b, c, d, e, f = m
    A, B, C, D, E, F = n
    return (a * A + b * C, a * B + b * D,
            c * A + d * C, c * B + d * D,
            e * A + f * C + E, e * B + f * D + F)


def apply(m, x, y):
    a, b, c, d, e, f = m
    return (a * x + c * y + e, b * x + d * y + f)


def invert(m):
    a, b, c, d, e, f = m
    det = a * d - b * c
    if abs(det) < 1e-12:
        return IDENT
    return (d / det, -b / det, -c / det, a / det,
            (c * f - d * e) / det, (b * e - a * f) / det)


def rotation_deg(m):
    """Rotation of a matrix expressed in PLAN space (y down), 0-360 clockwise."""
    return math.degrees(math.atan2(-m[1], m[0])) % 360.0


def scale_of(m):
    return math.hypot(m[0], m[1]), math.hypot(m[2], m[3])


def scale_factor(m):
    """The scalar a stroke width is multiplied by under this matrix.

    PDF strokes are transformed by the CTM, so a width is only meaningful once
    the matrix is applied. sqrt(|det|) is the right scalar for a possibly
    non-uniform matrix; here the plot matrix is a uniform 0.03, which is what
    turns the content stream's 5/9/12/19/24/28/47 into the drawing's
    0.15/0.27/0.36/0.57/0.72/0.84/1.41 pt line weights.
    """
    return math.sqrt(abs(m[0] * m[3] - m[1] * m[2]))


def to_plan(x, y):
    """PDF user space (y up) -> plan space (y down, R007 frame).

    The ONE place a page coordinate becomes a plan coordinate, which is what
    lets the sheet fit live here and nowhere else: paths, text, image quads
    and the in-plan test all pass through it.
    """
    s, tx, ty = _FIT
    return (s * x + tx, s * (MEDIA_H - y) + ty)


def in_plan_box(x, y):
    x0, y0, x1, y1 = PLAN_BOX
    return x0 <= x <= x1 and y0 <= y <= y1


# --------------------------------------------------------------------------
# the interpreter
# --------------------------------------------------------------------------

class Path:
    """
    One painted path.

    `stroke` and `fill` are DeviceRGB triples in 0..1. They are retained
    because in this drawing colour is not decoration -- it is a key. The
    architect's legend assigns a stroke colour per furniture type, and
    P-FULLHEIGHT PARTITION carries the real room dividers in black alongside
    5,012 orange hatch paths that are not walls at all. Without the colour
    those two are indistinguishable; with it the layer separates cleanly.

    Every colour in this file is set by a plain 3-operand DeviceRGB `RG`/`rg`:
    there is not one `sc`, `scn`, `SC`, `SCN`, `g`, `G`, `k` or `K` operator in
    the whole content stream, which is why three lines of tracking is enough.

    Corrected in Phase 7: there ARE 192 `CS` operators, which ADR-042 and an
    earlier version of this docstring both omitted from that list. `CS` only
    SELECTS a colour space; with no `SC`/`SCN` anywhere to set a value in it,
    every colour still comes from `RG`/`rg` and the conclusion is unchanged.
    The claim as written was simply not literally true.
    """

    __slots__ = ("layer", "ctm", "subpaths", "local", "painted", "stroke", "fill",
                 "width", "join", "even_odd")

    def __init__(self, layer, ctm, subpaths, local, painted,
                 stroke=(0.0, 0.0, 0.0), fill=(0.0, 0.0, 0.0),
                 width=0.0, join=0, even_odd=False):
        self.layer = layer          # CAD layer name
        self.ctm = ctm              # matrix in force when the path was painted
        self.subpaths = subpaths    # [[(x, y), ...]] in PLAN space
        self.local = local          # the same points, pre-CTM
        self.painted = painted      # 'S' stroked / 'f' filled
        self.stroke = stroke        # DeviceRGB 0..1, in force at paint time
        self.fill = fill            # DeviceRGB 0..1, in force at paint time
        # Presentation state, added in Phase 7 for the baked texture. The
        # geometry pipeline ignores all three; the texture emitter needs every
        # one of them, because the drawing carries eight stroke widths and a
        # mixed miter/round join and flattening either is visible.
        self.width = width          # stroke width in PLAN units (CTM applied)
        self.join = join            # 0 miter, 1 round. Only these two occur.
        self.even_odd = even_odd    # f* / B* / b* rather than f / B / b

    def stroke_hex(self):
        return "#%02X%02X%02X" % tuple(
            max(0, min(255, int(round(c * 255.0)))) for c in self.stroke
        )

    def fill_hex(self):
        return "#%02X%02X%02X" % tuple(
            max(0, min(255, int(round(c * 255.0)))) for c in self.fill
        )


class Span:
    __slots__ = ("layer", "x", "y", "text", "size", "in_plan")

    def __init__(self, layer, x, y, text, size, in_plan):
        self.layer, self.x, self.y = layer, x, y
        self.text, self.size = text, size
        # False for the title block and sheet notes. They are not part of the
        # floor, but they carry the schedule -- the sheet states the 141 total
        # and what it excludes -- so they are returned rather than discarded.
        self.in_plan = in_plan


def _bezier(p0, p1, p2, p3, steps=6):
    out = []
    for i in range(1, steps + 1):
        t = i / steps
        u = 1.0 - t
        out.append((
            u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
            u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
        ))
    return out


PAINT_OPS = (b"S", b"s", b"f", b"F", b"f*", b"B", b"B*", b"b", b"b*", b"n")
FILL_OPS = (b"f", b"F", b"f*", b"B", b"B*", b"b", b"b*")
EVEN_ODD_OPS = (b"f*", b"B*", b"b*")


def read(data, want_layers=None, want_text=True, want_images=False):
    """Interpret the page content.

    Returns (paths, spans), or (paths, spans, images) with want_images. The
    third element is opt-in so that every existing two-tuple call site keeps
    working unchanged.
    """
    fit_s = configure_sheet(data)[0]
    names = layer_names(data)
    uni = tounicode_cmap(data)
    streams = _streams_by_objnum(data)
    content = page_content(data, streams)
    xobjects = xobject_map(data) if want_images else {}

    paths, spans, images = [], [], []
    ctm = IDENT
    # PDF's initial colour is black in both channels.
    stroke = fill = (0.0, 0.0, 0.0)
    # Line width 0 means "one device pixel", which is 62% of this drawing;
    # resolving it needs the target raster size, so it is left as 0 here and
    # decided by the texture emitter. Default join is miter, per the spec.
    lw, join = 0.0, 0
    gstack = []
    oc_stack = []
    layer = None
    mc_depth = 0

    cur, sub, start = [], [], None
    operands = []
    tm = IDENT
    in_text = False
    font_size = 1.0

    def flush(painted, even_odd=False):
        nonlocal cur, sub
        if sub and len(sub) > 1:
            cur.append(sub)
        if cur and (want_layers is None or layer in want_layers):
            plan, keep = [], False
            for sp in cur:
                pts = []
                for (x, y) in sp:
                    px, py = to_plan(*apply(ctm, x, y))
                    pts.append((px, py))
                    if not keep and in_plan_box(px, py):
                        keep = True
                plan.append(pts)
            if keep:
                # Stroke width and text size are lengths, so they scale with
                # the sheet fit exactly as the geometry does.
                paths.append(Path(layer, ctm, plan, cur, painted, stroke, fill,
                                  lw * scale_factor(ctm) * fit_s, join, even_odd))
        cur, sub = [], []

    for kind, val in tokenize(content):
        if kind == "num":
            operands.append(val)
            continue
        if kind in ("name", "str", "hex", "arr"):
            operands.append((kind, val))
            continue

        op = val

        if op == b"q":
            # Colour rides the stack WITH the ctm. The drawing sets RG inside
            # nested q/Q blocks, so a bare global would leak one block's colour
            # into the next and mis-attribute paths wholesale.
            gstack.append((ctm, stroke, fill, lw, join))
        elif op == b"Q":
            if gstack:
                ctm, stroke, fill, lw, join = gstack.pop()
        elif op == b"w" and operands:
            nums = [x for x in operands if isinstance(x, float)]
            if nums:
                lw = nums[-1]
        elif op == b"j" and operands:
            nums = [x for x in operands if isinstance(x, float)]
            if nums:
                join = int(nums[-1])
        elif op == b"RG" and len(operands) >= 3:
            nums = [o for o in operands if isinstance(o, float)]
            if len(nums) >= 3:
                stroke = tuple(nums[-3:])
        elif op == b"rg" and len(operands) >= 3:
            nums = [o for o in operands if isinstance(o, float)]
            if len(nums) >= 3:
                fill = tuple(nums[-3:])
        elif op == b"cm" and len(operands) >= 6:
            nums = [o for o in operands if isinstance(o, float)]
            if len(nums) >= 6:
                ctm = mul(tuple(nums[-6:]), ctm)
        elif op == b"BDC":
            mc_depth += 1
            tag = None
            for o in operands:
                if isinstance(o, tuple) and o[0] == "name" and o[1].startswith(b"/oc"):
                    tag = o[1].decode()
            if tag:
                layer = names.get(tag, tag)
                oc_stack.append((mc_depth, layer))
        elif op in (b"BMC", b"BX"):
            mc_depth += 1
        elif op in (b"EMC", b"EX"):
            while oc_stack and oc_stack[-1][0] >= mc_depth:
                oc_stack.pop()
            layer = oc_stack[-1][1] if oc_stack else None
            mc_depth = max(0, mc_depth - 1)

        elif op == b"m" and len(operands) >= 2:
            if sub and len(sub) > 1:
                cur.append(sub)
            start = (float(operands[-2]), float(operands[-1]))
            sub = [start]
        elif op == b"l" and len(operands) >= 2 and sub:
            sub.append((float(operands[-2]), float(operands[-1])))
        elif op in (b"c", b"v", b"y") and sub:
            p0 = sub[-1]
            nums = [o for o in operands if isinstance(o, float)]
            if op == b"c" and len(nums) >= 6:
                p1, p2, p3 = (nums[-6], nums[-5]), (nums[-4], nums[-3]), (nums[-2], nums[-1])
            elif op == b"v" and len(nums) >= 4:
                p1, p2, p3 = p0, (nums[-4], nums[-3]), (nums[-2], nums[-1])
            elif len(nums) >= 4:
                p1 = (nums[-4], nums[-3])
                p3 = (nums[-2], nums[-1])
                p2 = p3
            else:
                operands = []
                continue
            sub.extend(_bezier(p0, p1, p2, p3))
        elif op == b"h":
            if sub and start:
                sub.append(start)
        elif op == b"re" and len(operands) >= 4:
            nums = [o for o in operands if isinstance(o, float)]
            if len(nums) >= 4:
                x, y, w, h = nums[-4:]
                if sub and len(sub) > 1:
                    cur.append(sub)
                start = (x, y)
                cur.append([(x, y), (x + w, y), (x + w, y + h), (x, y + h), (x, y)])
                sub = []
        elif op in PAINT_OPS:
            if op in (b"s", b"b", b"b*") and sub and start:
                sub.append(start)
            flush("f" if op in FILL_OPS else "S", op in EVEN_ODD_OPS)
            start = None

        elif op == b"Do" and want_images:
            for tok in operands:
                if isinstance(tok, tuple) and tok[0] == "name":
                    num = xobjects.get(tok[1].decode())
                    if num is not None and b"/Image" in _obj_head(data, num):
                        images.append(Image(layer, ctm, num))

        elif op == b"BT":
            in_text, tm = True, IDENT
        elif op == b"ET":
            in_text = False
        elif op == b"Tf":
            nums = [o for o in operands if isinstance(o, float)]
            if nums:
                font_size = nums[-1]
        elif op == b"Tm" and len(operands) >= 6:
            nums = [o for o in operands if isinstance(o, float)]
            if len(nums) >= 6:
                tm = tuple(nums[-6:])
        elif op in (b"Tj", b"TJ") and want_text and in_text:
            chunks = [o for o in operands if isinstance(o, tuple) and o[0] == "hex"]
            if chunks:
                text = ""
                for _, h in chunks:
                    hs = h.decode("latin1")
                    text += "".join(uni.get(int(hs[i:i + 4], 16), "")
                                    for i in range(0, len(hs), 4))
                if text.strip():
                    full = mul(tm, ctm)
                    px, py = to_plan(*apply(full, 0.0, 0.0))
                    spans.append(Span(layer, px, py, text.strip(),
                                      font_size * (abs(full[0]) or 1.0) * fit_s,
                                      in_plan_box(px, py)))

        operands = []

    if want_images:
        return paths, spans, images
    return paths, spans


def load(pdf_path, **kw):
    with open(pdf_path, "rb") as fh:
        return read(fh.read(), **kw)
