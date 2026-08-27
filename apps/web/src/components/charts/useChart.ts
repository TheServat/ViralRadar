/**
 * Shared chart machinery: scales, ticks, palette.
 *
 * These are hand-built SVG charts rather than a charting library. Three reasons
 * that matter here: they inherit the theme through CSS custom properties, so
 * light and dark need no configuration; they mirror correctly in a
 * right-to-left layout, which canvas-based libraries do not; and they cost a
 * few kilobytes next to the hundreds a general-purpose library adds.
 */
import { STATE_COLORS } from '@/plugins/vuetify';

/** A categorical palette that stays legible on both themes. */
export const SERIES_COLORS = [
  '#5b8cff',
  '#46d39a',
  '#ffd23d',
  '#ff8a3d',
  '#9b8cff',
  '#ff4d5e',
  '#38bdf8',
  '#f472b6',
  '#a3e635',
  '#fb923c',
] as const;

export function seriesColor(index: number): string {
  return SERIES_COLORS[index % SERIES_COLORS.length] as string;
}

/** Stable colour per source, so a platform looks the same on every chart. */
const SOURCE_ORDER = [
  'youtube',
  'reddit',
  'hackernews',
  'googletrends',
  'googlenews',
  'rss',
  'telegram',
  'mastodon',
  'bluesky',
  'github',
  'wikipedia',
  'charts',
];

export function sourceColor(source: string): string {
  const index = SOURCE_ORDER.indexOf(source);
  return seriesColor(index >= 0 ? index : SOURCE_ORDER.length + source.length);
}

export function stateColorOf(state: string): string {
  return STATE_COLORS[state as keyof typeof STATE_COLORS] ?? STATE_COLORS.DEAD;
}

export interface Scale {
  (value: number): number;
  readonly domain: readonly [number, number];
  readonly range: readonly [number, number];
}

export function linearScale(domain: readonly [number, number], range: readonly [number, number]): Scale {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0 || 1;
  const fn = ((value: number) => r0 + ((value - d0) / span) * (r1 - r0)) as {
    (value: number): number;
    domain: readonly [number, number];
    range: readonly [number, number];
  };
  fn.domain = domain;
  fn.range = range;
  return fn as Scale;
}

/**
 * A log scale that tolerates zero.
 *
 * Reach and growth both span several orders of magnitude - a 2,000-view clip
 * and a 40M-view one belong on the same axis - and log1p keeps zero placed
 * rather than undefined.
 */
export function logScale(domain: readonly [number, number], range: readonly [number, number]): Scale {
  const lo = Math.log1p(Math.max(0, domain[0]));
  const hi = Math.log1p(Math.max(1, domain[1]));
  const span = hi - lo || 1;
  const fn = ((value: number) => {
    const v = Math.log1p(Math.max(0, value));
    return range[0] + ((v - lo) / span) * (range[1] - range[0]);
  }) as { (value: number): number; domain: readonly [number, number]; range: readonly [number, number] };
  fn.domain = domain;
  fn.range = range;
  return fn as Scale;
}

/** Round numbers a person would actually choose for an axis. */
export function niceTicks(min: number, max: number, count = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) return [min];
  const span = max - min;
  const rawStep = span / Math.max(1, count);
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalised = rawStep / magnitude;
  const step = (normalised >= 5 ? 5 : normalised >= 2 ? 2 : 1) * magnitude;
  const start = Math.ceil(min / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= max + step / 1000; v += step) ticks.push(Number(v.toFixed(10)));
  return ticks;
}

export function extent(values: readonly number[]): [number, number] {
  if (values.length === 0) return [0, 1];
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min)) return [0, 1];
  return [min, max];
}

/** Catmull-Rom to cubic Bezier: a smooth line that still passes through every point. */
export function smoothPath(points: readonly (readonly [number, number])[], tension = 0.35): string {
  if (points.length === 0) return '';
  if (points.length < 3) {
    return points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
  }

  let d = `M${(points[0] as readonly [number, number])[0].toFixed(2)},${(points[0] as readonly [number, number])[1].toFixed(2)}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)] as readonly [number, number];
    const p1 = points[i] as readonly [number, number];
    const p2 = points[i + 1] as readonly [number, number];
    const p3 = points[Math.min(points.length - 1, i + 2)] as readonly [number, number];

    const c1x = p1[0] + ((p2[0] - p0[0]) / 6) * tension * 2;
    const c1y = p1[1] + ((p2[1] - p0[1]) / 6) * tension * 2;
    const c2x = p2[0] - ((p3[0] - p1[0]) / 6) * tension * 2;
    const c2y = p2[1] - ((p3[1] - p1[1]) / 6) * tension * 2;

    d += ` C${c1x.toFixed(2)},${c1y.toFixed(2)} ${c2x.toFixed(2)},${c2y.toFixed(2)} ${p2[0].toFixed(2)},${p2[1].toFixed(2)}`;
  }
  return d;
}

export function linePath(points: readonly (readonly [number, number])[]): string {
  return points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
}

/** Arc path for a donut segment, angles in radians from twelve o'clock. */
export function arcPath(
  cx: number,
  cy: number,
  outer: number,
  inner: number,
  start: number,
  end: number,
): string {
  const large = end - start > Math.PI ? 1 : 0;
  const p = (radius: number, angle: number): [number, number] => [
    cx + radius * Math.sin(angle),
    cy - radius * Math.cos(angle),
  ];
  const [x1, y1] = p(outer, start);
  const [x2, y2] = p(outer, end);
  const [x3, y3] = p(inner, end);
  const [x4, y4] = p(inner, start);
  return (
    `M${x1.toFixed(2)},${y1.toFixed(2)} A${outer},${outer} 0 ${large} 1 ${x2.toFixed(2)},${y2.toFixed(2)} ` +
    `L${x3.toFixed(2)},${y3.toFixed(2)} A${inner},${inner} 0 ${large} 0 ${x4.toFixed(2)},${y4.toFixed(2)} Z`
  );
}

export interface Margin {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export const DEFAULT_MARGIN: Margin = { top: 12, right: 16, bottom: 28, left: 46 };
