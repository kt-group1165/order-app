"""
居宅から届く提供票 (第6表) / 別表 (第7表) の FAX スキャン PDF の前処理 — 画像処理だけ (OCR は run.mjs が tesseract.js で行う)

  python -I prep.py pages <pdf> <outdir>
      ページ画像 (グレー PNG) を取り出し、白紙判定用のインク率と、向き判定用の帯 (4 方向 × 上端の帯) を書く → <outdir>/pages.json
  python -I prep.py cells <outdir> <page番号> <回転 0|90|180|270>
      回転 → 傾き補正 → 罫線からセルを出す → <outdir>/p<NN>/page.png と cells.json (セルの矩形・行・列)

依存: PyMuPDF (fitz) / OpenCV (cv2) / NumPy / Pillow。★ PDF・画像は個人情報なので git に入れない (outdir は repo の外)。
"""
import io, json, os, sys

import cv2
import fitz
import numpy as np
from PIL import Image

sys.stdout.reconfigure(encoding="utf-8")


def to_cv(im):
    return np.array(im.convert("L"))


def ink_ratio(g):
    """暗い画素の割合 (端の 3% はスキャンの影を避けて除く)"""
    h, w = g.shape
    m = g[int(h * 0.03): int(h * 0.97), int(w * 0.03): int(w * 0.97)]
    return float((m < 128).mean())


def rot(g, deg):
    if deg == 0:
        return g
    return cv2.rotate(g, {90: cv2.ROTATE_90_CLOCKWISE, 180: cv2.ROTATE_180, 270: cv2.ROTATE_90_COUNTERCLOCKWISE}[deg])


def cmd_pages(inputs, outdir):
    """inputs = PDF / 写真のリスト。順にページ番号を振る (提供票の写真 → 別表の写真 のように並べて渡す)"""
    os.makedirs(outdir, exist_ok=True)
    pages = []
    n = 0
    for pdf in inputs:
        n = _pages_of(pdf, outdir, pages, n)
    with open(os.path.join(outdir, "pages.json"), "w", encoding="utf-8") as f:
        json.dump({"pdf": " + ".join(inputs), "inputs": inputs, "pages": pages}, f, ensure_ascii=False, indent=1)
    print(json.dumps({"pages": len(pages)}))


def _pages_of(pdf, outdir, pages, n):
    # スマホの写真 (JPEG / PNG) も 1 ページとして扱う (撮ったまま: 台形のゆがみは直さない → 2 段目の Claude に任せる)
    if os.path.splitext(pdf)[1].lower() in (".jpg", ".jpeg", ".png", ".heic", ".webp"):
        d = [None]
        photo = True
    else:
        d = fitz.open(pdf)
        photo = False
    for i, p in enumerate(d):
        n += 1
        if photo:
            from PIL import ImageOps
            g = to_cv(ImageOps.exif_transpose(Image.open(pdf)))  # スマホの向き情報 (EXIF) を反映
            imgs = None
        else:
            imgs = p.get_images()
        if photo:
            pass
        elif imgs:
            b = d.extract_image(imgs[0][0])
            g = to_cv(Image.open(io.BytesIO(b["image"])))
        else:  # 画像が無いページ (念のため) はレンダリング
            pix = p.get_pixmap(dpi=300)
            g = to_cv(Image.frombytes("RGB", (pix.width, pix.height), pix.samples))
        path = os.path.join(outdir, f"raw{n:02d}.png")
        cv2.imwrite(path, g)
        bands = {}
        for deg in (0, 90, 180, 270):
            r = rot(g, deg)
            h, w = r.shape
            band = r[0: int(h * 0.16), :]  # 上端の帯 (表題がある)
            scale = 1600 / band.shape[1]
            band = cv2.resize(band, (1600, max(1, int(band.shape[0] * scale))), interpolation=cv2.INTER_AREA)
            bp = os.path.join(outdir, f"band{n:02d}_{deg}.png")
            cv2.imwrite(bp, band)
            bands[str(deg)] = bp
        pages.append({"page": n, "raw": path, "w": int(g.shape[1]), "h": int(g.shape[0]), "ink": round(ink_ratio(g), 4), "bands": bands, "photo": photo, "source": os.path.basename(pdf)})
    return n


