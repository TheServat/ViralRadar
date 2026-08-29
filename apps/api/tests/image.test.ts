/**
 * Reading a thumbnail as numbers.
 *
 * These functions are the reason the feature can be trusted at all: they are
 * pure, so every claim the interface makes about an image traces back to
 * something checked here against pixels whose answer is known by construction.
 *
 * The measures are crude by design — skin-toned pixels are not a face. What the
 * tests pin down is that each one moves in the direction it claims to, and that
 * malformed input produces null rather than a confident wrong number.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

process.env['RADAR_NO_ENV_FILE'] = '1';
process.env['LOG_LEVEL'] = 'error';

const { featuresOfRgb, readJpegInfo } = await import('../src/core/image.ts');
const { analyzeThumbnails } = await import('../src/core/thumbnail.ts');
import type { ThumbnailSample } from '../src/core/thumbnail.ts';

/** A solid block of one colour, `n` pixels wide. */
function solid(r: number, g: number, b: number, n = 64): Uint8Array {
  const out = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    out[i * 3] = r;
    out[i * 3 + 1] = g;
    out[i * 3 + 2] = b;
  }
  return out;
}

/** Half one colour, half another. */
function halves(a: [number, number, number], b: [number, number, number], n = 64): Uint8Array {
  const out = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    const [r, g, bl] = i < n / 2 ? a : b;
    out[i * 3] = r;
    out[i * 3 + 1] = g;
    out[i * 3 + 2] = bl;
  }
  return out;
}

describe('brightness', () => {
  test('black is 0 and white is 1', () => {
    assert.ok((featuresOfRgb(solid(0, 0, 0))?.brightness ?? -1) < 0.001);
    assert.ok((featuresOfRgb(solid(255, 255, 255))?.brightness ?? 0) > 0.999);
  });

  test('follows perceived lightness, not the channel average', () => {
    // Pure green and pure blue have the same channel average; the eye does not
    // see them as equally bright, and neither should this.
    const green = featuresOfRgb(solid(0, 255, 0))?.brightness ?? 0;
    const blue = featuresOfRgb(solid(0, 0, 255))?.brightness ?? 0;
    assert.ok(green > blue * 3, `green ${green} should far exceed blue ${blue}`);
  });
});

describe('contrast', () => {
  test('a flat image has none', () => {
    assert.ok((featuresOfRgb(solid(128, 128, 128))?.contrast ?? 1) < 0.001);
  });

  test('black against white is near the top of the scale', () => {
    const c = featuresOfRgb(halves([0, 0, 0], [255, 255, 255]))?.contrast ?? 0;
    assert.ok(c > 0.9, `expected near 1, got ${c}`);
  });

  test('a mild difference sits between the two', () => {
    const mild = featuresOfRgb(halves([110, 110, 110], [145, 145, 145]))?.contrast ?? 0;
    assert.ok(mild > 0 && mild < 0.3, `expected a small value, got ${mild}`);
  });
});

describe('saturation', () => {
  test('grey has none and a pure hue is full', () => {
    assert.ok((featuresOfRgb(solid(128, 128, 128))?.saturation ?? 1) < 0.001);
    assert.ok((featuresOfRgb(solid(255, 0, 0))?.saturation ?? 0) > 0.999);
  });

  test('black does not divide by zero', () => {
    const s = featuresOfRgb(solid(0, 0, 0))?.saturation;
    assert.equal(s, 0);
  });
});

describe('warmth', () => {
  test('neutral sits at the middle', () => {
    assert.ok(Math.abs((featuresOfRgb(solid(120, 120, 120))?.warmth ?? 0) - 0.5) < 0.001);
  });

  test('red reads warm and blue reads cool', () => {
    assert.ok((featuresOfRgb(solid(255, 0, 0))?.warmth ?? 0) > 0.9);
    assert.ok((featuresOfRgb(solid(0, 0, 255))?.warmth ?? 1) < 0.1);
  });

  test('pure black is neutral rather than undefined', () => {
    assert.equal(featuresOfRgb(solid(0, 0, 0))?.warmth, 0.5);
  });
});

describe('skin coverage', () => {
  test('a skin tone is counted', () => {
    // A mid-range tone that satisfies the rule.
    assert.ok((featuresOfRgb(solid(200, 150, 120))?.skin ?? 0) > 0.99);
  });

  test('blue, grey and green are not', () => {
    for (const [r, g, b] of [[0, 0, 255], [128, 128, 128], [0, 200, 0]] as const) {
      assert.equal(featuresOfRgb(solid(r, g, b))?.skin, 0, `${r},${g},${b} should not read as skin`);
    }
  });

  test('half a frame of skin reads as half', () => {
    const s = featuresOfRgb(halves([200, 150, 120], [0, 0, 255]))?.skin ?? 0;
    assert.ok(Math.abs(s - 0.5) < 0.02, `expected ~0.5, got ${s}`);
  });
});

describe('malformed pixels', () => {
  test('an empty buffer is null, not a zeroed reading', () => {
    assert.equal(featuresOfRgb(new Uint8Array(0)), null);
  });

  test('a truncated buffer is measured over the whole pixels it has', () => {
    // Four bytes is one complete pixel plus a stray. Losing the item entirely
    // over a rounding error upstream would be worse than reading the one pixel.
    const out = featuresOfRgb(new Uint8Array([255, 255, 255, 7]));
    assert.ok(out !== null);
    assert.ok(out.brightness > 0.99);
  });
});

