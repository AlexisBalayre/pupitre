/** The `package.json` fields the TypeScript adapter reads. */
export interface PackageManifest {
  name?: unknown;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  main?: string;
  module?: string;
  types?: string;
  bin?: string | Record<string, string>;
  exports?: unknown;
}
