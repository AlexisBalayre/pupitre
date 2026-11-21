/**
 * The design tokens every pup-generated HTML page inlines (`pup map`,
 * `pup report`, and the report's dossier pages to come): the warm off-white
 * surfaces, ink/muted text ramp, and the blue debt ramp, in light and dark.
 * Shared at BUILD time only — each template interpolates this block into its
 * own <style>, so every generated page stays fully self-contained (no external
 * stylesheet, no CDN). One definition so the palettes cannot silently drift
 * apart between pages.
 */
export const PAGE_THEME_CSS = `  :root {
    --surface: #fcfcfb; --page: #f9f9f7;
    --ink: #0b0b0b; --ink-2: #52514e; --muted: #898781;
    --grid: #e1e0d9; --baseline: #c3c2b7; --border: rgba(11,11,11,0.10);
    --debt-0: #86b6ef; --debt-1: #3987e5; --debt-2: #1c5cab; --debt-3: #0d366b;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --surface: #1a1a19; --page: #0d0d0d;
      --ink: #ffffff; --ink-2: #c3c2b7; --muted: #898781;
      --grid: #2c2c2a; --baseline: #383835; --border: rgba(255,255,255,0.10);
      --debt-0: #184f95; --debt-1: #256abf; --debt-2: #3987e5; --debt-3: #6da7ec;
    }
  }`;