describe('JPEG headers', () => {
  /** A minimal JPEG: SOI, an APP0 segment, then a frame header. */
  function jpeg(width: number, height: number, pad = 0): Uint8Array {
    const head = [
      0xff, 0xd8, // SOI
      0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, // APP0, length 4
      0xff, 0xc0, 0x00, 0x11, 0x08, // SOF0, length 17, precision 8
      (height >> 8) & 0xff, height & 0xff,
      (width >> 8) & 0xff, width & 0xff,
    ];
    return new Uint8Array([...head, ...new Array<number>(pad).fill(0)]);
  }

  test('reads the dimensions past other segments', () => {
    const info = readJpegInfo(jpeg(480, 360));
    assert.equal(info?.width, 480);
    assert.equal(info?.height, 360);
  });

  test('density is bytes over pixels', () => {
    const info = readJpegInfo(jpeg(100, 100, 4000));
    assert.ok(info !== null);
    assert.ok(Math.abs(info.density - info.bytes / 10_000) < 1e-9);
  });

  test('anything that is not a JPEG is null', () => {
    assert.equal(readJpegInfo(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), null, 'PNG');
    assert.equal(readJpegInfo(new Uint8Array([])), null, 'empty');
    // The case that actually happens: a fetch failed and returned an HTML page.
    assert.equal(readJpegInfo(new TextEncoder().encode('<!DOCTYPE html><html>')), null, 'HTML');
  });

  test('a truncated header is null rather than a guess', () => {
    assert.equal(readJpegInfo(new Uint8Array([0xff, 0xd8, 0xff, 0xc0])), null);
  });

  test('a Huffman table is not mistaken for a frame header', () => {
    // 0xC4 sits in the same numeric range as the frame markers and must be
    // skipped, or its contents get read as width and height.
    const bytes = new Uint8Array([
      0xff, 0xd8,
      0xff, 0xc4, 0x00, 0x06, 0x01, 0x02, 0x03, 0x04, // DHT
      0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c, 0x01, 0xe0, // SOF0: 300x480
    ]);
    const info = readJpegInfo(bytes);
    assert.equal(info?.height, 300);
    assert.equal(info?.width, 480);
  });
});

describe('the thumbnail analysis', () => {
  function sample(percentile: number, over: Partial<ThumbnailSample> = {}): ThumbnailSample {
    return {
      percentile,
      score: percentile * 100,
      density: null,
      brightness: null,
      contrast: null,
      saturation: null,
      warmth: null,
      skin: null,
      ...over,
    };
  }

  test('an empty set produces nothing rather than dividing by zero', () => {
    const r = analyzeThumbnails([]);
    assert.equal(r.n, 0);
    assert.deepEqual(r.findings, []);
  });

  test('an unmeasured image lands in no bucket', () => {
    // Null is not "dark". Bucketing it as the nearest band would invent data.
    const r = analyzeThumbnails(Array.from({ length: 40 }, () => sample(0.4)));
    assert.equal(r.n, 40);
    assert.equal(r.groups.length, 0);
    assert.equal(r.withPixels, 0);
  });

  test('a real difference between bands is found', () => {
    const bright = Array.from({ length: 40 }, (_, i) => sample(0.75 + (i % 2) * 0.04, { brightness: 0.8 }));
    const dark = Array.from({ length: 40 }, (_, i) => sample(0.25 + (i % 2) * 0.04, { brightness: 0.2 }));
    const r = analyzeThumbnails([...bright, ...dark]);
    const group = r.groups.find((g) => g.key === 'brightness');
    const veryBright = group?.buckets.find((b) => b.key === 'veryBright');
    assert.ok(veryBright?.significant, 'a 50-point gap should be a finding');
    assert.ok(veryBright.lift > 0);
  });

  test('a thin band is shown but never called a result', () => {
    // Three items at a wildly better rank: the shape that produces a
    // confident-looking lie if sample size is not respected.
    const many = Array.from({ length: 60 }, (_, i) => sample(0.3 + (i % 2) * 0.06, { brightness: 0.2 }));
    const few = Array.from({ length: 3 }, () => sample(0.95, { brightness: 0.9 }));
    const r = analyzeThumbnails([...many, ...few]);
    const veryBright = r.groups
      .find((g) => g.key === 'brightness')
      ?.buckets.find((b) => b.key === 'veryBright');
    assert.equal(veryBright?.n, 3);
    assert.equal(veryBright?.thin, true);
    assert.equal(veryBright?.significant, false);
    assert.ok(!r.findings.some((f) => f.key === 'veryBright'), 'three items must not be a finding');
  });

  test('bands read in their natural order, not strongest first', () => {
    const r = analyzeThumbnails([
      ...Array.from({ length: 30 }, () => sample(0.8, { brightness: 0.9 })),
      ...Array.from({ length: 30 }, () => sample(0.3, { brightness: 0.2 })),
    ]);
    const keys = r.groups.find((g) => g.key === 'brightness')?.buckets.map((b) => b.key);
    assert.deepEqual(keys, ['dark', 'veryBright']);
  });
});
