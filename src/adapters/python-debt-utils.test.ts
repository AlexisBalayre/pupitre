import { describe, expect, it } from 'vitest';
import { parseVultureOutput } from './python-debt.utils.js';

describe('parseVultureOutput', () => {
  it('maps named vulture findings to dead exports', () => {
    const stdout = [
      "src/app.py:10: unused function 'handler' (60% confidence)",
      "src/models.py:3: unused class 'Legacy' (60% confidence)",
      "src/util.py:1: unused import 'os' (90% confidence)",
      "src/util.py:7: unused variable 'RETRIES' (60% confidence)",
    ].join('\n');

    expect(parseVultureOutput(stdout, '/repo')).toEqual([
      { file: 'src/app.py', exportName: 'handler' },
      { file: 'src/models.py', exportName: 'Legacy' },
      { file: 'src/util.py', exportName: 'os' },
      { file: 'src/util.py', exportName: 'RETRIES' },
    ]);
  });

  it('strips a leading ./ from reported paths', () => {
    expect(
      parseVultureOutput("./src/app.py:5: unused method 'run' (60% confidence)", '/repo'),
    ).toEqual([{ file: 'src/app.py', exportName: 'run' }]);
  });

  it('drops unreachable-code findings and unrelated lines', () => {
    const stdout = [
      "src/app.py:22: unreachable code after 'return' (100% confidence)",
      'vulture: some diagnostic line',
      '',
    ].join('\n');

    expect(parseVultureOutput(stdout, '/repo')).toEqual([]);
  });

  it('drops findings whose path escapes the repo', () => {
    const stdout = [
      "../outside.py:1: unused function 'ghost' (60% confidence)",
      "/elsewhere/lib.py:2: unused class 'Ghost' (60% confidence)",
      "src/real.py:3: unused variable 'DEAD' (60% confidence)",
    ].join('\n');

    expect(parseVultureOutput(stdout, '/repo')).toEqual([
      { file: 'src/real.py', exportName: 'DEAD' },
    ]);
  });

  it('attributes a vulture-shaped filename to the file itself, not the fabricated pair', () => {
    const crafted = "src/mod.py:9: unused function 'ghost' (60% confidence).py";

    expect(
      parseVultureOutput(`${crafted}:3: unused import 'os' (90% confidence)`, '/repo'),
    ).toEqual([{ file: crafted, exportName: 'os' }]);
  });
});
