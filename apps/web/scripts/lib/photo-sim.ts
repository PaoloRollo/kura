import sharp from "sharp";

/** Deterministic PRNG (mulberry32). */
export function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Pt = [number, number];

/** 3x3 homography (row-major, h33 = 1) mapping each `from` point to its `to` point. */
function homography(from: Pt[], to: Pt[]): number[] {
  const a: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = from[i];
    const [u, v] = to[i];
    a.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    a.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
    [a[c], a[p]] = [a[p], a[c]];
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = a[r][c] / a[c][c];
      for (let k = c; k < 9; k++) a[r][k] -= f * a[c][k];
    }
  }
  return [...a.map((row, i) => row[8] / row[i]), 1];
}

/**
 * Turn a clean Scryfall scan into a plausible webcam crop of the capture guide: the card slightly
 * rotated (±6°), perspective-skewed, 8% scale/offset jitter against a desk background, brightness /
 * contrast / colour-temperature jitter, a glare blob, sensor noise, gaussian blur and JPEG q60.
 */
export async function simulatePhoto(scan: Buffer, seed: number): Promise<Buffer> {
  const rand = prng(seed);
  const span = (lo: number, hi: number) => lo + (hi - lo) * rand();
  const { data: src, info } = await sharp(scan).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height;

  // Where the card's corners land in the guide frame (same size as the scan).
  const scale = span(0.92, 1.08);
  const theta = (span(-6, 6) * Math.PI) / 180;
  const cx = W / 2 + span(-0.04, 0.04) * W, cy = H / 2 + span(-0.04, 0.04) * H;
  const skew = 0.03;
  const corners: Pt[] = [[0, 0], [W, 0], [W, H], [0, H]];
  const placed: Pt[] = corners.map(([x, y]) => {
    const px = (x - W / 2) * scale + span(-skew, skew) * W;
    const py = (y - H / 2) * scale + span(-skew, skew) * H;
    return [cx + px * Math.cos(theta) - py * Math.sin(theta), cy + px * Math.sin(theta) + py * Math.cos(theta)];
  });
  const h = homography(placed, corners); // guide frame -> scan

  const brightness = span(0.75, 1.2), contrast = span(0.8, 1.2), temp = span(-0.08, 0.08);
  const desk = [span(20, 110), span(20, 90), span(15, 80)];
  const glare = { x: span(0.1, 0.9) * W, y: span(0.1, 0.9) * H, r: span(0.08, 0.22) * W, a: span(0.25, 0.6) };

  const out = Buffer.alloc(W * H * 3);
  const px = [0, 0, 0];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const w = h[6] * x + h[7] * y + h[8];
      const u = (h[0] * x + h[1] * y + h[2]) / w;
      const v = (h[3] * x + h[4] * y + h[5]) / w;
      if (u >= 0 && v >= 0 && u < W - 1 && v < H - 1) {
        const x0 = Math.floor(u), y0 = Math.floor(v), fx = u - x0, fy = v - y0;
        for (let c = 0; c < 3; c++) {
          const i = (y0 * W + x0) * 3 + c;
          px[c] = (src[i] * (1 - fx) + src[i + 3] * fx) * (1 - fy) + (src[i + W * 3] * (1 - fx) + src[i + W * 3 + 3] * fx) * fy;
        }
      } else {
        for (let c = 0; c < 3; c++) px[c] = desk[c] + span(-8, 8);
      }
      const d2 = (x - glare.x) ** 2 + (y - glare.y) ** 2;
      const g = glare.a * Math.exp(-d2 / (2 * glare.r * glare.r));
      for (let c = 0; c < 3; c++) {
        let val = ((px[c] / 255 - 0.5) * contrast + 0.5) * brightness * 255;
        if (c === 0) val *= 1 + temp;
        if (c === 2) val *= 1 - temp;
        val += (255 - val) * g + span(-3, 3);
        out[(y * W + x) * 3 + c] = Math.max(0, Math.min(255, Math.round(val)));
      }
    }
  }
  return sharp(out, { raw: { width: W, height: H, channels: 3 } }).blur(span(0.4, 1.3)).jpeg({ quality: 60 }).toBuffer();
}
