// All widget CSS. It lives inside the shadow root, so host-page styles can't reach it and it can't leak out.
// Colors: Cuttlely violet with a blue highlight. Every text pair meets WCAG AA (see README "Contrast").

export const styles = `
:host { all: initial; display: block; }
:host([mode='page']) { height: 100%; }
* { box-sizing: border-box; }
.dc {
  --dc-font: Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  --dc-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace;
  --dc-bg: #ffffff;
  --dc-surface: #f5f6fc;
  --dc-surface-2: #eceef8;
  --dc-border: #e1e4f0;
  --dc-fg: #11142e;
  --dc-muted: #515874;
  --dc-accent: #6a3df2;
  --dc-accent-fg: #ffffff;
  --dc-accent-soft: #eeeafe;
  --dc-highlight: #4f8dfc;
  --dc-danger: #b42318;
  --dc-danger-soft: #fdeceb;
  --dc-code-bg: #0e1124;
  --dc-code-fg: #e6e9f6;
  --dc-shadow: 0 24px 60px -18px rgba(14, 16, 46, 0.35), 0 4px 14px rgba(14, 16, 46, 0.08);
  --dc-ring: 0 0 0 3px rgba(106, 61, 242, 0.45);
  font-family: var(--dc-font);
  font-size: var(--dc-size, 15px);
  line-height: 1.55;
  color: var(--dc-fg);
  -webkit-font-smoothing: antialiased;
  text-align: left;
}
.dc.dark {
  --dc-bg: #0d1020;
  --dc-surface: #151935;
  --dc-surface-2: #1e2242;
  --dc-border: #2a2f52;
  --dc-fg: #e8eaf6;
  --dc-muted: #a5acc9;
  --dc-accent: #a08cff;
  --dc-accent-fg: #130c36;
  --dc-accent-soft: #241e4c;
  --dc-highlight: #6fb6fd;
  --dc-ring: 0 0 0 3px rgba(160, 140, 255, 0.55);
  --dc-danger: #ff9a8c;
  --dc-danger-soft: #3a1f1c;
  --dc-code-bg: #080a18;
  --dc-code-fg: #e6e9f6;
  --dc-shadow: 0 24px 60px -18px rgba(0, 0, 0, 0.7), 0 4px 14px rgba(0, 0, 0, 0.35);
}
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
button { font: inherit; color: inherit; cursor: pointer; }
button:focus-visible, textarea:focus-visible, a:focus-visible, summary:focus-visible { outline: none; box-shadow: var(--dc-ring); }
button:disabled { cursor: default; opacity: 0.5; }

/* ---------- shells */
.dc-window { display: flex; flex-direction: column; background: var(--dc-bg); color: var(--dc-fg); overflow: hidden; min-height: 0; }
.dc-page { height: 100%; min-height: 320px; }
.dc-page .dc-window { height: 100%; position: relative; }
.dc-launcher {
  position: fixed; right: 20px; bottom: 20px; z-index: 2147483000;
  width: 56px; height: 56px; border-radius: 18px; border: 0;
  background: var(--dc-accent); color: var(--dc-accent-fg);
  display: grid; place-items: center; box-shadow: var(--dc-shadow);
  transition: transform 0.18s ease, border-radius 0.18s ease;
}
.dc-launcher:hover { transform: translateY(-2px); }
.dc-launcher svg { width: 26px; height: 26px; }
.dc-launcher[aria-expanded='true'] { border-radius: 50%; }
.dc-panel {
  position: fixed; right: 20px; bottom: 88px; z-index: 2147483000;
  width: min(410px, calc(100vw - 40px)); height: min(660px, calc(100vh - 120px));
  border-radius: 20px; border: 1px solid var(--dc-border); box-shadow: var(--dc-shadow);
  transform-origin: bottom right; animation: dc-pop 0.2s ease-out;
}
.dc-panel[hidden] { display: none; }
@keyframes dc-pop { from { opacity: 0; transform: translateY(8px) scale(0.98); } to { opacity: 1; transform: none; } }

/* ---------- header */
.dc-header {
  display: flex; align-items: center; gap: 10px; padding: 12px 14px 12px 16px;
  background: var(--dc-header-bg, var(--dc-bg)); color: var(--dc-header-fg, var(--dc-fg));
  border-bottom: 1px solid var(--dc-border); flex: none;
}
.dc-page .dc-header { padding: 14px 20px; }
.dc-brand { width: 34px; height: 34px; border-radius: 10px; display: grid; place-items: center; flex: none; background: var(--dc-accent-soft); color: var(--dc-accent); overflow: hidden; }
.dc.dark .dc-brand { color: var(--dc-fg); }
.dc-brand img { width: 100%; height: 100%; object-fit: cover; }
.dc-titles { min-width: 0; flex: 1; }
.dc-title { font-weight: 650; font-size: 1em; letter-spacing: -0.01em; margin: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dc-status { font-size: 0.8em; color: var(--dc-header-fg, var(--dc-muted)); opacity: 0.85; display: flex; align-items: center; gap: 6px; }
.dc-dot { width: 7px; height: 7px; border-radius: 50%; background: #2f9e6b; flex: none; }
.dc-busy .dc-dot { background: var(--dc-highlight); animation: dc-pulse 1.2s ease-in-out infinite; }
.dc-off .dc-dot { background: var(--dc-muted); }
@keyframes dc-pulse { 50% { opacity: 0.35; } }
.dc-icon-btn { width: 34px; height: 34px; display: grid; place-items: center; border-radius: 10px; border: 0; background: transparent; color: inherit; opacity: 0.8; flex: none; }
.dc-icon-btn:hover { background: color-mix(in srgb, currentColor 10%, transparent); opacity: 1; }

/* ---------- thread */
.dc-scroll { flex: 1; overflow-y: auto; overscroll-behavior: contain; scroll-behavior: smooth; background: var(--dc-bg); }
.dc-thread { padding: 18px 16px 8px; display: flex; flex-direction: column; gap: 18px; max-width: 780px; margin: 0 auto; }
.dc-page .dc-thread { padding: 28px 24px 12px; }
.dc-welcome { display: flex; flex-direction: column; align-items: flex-start; gap: 10px; padding: 8px 2px 4px; }
.dc-page .dc-welcome { padding-top: 6vh; }
.dc-welcome-mark { width: 44px; height: 44px; border-radius: 14px; display: grid; place-items: center; background: var(--dc-accent-soft); color: var(--dc-accent); overflow: hidden; }
.dc.dark .dc-welcome-mark { color: var(--dc-fg); }
.dc-welcome-mark img { width: 100%; height: 100%; object-fit: cover; }
.dc-welcome h2 { margin: 6px 0 0; font-size: 1.35em; line-height: 1.25; letter-spacing: -0.02em; font-weight: 700; }
.dc-welcome p { margin: 0; color: var(--dc-muted); white-space: pre-line; }
.dc-prompts { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 8px; width: 100%; margin-top: 8px; }
.dc-prompts > div { display: flex; }
.dc-prompt {
  width: 100%; text-align: left; padding: 11px 13px; border-radius: 12px; border: 1px solid var(--dc-border);
  background: var(--dc-bg); color: var(--dc-fg); font-size: 0.92em; line-height: 1.4;
  transition: border-color 0.15s ease, background 0.15s ease;
}
.dc-prompt:hover { border-color: var(--dc-accent); background: var(--dc-accent-soft); }

.dc-msg { display: flex; gap: 10px; align-items: flex-start; animation: dc-in 0.18s ease-out; }
@keyframes dc-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
.dc-msg.user { justify-content: flex-end; }
.dc-avatar { width: 28px; height: 28px; border-radius: 9px; flex: none; display: grid; place-items: center; background: var(--dc-accent-soft); color: var(--dc-accent); overflow: hidden; margin-top: 2px; }
.dc.dark .dc-avatar { color: var(--dc-fg); }
.dc-avatar svg { width: 20px; height: 20px; }
.dc-avatar img { width: 100%; height: 100%; object-fit: cover; }
.dc-body { min-width: 0; flex: 1; }
.dc-msg.user .dc-body { flex: 0 1 auto; max-width: 85%; display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }
.dc-user-bubble {
  background: var(--dc-user-bg, var(--dc-accent)); color: var(--dc-user-fg, var(--dc-accent-fg));
  padding: 9px 14px; border-radius: 18px 18px 6px 18px; white-space: pre-wrap; overflow-wrap: anywhere;
}
.dc-bot-bubble { color: var(--dc-bot-fg, var(--dc-fg)); }
.dc.has-bot-bg .dc-bot-bubble { background: var(--dc-bot-bg); padding: 10px 14px; border-radius: 6px 18px 18px 18px; }
.dc-thumbs { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
.dc-thumbs img { width: 84px; height: 84px; object-fit: cover; border-radius: 12px; border: 1px solid var(--dc-border); }
.dc-file-chip { display: inline-flex; align-items: center; gap: 6px; padding: 5px 10px; border-radius: 10px; background: var(--dc-surface); font-size: 0.85em; }

/* ---------- markdown */
.dc-md { overflow-wrap: anywhere; }
.dc-md > :first-child { margin-top: 0; }
.dc-md > :last-child { margin-bottom: 0; }
.dc-md p { margin: 0 0 0.7em; }
.dc-md h1, .dc-md h2, .dc-md h3, .dc-md h4, .dc-md h5, .dc-md h6 { margin: 1em 0 0.45em; line-height: 1.3; letter-spacing: -0.01em; }
.dc-md h1 { font-size: 1.3em; } .dc-md h2 { font-size: 1.18em; } .dc-md h3 { font-size: 1.06em; } .dc-md h4, .dc-md h5, .dc-md h6 { font-size: 1em; }
.dc-md ul, .dc-md ol { margin: 0 0 0.7em; padding-left: 1.4em; }
.dc-md li { margin: 0.2em 0; }
.dc-md li::marker { color: var(--dc-muted); }
.dc-md a { color: inherit; text-decoration: underline; text-decoration-color: var(--dc-highlight); text-decoration-thickness: 2px; text-underline-offset: 2px; }
.dc-md blockquote { margin: 0 0 0.7em; padding: 2px 0 2px 12px; border-left: 3px solid var(--dc-highlight); color: var(--dc-muted); }
.dc-md hr { border: 0; border-top: 1px solid var(--dc-border); margin: 1em 0; }
.dc-md code { font-family: var(--dc-mono); font-size: 0.88em; background: var(--dc-surface-2); padding: 0.1em 0.38em; border-radius: 6px; }
.dc-md img { max-width: 100%; border-radius: 12px; display: block; margin: 0.4em 0; }
.md-code { margin: 0 0 0.8em; border-radius: 12px; overflow: hidden; background: var(--dc-code-bg); color: var(--dc-code-fg); }
.md-code-head { display: flex; justify-content: space-between; align-items: center; padding: 6px 8px 6px 14px; font-size: 0.75em; color: #b5c4ba; font-family: var(--dc-mono); border-bottom: 1px solid rgba(255, 255, 255, 0.08); }
.md-copy { border: 0; background: rgba(255, 255, 255, 0.08); color: #e4ece6; border-radius: 7px; padding: 3px 9px; font-size: 1em; }
.md-copy:hover { background: rgba(255, 255, 255, 0.16); }
.md-code pre { margin: 0; padding: 12px 14px; overflow-x: auto; }
.md-code code { background: none; padding: 0; color: inherit; font-size: 0.85em; line-height: 1.6; white-space: pre; }
.md-table { overflow-x: auto; margin: 0 0 0.8em; border: 1px solid var(--dc-border); border-radius: 12px; }
.md-table table { border-collapse: collapse; width: 100%; font-size: 0.9em; }
.md-table th, .md-table td { padding: 8px 12px; border-bottom: 1px solid var(--dc-border); text-align: left; vertical-align: top; }
.md-table th { background: var(--dc-surface); font-weight: 600; white-space: nowrap; }
.md-table tr:last-child td { border-bottom: 0; }
.md-task { color: var(--dc-muted); }

/* ---------- answer extras */
.dc-artifacts { display: grid; gap: 10px; margin-top: 10px; }
.dc-figure { margin: 0; border: 1px solid var(--dc-border); border-radius: 14px; overflow: hidden; background: #fff; }
.dc-figure img { display: block; width: 100%; height: auto; }
.dc-figure-missing { padding: 14px; font-size: 0.88em; color: var(--dc-muted); background: var(--dc-surface); display: flex; gap: 8px; align-items: center; }
.dc-html-frame { width: 100%; min-height: 220px; border: 1px solid var(--dc-border); border-radius: 14px; background: #fff; }
.dc-sources { margin-top: 10px; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.dc-sources-label { font-size: 0.78em; font-weight: 600; color: var(--dc-muted); text-transform: uppercase; letter-spacing: 0.04em; margin-right: 2px; }
.dc-source {
  display: inline-flex; align-items: center; gap: 6px; max-width: 240px; padding: 4px 10px 4px 4px; border-radius: 999px;
  border: 1px solid var(--dc-border); background: var(--dc-bg); color: var(--dc-fg); font-size: 0.82em; text-decoration: none;
}
.dc-source:hover { border-color: var(--dc-accent); }
.dc-source b { display: grid; place-items: center; min-width: 20px; height: 20px; border-radius: 999px; background: var(--dc-accent-soft); color: var(--dc-fg); font-size: 0.85em; font-weight: 650; }
.dc-source span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dc-source-preview { margin-top: 8px; padding: 10px 12px; border-radius: 12px; background: var(--dc-surface); font-size: 0.86em; color: var(--dc-fg); white-space: pre-wrap; max-height: 180px; overflow: auto; }
.dc-followups { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.dc-chip { border: 1px solid var(--dc-border); background: var(--dc-bg); color: var(--dc-fg); border-radius: 999px; padding: 6px 12px; font-size: 0.86em; }
.dc-chip:hover { border-color: var(--dc-accent); background: var(--dc-accent-soft); }
.dc-chip.primary { background: var(--dc-accent); color: var(--dc-accent-fg); border-color: var(--dc-accent); }
.dc-tools { display: flex; gap: 2px; margin-top: 6px; margin-left: -6px; }
.dc-tool { width: 30px; height: 30px; border: 0; border-radius: 8px; background: transparent; color: var(--dc-muted); display: grid; place-items: center; }
.dc-tool svg { width: 17px; height: 17px; }
.dc-tool:hover { background: var(--dc-surface); color: var(--dc-fg); }
.dc-tool[aria-pressed='true'] { color: var(--dc-accent); background: var(--dc-accent-soft); }
.dc.dark .dc-tool[aria-pressed='true'] { color: var(--dc-fg); }

/* ---------- run card */
.dc-run { border: 1px solid var(--dc-border); border-radius: 14px; background: var(--dc-surface); margin-bottom: 10px; overflow: hidden; }
.dc-run summary { list-style: none; display: flex; align-items: center; gap: 10px; padding: 9px 12px; cursor: pointer; font-size: 0.88em; }
.dc-run summary::-webkit-details-marker { display: none; }
.dc-run-icon { width: 26px; height: 26px; border-radius: 8px; display: grid; place-items: center; background: var(--dc-bg); color: var(--dc-highlight); flex: none; }
.dc-run-icon svg { width: 16px; height: 16px; }
.dc-run-title { font-weight: 600; }
.dc-run-meta { color: var(--dc-muted); margin-left: auto; white-space: nowrap; font-variant-numeric: tabular-nums; }
.dc-run-chev { transition: transform 0.15s ease; color: var(--dc-muted); }
.dc-run[open] .dc-run-chev { transform: rotate(90deg); }
.dc-run ol { list-style: none; margin: 0; padding: 0 12px 10px 48px; display: grid; gap: 6px; font-size: 0.86em; }
.dc-run li { display: flex; gap: 8px; align-items: baseline; }
.dc-run li .dc-step-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--dc-border); flex: none; transform: translateY(-1px); }
.dc-run li.running .dc-step-dot { background: var(--dc-highlight); animation: dc-pulse 1.2s ease-in-out infinite; }
.dc-run li.done .dc-step-dot { background: #2f9e6b; }
.dc-run li.failed .dc-step-dot { background: var(--dc-danger); }
.dc-run li em { font-style: normal; color: var(--dc-muted); margin-left: auto; font-variant-numeric: tabular-nums; }

/* ---------- typing, errors */
.dc-typing { display: inline-flex; gap: 4px; padding: 10px 2px; }
.dc-typing i { width: 7px; height: 7px; border-radius: 50%; background: var(--dc-muted); opacity: 0.4; animation: dc-bounce 1.1s ease-in-out infinite; }
.dc-typing i:nth-child(2) { animation-delay: 0.15s; } .dc-typing i:nth-child(3) { animation-delay: 0.3s; }
@keyframes dc-bounce { 0%, 80%, 100% { opacity: 0.35; transform: none; } 40% { opacity: 1; transform: translateY(-3px); } }
.dc-caret::after { content: ''; display: inline-block; width: 0.5em; height: 1em; margin-left: 2px; vertical-align: -0.15em; background: var(--dc-highlight); border-radius: 2px; animation: dc-pulse 1s steps(2) infinite; }
.dc-error { display: flex; gap: 10px; align-items: flex-start; padding: 10px 12px; border-radius: 12px; background: var(--dc-danger-soft); color: var(--dc-fg); font-size: 0.92em; }
.dc-error svg { color: var(--dc-danger); flex: none; width: 18px; height: 18px; margin-top: 2px; }
.dc-error .dc-chip { margin-top: 8px; }
.dc-notice { flex: 1; display: grid; place-items: center; padding: 32px 24px; text-align: center; }
.dc-notice-card { max-width: 340px; display: grid; justify-items: center; gap: 10px; }
.dc-notice-icon { width: 52px; height: 52px; border-radius: 16px; display: grid; place-items: center; background: var(--dc-surface); color: var(--dc-fg); }
.dc-notice-icon svg { width: 26px; height: 26px; }
.dc-notice h2 { margin: 4px 0 0; font-size: 1.15em; }
.dc-notice p { margin: 0; color: var(--dc-muted); font-size: 0.93em; }
.dc-loading { flex: 1; display: grid; place-items: center; color: var(--dc-muted); }

/* ---------- composer */
.dc-composer { flex: none; padding: 10px 12px 12px; background: var(--dc-bg); }
.dc-page .dc-composer { padding: 12px 24px 18px; }
.dc-compose-inner { max-width: 780px; margin: 0 auto; }
.dc-box {
  display: flex; align-items: flex-end; gap: 6px; padding: 6px; border-radius: 16px;
  border: 1px solid var(--dc-border); background: var(--dc-input-bg, var(--dc-surface)); color: var(--dc-input-fg, var(--dc-fg));
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
.dc-box:focus-within { border-color: var(--dc-accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dc-accent) 18%, transparent); }
.dc-box textarea {
  flex: 1; min-width: 0; resize: none; border: 0; outline: none; background: transparent; color: inherit;
  font: inherit; line-height: 1.45; padding: 8px 6px; max-height: 160px; min-height: 38px;
}
.dc-box textarea::placeholder { color: var(--dc-muted); opacity: 1; }
.dc-box textarea:focus-visible { box-shadow: none; }
.dc-send { width: 38px; height: 38px; border-radius: 12px; border: 0; background: var(--dc-accent); color: var(--dc-accent-fg); display: grid; place-items: center; flex: none; }
.dc-send:disabled { opacity: 0.35; }
.dc-attach { width: 38px; height: 38px; border-radius: 12px; border: 0; background: transparent; color: var(--dc-muted); display: grid; place-items: center; flex: none; }
.dc-attach:hover { color: var(--dc-fg); background: var(--dc-surface-2); }
.dc-pending { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
.dc-pending-item { position: relative; }
.dc-pending-item img { width: 56px; height: 56px; border-radius: 10px; object-fit: cover; border: 1px solid var(--dc-border); display: block; }
.dc-pending-item button { position: absolute; top: -6px; right: -6px; width: 22px; height: 22px; border-radius: 50%; border: 0; background: var(--dc-fg); color: var(--dc-bg); display: grid; place-items: center; padding: 0; }
.dc-pending-item button svg { width: 12px; height: 12px; }
.dc-foot { text-align: center; font-size: 0.72em; color: var(--dc-muted); margin-top: 8px; }
.dc-foot a { color: inherit; text-decoration: none; font-weight: 600; }
.dc-foot a:hover { text-decoration: underline; }
.dc-drop { position: absolute; inset: 0; display: grid; place-items: center; background: color-mix(in srgb, var(--dc-bg) 88%, transparent); border: 2px dashed var(--dc-accent); border-radius: inherit; font-weight: 600; z-index: 2; }

@media (max-width: 520px) {
  .dc-panel { right: 0; bottom: 0; width: 100vw; height: 100%; max-height: 100dvh; border-radius: 0; border: 0; }
  .dc-panel:not([hidden]) ~ .dc-launcher, .dc-launcher.is-open { display: none; }
  .dc-page .dc-thread { padding: 18px 14px 8px; }
  .dc-page .dc-composer { padding: 10px 12px 12px; }
  .dc-page .dc-header { padding: 12px 14px; }
  .dc-prompts { grid-template-columns: 1fr; }
}
@media (prefers-reduced-motion: reduce) {
  .dc *, .dc *::before, .dc *::after { animation: none !important; transition: none !important; scroll-behavior: auto !important; }
}
`
