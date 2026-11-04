import { describe, expect, it } from 'vitest';
import { barChart, lineChart, sparkline, timeLineChart } from './chart.utils.js';

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
});
