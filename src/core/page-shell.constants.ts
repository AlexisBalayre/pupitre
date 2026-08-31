/**
 * The layout rules and client-side helpers the report's index and the session
 * dossier pages share, interpolated into each template at BUILD time like
 * `PAGE_THEME_CSS` — the pages stay self-contained, and the shared chrome
 * cannot drift apart between them. The mind-map is deliberately not a
 * consumer: it shares only the theme tokens.
 */

export const PAGE_SHELL_CSS = `  * { margin: 0; box-sizing: border-box; }
  body {
    font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
    background: var(--page); color: var(--ink);
  }
  header {
    padding: 14px 20px; border-bottom: 1px solid var(--grid);
    display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap;
  }
  header h1 { font-size: 14px; font-weight: 600; }
  header .repo { color: var(--ink-2); font-size: 12px; }
  main { max-width: 760px; margin: 0 auto; padding: 8px 20px 72px; }
  section { margin-top: 28px; }
  section > h2 {
    font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em;
    color: var(--muted); margin-bottom: 10px; font-weight: 600;
  }
  .hint { color: var(--muted); }
  .meta { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
  .state {
    border: 1px solid var(--border); border-radius: 999px; padding: 1px 8px;
    font-size: 11px; color: var(--ink-2); white-space: nowrap;
  }
  .state-running { background: var(--debt-1); border-color: transparent; color: #fff; }
  .state-blocked { background: var(--ink); border-color: transparent; color: var(--page); }
  .branch, .when { color: var(--muted); font-size: 12px; }
  .rejects { color: var(--ink-2); font-size: 12px; }
  .scope .k, .field .k { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
  .entry { border-top: 1px solid var(--grid); padding: 10px 0; }
  .entry .when { color: var(--muted); font-size: 11px; }
  .entry .field { margin-top: 2px; color: var(--ink-2); font-size: 12px; white-space: pre-wrap; max-width: 65ch; }`;

/**
 * Declared with `const`, so a template interpolating this block twice fails
 * loudly in the browser console instead of silently shadowing a helper. All of
 * it renders untrusted store prose via `textContent` — keep it that way.
 */
export const PAGE_SHELL_JS = `  const el = (tag, cls) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    return node;
  };
  const hint = (parent, text) => {
    const p = el('p', 'hint');
    p.textContent = text;
    parent.appendChild(p);
  };
  const when = (iso) =>
    new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const field = (parent, key, value) => {
    const div = el('div', 'field');
    const k = el('span', 'k');
    k.textContent = key + ': ';
    div.appendChild(k);
    div.appendChild(document.createTextNode(value));
    parent.appendChild(div);
  };
  // The state column is unchecked TEXT: an unknown state keeps the neutral
  // chip — classList.add would throw on whitespace and blank the whole page.
  const KNOWN_STATES = ['queued', 'running', 'awaiting-review', 'merged', 'killed', 'rejected', 'blocked'];
  const stateChip = (node, state) => {
    node.textContent = state;
    if (KNOWN_STATES.includes(state)) node.classList.add('state-' + state);
  };
  const stageText = (stage) =>
    stage.stage + ' ' + stage.status.toUpperCase() + (stage.detail ? ' \\u2014 ' + stage.detail : '');
  const decisionFields = (parent, record) => {
    if (record.alternatives) field(parent, 'alternatives', record.alternatives);
    if (record.conventions) field(parent, 'conventions', record.conventions);
    if (record.files.length) field(parent, 'files', record.files.join(', '));
  };`;
