import { escapeHtml } from './web-dashboard-sheet.utils.js';

/** One labelled figure a chart draws: a bar, or a point on a line. */
export interface ChartDatum {
  label: string;
  value: number;
}

interface ChartOptions {
  /** Names the chart: the SVG's `<title>` and the head of its figure line. */
  title: string;
  /** How a value prints, on the chart and in its figure line; plain numbers by default. */
  format?: (value: number) => string;
}

/**
 * The marks' look, carried by classes so the page's theme tokens reach them:
 * the dashboard's CSP admits no `style` attribute, and a presentation
 * attribute does not resolve `var()`. One sequential hue for every mark, since
 * each chart here draws a single series; text stays in the ink ramp.
 */
export const CHART_CSS = `  figure.chart { margin: 4px 0 0; }
  figure.chart svg { display: block; width: 100%; height: auto; max-width: 560px; }
  figure.chart .mark { fill: var(--debt-1); }
  figure.chart .line { fill: none; stroke: var(--debt-1); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
  figure.chart .dot { fill: var(--debt-1); stroke: var(--surface); stroke-width: 2; }
  figure.chart .base { stroke: var(--baseline); stroke-width: 1; }
  figure.chart .axis { fill: var(--muted); font: 11px system-ui, -apple-system, sans-serif; }
  figure.chart .value { fill: var(--ink-2); font: 11px system-ui, -apple-system, sans-serif; }
  figure.chart figcaption { color: var(--ink-2); font-size: 12px; margin-top: 4px; }
  figure.spark svg { max-width: 120px; }`;

const WIDTH = 560;
const AXIS_FONT_PX = 11;
/** Width the rows layout gives its labels; a longer one keeps its tail, where a path's file name is. */
const ROW_LABEL_CHARS = 38;
const ROW_HEIGHT = 22;
const BAR_RADIUS = 4;

const plain = (value: number): string => String(value);

/**
 * A bar's length: a value that is not a finite non-negative number draws no
 * mark, where it would scale every other bar to NaN. Its figure still prints.
 */
const drawable = (value: number): number => (Number.isFinite(value) ? Math.max(0, value) : 0);

/**
 * The SVG and, under it, the figure line: every value in words, so the
 * numbers read without the chart — to a screen reader, in a text-only
 * browser, or when the drawing is too small to tell two bars apart.
 */
function figure(
  className: string,
  { title, format = plain }: ChartOptions,
  data: ChartDatum[],
  height: number,
  width: number,
  marks: string,
): string {
  const figures = data.map((d) => `${d.label} ${format(d.value)}`).join(' · ');
  return (
    `<figure class="${className}"><svg viewBox="0 0 ${width} ${height}" role="img">` +
    `<title>${escapeHtml(`${title}: ${figures}`)}</title>${marks}</svg>` +
    `<figcaption>${escapeHtml(`${title}: ${figures}`)}</figcaption></figure>`
  );
}

/** Two decimals at most, so a coordinate does not carry float noise into the page. */
const at = (n: number): string => String(Math.round(n * 100) / 100);

/** A bar rounded at its data end only, the end away from the baseline. */
function bar(x: number, y: number, w: number, h: number, horizontal: boolean): string {
  const r = Math.min(BAR_RADIUS, w / 2, h / 2);
  return horizontal
    ? `<path class="mark" d="M${at(x)} ${at(y)}H${at(x + w - r)}Q${at(x + w)} ${at(y)} ${at(x + w)} ${at(y + r)}V${at(y + h - r)}Q${at(x + w)} ${at(y + h)} ${at(x + w - r)} ${at(y + h)}H${at(x)}Z"/>`
    : `<path class="mark" d="M${at(x)} ${at(y + h)}V${at(y + r)}Q${at(x)} ${at(y)} ${at(x + r)} ${at(y)}H${at(x + w - r)}Q${at(x + w)} ${at(y)} ${at(x + w)} ${at(y + r)}V${at(y + h)}Z"/>`;
}

/** A label cut to fit, keeping its end: `…/core/web-dashboard.service.ts`. */
function fitLabel(label: string, chars: number): string {
  return label.length <= chars ? label : `…${label.slice(label.length - chars + 1)}`;
}

/**
 * A bar chart of non-negative values. `columns` stands the bars on a shared
 * baseline in the data's order, for a series in time; `rows` lays them out
 * one per line with the label before and the value after, for a ranking whose
 * labels are long (file paths). Every bar carries its own `<title>`, so a
 * hover names the bar without a script.
 */
