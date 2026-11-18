import { describe, expect, it } from 'vitest';
import { pythonAdapter } from './python.adapter.js';
import { typescriptAdapter } from './typescript.adapter.js';

// The gate names a failed test stage's failing tests from what the adapter
// reads of its runner's own summary, never from a tail of free text: the tail
// was a fixture's git noise on #325 and named no test.
describe('failingTests', () => {
  const failingTests = (adapter: typeof typescriptAdapter, output: string[]) =>
    adapter.failingTests?.(output.join('\n'));

  it("reads vitest's summary: each failed test once, and a file that failed as a whole", () => {
    expect(
      failingTests(typescriptAdapter, [
        'fatal: no merge base',
        ' ❯ src/a.test.ts (3 tests | 2 failed) 20ms',
        '   × suite > adds 5ms',
        '⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯',
        ' FAIL  src/b.test.ts [ src/b.test.ts ]',
        "Error: Cannot find module './gone.js'",
        '⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯',
        ' FAIL  src/a.test.ts > suite > adds',
        'AssertionError: expected 1 to be 2',
        ' FAIL  |unit| src/a.test.ts > suite > subtracts',
        ' FAIL   unit  src/a.test.ts > suite > adds',
        ' Test Files  2 failed (2)',
        'Automatic merge went well; stopped before committing as requested',
      ]),
    ).toEqual([
      { file: 'src/b.test.ts' },
      { file: 'src/a.test.ts', test: 'suite > adds' },
      { file: 'src/a.test.ts', test: 'suite > subtracts' },
    ]);
  });

  it("reads jest's per-file headers and the failed tests under them", () => {
    expect(
      failingTests(typescriptAdapter, [
        'FAIL src/a.test.ts (1.2 s)',
        '  ● suite › adds',
        '  ● Console',
        'PASS src/c.test.ts',
        '  ● Console',
        '  ● not a failure',
        'FAIL src/b.test.ts',
        '  ● Test suite failed to run',
        'Summary of all failing tests',
        'FAIL src/a.test.ts',
        '  ● suite › adds',
      ]),
    ).toEqual([{ file: 'src/a.test.ts', test: 'suite › adds' }, { file: 'src/b.test.ts' }]);
  });

  it("reads pytest's short test summary, past its messages", () => {
    expect(
      failingTests(pythonAdapter, [
        'tests/test_a.py::test_adds FAILED                    [ 50%]',
        '=========================== short test summary info ============================',
        'FAILED tests/test_a.py::TestMath::test_adds - assert 1 == 2',
        'FAILED tests/test_a.py::test_param[1-2] - AssertionError',
        'ERROR tests/test_b.py - ModuleNotFoundError: No module named gone',
        'FAILED tests/test_a.py::TestMath::test_adds - assert 1 == 2',
      ]),
    ).toEqual([
      { file: 'tests/test_a.py', test: 'TestMath::test_adds' },
      { file: 'tests/test_a.py', test: 'test_param[1-2]' },
      { file: 'tests/test_b.py' },
    ]);
  });

  it('names nothing in output that holds no summary', () => {
    const noise = ['fatal: no merge base', 'Automatic merge went well', 'FAIL to do x and y'];
    expect(failingTests(typescriptAdapter, noise)).toEqual([]);
    expect(failingTests(pythonAdapter, noise)).toEqual([]);
  });
});
