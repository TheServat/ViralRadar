/**
 * What a thumbnail looks like, as numbers.
 *
 * The title analysis can say a hundred-character title beats a twenty-character
 * one, with an interval attached. It says nothing about the image, which for a
 * video audience is at least half the click. This closes that gap with the same
 * statistics and the same honesty.
 *
 * Pure functions over raw pixels and raw file bytes: no network, no decoding,
 * no `ffmpeg`. Whatever produced the pixels is somebody else's problem, which
 * is what makes every one of these measurable in a test rather than only
 * against a live thumbnail.
 *
 * These are deliberately crude measures. "Is there a face" is approximated by
 * counting skin-toned pixels, which a wooden table also satisfies. That is
 * acceptable because the analysis around them reports sample sizes and
 * confidence intervals: a crude signal measured honestly across thousands of
 * items is useful, where a sophisticated one presented as certainty is not.
 */

export interface ImageFeatures {
  /** Mean perceived lightness, 0..1. */
  readonly brightness: number;
  /** Spread of lightness, 0..1. Low is flat, high is punchy. */
  readonly contrast: number;
  /** Mean colour intensity, 0..1. Low is washed out, high is vivid. */
  readonly saturation: number;
  /** Red against blue, 0..1. Below .5 is cool, above is warm. */
  readonly warmth: number;
  /** Fraction of pixels in a skin-tone range, 0..1. A crude "is a person in it". */
  readonly skin: number;
}

/**
 * Perceived lightness rather than the plain average of the channels.
 *
 * Green carries most of what the eye reads as brightness and blue almost none,
 * so a flat mean would call a saturated blue image as bright as a yellow one.
 * These are the Rec. 601 luma coefficients.
 */
function luma(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/**
 * Skin tone, by the Kovac rule.
 *
 * Cheap, well-known, and wrong often enough to be described as what it is: a
 * count of pixels in a colour range that human skin occupies, under daylight,
 * for some skin tones more reliably than others. Wood, sand and orange walls
 * all pass. It is a hint that a person may be in frame, not a face detector,
 * and nothing downstream should call it one.
 */
function isSkin(r: number, g: number, b: number): boolean {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return (
    r > 95 && g > 40 && b > 20 && max - min > 15 && Math.abs(r - g) > 15 && r > g && r > b
  );
}

/**
 * Reads features out of raw 8-bit RGB.
 *
 * Expects `rgb.length` to be a multiple of three. A truncated buffer is
 * measured over the whole pixels it does contain rather than rejected — a
 * frame that arrived slightly short is still worth reading, and throwing here
 * would lose the item entirely over a rounding error somewhere upstream.
 */
export function featuresOfRgb(rgb: Uint8Array): ImageFeatures | null {
  const pixels = Math.floor(rgb.length / 3);
  if (pixels === 0) return null;

  let sumLuma = 0;
  let sumSquares = 0;
  let sumSaturation = 0;
  let sumR = 0;
  let sumB = 0;
  let skinCount = 0;

  for (let i = 0; i < pixels; i++) {
    const r = rgb[i * 3] as number;
    const g = rgb[i * 3 + 1] as number;
    const b = rgb[i * 3 + 2] as number;

    const l = luma(r, g, b);
    sumLuma += l;
    sumSquares += l * l;

    // Saturation as the spread between the strongest and weakest channel,
    // which is the HSV definition and needs no conversion.
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    sumSaturation += max === 0 ? 0 : (max - min) / max;

    sumR += r;
    sumB += b;
    if (isSkin(r, g, b)) skinCount++;
  }

  const meanLuma = sumLuma / pixels;
  // Population standard deviation, clamped: floating point can push the
  // variance a hair below zero when every pixel is identical.
  const variance = Math.max(0, sumSquares / pixels - meanLuma * meanLuma);

  const meanR = sumR / pixels;
  const meanB = sumB / pixels;
  const warmthRange = meanR + meanB;

  return {
    brightness: meanLuma / 255,
    // Divided by 128 rather than 255: the standard deviation of a bounded
    // 0..255 signal cannot exceed 127.5, so this maps the real range onto 0..1
    // instead of leaving the top half of the scale permanently unreachable.
    contrast: Math.min(1, Math.sqrt(variance) / 128),
    saturation: sumSaturation / pixels,
    // A neutral image sits at exactly .5 rather than at zero.
    warmth: warmthRange === 0 ? 0.5 : meanR / warmthRange,
    skin: skinCount / pixels,
  };
}

// ── JPEG headers ───────────────────────────────────────────────────────────

export interface JpegInfo {
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  /**
   * Compressed bytes per pixel.
   *
   * A useful measure on its own, and the only one here that needs no pixels at
   * all: a busy thumbnail full of text, faces and edges cannot be compressed as
   * hard as a flat one, so this reads as visual complexity. It is why the
   * analysis still says something even where `ffmpeg` is not installed.
   */
  readonly density: number;
}

/**
 * Dimensions from the JPEG frame header.
 *
 * Walks the marker segments rather than decoding anything. Returns null for
 * anything that is not a JPEG, or whose header is truncated — both of which
 * happen when a fetch fails and returns an error page with an image URL.
 */
export function readJpegInfo(bytes: Uint8Array): JpegInfo | null {
  // Start of Image.
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;

  let i = 2;
  // `i + 9 <= length`, because reading a frame header touches bytes[i+8]. The
  // stricter `<` skipped a header that sat at the very end of the buffer.
  while (i + 9 <= bytes.length) {
    // Markers are 0xFF followed by a type; padding 0xFF bytes are legal.
    if (bytes[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = bytes[i + 1] as number;
    if (marker === 0xff) {
      i++;
      continue;
    }

    // Standalone markers carry no length.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }

    const length = ((bytes[i + 2] as number) << 8) | (bytes[i + 3] as number);
    if (length < 2) return null;

    // Any Start of Frame carries the dimensions. Excludes DHT (0xC4), JPG
    // (0xC8) and DAC (0xCC), which sit in the same numeric range but are not
    // frame headers.
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      const height = ((bytes[i + 5] as number) << 8) | (bytes[i + 6] as number);
      const width = ((bytes[i + 7] as number) << 8) | (bytes[i + 8] as number);
      if (width <= 0 || height <= 0) return null;
      return {
        width,
        height,
        bytes: bytes.length,
        density: bytes.length / (width * height),
      };
    }

    i += 2 + length;
  }
  return null;
}