export function barChart(
  data: ChartDatum[],
  options: ChartOptions & { layout?: 'columns' | 'rows' },
): string {
  const format = options.format ?? plain;
  const max = Math.max(1, ...data.map((d) => drawable(d.value)));
  const tip = (d: ChartDatum): string =>
    `<title>${escapeHtml(`${d.label}: ${format(d.value)}`)}</title>`;
  if (options.layout === 'rows') {
    const labelWidth = ROW_LABEL_CHARS * AXIS_FONT_PX * 0.6;
    const valueWidth = 48;
    const plotWidth = WIDTH - labelWidth - valueWidth;
    const marks = data.map((d, i) => {
      const y = i * ROW_HEIGHT;
      const w = (drawable(d.value) / max) * plotWidth;
      return (
        `<g>${tip(d)}<text class="axis" x="${at(labelWidth - 6)}" y="${at(y + 15)}" text-anchor="end">${escapeHtml(fitLabel(d.label, ROW_LABEL_CHARS))}</text>` +
        (w > 0 ? bar(labelWidth, y + 4, w, ROW_HEIGHT - 8, true) : '') +
        `<text class="value" x="${at(labelWidth + w + 4)}" y="${at(y + 15)}">${escapeHtml(format(d.value))}</text></g>`
      );
    });
    return figure('chart', options, data, data.length * ROW_HEIGHT, WIDTH, marks.join(''));
  }
  const height = 140;
  const top = 16;
  const base = height - 20;
  const slot = WIDTH / Math.max(1, data.length);
  const barWidth = Math.min(48, slot * 0.6);
  const marks = data.map((d, i) => {
    const h = (drawable(d.value) / max) * (base - top);
    const x = i * slot + (slot - barWidth) / 2;
    return (
      `<g>${tip(d)}${h > 0 ? bar(x, base - h, barWidth, h, false) : ''}` +
      `<text class="value" x="${at(x + barWidth / 2)}" y="${at(base - h - 4)}" text-anchor="middle">${escapeHtml(format(d.value))}</text>` +
      `<text class="axis" x="${at(i * slot + slot / 2)}" y="${height - 4}" text-anchor="middle">${escapeHtml(d.label)}</text></g>`
    );
  });
  return figure(
    'chart',
    options,
    data,
    height,
    WIDTH,
    `<line class="base" x1="0" x2="${WIDTH}" y1="${base}" y2="${base}"/>${marks.join('')}`,
  );
}

/** Where each value falls in a box, x evenly spaced, y scaled between the series' own min and max. */
function points(
  values: number[],
  box: { left: number; top: number; width: number; height: number },
): [number, number][] {
  const finite = values.map((value) => (Number.isFinite(value) ? value : 0));
  const min = Math.min(...finite);
  // Halved, so two finite extremes (±1e308) cannot overflow the span to Infinity.
  const span = Math.max(...finite) / 2 - min / 2 || 1;
  const step = values.length > 1 ? box.width / (values.length - 1) : 0;
  return finite.map((value, i) => [
    box.left + i * step,
    box.top + box.height - ((value / 2 - min / 2) / span) * box.height,
  ]);
}

const polyline = (coords: [number, number][]): string =>
  `<polyline class="line" points="${coords.map(([x, y]) => `${at(x)},${at(y)}`).join(' ')}"/>`;

/**
 * A line over a series in time, scaled to its own range: what it shows is the
 * shape of the change, so the first and last values are labelled at their
 * ends and the figure line carries every one.
 */
export function lineChart(data: ChartDatum[], options: ChartOptions): string {
  const format = options.format ?? plain;
  const height = 140;
  const coords = points(
    data.map((d) => d.value),
    { left: 8, top: 16, width: WIDTH - 16, height: height - 44 },
  );
  const ends = [0, data.length - 1].filter((i, n, all) => all.indexOf(i) === n);
  const marks = ends.map((i) => {
    const [x, y] = coords[i] as [number, number];
    const d = data[i] as ChartDatum;
    const anchor = i === 0 ? 'start' : 'end';
    return (
      `<g><title>${escapeHtml(`${d.label}: ${format(d.value)}`)}</title><circle class="dot" cx="${at(x)}" cy="${at(y)}" r="4"/>` +
      `<text class="value" x="${at(x)}" y="${at(y - 8)}" text-anchor="${anchor}">${escapeHtml(format(d.value))}</text>` +
      `<text class="axis" x="${at(x)}" y="${height - 4}" text-anchor="${anchor}">${escapeHtml(d.label)}</text></g>`
    );
  });
  const base = height - 20;
  return figure(
    'chart',
    options,
    data,
    height,
    WIDTH,
    `<line class="base" x1="0" x2="${WIDTH}" y1="${base}" y2="${base}"/>${polyline(coords)}${marks.join('')}`,
  );
}

/** A line small enough to sit in a figure tile: no axis, the last value dotted. */
export function sparkline(data: ChartDatum[], options: ChartOptions): string {
  const width = 120;
  const height = 28;
  const coords = points(
    data.map((d) => d.value),
    { left: 4, top: 4, width: width - 8, height: height - 8 },
  );
  const [x, y] = coords.at(-1) as [number, number];
  return figure(
    'chart spark',
    options,
    data,
    height,
    width,
    `${polyline(coords)}<circle class="dot" cx="${at(x)}" cy="${at(y)}" r="3"/>`,
  );
}
