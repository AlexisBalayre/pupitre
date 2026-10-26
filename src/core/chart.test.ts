import { describe, expect, it } from 'vitest';
import { barChart, lineChart, sparkline } from './chart.utils.js';

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

  it('draws a single-point line without dividing by zero', () => {
    const svg = lineChart([{ label: 'only', value: 3 }], { title: 'One' });

    expect(svg).not.toContain('NaN');
    expect(svg.match(/<circle/g)).toHaveLength(1);
  });
});
