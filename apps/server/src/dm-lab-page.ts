/**
 * DM Lab — a self-contained web front-end for driving the real DM and tuning it LIVE.
 * Served by the BACKEND (GET /dm/lab) so it never touches apps/web (scene-lab's territory).
 *
 * Three tabs:
 *  - Run      — enter a turn script + temperature, Run, inspect each turn (narration, tool
 *               calls + results, state diff, cost). Uses the current editor contents as overrides.
 *  - Playbook — edit prompts/dm-playbook.md live; Run picks it up without saving; Save persists.
 *  - Scenario — edit the scenario.json (per-scene GM guidance) live; same override + Save.
 *
 * Endpoints used: GET /dm/lab/files, POST /dm/lab (run with overrides), POST /dm/lab/save.
 */

import type { LabTurn } from './dm-lab.js';

/** Render the page. `transcripts` are injected so the UI can offer one-click presets. */
export function renderDmLabPage(transcripts: Record<string, LabTurn[]>): string {
  const transcriptsJson = JSON.stringify(transcripts);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>MythWeaver — DM Lab</title>
<style>
  :root { color-scheme: dark; --hdr: 52px; --tabs: 44px; }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body { margin: 0; background: #0e1014; color: #e6e8ee; font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
  header { height: var(--hdr); padding: 0 20px; border-bottom: 1px solid #23262e; display: flex; align-items: center; gap: 12px; }
  header h1 { font-size: 16px; margin: 0; font-weight: 600; }
  header .sub { color: #8b90a0; font-size: 12px; }
  nav.tabs { height: var(--tabs); display: flex; align-items: stretch; gap: 2px; padding: 0 14px; border-bottom: 1px solid #23262e; background: #0c0e12; }
  nav.tabs .tab { background: none; border: 0; border-bottom: 2px solid transparent; color: #9aa0b0; font: inherit; font-weight: 500; padding: 0 16px; cursor: pointer; }
  nav.tabs .tab:hover { color: #e6e8ee; }
  nav.tabs .tab.active { color: #fff; border-bottom-color: #4c6ef5; }
  nav.tabs .gstatus { margin-left: auto; align-self: center; color: #8b90a0; font-size: 12px; font-family: ui-monospace, monospace; }
  main { height: calc(100vh - var(--hdr) - var(--tabs)); }
  .view { display: none; height: 100%; }
  .view.run.active { display: grid; grid-template-columns: 400px 1fr; }
  .view.editor.active { display: flex; flex-direction: column; }
  /* interactive chat (Run tab) */
  .right-wrap { display: flex; flex-direction: column; min-height: 0; }
  .convo { flex: 1; overflow: auto; padding: 16px 20px; }
  .inputbar { border-top: 1px solid #23262e; padding: 10px 16px; background: #0c0e12; }
  .inputbar .row { gap: 8px; }
  .inputbar input { background: #161922; color: #e6e8ee; border: 1px solid #2b2f3a; border-radius: 8px; padding: 9px 11px; font: inherit; }
  .bubble { margin-bottom: 14px; max-width: 760px; }
  .bubble .who { font-size: 11px; color: #8b90a0; margin-bottom: 3px; font-weight: 600; }
  .bubble.player .who { color: #6ab0ff; }
  .bubble.player .line { color: #c7ccda; }
  .bubble.dm .narr { white-space: pre-wrap; }
  .bubble .meta { color: #7b8090; font-size: 11px; font-family: ui-monospace, monospace; margin-top: 5px; }
  .bubble .roll-pending { color: #e8a13a; font-size: 12px; margin-top: 5px; }
  .bubble details { margin-top: 6px; }
  .bubble details summary { color: #7b8090; font-size: 11px; cursor: pointer; user-select: none; }
  .bubble details > .tool, .bubble details > .diff { margin-top: 6px; }
  .rollask { color: #e8a13a; font-size: 12px; align-self: center; margin-right: auto; font-family: ui-monospace, monospace; }
  .sys { color: #6b7080; font-style: italic; font-size: 12px; margin-bottom: 12px; }
  .panel { padding: 16px 20px; overflow: auto; }
  .panel.left { border-right: 1px solid #23262e; }
  label { display: block; font-size: 12px; color: #9aa0b0; margin: 12px 0 4px; }
  label:first-child { margin-top: 0; }
  input[type=text], textarea { width: 100%; background: #161922; color: #e6e8ee; border: 1px solid #2b2f3a; border-radius: 8px; padding: 9px 11px; font: inherit; }
  textarea { resize: vertical; font: 13px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; }
  #turns { min-height: 200px; white-space: pre; }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  button { background: #3b5bdb; color: #fff; border: 0; border-radius: 8px; padding: 9px 16px; font: inherit; font-weight: 600; cursor: pointer; }
  button:hover { background: #4c6ef5; }
  button:disabled { background: #2b2f3a; color: #6b7080; cursor: default; }
  button.ghost { background: #1b1f29; color: #c7ccda; border: 1px solid #2b2f3a; font-weight: 500; padding: 6px 11px; }
  button.ghost:hover { background: #232735; }
  .temp { display: flex; align-items: center; gap: 10px; }
  .temp input[type=range] { flex: 1; accent-color: #4c6ef5; }
  .temp .val { font-family: ui-monospace, monospace; min-width: 34px; text-align: right; color: #c7ccda; }
  .hint { color: #6b7080; font-size: 12px; margin-top: 6px; }
  kbd { background: #20242e; border: 1px solid #2b2f3a; border-radius: 4px; padding: 0 5px; font: 11px ui-monospace, monospace; }
  /* editor tabs */
  .ed-toolbar { display: flex; align-items: center; gap: 10px; padding: 10px 20px; border-bottom: 1px solid #23262e; background: #0c0e12; }
  .ed-toolbar .name { font-family: ui-monospace, monospace; font-size: 12px; color: #9aa0b0; }
  .ed-toolbar .status { margin-left: auto; font-size: 12px; font-family: ui-monospace, monospace; color: #8b90a0; }
  .ed-wrap { flex: 1; padding: 0; display: flex; }
  .ed-wrap textarea { flex: 1; border: 0; border-radius: 0; resize: none; padding: 16px 20px; background: #0e1014; font-size: 13px; }
  .ed-wrap textarea:focus { outline: none; }
  /* arc tab */
  .arc-body { flex: 1; overflow: auto; padding: 18px 24px; max-width: 940px; }
  .arc-sec { margin-bottom: 18px; }
  .arc-sec h3 { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: #8b90a0; margin: 0 0 6px; font-weight: 700; }
  .arc-ending { background: #11351e; border: 1px solid #2a6b40; border-radius: 8px; padding: 10px 12px; color: #cdebd6; }
  .arc-problem { color: #e8c98a; }
  .kv { font-size: 13px; color: #c7ccda; line-height: 1.55; }
  .kv b { color: #8b90a0; font-weight: 600; }
  ul.spine { list-style: none; padding: 0; margin: 0; }
  ul.spine li { border-left: 2px solid #2b2f3a; padding: 2px 0 10px 14px; margin-left: 6px; }
  ul.spine li.done { border-color: #3a6b48; } ul.spine li.current { border-color: #4c6ef5; }
  ul.spine .ms { font-weight: 600; font-size: 13px; }
  ul.spine .mi { color: #9aa0b0; font-size: 12px; }
  .beatmap { display: flex; flex-wrap: wrap; gap: 8px; }
  .beat { border: 1px solid #2b2f3a; border-radius: 8px; padding: 6px 10px; font-size: 13px; color: #b7bccb; }
  .beat.done { border-color: #3a6b48; color: #8fd6a2; }
  .beat.current { border-color: #4c6ef5; color: #fff; background: #1b2340; }
  .beat.reach { border-color: #7b6a2e; color: #e8c98a; }
  .bubble .brief { color: #8fa0c8; font-size: 12px; margin-top: 5px; }
  /* "now playing" — reflects the active session in the Run left panel */
  .nowplaying { border: 1px solid #2a6b40; background: #0f1f15; border-radius: 10px; padding: 10px 12px; margin-bottom: 6px; }
  .nowplaying .np-tag { font-size: 10px; text-transform: uppercase; letter-spacing: .05em; color: #8fd6a2; font-weight: 700; margin-bottom: 4px; }
  .nowplaying.authored { border-color: #3b4663; background: #131722; }
  .nowplaying.authored .np-tag { color: #8fa0c8; }
  .nowplaying .np-title { font-size: 14px; font-weight: 600; color: #e6e8ee; line-height: 1.35; margin-bottom: 6px; }
  .nowplaying .np-row { font-size: 12px; color: #b7bccb; margin-top: 2px; }
  .nowplaying .np-row b { color: #8b90a0; font-weight: 600; }
  .np-sep { text-align: center; color: #4b5060; font-size: 11px; margin: 4px 0 8px; }
  .director-wrap { border: 1px solid #2b2f3a; border-radius: 10px; margin-bottom: 10px; background: #0c0e12; }
  .director-wrap summary { cursor: pointer; padding: 8px 11px; font-size: 12px; color: #8fa0c8; user-select: none; }
  .director-wrap .arc-body { padding: 4px 12px 12px; max-height: 320px; overflow: auto; }
  .run-empty { border: 1px dashed #2b2f3a; border-radius: 10px; padding: 14px 12px; color: #8b90a0; font-size: 13px; margin-bottom: 10px; }
  .run-empty a { color: #6ab0ff; text-decoration: none; }
  .run-empty a:hover { text-decoration: underline; }
  #presets .sugg { background: #1b1f29; color: #c7ccda; border: 1px solid #2b2f3a; font-weight: 500; padding: 6px 11px; border-radius: 8px; cursor: pointer; font: inherit; font-size: 12px; }
  #presets .sugg:hover { background: #232735; }
  /* distill tab */
  .view.distill.active { display: flex; flex-direction: column; }
  .distill-grid { flex: 1; display: grid; grid-template-columns: 1fr 1fr; min-height: 0; }
  .distill-col { display: flex; flex-direction: column; min-height: 0; }
  .distill-col:first-child { border-right: 1px solid #23262e; }
  select.seg { background: #161922; color: #e6e8ee; border: 1px solid #2b2f3a; border-radius: 7px; padding: 5px 8px; font: inherit; font-size: 12px; }
  .seg-btn { padding: 5px 11px; font-size: 12px; }
  .seg-btn.active { background: #2b3556; color: #fff; border-color: #3b5bdb; }
  .diff-view { flex: 1; overflow: auto; padding: 10px 14px; font: 12px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; background: #0e1014; }
  .diff-view .ln { white-space: pre-wrap; word-break: break-word; padding: 0 6px; }
  .diff-view .add { background: #11351e; color: #8fd6a2; }
  .diff-view .del { background: #38141d; color: #f0a6b0; }
  .diff-view .ctx { color: #6b7080; }
  .diff-view .gap { color: #4b5060; font-style: italic; padding: 3px 6px; }
  .diff-view .none { color: #6b7080; font-style: italic; }
  /* director tab (3 editable prompts side by side) */
  .view.director.active { display: flex; flex-direction: column; }
  .dir-head { padding: 10px 20px; border-bottom: 1px solid #23262e; background: #0c0e12; color: #8b90a0; font-size: 12px; }
  .dir-grid { flex: 1; display: grid; grid-template-columns: 1fr 1fr 1fr; min-height: 0; }
  .dir-col { display: flex; flex-direction: column; min-height: 0; border-right: 1px solid #23262e; }
  .dir-col:last-child { border-right: 0; }
  .dir-col .ed-toolbar { padding: 8px 12px; gap: 7px; }
  .dir-col .ed-toolbar .name { font-size: 11px; }
  /* generate tab */
  .view.generate.active { display: grid; grid-template-columns: 400px 1fr; }
  .gen-form textarea { min-height: 64px; }
  .gen-badge { border-bottom: 1px solid #23262e; padding: 8px 24px; font-size: 12px; font-family: ui-monospace, monospace; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .pill { border-radius: 20px; padding: 2px 10px; font-size: 11px; font-weight: 600; }
  .pill.fresh { background: #11351e; color: #8fd6a2; border: 1px solid #2a6b40; }
  .pill.stale { background: #38301a; color: #e8c98a; border: 1px solid #7b6a2e; }
  .pill.fallback { background: #38141d; color: #f0a6b0; border: 1px solid #5a2630; }
  .gen-badge .det { color: #8b90a0; }
  .prow { display: flex; flex-direction: column; gap: 4px; margin-bottom: 10px; }
  .prow-top { display: flex; gap: 6px; align-items: center; }
  .prow-top select { flex: 0 0 116px; }
  .prow-top .pname { flex: 1; min-width: 0; }
  .prow .premove { padding: 6px 9px; color: #c08; }
  .prow .pback { width: 100%; min-height: 30px; resize: vertical; font: 12px/1.4 ui-sans-serif, system-ui; }
  .radiorow, .ckrow { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: #c7ccda; margin: 0; cursor: pointer; }
  .ckrow { margin-top: 6px; }
  .mon-lib { display: flex; flex-wrap: wrap; gap: 6px; max-height: 150px; overflow: auto; }
  .mon-lib label { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: #c7ccda; margin: 0; border: 1px solid #2b2f3a; border-radius: 7px; padding: 4px 8px; cursor: pointer; }
  .mon-lib .cr { color: #6b7080; }
  /* results */
  .turn { border: 1px solid #23262e; border-radius: 10px; margin-bottom: 14px; overflow: hidden; }
  .turn .head { display: flex; justify-content: space-between; gap: 10px; padding: 9px 13px; background: #161922; border-bottom: 1px solid #23262e; align-items: baseline; }
  .turn .who { font-weight: 600; }
  .turn .who .tag { color: #e8a13a; font-weight: 500; font-size: 11px; margin-left: 6px; }
  .turn .meta { color: #7b8090; font-size: 11px; font-family: ui-monospace, monospace; white-space: nowrap; }
  .turn .body { padding: 11px 13px; }
  .tool { font-family: ui-monospace, monospace; font-size: 12px; margin: 0 0 7px; padding-left: 14px; border-left: 2px solid #3b5bdb; }
  .tool .name { color: #6ab0ff; font-weight: 600; }
  .tool .inp { color: #9aa0b0; }
  .tool .res { color: #79c08a; display: block; margin-top: 2px; word-break: break-word; }
  .roll { color: #e8a13a; font-size: 12px; margin: 0 0 7px; }
  .diff { font-family: ui-monospace, monospace; font-size: 12px; color: #c08ae8; margin: 0 0 8px; }
  .diff b { color: #c08ae8; font-weight: 600; }
  .narr { white-space: pre-wrap; }
  .narr.empty { color: #6b7080; font-style: italic; }
  .total { color: #9aa0b0; font-size: 12px; font-family: ui-monospace, monospace; padding: 4px 0 16px; }
  .err { background: #2a1416; border: 1px solid #5a2630; color: #f3a3ad; border-radius: 8px; padding: 11px 13px; white-space: pre-wrap; }
  .empty-state { color: #6b7080; padding: 40px 0; text-align: center; }
  .spin { display: inline-block; width: 13px; height: 13px; border: 2px solid #ffffff60; border-top-color: #fff; border-radius: 50%; animation: s .7s linear infinite; vertical-align: -2px; margin-right: 7px; }
  @keyframes s { to { transform: rotate(360deg); } }

  /* --- Character sheets (Run view party panel + modal) --- */
  .party-panel { margin-bottom: 12px; }
  .party-panel .ph { color: #8a90a0; font-size: 10px; text-transform: uppercase; letter-spacing: .06em; margin: 4px 0 6px; }
  .pc-row { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border: 1px solid #23262e; border-radius: 9px; background: #0c0e12; margin-bottom: 6px; cursor: pointer; }
  .pc-row:hover { border-color: #3a4560; background: #11141b; }
  .pc-row .nm { font-weight: 600; color: #e6e8ee; font-size: 13px; }
  .pc-row .sub { color: #8a90a0; font-size: 11px; }
  .pc-row .right { margin-left: auto; text-align: right; font-size: 11px; color: #9aa0b0; white-space: nowrap; }
  .pc-row .sheetbtn { color: #6ab0ff; }
  .hpbar { height: 5px; border-radius: 3px; background: #23262e; overflow: hidden; margin-top: 4px; }
  .hpbar > i { display: block; height: 100%; background: #8fd6a2; }

  .modal-backdrop { position: fixed; inset: 0; background: rgba(6,7,10,.74); display: none; align-items: flex-start; justify-content: center; z-index: 50; overflow: auto; padding: 26px 16px; }
  .modal-backdrop.open { display: flex; }
  .sheet { width: min(940px, 100%); background: #0e1014; border: 1px solid #2b2f3a; border-radius: 14px; box-shadow: 0 24px 70px rgba(0,0,0,.55); }
  .sheet-head { display: flex; align-items: flex-start; gap: 14px; padding: 16px 20px; border-bottom: 1px solid #23262e; position: sticky; top: 0; background: #0e1014; border-radius: 14px 14px 0 0; z-index: 1; }
  .sheet-head .nm { font-size: 20px; font-weight: 700; color: #fff; }
  .sheet-head .cls { color: #9aa0b0; font-size: 13px; margin-top: 2px; }
  .sheet-head .x { margin-left: auto; background: #1b1f29; border: 1px solid #2b2f3a; color: #c7ccda; border-radius: 8px; width: 30px; height: 30px; cursor: pointer; font-size: 14px; }
  .xpbar { height: 6px; background: #23262e; border-radius: 4px; overflow: hidden; margin-top: 7px; }
  .xpbar > i { display: block; height: 100%; background: #4c6ef5; }
  .sheet-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(232px, 1fr)); gap: 12px; padding: 16px 20px; }
  .sheet-section { border: 1px solid #23262e; border-radius: 10px; background: #0c0e12; padding: 11px 13px; }
  .sheet-section.wide { grid-column: 1 / -1; }
  .sheet-section h4 { margin: 0 0 9px; font-size: 10px; text-transform: uppercase; letter-spacing: .07em; color: #8a90a0; font-weight: 700; }
  .stat { display: flex; justify-content: space-between; gap: 8px; padding: 2px 0; font-size: 13px; }
  .stat .k { color: #9aa0b0; } .stat b { color: #e6e8ee; }
  .abil-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
  .abil { border: 1px solid #23262e; border-radius: 8px; padding: 7px 4px; text-align: center; background: #0e1014; }
  .abil.prof { border-color: #3a5bd0; }
  .abil .ab { font-size: 10px; text-transform: uppercase; color: #8a90a0; }
  .abil .mod { font-size: 19px; font-weight: 700; color: #e6e8ee; }
  .abil .sc { font-size: 11px; color: #9aa0b0; }
  .abil .sv { font-size: 10px; color: #6b7080; }
  .skill-row { display: flex; align-items: center; gap: 6px; font-size: 12px; padding: 2px 0; }
  .skill-row .tier { width: 12px; text-align: center; color: #e8a13a; }
  .skill-row .sk { flex: 1; color: #9aa0b0; }
  .skill-row.p .sk { color: #e6e8ee; }
  .skill-row .ab { color: #6b7080; font-size: 10px; text-transform: uppercase; }
  .skill-row .m { color: #e6e8ee; font-weight: 600; width: 30px; text-align: right; }
  .item-row { display: flex; align-items: center; gap: 8px; font-size: 12px; padding: 4px 0; border-bottom: 1px solid #171a20; }
  .badge { display: inline-block; font-size: 10px; padding: 1px 6px; border-radius: 999px; border: 1px solid #2b2f3a; color: #9aa0b0; margin-left: 5px; }
  .badge.eq { color: #8fd6a2; border-color: #2a6b40; }
  .badge.at { color: #c08ae8; border-color: #5a3d78; }
  .badge.un { color: #e8a13a; border-color: #7a5a1e; }
  .pill-sm { display: inline-block; font-size: 11px; padding: 2px 7px; border-radius: 6px; background: #161922; border: 1px solid #2b2f3a; color: #c7ccda; margin: 2px 4px 2px 0; }
  .coin { display: inline-block; margin-right: 12px; color: #9aa0b0; } .coin b { color: #e8c14a; }
  .over { color: #f0a6b0 !important; }
</style>
</head>
<body>
<header>
  <h1>MythWeaver — DM Lab</h1>
  <span class="sub">tune the DM live · edit the playbook &amp; scenario, set a temperature, Run the same prompts &amp; compare</span>
</header>
<nav class="tabs">
  <button class="tab active" data-tab="generate">Generate</button>
  <button class="tab" data-tab="run">Run</button>
  <button class="tab" data-tab="arc">Arc</button>
  <button class="tab" data-tab="playbook">DM</button>
  <button class="tab" data-tab="director">Director</button>
  <button class="tab" data-tab="distill">Distill</button>
  <span class="gstatus" id="gstatus"></span>
</nav>
<main>
  <section class="view run" id="view-run">
    <div class="panel left">
      <!-- Authored-scenario selectors kept hidden (still drive the Playbook/Scenario/Director editor tabs). -->
      <input id="scenario" type="hidden" value="the-sunken-bell" />
      <select id="startScene" style="display:none"></select>
      <div id="nowplaying" class="nowplaying" style="display:none"></div>
      <div id="party-panel" class="party-panel"></div>
      <details id="director-wrap" class="director-wrap" style="display:none">
        <summary>🎬 Director (live) — what the Showrunner is steering this turn</summary>
        <div class="arc-body" id="director-panel"></div>
      </details>
      <div id="run-empty" class="run-empty">No live campaign yet. <a href="#" id="goGenerate">Generate one in the Generate tab →</a></div>
      <label for="temp">DM temperature <span style="color:#6b7080">— narration creativity (0 = deterministic, 1 = creative)</span></label>
      <div class="temp">
        <input id="temp" type="range" min="0" max="1" step="0.05" value="1" />
        <span class="val" id="tempVal">1.00</span>
      </div>
      <div class="hint" style="margin-bottom:10px">Captured when you start a session from the Generate tab.</div>
      <label>Suggested actions <span style="color:#6b7080">— arc-aware; click to prefill, then tweak &amp; send</span></label>
      <div class="row" id="presets"><span class="hint">start a campaign to see suggestions</span></div>
      <div class="hint" id="status" style="margin-top:10px">Generate a campaign to begin.</div>
    </div>
    <div class="right-wrap">
      <details id="scene-panel" style="display:none;margin-bottom:8px;border:1px solid #23262f;border-radius:8px;background:#0f1116" open>
        <summary style="cursor:pointer;padding:7px 10px;color:#c9a227;font-size:13px">Scene — the story made real <span style="color:#6b7080">(re-renders as the DM sets scenes)</span></summary>
        <div style="padding:8px"><img id="scene-img" alt="current scene" style="width:100%;image-rendering:pixelated;border-radius:4px;display:block" /></div>
      </details>
      <div class="convo" id="convo"><div class="empty-state">No live campaign yet — head to the <b>Generate</b> tab, build your party, and generate an arc. Play begins here.</div></div>
      <div class="inputbar">
        <div class="row" id="msgbar">
          <select id="speaker" class="seg" style="width:160px" title="who is speaking"></select>
          <input id="msg" type="text" placeholder="What does the party do?  (Enter to send)" style="flex:1" />
          <button id="send" disabled>Send</button>
        </div>
        <div class="row" id="rollbar" style="display:none">
          <span id="rollask" class="rollask"></span>
          <input id="rollval" type="number" placeholder="total" style="width:90px" />
          <button id="declare">Declare</button>
          <button class="ghost" id="autoroll">Auto-roll</button>
        </div>
      </div>
    </div>
  </section>

  <div id="sheet-modal" class="modal-backdrop"><div class="sheet" id="sheet-body"></div></div>

  <section class="view editor" id="view-playbook">
    <div class="ed-toolbar">
      <span class="name">prompts/dm-playbook.md</span>
      <button class="ghost" data-reload="playbook">Reload from disk</button>
      <button data-save="playbook">Save</button>
      <span class="status" id="status-playbook"></span>
    </div>
    <div class="ed-wrap"><textarea id="ed-playbook" spellcheck="false" placeholder="loading…"></textarea></div>
  </section>

  <section class="view editor" id="view-arc">
    <div class="ed-toolbar">
      <span class="name">Generated arc <span style="color:#6b7080">— the editable campaign object; tweak party levels, monster stats, beats — then Start to test how the DM reads it</span></span>
      <button class="ghost" id="arc-revert" title="discard edits, restore the last generated arc">Revert</button>
      <button id="arc-start">Start session →</button>
      <span class="status" id="status-arc"></span>
    </div>
    <div class="ed-wrap"><textarea id="ed-arc" spellcheck="false" placeholder="Generate an arc (Generate tab) — the full campaign object appears here, editable: party (level/HP/abilities), bestiary (CR/HP/AC), encounters, beats. Edit, then Start session to see the DM react to the new numbers."></textarea></div>
  </section>

  <section class="view director" id="view-director">
    <div class="dir-head">The Game Director's brain is editable data — three hot-reloaded prompts. Edit + Save, then start a new (or generated) session to apply.</div>
    <div class="dir-grid">
      <div class="dir-col">
        <div class="ed-toolbar">
          <span class="name">prompts/director-architect.md</span>
          <button class="ghost" data-reload="director">Reload</button>
          <button data-save="director-architect">Save</button>
          <span class="status" id="status-director-architect"></span>
        </div>
        <div class="ed-wrap"><textarea id="ed-director-architect" spellcheck="false" placeholder="loading…" title="Builds the campaign blueprint (north star) from an authored scenario."></textarea></div>
      </div>
      <div class="dir-col">
        <div class="ed-toolbar">
          <span class="name">prompts/director-planner.md</span>
          <button class="ghost" data-reload="director">Reload</button>
          <button data-save="director-planner">Save</button>
          <span class="status" id="status-director-planner"></span>
        </div>
        <div class="ed-wrap"><textarea id="ed-director-planner" spellcheck="false" placeholder="loading…" title="Per-turn steering brief that adapts as the party plays."></textarea></div>
      </div>
      <div class="dir-col">
        <div class="ed-toolbar">
          <span class="name">prompts/director-composer.md</span>
          <button class="ghost" data-reload="director">Reload</button>
          <button data-save="director-composer">Save</button>
          <span class="status" id="status-director-composer"></span>
        </div>
        <div class="ed-wrap"><textarea id="ed-director-composer" spellcheck="false" placeholder="loading…" title="Generates a brand-new arc (beats + blueprint) from a seed."></textarea></div>
      </div>
    </div>
  </section>

  <section class="view generate active" id="view-generate">
    <div class="panel left gen-form">
      <label>1 · Your party <span style="color:#6b7080">— add players, pick a role</span></label>
      <div id="party-list"></div>
      <button class="ghost" id="party-add" style="margin-top:6px">+ Add player</button>
      <div class="hint">The party pre-exists the campaign — the Director designs the adventure for them.</div>

      <label for="gen-theme" style="margin-top:18px">2 · Theme <span style="color:#6b7080">— optional; blank = the Director invents it</span></label>
      <input id="gen-theme" type="text" placeholder="(optional) e.g. a haunted lighthouse hiding a smuggler's secret" />
      <label for="gen-tone">Tone</label>
      <select id="gen-tone" class="seg" style="width:100%">
        <option value="">(unspecified)</option>
        <option value="grim">grim</option>
        <option value="heroic">heroic</option>
        <option value="whimsical">whimsical</option>
        <option value="mystery">mystery</option>
        <option value="horror">horror</option>
      </select>
      <label for="gen-len">Length <span style="color:#6b7080">— beats (3–8)</span></label>
      <input id="gen-len" type="number" min="3" max="8" value="5" />
      <label for="gen-constraints">Constraints <span style="color:#6b7080">— one per line, optional</span></label>
      <textarea id="gen-constraints" rows="2" placeholder="no undead&#10;must feature a betrayal"></textarea>

      <label style="margin-top:18px">3 · Monsters</label>
      <div class="row">
        <label class="radiorow"><input type="radio" name="mmode" value="auto" checked /> Director fits them</label>
        <label class="radiorow"><input type="radio" name="mmode" value="manual" /> I pick the palette</label>
      </div>
      <div id="mon-auto"><label class="ckrow"><input type="checkbox" id="mon-commission" checked /> may commission new creatures <span style="color:#6b7080">(engine-statted)</span></label></div>
      <div id="mon-manual" style="display:none">
        <div class="hint" style="margin-bottom:4px">Allowed creatures (the Director places only these):</div>
        <div id="mon-library" class="mon-lib"></div>
      </div>

      <label for="gen-seedphrase" style="margin-top:18px">Seed phrase <span style="color:#6b7080">— vary for a different arc</span></label>
      <div class="row">
        <input id="gen-seedphrase" type="text" style="flex:1" placeholder="(blank = let the model choose)" />
        <button class="ghost" id="gen-reroll" title="new random seed phrase">Reroll</button>
      </div>
      <label for="gen-temp">Director temperature <span style="color:#6b7080">— novelty of the arc</span></label>
      <div class="temp">
        <input id="gen-temp" type="range" min="0" max="1" step="0.05" value="0.9" />
        <span class="val" id="gen-tempVal">0.90</span>
      </div>
      <div class="row" style="margin-top:14px;">
        <button id="gen-run">Generate arc</button>
        <button class="ghost" id="gen-start" disabled>Start session →</button>
      </div>
      <div class="hint" id="gen-status">Generation creates a fresh arc each time. Authored scenarios stay the default quality lane.</div>
    </div>
    <div class="right-wrap">
      <div class="gen-badge" id="gen-badge" style="display:none"></div>
      <div class="arc-body" id="gen-preview"><div class="empty-state">Set a theme and click <b>Generate arc</b> — the Director composes a brand-new campaign (premise → ending → beats) from your seed.</div></div>
    </div>
  </section>

  <section class="view distill" id="view-distill">
    <div class="distill-grid">
      <div class="distill-col">
        <div class="ed-toolbar">
          <span class="name">Source in</span>
          <select id="distill-mode" class="seg" title="Transcript = distil the DM's voice. Guide = distil best-practice directives.">
            <option value="transcript">Transcript</option>
            <option value="guide">Guide / best-practices</option>
          </select>
          <input type="file" id="distill-files" accept=".txt,.md,.json,.text,text/plain" multiple style="display:none" />
          <button class="ghost" id="distill-upload">Upload files…</button>
          <span class="status" id="distill-incount">0 chars</span>
          <button id="distill-run" style="margin-left:auto">Distill</button>
        </div>
        <div class="ed-wrap"><textarea id="distill-in" spellcheck="false" placeholder="Transcript mode: paste real session transcript(s) — lines prefixed 'DM:' work best — to distil the DM's voice.&#10;Guide mode: paste a DM best-practices / advice document to distil actionable principles.&#10;Or click Upload files (any text). Large pastes are sampled across the whole text."></textarea></div>
      </div>
      <div class="distill-col">
        <div class="ed-toolbar">
          <span class="name" id="distill-out-name">Distilled output (editable)</span>
          <button class="ghost seg-btn active" id="view-block">Block</button>
          <button class="ghost seg-btn" id="view-diff">Diff</button>
          <button id="distill-apply" style="margin-left:auto">Apply to Playbook →</button>
          <span class="status" id="distill-status"></span>
        </div>
        <div class="ed-wrap" id="wrap-block"><textarea id="distill-out" spellcheck="false" placeholder="The distilled block appears here. Review/edit it, flip to 'Diff' to see exactly what it changes in the playbook, then 'Apply to Playbook' (temporary) and test in Run. Nothing is saved until you hit Save on the Playbook tab."></textarea></div>
        <div class="diff-view" id="wrap-diff" style="display:none"></div>
      </div>
    </div>
  </section>

</main>
<script>
  var TRANSCRIPTS = ${transcriptsJson};
  var $ = function (id) { return document.getElementById(id); };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function turnsToText(turns) {
    return turns.map(function (t) { return ('roll' in t) ? 'roll: ' + t.roll : (t.as ? t.as + ': ' + t.say : t.say); }).join('\\n');
  }
  function parseTurns(text) {
    var out = [];
    text.split('\\n').forEach(function (raw) {
      var line = raw.trim();
      if (!line) return;
      var m = line.match(/^(?:roll|🎲)\\s*:?\\s*(-?\\d+)$/i);
      if (m) { out.push({ roll: Number(m[1]) }); return; }
      var s = line.match(/^([^:]{1,40}):\\s*(.+)$/);
      if (s) out.push({ as: s[1].trim(), say: s[2].trim() });
      else out.push({ say: line });
    });
    return out;
  }
  function fmtCost(n) { return '$' + (n || 0).toFixed(4); }
  function fmtTime(ms) { return ((ms || 0) / 1000).toFixed(1) + 's'; }
  function gstatus(msg) { $('gstatus').textContent = msg || ''; }

  // --- tabs ---
  function showTab(name) {
    ['generate', 'run', 'arc', 'playbook', 'director', 'distill'].forEach(function (n) {
      $('view-' + n).classList.toggle('active', n === name);
    });
    document.querySelectorAll('nav.tabs .tab').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-tab') === name);
    });
  }
  document.querySelectorAll('nav.tabs .tab').forEach(function (b) {
    b.onclick = function () { showTab(b.getAttribute('data-tab')); };
  });

  // --- interactive session (turn by turn, accumulating context) ---
  var sessionId = null;
  var pendingRoll = null;
  function convo() { return $('convo'); }
  function scrollConvo() { var c = $('convo'); c.scrollTop = c.scrollHeight; }
  function addSys(t) { var d = document.createElement('div'); d.className = 'sys'; d.textContent = t; convo().appendChild(d); scrollConvo(); }
  function addPlayer(speaker, text) {
    var d = document.createElement('div'); d.className = 'bubble player';
    d.innerHTML = '<div class="who">' + esc(speaker) + '</div><div class="line">' + esc(text) + '</div>';
    convo().appendChild(d); scrollConvo();
  }
  function addDm(t, brief) {
    var tools = (t.tools || []).map(function (c) {
      var res = c.result ? '<span class="res">→ ' + esc(c.result) + '</span>' : '';
      return '<div class="tool"><span class="name">' + esc(c.name) + '</span><span class="inp">(' + esc(JSON.stringify(c.input)) + ')</span>' + res + '</div>';
    }).join('');
    var diff = (t.diff && t.diff.length) ? '<div class="diff"><b>state Δ</b> ' + t.diff.map(esc).join('  |  ') + '</div>' : '';
    var details = (tools || diff) ? ('<details><summary>tools + state Δ</summary>' + tools + diff + '</details>') : '';
    var roll = t.rollRequest ? '<div class="roll-pending">⏸ needs a roll: ' + esc(t.rollRequest.expr) + ' — ' + esc(t.rollRequest.reason) + '</div>' : '';
    var bf = (brief && brief.activeBeatIntent) ? '<div class="brief">🎬 steering: ' + esc(brief.activeBeatIntent) + (brief.reachable && brief.reachable.length ? '  ·  → ' + brief.reachable.map(function (r) { return esc(r.sceneId); }).join(', ') : '') + '</div>' : '';
    var narr = t.narration ? '<div class="narr">' + esc(t.narration) + '</div>' : '<div class="narr" style="color:#6b7080;font-style:italic">(no narration — awaiting your roll)</div>';
    var meta = esc(t.model || '?') + ' · ' + t.steps + ' step(s) · ' + fmtTime(t.latencyMs) + ' · ' + fmtCost(t.costUsd);
    var d = document.createElement('div'); d.className = 'bubble dm';
    d.innerHTML = '<div class="who">Dungeon Master</div>' + narr + roll + bf + '<div class="meta">' + meta + '</div>' + details;
    convo().appendChild(d); scrollConvo();
  }

  // --- Arc tab (Game Director plan) ---
  var latestArc = null;
  var composerOn = true;
  var lastGeneratedArc = null; // the last /generate-arc result (arc + costUsd + markdown)

  // Freshness fingerprint badge from a generated arc's genMeta (proves fresh vs stale at a glance).
  function genBadgeHtml(meta, stale) {
    if (!meta) return '';
    var pill = meta.fallback
      ? '<span class="pill fallback">fallback — deterministic</span>'
      : stale
        ? '<span class="pill stale">stale — prompt edited since</span>'
        : '<span class="pill fresh">fresh</span>';
    var when = meta.timestampMs ? new Date(meta.timestampMs).toLocaleTimeString() : '';
    var bits = [];
    if (when) bits.push(when);
    bits.push('seed ' + esc(meta.seedHash || '?'));
    if (meta.seedPhrase) bits.push('“' + esc(meta.seedPhrase) + '”');
    bits.push(esc(meta.model || '?') + (meta.temperature != null ? '@' + meta.temperature : ''));
    if ((meta.inputTokens || meta.outputTokens)) bits.push((meta.inputTokens || 0) + '/' + (meta.outputTokens || 0) + ' tok');
    return pill + '<span class="det">' + bits.join(' · ') + '</span>';
  }

  // The LIVE Director state on the Run tab (the frozen blueprint lives in the Arc/Generate tabs).
  function renderDirectorPanel() {
    var wrap = $('director-wrap'); var el = $('director-panel');
    if (!el) return;
    var a = latestArc;
    if (!a || (!a.brief && (!a.beats || !a.beats.length))) { wrap.style.display = 'none'; return; }
    wrap.style.display = '';
    var h = '';
    if (a.beats && a.beats.length) {
      h += '<div class="arc-sec"><h3>Beats</h3><div class="beatmap">' + a.beats.map(function (b) {
        var cls = b.current ? 'current' : b.done ? 'done' : b.reachable ? 'reach' : '';
        var tag = b.current ? '● here' : b.done ? '✓ done' : b.reachable ? '→ reachable' : '';
        return '<span class="beat ' + cls + '">' + esc(b.title) + (tag ? ' <span style="color:#6b7080">' + tag + '</span>' : '') + '</span>';
      }).join('') + '</div></div>';
    }
    if (a.brief) {
      var br = a.brief;
      h += '<div class="arc-sec"><h3>Steering this turn</h3>';
      h += '<div class="kv"><b>Now:</b> ' + esc(br.activeBeatIntent || '—') + '</div>';
      if (br.reachable && br.reachable.length) h += '<div class="kv"><b>Reachable:</b> ' + br.reachable.map(function (r) { return esc(r.sceneId + ' — ' + r.hook); }).join('  ·  ') + '</div>';
      if (br.bridgeNpcs && br.bridgeNpcs.length) h += '<div class="kv"><b>Bridge NPCs:</b> ' + br.bridgeNpcs.map(function (n) { return esc(n.name + ' (' + n.role + ')'); }).join('; ') + '</div>';
      if (br.clocks && br.clocks.length) h += '<div class="kv"><b>Pressure:</b> ' + br.clocks.map(esc).join('; ') + '</div>';
      if (br.notes) h += '<div class="kv"><b>Note:</b> ' + esc(br.notes) + '</div>';
      h += '</div>';
    }
    if ((a.decisions && a.decisions.length) || (a.npcs && a.npcs.length)) {
      h += '<div class="arc-sec"><h3>Tracked</h3>';
      if (a.decisions && a.decisions.length) h += '<div class="kv"><b>Decisions:</b> ' + a.decisions.map(function (d) { return esc(d.key + '=' + d.value); }).join(', ') + '</div>';
      if (a.npcs && a.npcs.length) h += '<div class="kv"><b>NPCs:</b> ' + a.npcs.map(function (n) { return esc(n.key + '=' + n.value); }).join(', ') + '</div>';
      h += '</div>';
    }
    var L = a.ledger;
    if (L) {
      var pcs = (L.entities || []).filter(function (e) { return e.kind === 'pc'; });
      var cast = (L.entities || []).filter(function (e) { return e.kind !== 'pc'; });
      if (pcs.length) {
        h += '<div class="arc-sec"><h3>Party (backstories)</h3>' + pcs.map(function (e) {
          return '<div class="kv"><b>' + esc(e.name) + '</b>' + (e.notes ? ' — <span style="color:#9aa0b0">' + esc(e.notes) + '</span>' : '') + '</div>';
        }).join('') + '</div>';
      }
      if (cast.length) {
        h += '<div class="arc-sec"><h3>Canon — cast</h3>' + cast.map(function (e) {
          var v = e.voice ? [e.voice.tic, e.voice.want && 'wants ' + e.voice.want, e.voice.fear && 'fears ' + e.voice.fear].filter(Boolean).join('; ') : '';
          return '<div class="kv"><b>' + esc(e.name) + '</b> <span style="color:#6b7080">' + esc(e.status) + '</span>' + (v ? ' — <span style="color:#9aa0b0">' + esc(v) + '</span>' : '') + '</div>';
        }).join('') + '</div>';
      }
      if (L.facts && L.facts.length) {
        h += '<div class="arc-sec"><h3>Canon — facts</h3>' + L.facts.map(function (f) { return '<div class="kv">' + esc(f.subject) + ' · ' + esc(f.attribute) + ': ' + esc(f.value) + '</div>'; }).join('') + '</div>';
      }
      if (L.plants && L.plants.length) {
        h += '<div class="arc-sec"><h3>Plants</h3>' + L.plants.map(function (p) { return '<div class="kv">' + esc(p.what) + ' <span style="color:#6b7080">[' + esc(p.status) + ']</span></div>'; }).join('') + '</div>';
      }
    }
    el.innerHTML = h;
  }
  function setPending(rr) {
    pendingRoll = rr || null;
    $('rollbar').style.display = pendingRoll ? 'flex' : 'none';
    $('msgbar').style.display = pendingRoll ? 'none' : 'flex';
    if (pendingRoll) { $('rollask').textContent = '🎲 ' + pendingRoll.expr + ' — ' + pendingRoll.reason; $('rollval').value = ''; $('rollval').focus(); }
    else if (sessionId) { $('msg').focus(); }
  }
  function setBusy(b) { $('send').disabled = b || !sessionId; $('msg').disabled = b || !sessionId; $('declare').disabled = b; $('autoroll').disabled = b; }

  var partyNames = []; // party of the live session (for arc-aware suggestions)

  // Shared success handler for a session start (campaigns now always start from the Generate tab).
  function sessionStarted(b) {
    sessionId = b.sessionId; pendingRoll = null;
    partyNames = (b.party || []).map(function (p) { return p.name; });
    convo().innerHTML = '';
    addSys('Session started · scene "' + b.scene + '" · party: ' + partyNames.join(', '));
    var sp = $('speaker'); sp.innerHTML = '';
    var grp = document.createElement('option'); grp.value = 'The party'; grp.textContent = 'The party'; sp.appendChild(grp);
    (b.party || []).forEach(function (p) { var o = document.createElement('option'); o.value = p.name; o.textContent = p.name; sp.appendChild(o); });
    latestArc = b.arc || null; renderDirectorPanel();
    latestCharacters = b.characters || []; renderCharacterSheets();
    renderNowPlaying(b);
    renderSuggestions();
    $('run-empty').style.display = 'none';
    setPending(null); setBusy(false);
  }

  // Reflect the ACTIVE campaign in the Run left panel (so it stops showing the stale authored defaults).
  function renderNowPlaying(b) {
    var arc = b.arc || {};
    var bp = arc.blueprint;
    var gen = !!arc.genMeta;
    var sceneTitle = (arc.beats || []).filter(function (x) { return x.current; }).map(function (x) { return x.title; })[0] || arc.currentScene || b.scene;
    var title = (bp && bp.premise) ? bp.premise : (b.scenarioId || 'session');
    var el = $('nowplaying');
    el.className = 'nowplaying' + (gen ? '' : ' authored');
    el.innerHTML = '<div class="np-tag">' + (gen ? '✦ now playing — generated campaign' : 'now playing — authored scenario') + '</div>' +
      '<div class="np-title">' + esc(title) + '</div>' +
      '<div class="np-row"><b>Scene:</b> ' + esc(sceneTitle) + '</div>' +
      '<div class="np-row"><b>Party:</b> ' + esc((b.party || []).map(function (p) { return p.name; }).join(', ')) + '</div>';
    el.style.display = '';
  }

  // --- Character sheets: compact party rows in the Run left panel + a full per-PC modal, both live. ---
  var latestCharacters = [];
  var openSheetId = null;
  function signed(n) { return (n >= 0 ? '+' : '') + n; }
  function tierMark(t) { return t === 'expertise' ? '★' : t === 'proficient' ? '●' : t === 'half' ? '◐' : '·'; }
  function skillName(k) { return k.replace(/([A-Z])/g, ' $1').replace(/^./, function (c) { return c.toUpperCase(); }); }
  function sec(title, body, wide) { return '<div class="sheet-section' + (wide ? ' wide' : '') + '"><h4>' + esc(title) + '</h4>' + body + '</div>'; }
  function st(k, v) { return '<div class="stat"><span class="k">' + k + '</span><b>' + v + '</b></div>'; }
  function pcById(id) { return latestCharacters.filter(function (p) { return p.id === id; })[0] || null; }

  function renderCharacterSheets() {
    var box = $('party-panel'); if (!box) return;
    if (!latestCharacters.length) { box.innerHTML = ''; return; }
    var html = '<div class="ph">Party — click a character for the full sheet</div>';
    latestCharacters.forEach(function (pc) {
      var pct = pc.hp.max ? Math.max(0, Math.min(100, Math.round(100 * pc.hp.cur / pc.hp.max))) : 0;
      var tags = [];
      if (pc.concentration) tags.push('◎ ' + esc(pc.concentration));
      if (pc.inspiration) tags.push('★ insp');
      if (pc.exhaustion) tags.push('exh ' + pc.exhaustion);
      if (pc.conditions && pc.conditions.length) tags.push(esc(pc.conditions.join(', ')));
      html += '<div class="pc-row" data-id="' + esc(pc.id) + '">'
        + '<div style="flex:1;min-width:0">'
        + '<div class="nm">' + esc(pc.name) + ' <span class="sub">L' + pc.level + ' ' + esc(pc.className) + '</span></div>'
        + '<div class="hpbar"><i style="width:' + pct + '%"></i></div>'
        + (tags.length ? '<div class="sub" style="margin-top:4px">' + tags.join(' · ') + '</div>' : '')
        + '</div>'
        + '<div class="right">' + pc.hp.cur + '/' + pc.hp.max + ' HP<br>AC ' + pc.ac + ' · <span class="sheetbtn">Sheet ›</span></div>'
        + '</div>';
    });
    box.innerHTML = html;
    Array.prototype.forEach.call(box.querySelectorAll('.pc-row'), function (row) {
      row.onclick = function () { openSheet(row.getAttribute('data-id')); };
    });
  }

  function openSheet(id) {
    openSheetId = id; renderSheet(id); $('sheet-modal').classList.add('open');
    // Refresh from the server in the background so an opened sheet reflects the very latest state.
    if (sessionId) fetch('/dm/lab/session/' + sessionId + '/characters').then(function (r) { return r.json(); })
      .then(function (b) { if (b && b.characters) { latestCharacters = b.characters; renderCharacterSheets(); if (openSheetId) renderSheet(openSheetId); } }).catch(function () {});
  }
  function closeSheet() { openSheetId = null; $('sheet-modal').classList.remove('open'); }

  function renderSheet(id) {
    var pc = pcById(id); var b = $('sheet-body'); if (!pc || !b) return;
    var xpPct = 100, xpLabel = pc.xp + ' XP (max level)';
    if (pc.xpNext) { var span = pc.xpNext - pc.xpThis; xpPct = span > 0 ? Math.max(0, Math.min(100, Math.round(100 * (pc.xp - pc.xpThis) / span))) : 100; xpLabel = pc.xp + ' / ' + pc.xpNext + ' XP'; }
    var head = '<div class="sheet-head"><div style="flex:1">'
      + '<div class="nm">' + esc(pc.name) + '</div>'
      + '<div class="cls">' + esc(pc.ancestry) + ' · ' + esc(pc.className) + ' · Level ' + pc.level + (pc.inspiration ? ' · ★ Inspiration' : '') + (pc.exhaustion ? ' · Exhaustion ' + pc.exhaustion : '') + '</div>'
      + '<div class="xpbar"><i style="width:' + xpPct + '%"></i></div>'
      + '<div class="sub" style="font-size:11px;color:#6b7080;margin-top:4px">' + xpLabel + '</div>'
      + '</div><button class="x" id="sheet-x">✕</button></div>';

    var sections = [];
    sections.push(sec('Core',
      st('Hit Points', pc.hp.cur + ' / ' + pc.hp.max + (pc.hp.temp ? (' (+' + pc.hp.temp + ' temp)') : ''))
      + st('Armor Class', pc.ac) + st('Speed', pc.speed + ' ft') + st('Initiative', signed(pc.initiative)) + st('Proficiency', signed(pc.prof))
      + (pc.hitDice ? st('Hit Dice', pc.hitDice.remaining + ' / ' + pc.hitDice.max + ' d' + pc.hitDice.size) : '')
      + (pc.passives ? st('Passive Per / Inv / Ins', pc.passives.perception + ' / ' + pc.passives.investigation + ' / ' + pc.passives.insight) : '')
      + (pc.conditions && pc.conditions.length ? st('Conditions', esc(pc.conditions.join(', '))) : '')
      + (pc.concentration ? st('Concentrating on', esc(pc.concentration)) : '')));

    sections.push(sec('Abilities', '<div class="abil-grid">' + pc.abilities.map(function (a) {
      return '<div class="abil' + (a.saveProf ? ' prof' : '') + '"><div class="ab">' + esc(a.key) + '</div><div class="mod">' + signed(a.mod) + '</div><div class="sc">' + a.score + '</div><div class="sv">save ' + signed(a.save) + '</div></div>';
    }).join('') + '</div>'));

    sections.push(sec('Skills', pc.skills.map(function (s) {
      return '<div class="skill-row' + (s.tier !== 'none' ? ' p' : '') + '"><span class="tier">' + tierMark(s.tier) + '</span><span class="sk">' + skillName(s.key) + '</span><span class="ab">' + esc(s.ability) + '</span><span class="m">' + signed(s.mod) + '</span></div>';
    }).join('')));

    if (pc.attacks && pc.attacks.length) {
      sections.push(sec('Attacks', pc.attacks.map(function (at) { return st(esc(at.name), signed(at.attackBonus) + ' · ' + esc(at.damage) + ' ' + esc(at.damageType)); }).join('')));
    }

    if (pc.spellcasting) {
      var sc = pc.spellcasting;
      var chips = function (arr) { return (arr && arr.length) ? arr.map(function (x) { return '<span class="pill-sm">' + esc(x) + '</span>'; }).join('') : '<span class="sub">—</span>'; };
      var slotHtml = pc.slots.length ? pc.slots.map(function (s) { return '<span class="pill-sm">L' + s.level + ' ' + s.cur + '/' + s.max + '</span>'; }).join('') : '<span class="sub">no slots</span>';
      sections.push(sec('Spellcasting',
        st('Spell Save DC', sc.saveDc) + st('Spell Attack', signed(sc.attack)) + (sc.preparedMax != null ? st('Prepared', (sc.prepared ? sc.prepared.length : 0) + ' / ' + sc.preparedMax) : '')
        + '<div class="sub" style="margin:7px 0 3px">Slots</div>' + slotHtml
        + '<div class="sub" style="margin:7px 0 3px">Cantrips</div>' + chips(sc.cantrips)
        + '<div class="sub" style="margin:7px 0 3px">Prepared</div>' + chips(sc.prepared)
        + (sc.rituals && sc.rituals.length ? '<div class="sub" style="margin:7px 0 3px">Rituals <span style="color:#6b7080">(no slot)</span></div>' + chips(sc.rituals) : '')));
    }

    if (pc.resources && pc.resources.length) {
      sections.push(sec('Class Resources', pc.resources.map(function (r) { return st(esc(r.id) + ' <span style="color:#6b7080">(' + r.recharge + ' rest)</span>', r.current + ' / ' + r.max); }).join('')));
    }

    var coins = '<div style="margin-bottom:8px"><span class="coin"><b>' + pc.currency.gp + '</b> gp</span><span class="coin"><b>' + pc.currency.sp + '</b> sp</span><span class="coin"><b>' + pc.currency.cp + '</b> cp</span></div>';
    var carry = '<div class="sub' + (pc.carry.over ? ' over' : '') + '" style="margin-bottom:7px">Carry ' + pc.carry.lb + ' / ' + pc.carry.cap + ' lb' + (pc.carry.over ? ' — OVERLOADED' : '') + ' · Attuned ' + pc.attunement.used + '/' + pc.attunement.max + '</div>';
    var itemsHtml = pc.items.length ? pc.items.map(function (it) {
      var badges = '';
      if (it.equippedSlot) badges += '<span class="badge eq">' + esc(it.equippedSlot) + '</span>';
      if (it.attuned) badges += '<span class="badge at">attuned</span>';
      if (it.magic && !it.identified) badges += '<span class="badge un">unidentified</span>';
      if (it.charges) badges += '<span class="badge">' + it.charges.remaining + '/' + it.charges.max + ' chg</span>';
      return '<div class="item-row"><span style="flex:1">' + esc(it.name) + (it.qty > 1 ? ' ×' + it.qty : '') + badges + '</span><span class="sub">' + it.weightLb + ' lb</span></div>';
    }).join('') : '<span class="sub">(nothing carried)</span>';
    sections.push(sec('Inventory', coins + carry + itemsHtml, true));

    var story = (pc.backstory ? '<div style="white-space:pre-wrap;color:#c7ccda;font-size:13px;line-height:1.5;margin-bottom:8px">' + esc(pc.backstory) + '</div>' : '<span class="sub">No backstory recorded.</span>')
      + (pc.features && pc.features.length ? '<div class="sub" style="margin:8px 0 4px">Features</div>' + pc.features.map(function (f) { return '<div class="stat"><span class="k">' + esc(f.name) + '</span></div>'; }).join('') : '');
    sections.push(sec('Story & Features', story, true));

    b.innerHTML = head + '<div class="sheet-grid">' + sections.join('') + '</div>';
    $('sheet-x').onclick = closeSheet;
  }

  (function () {
    var m = $('sheet-modal');
    if (m) m.addEventListener('click', function (e) { if (e.target === m) closeSheet(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && openSheetId) closeSheet(); });
  })();

  // Arc-aware quick-starts: derive a few suggested player actions from the LIVE arc (current scene +
  // steering brief + party), prefill the input on click so the tester can tweak & send.
  function renderSuggestions() {
    var box = $('presets');
    if (!sessionId) { box.innerHTML = '<span class="hint">start a campaign to see suggestions</span>'; return; }
    var a = latestArc || {};
    var brief = a.brief || {};
    var sceneTitle = (a.beats || []).filter(function (x) { return x.current; }).map(function (x) { return x.title; })[0] || 'the scene';
    var p0 = partyNames[0] || null;
    var sugg = [];
    sugg.push({ label: 'Investigate', who: 'The party', text: 'We examine ' + sceneTitle + ' carefully — what stands out?' });
    if (brief.bridgeNpcs && brief.bridgeNpcs.length) {
      sugg.push({ label: 'Talk to ' + brief.bridgeNpcs[0].name, who: p0 || 'The party', text: (p0 ? 'I' : 'We') + ' approach ' + brief.bridgeNpcs[0].name + ' and ask what is really going on.' });
    } else {
      sugg.push({ label: 'Question someone', who: p0 || 'The party', text: (p0 ? 'I' : 'We') + ' find someone here and press them for what they know.' });
    }
    if (brief.reachable && brief.reachable.length) {
      var r = brief.reachable[0];
      sugg.push({ label: 'Move on', who: 'The party', text: 'We move on — ' + (r.hook || ('toward ' + r.sceneId)) + '.' });
    }
    sugg.push({ label: 'Ready for trouble', who: p0 || 'The party', text: (p0 ? 'I ready my weapon' : 'We ready weapons') + ' and watch for any threat.' });
    box.innerHTML = '';
    sugg.forEach(function (s) {
      var b = document.createElement('button');
      b.className = 'sugg'; b.textContent = s.label; b.title = s.text;
      b.onclick = function () {
        if (pendingRoll) return;
        var sp = $('speaker'); if (sp) sp.value = s.who;
        $('msg').value = s.text; $('msg').focus();
      };
      box.appendChild(b);
    });
  }

  // Auto-deliver the DM's opening narration so a fresh session sets the scene before the players act.
  function autoOpen() {
    if (!sessionId) return Promise.resolve();
    setBusy(true);
    $('status').innerHTML = '<span class="spin"></span>DM is setting the scene…';
    return fetch('/dm/lab/session/' + sessionId + '/turn', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ open: true }) })
      .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
      .then(function (x) {
        if (!x.ok) { addSys('(opening narration skipped: ' + (x.body.error || 'failed') + ')'); setBusy(false); $('status').textContent = 'session live — what do you do?'; return; }
        var t = x.body.turn;
        if (x.body.arc) { latestArc = x.body.arc; renderDirectorPanel(); }
        if (x.body.characters) { latestCharacters = x.body.characters; renderCharacterSheets(); if (openSheetId) renderSheet(openSheetId); }
        addDm(t, latestArc && latestArc.brief);
        setPending(x.body.pendingRoll);
        renderSuggestions();
        setBusy(false);
        $('status').textContent = 'the scene is set — what do you do?';
        refreshScene();
      })
      .catch(function (e) { addSys('(opening narration skipped: ' + (e.message || e) + ')'); setBusy(false); $('status').textContent = 'session live — what do you do?'; });
  }

  // The playable view's SCENE panel: probe the server-side headless render of the current location and
  // show it when the DM has established one (404 until then). Called after every turn.
  function refreshScene() {
    if (!sessionId) return;
    var probe = new Image();
    probe.onload = function () { $('scene-img').src = probe.src; $('scene-panel').style.display = ''; };
    probe.src = '/dm/lab/session/' + sessionId + '/scene.png?v=' + Date.now();
  }

  function submitTurn(payload) {
    if (!sessionId) return Promise.resolve();
    setBusy(true);
    $('status').innerHTML = '<span class="spin"></span>DM thinking…';
    return fetch('/dm/lab/session/' + sessionId + '/turn', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
      .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
      .then(function (x) {
        if (!x.ok) { addSys('error: ' + (x.body.error || 'failed')); setBusy(false); $('status').textContent = ''; return; }
        var t = x.body.turn;
        if (x.body.arc) { latestArc = x.body.arc; renderDirectorPanel(); } // Director may have re-planned this turn
        if (x.body.characters) { latestCharacters = x.body.characters; renderCharacterSheets(); if (openSheetId) renderSheet(openSheetId); } // live sheet update
        if (t.kind !== 'message') addPlayer('roll', t.input); // show the actual declared/auto total
        addDm(t, latestArc && latestArc.brief);
        setPending(x.body.pendingRoll);
        renderSuggestions(); // keep quick-starts arc-aware as the scene advances
        setBusy(false);
        refreshScene(); // the DM may have established/changed the location this turn
        $('status').textContent = 'turn ' + t.index + ' · total ' + fmtCost(x.body.totalCostUsd) + ' · ' + fmtTime(x.body.totalLatencyMs);
      }).catch(function (e) { addSys('error: ' + (e.message || e)); setBusy(false); $('status').textContent = ''; });
  }

  function sendMsg() {
    if (!sessionId || pendingRoll) return;
    var text = $('msg').value.trim(); if (!text) return;
    var as = $('speaker').value;
    $('msg').value = '';
    addPlayer(as || 'The party', text);
    var payload = { say: text }; if (as) payload.as = as;
    submitTurn(payload);
  }
  function declareRoll() { if (!pendingRoll) return; var n = Number($('rollval').value); if (!isFinite(n)) return; submitTurn({ roll: n }); }
  function autoRoll() { if (!pendingRoll) return; submitTurn({ auto: true }); }

  // --- load / save editable files ---
  function loadFiles() {
    var slug = $('scenario').value.trim() || 'the-sunken-bell';
    gstatus('loading files…');
    fetch('/dm/lab/files?scenario=' + encodeURIComponent(slug)).then(function (r) { return r.json(); }).then(function (b) {
      if (b.error) { gstatus('load error: ' + b.error); return; }
      // Loads the GLOBAL, hot-reloaded prompts (playbook + Director). The authored scenario.json is no
      // longer edited here — it's the eval / real-game fixture; the lab plays generated arcs.
      $('ed-playbook').value = b.playbook || '';
      $('ed-director-architect').value = b.directorArchitect || '';
      $('ed-director-planner').value = b.directorPlanner || '';
      $('ed-director-composer').value = b.directorComposer || '';
      composerOn = b.composerOn !== false;
      if (!composerOn) $('gen-status').textContent = 'arc generation is OFF — set MYTHWEAVER_ARC_COMPOSER=llm and restart the server';
      gstatus('files loaded');
      setTimeout(function () { gstatus(''); }, 1500);
    }).catch(function (e) { gstatus('load error: ' + (e.message || e)); });
  }
  function save(kind) {
    var st = $('status-' + kind);
    var payload;
    if (kind === 'playbook') payload = { playbook: $('ed-playbook').value };
    else if (kind === 'director-architect') payload = { directorArchitect: $('ed-director-architect').value };
    else if (kind === 'director-planner') payload = { directorPlanner: $('ed-director-planner').value };
    else if (kind === 'director-composer') payload = { directorComposer: $('ed-director-composer').value };
    else return;
    st.textContent = 'saving…';
    fetch('/dm/lab/save', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
      .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
      .then(function (x) { st.textContent = x.ok ? 'saved ✓' : ('error: ' + (x.body.error || 'failed')); })
      .catch(function (e) { st.textContent = 'error: ' + (e.message || e); });
  }
  document.querySelectorAll('[data-save]').forEach(function (b) { b.onclick = function () { save(b.getAttribute('data-save')); }; });
  document.querySelectorAll('[data-reload]').forEach(function (b) { b.onclick = function () { loadFiles(); }; });

  // --- session controls + temp ---
  $('temp').oninput = function () { $('tempVal').textContent = Number($('temp').value).toFixed(2); };
  $('goGenerate').onclick = function (e) { e.preventDefault(); showTab('generate'); };
  $('send').onclick = sendMsg;
  $('msg').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); sendMsg(); } });
  $('declare').onclick = declareRoll;
  $('autoroll').onclick = autoRoll;
  $('rollval').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); declareRoll(); } });

  // --- Generate tab (build a party → compose a fresh arc from a seed → start a session) ---
  var libraryRoles = [];   // [{id,name,className,...}]
  var libraryBestiary = []; // [{id,name,cr,type}]

  function loadLibrary() {
    fetch('/dm/lab/library').then(function (r) { return r.json(); }).then(function (b) {
      if (b.error) { $('gen-status').textContent = 'library error: ' + b.error; return; }
      libraryRoles = b.roles || [];
      libraryBestiary = b.bestiary || [];
      // Monster palette browser (manual mode).
      $('mon-library').innerHTML = libraryBestiary.map(function (m) {
        return '<label><input type="checkbox" value="' + esc(m.id) + '" /> ' + esc(m.name) + ' <span class="cr">CR ' + esc(m.cr) + '</span></label>';
      }).join('');
      // Seed a default party once the roles are known.
      if (!$('party-list').children.length) ['fighter', 'cleric', 'rogue'].forEach(function (role) { addPlayer(role); });
    }).catch(function (e) { $('gen-status').textContent = 'library error: ' + (e.message || e); });
  }
  function roleOptions(sel) {
    return libraryRoles.map(function (r) { return '<option value="' + esc(r.id) + '"' + (r.id === sel ? ' selected' : '') + '>' + esc(r.name) + '</option>'; }).join('');
  }
  function addPlayer(role, name) {
    var row = document.createElement('div'); row.className = 'prow';
    row.innerHTML = '<div class="prow-top"><select class="seg prole">' + roleOptions(role) + '</select>' +
      '<input class="pname" type="text" placeholder="name (optional)" value="' + esc(name || '') + '" />' +
      '<button class="ghost premove" title="remove">×</button></div>' +
      '<textarea class="pback" rows="1" placeholder="backstory (optional — blank = the Director invents one)"></textarea>';
    row.querySelector('.premove').onclick = function () { row.remove(); };
    $('party-list').appendChild(row);
  }
  function collectParty() {
    return [].slice.call(document.querySelectorAll('#party-list .prow')).map(function (row) {
      var role = row.querySelector('.prole').value;
      var name = row.querySelector('.pname').value.trim();
      var backstory = row.querySelector('.pback').value.trim();
      var p = { role: role };
      if (name) p.name = name;
      if (backstory) p.backstory = backstory;
      return p;
    }).filter(function (p) { return p.role; });
  }
  function monsterConfig() {
    var mode = (document.querySelector('input[name="mmode"]:checked') || {}).value || 'auto';
    if (mode === 'manual') {
      var palette = [].slice.call(document.querySelectorAll('#mon-library input:checked')).map(function (c) { return c.value; });
      return { monsterMode: 'manual', monsterPalette: palette, allowCommission: false };
    }
    return { monsterMode: 'auto', allowCommission: $('mon-commission').checked };
  }
  function collectSeed() {
    var seed = { party: collectParty() };
    var theme = $('gen-theme').value.trim(); if (theme) seed.theme = theme;
    var tone = $('gen-tone').value; if (tone) seed.tone = tone;
    var len = Number($('gen-len').value); if (isFinite(len)) seed.lengthBeats = len;
    var cons = $('gen-constraints').value.split('\\n').map(function (s) { return s.trim(); }).filter(Boolean);
    if (cons.length) seed.constraints = cons;
    var sp = $('gen-seedphrase').value.trim(); if (sp) seed.seedPhrase = sp;
    seed.temperature = Number($('gen-temp').value);
    var mc = monsterConfig();
    seed.monsterMode = mc.monsterMode; seed.allowCommission = mc.allowCommission;
    if (mc.monsterPalette) seed.monsterPalette = mc.monsterPalette;
    return seed;
  }
  function renderGenPreview(arc) {
    var bp = arc.blueprint || {};
    var encBySceneId = {}; (arc.encounters || []).forEach(function (e) { encBySceneId[e.sceneId] = e; });
    function monLine(enc) {
      if (!enc) return '';
      return ' <span style="color:#e8a13a">⚔ ' + enc.monsters.map(function (m) { return m.count + '× ' + esc((arc.bestiary[m.statBlockId] || {}).name || m.statBlockId); }).join(', ') + '</span>';
    }
    var h = '';
    h += '<div class="arc-sec"><h3>Premise</h3><div class="kv">' + esc(bp.premise || '—') + '</div></div>';
    if (arc.party && arc.party.length) {
      h += '<div class="arc-sec"><h3>Party <span style="color:#6b7080">— backstories (authored or Director-invented)</span></h3>' + arc.party.map(function (p) {
        return '<div class="kv"><b>' + esc(p.name) + '</b> <span style="color:#6b7080">L' + esc(p.level) + ' ' + esc(p.className) + '</span>' + (p.backstory ? ' — <span style="color:#9aa0b0">' + esc(p.backstory) + '</span>' : ' <span style="color:#6b7080">(no backstory)</span>') + '</div>';
      }).join('') + '</div>';
    }
    h += '<div class="arc-sec"><h3>Central problem</h3><div class="kv arc-problem">' + esc(bp.centralProblem || '—') + '</div></div>';
    h += '<div class="arc-sec"><h3>Intended ending — north star</h3><div class="arc-ending">' + esc(bp.intendedEnding || '—') + '</div></div>';
    h += '<div class="arc-sec"><h3>Opening</h3><div class="kv">' + esc(bp.opening || '—') + '</div></div>';
    if (bp.spine && bp.spine.length) {
      h += '<div class="arc-sec"><h3>Spine — route to the ending</h3><ul class="spine">' + bp.spine.map(function (s) {
        return '<li><div class="ms">' + esc(s.milestone || s.sceneId || '') + (s.sceneId ? ' <span style="color:#6b7080">[' + esc(s.sceneId) + ']</span>' : '') + '</div><div class="mi">' + esc(s.intent || '') + '</div></li>';
      }).join('') + '</ul></div>';
    }
    var scenes = (arc.adventure && arc.adventure.scenes) || {};
    var ids = Object.keys(scenes);
    if (ids.length) {
      h += '<div class="arc-sec"><h3>Beats</h3><ul class="spine">' + ids.map(function (id) {
        var s = scenes[id];
        var ex = (s.exits && s.exits.length) ? ' <span style="color:#6b7080">→ ' + s.exits.map(esc).join(', ') + '</span>' : '';
        return '<li><div class="ms">' + esc(s.title) + ' <span style="color:#6b7080">[' + esc(id) + ']</span>' + ex + monLine(encBySceneId[id]) + '</div><div class="mi">' + esc(s.summary || '') + '</div></li>';
      }).join('') + '</ul></div>';
    }
    var commissioned = Object.keys(arc.bestiary || {}).map(function (k) { return arc.bestiary[k]; }).filter(function (b) { return b.source === 'commissioned' || b.source === 'generated'; });
    if (commissioned.length) {
      h += '<div class="arc-sec"><h3>Commissioned creatures <span style="color:#6b7080">— engine-statted</span></h3><ul class="spine">' + commissioned.map(function (c) {
        return '<li><div class="ms">' + esc(c.name) + ' <span style="color:#6b7080">CR ' + esc(c.challengeRating) + '</span></div><div class="mi">AC ' + esc(c.armorClass) + ' · ' + esc(c.hitPoints.average) + ' HP · ' + esc((c.attacks[0] || {}).name || '') + ' ' + esc((c.attacks[0] || {}).damage || '') + '</div></li>';
      }).join('') + '</ul></div>';
    }
    $('gen-preview').innerHTML = h;
  }
  function generateArc() {
    if (!composerOn) { $('gen-status').textContent = 'arc generation is OFF — set MYTHWEAVER_ARC_COMPOSER=llm and restart'; return; }
    var seed = collectSeed();
    if (!seed.party.length) { $('gen-status').textContent = 'add at least one player to the party first'; return; }
    $('gen-run').disabled = true; $('gen-start').disabled = true;
    $('gen-status').innerHTML = '<span class="spin"></span>composing a fresh arc — real API call…';
    fetch('/dm/lab/generate-arc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(seed) })
      .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
      .then(function (x) {
        if (!x.ok) { $('gen-status').textContent = 'error: ' + (x.body.error || 'failed'); return; }
        lastGeneratedArc = x.body.arc;
        $('ed-arc').value = JSON.stringify(x.body.arc, null, 2); // editable bundle (party levels, monster stats, beats)
        $('gen-badge').style.display = 'flex';
        $('gen-badge').innerHTML = genBadgeHtml(x.body.arc.genMeta, false) + '<span class="det">· ' + fmtCost(x.body.costUsd) + '</span>';
        renderGenPreview(x.body.arc);
        $('gen-start').disabled = false;
        $('gen-status').textContent = 'arc ready — review/edit it on the Arc tab, then Start session (or Reroll)';
      })
      .catch(function (e) { $('gen-status').textContent = 'error: ' + (e.message || e); })
      .finally(function () { $('gen-run').disabled = false; });
  }
  // The arc to start with = the (possibly hand-edited) JSON on the Arc tab, else the last generated one.
  function currentArc() {
    var raw = $('ed-arc') ? $('ed-arc').value.trim() : '';
    if (!raw) return lastGeneratedArc;
    try { return JSON.parse(raw); } catch (e) { return { __parseError: String(e) }; }
  }
  function startGeneratedSession(statusEl) {
    var setStatus = function (t, spin) { var el = statusEl || $('gen-status'); el.innerHTML = spin ? ('<span class="spin"></span>' + t) : ''; if (!spin) el.textContent = t; };
    var arc = currentArc();
    if (!arc) { setStatus('generate an arc first'); return; }
    if (arc.__parseError) { setStatus('arc JSON is invalid — fix it on the Arc tab (' + arc.__parseError + ')'); return; }
    $('gen-start').disabled = true; $('gen-run').disabled = true; $('arc-start').disabled = true;
    setStatus('starting session…', true);
    fetch('/dm/lab/session', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        generatedArc: arc, // party + bestiary + beats ride on the bundle (with any hand-edits)
        temperature: Number($('temp').value), // DM narration temp (Run tab)
        arcTemperature: Number($('gen-temp').value), // Director temp (Generate tab)
        playbook: $('ed-playbook').value,
      }),
    }).then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); }).then(function (x) {
      $('gen-start').disabled = false; $('gen-run').disabled = false; $('arc-start').disabled = false;
      if (!x.ok) { setStatus('error: ' + (x.body.error || 'failed')); return; }
      sessionStarted(x.body);
      showTab('run');
      $('gen-status').textContent = '✓ session started — switched to the Run tab';
      $('status-arc').textContent = '';
      autoOpen(); // DM sets the opening scene on the Run tab
      try { $('msg').focus(); } catch (e) {}
    }).catch(function (e) { $('gen-start').disabled = false; $('gen-run').disabled = false; $('arc-start').disabled = false; setStatus('error: ' + (e.message || e)); });
  }
  var REROLL = ['ember', 'hollow', 'tide', 'lantern', 'thornwood', 'saltmarsh', 'ravenfall', 'gravemoor', 'witchlight', 'ironvale', 'mistral', 'cinder'];
  $('gen-temp').oninput = function () { $('gen-tempVal').textContent = Number($('gen-temp').value).toFixed(2); };
  $('gen-reroll').onclick = function () { $('gen-seedphrase').value = REROLL[Math.floor(Math.random() * REROLL.length)] + '-' + Math.floor(Math.random() * 1000); };
  $('gen-run').onclick = generateArc;
  $('gen-start').onclick = function () { startGeneratedSession(); };
  $('arc-start').onclick = function () { startGeneratedSession($('status-arc')); };
  $('arc-revert').onclick = function () {
    if (!lastGeneratedArc) { $('status-arc').textContent = 'nothing generated yet'; return; }
    $('ed-arc').value = JSON.stringify(lastGeneratedArc, null, 2);
    $('status-arc').textContent = 'reverted to the last generated arc';
  };
  $('party-add').onclick = function () { addPlayer('fighter'); };
  document.querySelectorAll('input[name="mmode"]').forEach(function (r) {
    r.onchange = function () {
      var manual = (document.querySelector('input[name="mmode"]:checked') || {}).value === 'manual';
      $('mon-manual').style.display = manual ? '' : 'none';
      $('mon-auto').style.display = manual ? 'none' : '';
    };
  });
  $('gen-theme').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); generateArc(); } });
  loadLibrary();

  // --- distill: source (transcript|guide) -> block -> diff/apply into the (temp) playbook ---
  var distillMode = 'transcript'; // the mode the CURRENT output belongs to (set on Distill)
  function markersFor(mode) {
    return mode === 'guide'
      ? { b: '<!-- DISTILLED-PRINCIPLES:BEGIN -->', e: '<!-- DISTILLED-PRINCIPLES:END -->' }
      : { b: '<!-- DISTILLED-STYLE:BEGIN -->', e: '<!-- DISTILLED-STYLE:END -->' };
  }
  function spliceInto(pb, block, mode) {
    var m = markersFor(mode);
    var wrapped = m.b + '\\n' + block.trim() + '\\n' + m.e;
    var bi = pb.indexOf(m.b), ei = pb.indexOf(m.e);
    if (bi >= 0 && ei > bi) return pb.slice(0, bi) + wrapped + pb.slice(ei + m.e.length);
    return pb.replace(/\\s*$/, '') + '\\n\\n' + wrapped + '\\n';
  }
  function inCount() { $('distill-incount').textContent = $('distill-in').value.length.toLocaleString() + ' chars'; }
  $('distill-in').oninput = inCount;
  $('distill-upload').onclick = function () { $('distill-files').click(); };
  $('distill-files').onchange = function (e) {
    var files = [].slice.call(e.target.files || []);
    if (!files.length) return;
    Promise.all(files.map(function (f) {
      return new Promise(function (resolve) {
        var r = new FileReader();
        r.onload = function () { resolve('### ' + f.name + '\\n' + (r.result || '')); };
        r.onerror = function () { resolve(''); };
        r.readAsText(f);
      });
    })).then(function (texts) {
      var cur = $('distill-in').value;
      $('distill-in').value = (cur ? cur + '\\n\\n' : '') + texts.filter(Boolean).join('\\n\\n');
      inCount();
      $('distill-status').textContent = 'loaded ' + files.length + ' file(s)';
    });
    e.target.value = '';
  };
  $('distill-run').onclick = function () {
    var input = $('distill-in').value.trim();
    if (!input) { $('distill-status').textContent = 'paste or upload some text first'; return; }
    var mode = $('distill-mode').value;
    var btn = $('distill-run');
    btn.disabled = true;
    $('distill-status').innerHTML = '<span class="spin"></span>distilling — real API calls…';
    fetch('/dm/lab/distill', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ transcript: input, mode: mode }) })
      .then(function (res) { return res.json().then(function (b) { return { ok: res.ok, body: b }; }); })
      .then(function (x) {
        if (!x.ok) { $('distill-status').textContent = 'error: ' + (x.body.error || 'failed'); return; }
        distillMode = x.body.mode || mode;
        $('distill-out').value = x.body.styleBlock || '';
        $('distill-out-name').textContent = distillMode === 'guide' ? 'Distilled principles (editable)' : 'Distilled voice (editable)';
        setDiffView(false);
        $('distill-status').textContent = 'distilled ' + x.body.chunks + ' excerpt(s) of ' + (x.body.inputChars || 0).toLocaleString() + ' chars — review/Diff, then Apply';
      })
      .catch(function (e) { $('distill-status').textContent = 'error: ' + (e.message || e); })
      .finally(function () { btn.disabled = false; });
  };
  $('distill-apply').onclick = function () {
    var block = $('distill-out').value.trim();
    if (!block) { $('distill-status').textContent = 'nothing to apply — Distill first'; return; }
    $('ed-playbook').value = spliceInto($('ed-playbook').value, block, distillMode);
    $('distill-status').textContent = 'applied to playbook (unsaved) — switch to Run to test, or Playbook to review/Save';
    showTab('playbook');
  };

  // Diff preview: current playbook vs the playbook AFTER applying this block (git-style).
  function lineDiff(aText, bText) {
    var a = aText.split('\\n'), b = bText.split('\\n');
    var n = a.length, m = b.length;
    var dp = []; for (var i = 0; i <= n; i++) dp.push(new Int32Array(m + 1));
    for (var i = n - 1; i >= 0; i--) for (var j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : (dp[i + 1][j] >= dp[i][j + 1] ? dp[i + 1][j] : dp[i][j + 1]);
    var out = [], i = 0, j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) { out.push({ t: ' ', v: a[i] }); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ t: '-', v: a[i] }); i++; }
      else { out.push({ t: '+', v: b[j] }); j++; }
    }
    while (i < n) out.push({ t: '-', v: a[i++] });
    while (j < m) out.push({ t: '+', v: b[j++] });
    return out;
  }
  function diffLine(cls, sign, v) { return '<div class="ln ' + cls + '">' + esc(sign + ' ' + v) + '</div>'; }
  function renderDiff(aText, bText) {
    var d = lineDiff(aText, bText);
    if (!d.some(function (it) { return it.t !== ' '; })) return '<div class="none">No changes — this block already matches the playbook.</div>';
    var html = [], ctx = [];
    function flush() {
      if (!ctx.length) return;
      if (ctx.length <= 6) ctx.forEach(function (l) { html.push(diffLine('ctx', ' ', l)); });
      else {
        ctx.slice(0, 2).forEach(function (l) { html.push(diffLine('ctx', ' ', l)); });
        html.push('<div class="ln gap">  … ' + (ctx.length - 4) + ' unchanged lines …</div>');
        ctx.slice(-2).forEach(function (l) { html.push(diffLine('ctx', ' ', l)); });
      }
      ctx = [];
    }
    d.forEach(function (it) { if (it.t === ' ') ctx.push(it.v); else { flush(); html.push(diffLine(it.t === '+' ? 'add' : 'del', it.t, it.v)); } });
    flush();
    return html.join('');
  }
  function setDiffView(on) {
    $('wrap-block').style.display = on ? 'none' : '';
    $('wrap-diff').style.display = on ? '' : 'none';
    $('view-block').classList.toggle('active', !on);
    $('view-diff').classList.toggle('active', on);
    if (on) {
      var block = $('distill-out').value.trim();
      if (!block) { $('wrap-diff').innerHTML = '<div class="none">Distill or paste a block first.</div>'; return; }
      var pb = $('ed-playbook').value;
      $('wrap-diff').innerHTML = renderDiff(pb, spliceInto(pb, block, distillMode));
    }
  }
  $('view-block').onclick = function () { setDiffView(false); };
  $('view-diff').onclick = function () { setDiffView(true); };
  loadFiles();
  setBusy(false); // gates the Run input off until a session is started from Generate
</script>
</body>
</html>`;
}
