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
  figure.chart .marker { stroke: var(--muted); stroke-width: 1; stroke-dasharray: 2 3; }
  figure.chart .hit { stroke: transparent; stroke-width: 8; }
  figure.chart .axis { fill: var(--muted); font: 11px system-ui, -apple-system, sans-serif; }
  figure.chart .value { fill: var(--ink-2); font: 11px system-ui, -apple-system, sans-serif; }
  figure.chart figcaption { color: var(--ink-2); font-size: 12px; margin-top: 4px; }
  figure.spark svg { max-width: 120px; }
  .treemap figure.chart svg { max-width: 720px; }
  .treemap .cell { fill: var(--grid); stroke: var(--surface); stroke-width: 0.5; }
  .treemap .group { fill: none; stroke: var(--surface); stroke-width: 2; }
  .treemap .group-label { fill: var(--ink); font: 600 11px system-ui, -apple-system, sans-serif; paint-order: stroke; stroke: var(--surface); stroke-width: 3; }
  .treemap .tones { font-size: 12px; color: var(--ink-2); }
  .treemap input:nth-of-type(1):checked ~ figure .t0-1, .treemap input:nth-of-type(2):checked ~ figure .t1-1 { fill: var(--debt-0); }
  .treemap input:nth-of-type(1):checked ~ figure .t0-2, .treemap input:nth-of-type(2):checked ~ figure .t1-2 { fill: var(--debt-1); }
  .treemap input:nth-of-type(1):checked ~ figure .t0-3, .treemap input:nth-of-type(2):checked ~ figure .t1-3 { fill: var(--debt-3); }`;

const WIDTH = 560;
/** The columns' and the line's height, and where their baseline sits, above the axis labels. */
const PLOT_HEIGHT = 140;
const PLOT_BASE = PLOT_HEIGHT - 20;
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
  return framed(className, `${title}: ${figures}`, height, width, marks);
}

/** The figure around an SVG, its title and its figure line one text. */
function framed(
  className: string,
  caption: string,
  height: number,
  width: number,
  marks: string,
): string {
  return (
    `<figure class="${className}"><svg viewBox="0 0 ${width} ${height}" role="img">` +
    `<title>${escapeHtml(caption)}</title>${marks}</svg>` +
    `<figcaption>${escapeHtml(caption)}</figcaption></figure>`
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
  const top = 16;
  const base = PLOT_BASE;
  const slot = WIDTH / Math.max(1, data.length);
  const barWidth = Math.min(48, slot * 0.6);
  const marks = data.map((d, i) => {
    const h = (drawable(d.value) / max) * (base - top);
    const x = i * slot + (slot - barWidth) / 2;
    return (
      `<g>${tip(d)}${h > 0 ? bar(x, base - h, barWidth, h, false) : ''}` +
      `<text class="value" x="${at(x + barWidth / 2)}" y="${at(base - h - 4)}" text-anchor="middle">${escapeHtml(format(d.value))}</text>` +
      `<text class="axis" x="${at(i * slot + slot / 2)}" y="${PLOT_HEIGHT - 4}" text-anchor="middle">${escapeHtml(d.label)}</text></g>`
    );
  });
  return plotted(options, data, marks.join(''));
}

/** The frame the columns and the line share: full width, a fixed height, the baseline under the marks. */
function plotted(options: ChartOptions, data: ChartDatum[], marks: string): string {
  const baseline = `<line class="base" x1="0" x2="${WIDTH}" y1="${PLOT_BASE}" y2="${PLOT_BASE}"/>`;
  return figure('chart', options, data, PLOT_HEIGHT, WIDTH, `${baseline}${marks}`);
}

/**
 * Where a value falls in a box, scaled between the finite values' own min and
 * max. Reduced, not spread: a spread of a long series overflows the call stack.
 */
function scale(values: number[], from: number, length: number): (value: number) => number {
  const finite = values.filter((value) => Number.isFinite(value));
  const min = finite.reduce((least, value) => Math.min(least, value), finite[0] ?? 0);
  const max = finite.reduce((most, value) => Math.max(most, value), finite[0] ?? 0);
  // Halved, so two finite extremes (±1e308) cannot overflow the span to Infinity.
  const span = max / 2 - min / 2 || 1;
  return (value) => from + ((value / 2 - min / 2) / span) * length;
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
  const coords = points(
    data.map((d) => d.value),
    { left: 8, top: 16, width: WIDTH - 16, height: PLOT_HEIGHT - 44 },
  );
  // Both ends, once each; none for an empty series.
  const ends = data.length === 0 ? [] : [...new Set([0, data.length - 1])];
  const marks = ends.map((i) => {
    const [x, y] = coords[i] as [number, number];
    const d = data[i] as ChartDatum;
    const anchor = i === 0 ? 'start' : 'end';
    return (
      `<g><title>${escapeHtml(`${d.label}: ${format(d.value)}`)}</title><circle class="dot" cx="${at(x)}" cy="${at(y)}" r="4"/>` +
      `<text class="value" x="${at(x)}" y="${at(y - 8)}" text-anchor="${anchor}">${escapeHtml(format(d.value))}</text>` +
      `<text class="axis" x="${at(x)}" y="${PLOT_HEIGHT - 4}" text-anchor="${anchor}">${escapeHtml(d.label)}</text></g>`
    );
  });
  return plotted(options, data, `${polyline(coords)}${marks.join('')}`);
}

/** One capture on a time axis; a `value` left undefined is a capture that did not measure it. */
export interface TimeDatum {
  /** Milliseconds since the epoch. */
  at: number;
  label: string;
  value: number | undefined;
  /** Not comparable with the value before it (counted under another rule): the line breaks here too. */
  breakBefore?: boolean;
}

/** Something that happened at a moment, marked across the plot: a merge. */
export interface TimeMarker {
  at: number;
  /** Its hover, naming it. */
  label: string;
  /** Where it links to, when it does; the caller vouches for the url's shape. */
  href?: string;
}

/**
 * A line over captures placed by when they were taken, scaled to its own
 * range. A capture that left the figure unmeasured breaks the line rather than
 * drawing a zero, so does one marked `breakBefore`; every measured capture is a
 * dot with its own `<title>`, so one standing alone between two gaps still
 * shows. Each marker is a dashed rule across the plot at its moment, its label
 * the hover, a link when it has an `href`. The axis spans every capture and
 * every marker; the figure line carries every capture, an unmeasured one said
 * in words.
 */
export function timeLineChart(
  data: TimeDatum[],
  markers: TimeMarker[],
  options: ChartOptions,
): string {
  const format = options.format ?? plain;
  const box = { left: 8, top: 16, width: WIDTH - 16, height: PLOT_HEIGHT - 44 };
  const placed = data.filter((d) => Number.isFinite(d.at));
  const shown = markers.filter((m) => Number.isFinite(m.at));
  const x = scale(
    [...placed, ...shown].map((p) => p.at),
    box.left,
    box.width,
  );
  const measured = (d: TimeDatum): d is TimeDatum & { value: number } =>
    d.value !== undefined && Number.isFinite(d.value);
  const y = scale(
    placed.filter(measured).map((d) => d.value),
    box.top + box.height,
    -box.height,
  );

  const rules = shown.map((m) => {
    const line = (className: string): string =>
      `<line class="${className}" x1="${at(x(m.at))}" x2="${at(x(m.at))}" y1="${box.top - 8}" y2="${PLOT_BASE}"/>`;
    const mark = `<title>${escapeHtml(m.label)}</title>${line('marker')}${line('hit')}`;
    return m.href === undefined
      ? `<g>${mark}</g>`
      : `<a href="${escapeHtml(m.href)}" target="_blank" rel="noopener noreferrer">${mark}</a>`;
  });
  const segments: [number, number][][] = [];
  let open: [number, number][] = [];
  for (const d of placed) {
    if (!measured(d) || d.breakBefore) {
      segments.push(open);
      open = [];
    }
    if (measured(d)) open.push([x(d.at), y(d.value)]);
  }
  segments.push(open);
  const lines = segments.filter((segment) => segment.length > 1).map(polyline);
  const dots = placed
    .filter(measured)
    .map(
      (d) =>
        `<g><title>${escapeHtml(`${d.label}: ${format(d.value)}`)}</title>` +
        `<circle class="dot" cx="${at(x(d.at))}" cy="${at(y(d.value))}" r="3"/></g>`,
    );
  // The first and last captures name the axis's ends, once each.
  const first = placed[0];
  const last = placed.at(-1);
  const ends = [first, ...(last !== first ? [last] : [])].flatMap((d, i) =>
    d === undefined
      ? []
      : [
          `<text class="axis" x="${at(x(d.at))}" y="${PLOT_HEIGHT - 4}" text-anchor="${i === 0 ? 'start' : 'end'}">${escapeHtml(d.label)}</text>`,
        ],
  );
  // The figure line says an unmeasured capture, NaN here, in words.
  return plotted(
    { ...options, format: (value) => (Number.isFinite(value) ? format(value) : 'not measured') },
    data.map((d) => ({ label: d.label, value: Number(d.value) })),
    `${rules.join('')}${lines.join('')}${dots.join('')}${ends.join('')}`,
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
  const last = coords.at(-1);
  const dot = last ? `<circle class="dot" cx="${at(last[0])}" cy="${at(last[1])}" r="3"/>` : '';
  return figure('chart spark', options, data, height, width, `${polyline(coords)}${dot}`);
}

/** A rectangle in the SVG's user units. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Lays items out as rectangles filling `box`, each with an area in proportion
 * to its value (the squarified treemap: rows are grown while that keeps their
 * cells closer to square). Largest first, a tie keeping the given order; a
 * value that is not a finite positive number has no area and no rectangle.
 * The areas sum to the box's.
 */
export function squarify<T extends { value: number }>(items: T[], box: Box): (Box & { item: T })[] {
  const queue = items
    .filter((item) => Number.isFinite(item.value) && item.value > 0)
    .sort((a, b) => b.value - a.value);
  const total = queue.reduce((sum, item) => sum + item.value, 0);
  if (!Number.isFinite(total) || total === 0 || box.w <= 0 || box.h <= 0) return [];
  const scale = (box.w * box.h) / total;
  // How far from square a row's least square cell is, laid along `side`.
  const worst = (row: T[], side: number): number => {
    const areas = row.map((item) => item.value * scale);
    const sum = areas.reduce((s, a) => s + a, 0);
    const max = areas.reduce((m, a) => Math.max(m, a), 0);
    const min = areas.reduce((m, a) => Math.min(m, a), Number.POSITIVE_INFINITY);
    return Math.max((side * side * max) / (sum * sum), (sum * sum) / (side * side * min));
  };
  const placed: (Box & { item: T })[] = [];
  // Lays a row along the shorter side of what is left, and returns what is left after it.
  const lay = (row: T[], rest: Box): Box => {
    const area = row.reduce((sum, item) => sum + item.value * scale, 0);
    const across = rest.w >= rest.h;
    const thickness = area / (across ? rest.h : rest.w);
    let offset = across ? rest.y : rest.x;
    for (const item of row) {
      const length = (item.value * scale) / thickness;
      placed.push(
        across
          ? { item, x: rest.x, y: offset, w: thickness, h: length }
          : { item, x: offset, y: rest.y, w: length, h: thickness },
      );
      offset += length;
    }
    return across
      ? { x: rest.x + thickness, y: rest.y, w: rest.w - thickness, h: rest.h }
      : { x: rest.x, y: rest.y + thickness, w: rest.w, h: rest.h - thickness };
  };
  let rest = box;
  let row: T[] = [];
  for (const item of queue) {
    const side = Math.min(rest.w, rest.h);
    if (row.length > 0 && worst([...row, item], side) > worst(row, side)) {
      rest = lay(row, rest);
      row = [];
    }
    row.push(item);
  }
  if (row.length > 0) lay(row, rest);
  return placed;
}

/** One cell of a treemap: a file, sized by `value`, with one count per tone. */
export interface TreemapLeaf {
  label: string;
  value: number;
  /** In the tones' order. */
  counts: number[];
}

/** The cells of one region, outlined and named together: a module. */
export interface TreemapGroup {
  label: string;
  leaves: TreemapLeaf[];
}

/** One way to colour the cells, chosen by a toggle; `CHART_CSS` styles two. */
export interface TreemapTone {
  /** The toggle's text, and how the figure line counts the cells it colours: `with open debt`. */
  label: string;
  /** How a cell's count reads in its hover: `2 open debt entries`. */
  count: (n: number) => string;
}

const TREEMAP_WIDTH = 720;
const TREEMAP_HEIGHT = 360;
const GROUP_LABEL_MIN = { w: 60, h: 18 };

/** A count's shade: none, one, two or three, four or more. */
function toneLevel(n: number): number {
  return n <= 0 || !Number.isFinite(n) ? 0 : n === 1 ? 1 : n <= 3 ? 2 : 3;
}

/**
 * A treemap of groups of cells, each cell's area its value's share of the
 * whole, so the cells' areas sum to the plot's. Groups are laid out by their
 * total, then their cells inside them; a group is outlined and, when it has
 * room, named over its cells, so no cell gives up area to a heading. A cell is
 * shaded by its count under the tone the toggle selects: radio inputs ahead of
 * the figure and `CHART_CSS`'s sibling rules, so it switches with the script
 * off. Every cell carries its own `<title>`; the figure line gives each
 * group's total and how many of its cells each tone colours.
 */
export function treemap(
  groups: TreemapGroup[],
  options: ChartOptions & { tones: TreemapTone[] },
): string {
  const format = options.format ?? plain;
  const sized = groups.map((group) => ({
    group,
    value: group.leaves.reduce((sum, leaf) => sum + drawable(leaf.value), 0),
  }));
  const total = sized.reduce((sum, { value }) => sum + value, 0);
  const marks = squarify(sized, { x: 0, y: 0, w: TREEMAP_WIDTH, h: TREEMAP_HEIGHT }).map(
    ({ item: { group }, ...box }) => {
      const cells = squarify(group.leaves, box).map(({ item: leaf, x, y, w, h }) => {
        const shades = leaf.counts
          .map((n, tone) => (toneLevel(n) > 0 ? ` t${tone}-${toneLevel(n)}` : ''))
          .join('');
        const tip = [
          `${leaf.label}: ${format(leaf.value)}`,
          ...options.tones.map((tone, i) => tone.count(leaf.counts[i] ?? 0)),
        ].join(', ');
        return `<g><title>${escapeHtml(tip)}</title><rect class="cell${shades}" x="${at(x)}" y="${at(y)}" width="${at(w)}" height="${at(h)}"/></g>`;
      });
      const outline = `<rect class="group" x="${at(box.x)}" y="${at(box.y)}" width="${at(box.w)}" height="${at(box.h)}"/>`;
      const name =
        box.w >= GROUP_LABEL_MIN.w && box.h >= GROUP_LABEL_MIN.h
          ? `<text class="group-label" x="${at(box.x + 4)}" y="${at(box.y + 13)}">${escapeHtml(fitLabel(group.label, Math.floor((box.w - 8) / (AXIS_FONT_PX * 0.6))))}</text>`
          : '';
      return `<g>${cells.join('')}${outline}${name}</g>`;
    },
  );
  const figures = [...sized]
    .sort((a, b) => b.value - a.value)
    .map(({ group, value }) =>
      [
        `${group.label} ${format(value)} in ${group.leaves.length} ${group.leaves.length === 1 ? 'file' : 'files'}`,
        ...options.tones.map(
          (tone, i) =>
            `${group.leaves.filter((leaf) => toneLevel(leaf.counts[i] ?? 0) > 0).length} ${tone.label}`,
        ),
      ].join(', '),
    );
  const toggles = options.tones.map(
    (tone, i) =>
      `<input type="radio" name="treemap-tone" id="treemap-tone-${i}"${i === 0 ? ' checked' : ''}>` +
      `<label for="treemap-tone-${i}">${escapeHtml(tone.label)}</label> `,
  );
  return (
    `<div class="treemap"><span class="tones">Shade files </span>${toggles.join('')}` +
    `<span class="tones">${escapeHtml('(darker: 1, 2–3, 4 or more)')}</span>` +
    framed(
      'chart',
      `${options.title}: ${format(total)} in total · ${figures.join(' · ')}`,
      TREEMAP_HEIGHT,
      TREEMAP_WIDTH,
      marks.join(''),
    ) +
    '</div>'
  );
}
