import { describe, expect, it } from 'vitest';
import {
  barChart,
  lineChart,
  sparkline,
  squarify,
  type TreemapGroup,
  timeLineChart,
  treemap,
} from './chart.utils.js';

const WEEKS = [
  { label: '10-05', value: 2 },
  { label: '10-12', value: 0 },
  { label: '10-19', value: 5 },
];

describe('chart.utils', () => {
  it.each([
    ['a column bar chart', () => barChart(WEEKS, { title: 'Merges' })],
    ['a row bar chart', () => barChart(WEEKS, { title: 'Merges', layout: 'rows' })],
    ['a line chart', () => lineChart(WEEKS, { title: 'Merges' })],
    ['a sparkline', () => sparkline(WEEKS, { title: 'Merges' })],
    [
      'a time line chart',
      () =>
        timeLineChart(
          WEEKS.map((week, i) => ({ ...week, at: i * 1000 })),
          [],
          { title: 'Merges' },
        ),
    ],
  ])('gives %s a title and a figure line carrying every value', (_case, draw) => {
    const svg = draw();

    expect(svg).toMatch(/^<figure class="chart[^"]*"><svg viewBox="[\d. ]+" role="img"><title>/);
    expect(svg).toContain('<title>Merges: 10-05 2 · 10-12 0 · 10-19 5</title>');
    expect(svg).toContain('<figcaption>Merges: 10-05 2 · 10-12 0 · 10-19 5</figcaption>');
  });

  it('draws one mark per non-zero bar, scaled to the largest', () => {
    const svg = barChart(WEEKS, { title: 'Merges' });
    const heights = [...svg.matchAll(/<path class="mark" d="M[\d.]+ ([\d.]+)V([\d.]+)/g)].map(
      ([, base, top]) => Number(base) - Number(top),
    );

    expect(heights).toHaveLength(2);
    expect(heights[1]).toBeGreaterThan(heights[0] as number);
    expect(svg).toContain('<title>10-12: 0</title>');
  });

  it('prints values through the format it is given', () => {
    const svg = lineChart(
      [
        { label: 'a', value: 0.812 },
        { label: 'b', value: 0.835 },
      ],
      { title: 'Coverage', format: (v) => `${Math.round(v * 1000) / 10}%` },
    );

    expect(svg).toContain('Coverage: a 81.2% · b 83.5%');
  });

  it('takes its colours from the theme through classes, never from an inline style', () => {
    const svg = barChart(WEEKS, { title: 'Merges' }) + sparkline(WEEKS, { title: 'Merges' });

    expect(svg).not.toMatch(/style=|fill="#|stroke="#/);
    expect(svg).toContain('class="mark"');
    expect(svg).toContain('class="line"');
  });

  it('escapes the labels and the title, and keeps the tail of a long row label', () => {
    const svg = barChart([{ label: `src/${'deep/'.repeat(10)}<b>.ts`, value: 1 }], {
      title: 'Files & "debt"',
      layout: 'rows',
    });

    expect(svg).not.toContain('<b>');
    expect(svg).toContain('Files &amp; &quot;debt&quot;');
    expect(svg).toMatch(/>…[^<]*&lt;b&gt;\.ts<\/text>/);
  });

  it.each([
    ['infinite values', [Number.POSITIVE_INFINITY, 1, Number.NaN]],
    ['finite extremes whose span overflows', [-1e308, 1e308, 0]],
  ])('draws no NaN for %s', (_case, values) => {
    const data = values.map((value, i) => ({ label: String(i), value }));
    const svg = [
      barChart(data, { title: 'Bars' }),
      barChart(data, { title: 'Rows', layout: 'rows' }),
      lineChart(data, { title: 'Line' }),
      sparkline(data, { title: 'Spark' }),
      timeLineChart(
        data.map((d, i) => ({ ...d, at: values[i] ?? 0 })),
        [{ at: Number.NaN, label: 'lost' }],
        { title: 'Time' },
      ),
    ].join('');

    expect(svg).not.toMatch(/="[^"]*(NaN|Infinity)/);
  });

  it('draws an empty series as an empty frame, not a throw', () => {
    expect(lineChart([], { title: 'None' })).toContain('<figcaption>None: </figcaption>');
    expect(sparkline([], { title: 'None' })).not.toContain('<circle');
  });

  it('draws a single-point line without dividing by zero', () => {
    const svg = lineChart([{ label: 'only', value: 3 }], { title: 'One' });

    expect(svg).not.toContain('NaN');
    expect(svg.match(/<circle/g)).toHaveLength(1);
  });

  it('places a time series by when, breaks it at a gap rather than drawing a zero, and marks moments', () => {
    const svg = timeLineChart(
      [
        { at: 0, label: 'a', value: 1 },
        { at: 1000, label: 'b', value: 3 },
        { at: 2000, label: 'c', value: undefined },
        { at: 4000, label: 'd', value: 2 },
        { at: 5000, label: 'e', value: 2, breakBefore: true },
      ],
      [
        { at: 3000, label: 's-1 merged', href: 'https://github.com/o/r/pull/1' },
        { at: 500, label: '<b>s-2</b>' },
      ],
      { title: 'Lines' },
    );

    expect(svg).toContain('<figcaption>Lines: a 1 · b 3 · c not measured · d 2 · e 2</figcaption>');
    // Two lines: a to b, then d alone (a dot) after the gap, e alone after the break.
    expect([...svg.matchAll(/<polyline class="line" points="([^"]*)"/g)].map(([, p]) => p)).toEqual(
      ['8,112 116.8,16'],
    );
    expect(svg.match(/<circle/g)).toHaveLength(4);
    expect(svg).toContain(
      '<a href="https://github.com/o/r/pull/1" target="_blank" rel="noopener noreferrer"><title>s-1 merged</title><line class="marker" x1="334.4"',
    );
    expect(svg).toContain('<g><title>&lt;b&gt;s-2&lt;/b&gt;</title><line class="marker" x1="62.4"');
    expect(svg).not.toContain('<b>');
  });

  it('draws a time series measured nowhere as a frame with no line', () => {
    const svg = timeLineChart([{ at: 0, label: 'a', value: undefined }], [], { title: 'None' });

    expect(svg).toContain('<figcaption>None: a not measured</figcaption>');
    expect(svg).not.toMatch(/<polyline|<circle|NaN/);
  });

  describe('treemap', () => {
    const TONES = [
      { label: 'with open debt', count: (n: number) => `${n} debt` },
      { label: 'merged lately', count: (n: number) => `${n} merges` },
    ];
    const GROUPS: TreemapGroup[] = [
      {
        label: 'src/core',
        leaves: [
          { label: 'src/core/a.ts', value: 300, counts: [0, 1] },
          { label: 'src/core/b.ts', value: 100, counts: [5, 0] },
        ],
      },
      { label: 'src/cli', leaves: [{ label: 'src/cli/c.ts', value: 50, counts: [2, 3] }] },
    ];
    const cells = (svg: string): { w: number; h: number; className: string }[] =>
      [
        ...svg.matchAll(
          /<rect class="(cell[^"]*)" x="[\d.]+" y="[\d.]+" width="([\d.]+)" height="([\d.]+)"/g,
        ),
      ].map(([, className, w, h]) => ({
        className: className as string,
        w: Number(w),
        h: Number(h),
      }));

    it('lays out areas in proportion to the values, filling the box', () => {
      const values = [612, 1, 37, 240, 240, 9, 88, 1500];
      const total = values.reduce((sum, v) => sum + v, 0);
      // A box whose area is the total, so each area is its value.
      const placed = squarify(
        values.map((value) => ({ value })),
        { x: 0, y: 0, w: 100, h: total / 100 },
      );

      expect(placed).toHaveLength(values.length);
      for (const { item, w, h } of placed) expect(w * h).toBeCloseTo(item.value, 6);
      expect(placed.reduce((sum, { w, h }) => sum + w * h, 0)).toBeCloseTo(total, 6);
      for (const { x, y, w, h } of placed) {
        expect(x).toBeGreaterThanOrEqual(-1e-9);
        expect(y).toBeGreaterThanOrEqual(-1e-9);
        expect(x + w).toBeLessThanOrEqual(100 + 1e-9);
        expect(y + h).toBeLessThanOrEqual(total / 100 + 1e-9);
      }
    });

    it('gives no area to a zero, negative or non-finite value', () => {
      const placed = squarify(
        [0, -3, Number.NaN, Number.POSITIVE_INFINITY, 4].map((value) => ({ value })),
        { x: 0, y: 0, w: 10, h: 10 },
      );

      expect(placed.map(({ item }) => item.value)).toEqual([4]);
      expect(squarify([{ value: 0 }], { x: 0, y: 0, w: 10, h: 10 })).toEqual([]);
    });

    it('draws cells whose areas sum to the plot, each its share of the total', () => {
      const svg = treemap(GROUPS, { title: 'Map', tones: TONES });
      const [, , width, height] = (/viewBox="([\d. ]+)"/.exec(svg)?.[1] ?? '')
        .split(' ')
        .map(Number);
      const drawn = cells(svg);
      const unit = ((width as number) * (height as number)) / 450;

      expect(drawn).toHaveLength(3);
      // Coordinates print to two decimals, so an area is good to about a pixel.
      expect(drawn.reduce((sum, { w, h }) => sum + w * h, 0) / unit).toBeCloseTo(450, 0);
      expect(drawn.map(({ w, h }) => Math.round((w * h) / unit))).toEqual([300, 100, 50]);
    });

    it('carries a title and a figure line with every group, and a hover on every cell', () => {
      const svg = treemap(GROUPS, { title: 'Map', tones: TONES, format: (n) => `${n} lines` });
      const line =
        'Map: 450 lines in total · src/core 400 lines in 2 files, 1 with open debt, 1 merged lately · ' +
        'src/cli 50 lines in 1 file, 1 with open debt, 1 merged lately';

      expect(svg).toContain(`<title>${line}</title>`);
      expect(svg).toContain(`<figcaption>${line}</figcaption>`);
      expect(svg).toContain('<title>src/core/b.ts: 100 lines, 5 debt, 0 merges</title>');
    });

    it('shades each cell per tone by its count, through classes the toggle selects', () => {
      const svg = treemap(GROUPS, { title: 'Map', tones: TONES });

      expect(cells(svg).map(({ className }) => className)).toEqual([
        'cell t0-0 t1-1',
        'cell t0-3 t1-0',
        'cell t0-2 t1-2',
      ]);
      expect(svg).toMatch(
        /^<div class="treemap">.*<input type="radio" name="treemap-tone" id="treemap-tone-0" checked><label for="treemap-tone-0">with open debt<\/label> <input type="radio" name="treemap-tone" id="treemap-tone-1"><label for="treemap-tone-1">merged lately<\/label>.*<figure/,
      );
      expect(svg).not.toMatch(/style=|fill="#|stroke="#/);
    });

    it('escapes its labels and draws no NaN for values it cannot place', () => {
      const svg = treemap(
        [
          {
            label: '<b>mod</b>',
            leaves: [
              { label: '<i>x</i>.ts', value: Number.POSITIVE_INFINITY, counts: [Number.NaN, 0] },
              { label: 'y.ts', value: 1e308, counts: [0, 0] },
              { label: 'z.ts', value: 1e308, counts: [0, 0] },
            ],
          },
        ],
        { title: 'A & "B"', tones: TONES },
      );

      expect(svg).not.toMatch(/<b>|<i>/);
      expect(svg).toContain('A &amp; &quot;B&quot;');
      expect(svg).not.toMatch(/="[^"]*(NaN|Infinity)/);
    });
  });
});
