/**
 * Shape of `.pupitre/adapter.yml` (docs/06 "Custom adapters"): every value is
 * a shell command. build/test/lint gate on exit code; the rest must print the
 * matching capability's JSON on stdout. `complexity` receives the file list as
 * a JSON array on stdin.
 */
export interface CustomAdapterConfig {
  id?: string;
  build?: string;
  test?: string;
  lint?: string;
  depGraph?: string;
  deadCode?: string;
  duplication?: string;
  complexity?: string;
  coverage?: string;
}