def deskew(g):
    """±1.5° で 行の濃さの分布が一番鋭くなる角度 (試作 deskew.py と同じ考え方)"""
    small = cv2.resize(g, (g.shape[1] // 4, g.shape[0] // 4), interpolation=cv2.INTER_AREA)
    inv = (small < 140).astype(np.uint8)
    h, w = inv.shape
    best = (0.0, -1.0)
    for ang in np.arange(-1.5, 1.5001, 0.05):
        M = cv2.getRotationMatrix2D((w / 2, h / 2), ang, 1.0)
        r = cv2.warpAffine(inv, M, (w, h), flags=cv2.INTER_NEAREST, borderValue=0)
        s = float((r.sum(1).astype(np.float64) ** 2).sum())
        if s > best[1]:
            best = (float(ang), s)
    ang = best[0]
    H, W = g.shape
    M = cv2.getRotationMatrix2D((W / 2, H / 2), ang, 1.0)
    return cv2.warpAffine(g, M, (W, H), flags=cv2.INTER_CUBIC, borderValue=255), ang


def detect_cells(g):
    """罫線 (横・縦) を取り出し、線で囲まれた矩形をセルとして返す"""
    bw = cv2.adaptiveThreshold(g, 255, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY_INV, 25, 15)
    H, W = g.shape
    hk = cv2.getStructuringElement(cv2.MORPH_RECT, (max(20, W // 60), 1))
    vk = cv2.getStructuringElement(cv2.MORPH_RECT, (1, max(15, H // 80)))
    hl = cv2.dilate(cv2.morphologyEx(bw, cv2.MORPH_OPEN, hk), cv2.getStructuringElement(cv2.MORPH_RECT, (5, 3)))
    vl = cv2.dilate(cv2.morphologyEx(bw, cv2.MORPH_OPEN, vk), cv2.getStructuringElement(cv2.MORPH_RECT, (3, 5)))
    grid = cv2.bitwise_or(hl, vl)
    # セル = 線の無い領域の連結成分 (線で囲まれていれば 1 つのセル)
    inv = cv2.bitwise_not(grid)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(inv, connectivity=4)
    cells = []
    for i in range(1, n):
        x, y, w, h, a = stats[i]
        if x == 0 or y == 0 or x + w >= W or y + h >= H:
            continue  # 外側 (紙の余白)
        if w < 14 or h < 14 or a < w * h * 0.6:
            continue
        cells.append({"x": int(x), "y": int(y), "w": int(w), "h": int(h)})
    cells.sort(key=lambda c: (c["y"], c["x"]))
    return cells, hl, vl


def cmd_cells(outdir, page, deg):
    pj = json.load(open(os.path.join(outdir, "pages.json"), encoding="utf-8"))
    pg = next(p for p in pj["pages"] if p["page"] == page)
    g = cv2.imread(pg["raw"], cv2.IMREAD_GRAYSCALE)
    g = rot(g, deg)
    g, ang = deskew(g)
    pd = os.path.join(outdir, f"p{page:02d}")
    os.makedirs(pd, exist_ok=True)
    cv2.imwrite(os.path.join(pd, "page.png"), g)
    cells, _, _ = detect_cells(g)
    with open(os.path.join(pd, "cells.json"), "w", encoding="utf-8") as f:
        json.dump({"page": page, "rotate": deg, "skew": round(ang, 2), "w": int(g.shape[1]), "h": int(g.shape[0]), "cells": cells}, f, ensure_ascii=False)
    print(json.dumps({"page": page, "rotate": deg, "skew": round(ang, 2), "cells": len(cells)}))


def split_digit_boxes(g, r):
    """番号の欄 (1 桁ずつ枠・点線で区切られた欄) を 1 文字ずつに分ける。
    区切り = 欄の上端と下端の両方の帯にインクがある縦の列 (点線も上下に届く。数字は上下に余白がある)。
    返り値: [(x0, x1)] (欄の中の x 範囲)"""
    x, y, w, h = r["x"], r["y"], r["w"], r["h"]
    c = g[y + 2: y + h - 2, x + 2: x + w - 2]
    ink = c < 140
    H, W = ink.shape
    band = max(2, int(H * 0.14))
    top, bot = ink[:band].any(0), ink[H - band:].any(0)
    mid = ink[band: H - band].mean(0)
    sep = top & bot & (mid > 0.25)
    # 区切りの列を 1 本ずつにまとめる
    seps, run = [], None
    for i, s in enumerate(sep):
        if s and run is None: run = i
        if not s and run is not None: seps.append((run, i)); run = None
    if run is not None: seps.append((run, W))
    edges = [0] + [ (a + b) // 2 for a, b in seps ] + [W]
    boxes = []
    for a, b in zip(edges, edges[1:]):
        if b - a >= max(6, H * 0.18):
            boxes.append((a, b))
    return boxes, c


def classify_char(cell):
    """1 文字の枠: 空 / ● (塗りつぶした丸) / 文字。● = 一番大きいインクの塊が 縦横ほぼ同じで 中まで詰まっている"""
    ink = (cell < 140).astype(np.uint8)
    if ink.mean() < 0.02:
        return "empty"
    n, lab, st, _ = cv2.connectedComponentsWithStats(ink, connectivity=8)
    if n <= 1:
        return "empty"
    i = 1 + int(np.argmax(st[1:, cv2.CC_STAT_AREA]))
    x, y, w, h, a = st[i]
    if h >= cell.shape[0] * 0.3 and 0.7 <= w / max(1, h) <= 1.4 and a / max(1, w * h) >= 0.6:
        return "dot"
    return "char"


def cmd_digits(outdir, page, rects_json):
    """番号の欄を 1 文字ずつに切る。rects_json = [{"key":..., "x","y","w","h"}] → 文字の画像と分類を返す"""
    pd = os.path.join(outdir, f"p{page:02d}")
    g = cv2.imread(os.path.join(pd, "page.png"), cv2.IMREAD_GRAYSCALE)
    rects = json.load(open(rects_json, encoding="utf-8"))
    out = []
    for r in rects:
        boxes, c = split_digit_boxes(g, r)
        chars = []
        for j, (a, b) in enumerate(boxes):
            sub = c[:, a:b]
            kind = classify_char(sub)
            item = {"kind": kind}
            if kind == "char":
                # 文字だけを切り出して 2 値化・高さ 64px にそろえ、余白を付ける
                # (枠の切れ端が端に残ると tesseract が空振りするので、端に触れるインクの塊は捨てる)
                bw = (sub < 150).astype(np.uint8)
                n, lab, st, _ = cv2.connectedComponentsWithStats(bw, connectivity=8)
                hh, ww = bw.shape
                keep = np.zeros_like(bw)
                for k in range(1, n):
                    x0, y0, w0, h0, a0 = st[k]
                    if x0 == 0 or y0 == 0 or x0 + w0 >= ww or y0 + h0 >= hh or a0 < 8:
                        continue
                    keep[lab == k] = 1
                ys, xs = np.nonzero(keep)
                if len(xs) == 0:
                    item["kind"] = "empty"
                    chars.append(item)
                    continue
                ch = 255 - keep[ys.min(): ys.max() + 1, xs.min(): xs.max() + 1] * 255
                s = 64 / ch.shape[0]
                ch = cv2.resize(ch.astype(np.uint8), (max(1, int(ch.shape[1] * s)), 64), interpolation=cv2.INTER_AREA)
                ch = cv2.copyMakeBorder(ch, 24, 24, 24, 24, cv2.BORDER_CONSTANT, value=255)
                p = os.path.join(pd, f"d_{r['key']}_{j:02d}.png")
                cv2.imwrite(p, ch)
                item["img"] = p
            chars.append(item)
        out.append({"key": r["key"], "boxes": len(boxes), "chars": chars})
    print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    a = sys.argv[1:]
    if not a:
        print(__doc__)
        sys.exit(1)
    if a[0] == "pages":
        # prep.py pages <PDF か 写真> <outdir> [<追加の PDF / 写真> …]
        cmd_pages([a[1]] + a[3:], a[2])
    elif a[0] == "cells":
        cmd_cells(a[1], int(a[2]), int(a[3]))
    elif a[0] == "digits":
        cmd_digits(a[1], int(a[2]), a[3])
    elif a[0] == "exportraw":
        # 補正していない元の画像 (写真・向き不明のページ) を Claude に送る JPEG にする: prep.py exportraw <outdir> <page> <長辺px>
        pj = json.load(open(os.path.join(a[1], "pages.json"), encoding="utf-8"))
        pg = next(p for p in pj["pages"] if p["page"] == int(a[2]))
        g = cv2.imread(pg["raw"], cv2.IMREAD_GRAYSCALE)
        s = int(a[3]) / max(g.shape)
        if s < 1:
            g = cv2.resize(g, None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
        pd = os.path.join(a[1], f"p{int(a[2]):02d}")
        os.makedirs(pd, exist_ok=True)
        p = os.path.join(pd, "send_raw.jpg")
        cv2.imwrite(p, g, [cv2.IMWRITE_JPEG_QUALITY, 85])
        print(json.dumps({"path": p, "w": int(g.shape[1]), "h": int(g.shape[0]), "bytes": os.path.getsize(p)}))
    elif a[0] == "export":
        # 補正済みのページを Claude に送る JPEG にする: prep.py export <outdir> <page> <長辺px>
        pd = os.path.join(a[1], f"p{int(a[2]):02d}")
        g = cv2.imread(os.path.join(pd, "page.png"), cv2.IMREAD_GRAYSCALE)
        s = int(a[3]) / max(g.shape)
        if s < 1:
            g = cv2.resize(g, None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
        p = os.path.join(pd, "send.jpg")
        cv2.imwrite(p, g, [cv2.IMWRITE_JPEG_QUALITY, 85])
        print(json.dumps({"path": p, "w": int(g.shape[1]), "h": int(g.shape[0]), "bytes": os.path.getsize(p)}))
    else:
        print(__doc__)
        sys.exit(1)
