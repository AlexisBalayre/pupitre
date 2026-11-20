/** What one vitest run collects, and the config that says so without its lists. */
export interface VitestCollection {
  collects: (path: string) => boolean;
  /**
   * The config's file name and text with its `include` and `exclude` lists cut
   * out. Vitest runs the branch's config, so its lists are read only where the
   * rest is the trusted config's: whatever else the branch's sets runs, and may
   * pass a file the lists collect (decision 143).
   */
  config: string;
  /**
   * The config's `resolve.alias` keys, each a bare `@name`: one that names a
   * scope in `node_modules` redirects its packages to the branch's modules.
   */
  aliases: string[];
}
