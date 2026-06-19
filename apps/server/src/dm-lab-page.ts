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
  .prow { display: flex; gap: 6px; align-items: center; margin-bottom: 6px; }
  .prow select { flex: 0 0 116px; }
  .prow input { flex: 1; min-width: 0; }
  .prow .premove { padding: 6px 9px; color: #c08; }
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
</style>
</head>
<body>
<header>
  <h1>MythWeaver — DM Lab</h1>
  <span class="sub">tune the DM live · edit the playbook &amp; scenario, set a temperature, Run the same prompts &amp; compare</span>
</header>
<nav class="tabs">
  <button class="tab active" data-tab="run">Run</button>
  <button class="tab" data-tab="playbook">Playbook</button>
  <button class="tab" data-tab="scenario">Scenario</button>
  <button class="tab" data-tab="director">Director</button>
  <button class="tab" data-tab="generate">Generate</button>
  <button class="tab" data-tab="distill">Distill</button>
  <button class="tab" data-tab="arc">Arc</button>
  <span class="gstatus" id="gstatus"></span>
</nav>
<main>
  <section class="view run active" id="view-run">
    <div class="panel left">
      <label for="scenario">Scenario</label>
      <input id="scenario" type="text" value="the-sunken-bell" />
      <label for="startScene">Start scene <span style="color:#6b7080">— drop the party here (pick the fight to test combat)</span></label>
      <select id="startScene" class="seg" style="width:100%"></select>
      <label for="temp">Temperature <span style="color:#6b7080">— 0 = deterministic, 1 = creative</span></label>
      <div class="temp">
        <input id="temp" type="range" min="0" max="1" step="0.05" value="1" />
        <span class="val" id="tempVal">1.00</span>
      </div>
      <div class="row" style="margin-top:12px;">
        <button id="newSession">New session</button>
      </div>
      <div class="hint">A session captures the current Playbook + Scenario tabs + temperature. Edit them, then start a new session to apply.</div>
      <label>Quick-start a situation</label>
      <div class="row" id="presets"></div>
      <div class="hint" id="status">Start a session, then play turn by turn.</div>
    </div>
    <div class="right-wrap">
      <div class="convo" id="convo"><div class="empty-state">Start a session, then play turn by turn — the DM keeps the growing context.</div></div>
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

  <section class="view editor" id="view-playbook">
    <div class="ed-toolbar">
      <span class="name">prompts/dm-playbook.md</span>
      <button class="ghost" data-reload="playbook">Reload from disk</button>
      <button data-save="playbook">Save</button>
      <span class="status" id="status-playbook"></span>
    </div>
    <div class="ed-wrap"><textarea id="ed-playbook" spellcheck="false" placeholder="loading…"></textarea></div>
  </section>

  <section class="view editor" id="view-scenario">
    <div class="ed-toolbar">
      <span class="name" id="scenario-name">content/scenarios/&hellip;/scenario.json</span>
      <button class="ghost" data-reload="scenario">Reload from disk</button>
      <button data-save="scenario">Save</button>
      <span class="status" id="status-scenario"></span>
    </div>
    <div class="ed-wrap"><textarea id="ed-scenario" spellcheck="false" placeholder="loading…"></textarea></div>
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

  <section class="view generate" id="view-generate">
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

  <section class="view editor" id="view-arc">
    <div class="ed-toolbar">
      <span class="name">Campaign arc — the Game Director's plan</span>
      <button class="ghost" id="arc-refresh">Refresh</button>
      <span class="status" id="arc-status"></span>
    </div>
    <div class="arc-body" id="arc-body"><div class="empty-state">Start a session — the Director architects the campaign arc (premise → ending → spine) up front, then adapts it as you play.</div></div>
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
    ['run', 'playbook', 'scenario', 'director', 'generate', 'distill', 'arc'].forEach(function (n) {
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

  function renderArc() {
    var el = $('arc-body');
    var a = latestArc;
    if (!a || (!a.blueprint && (!a.beats || !a.beats.length))) { el.innerHTML = '<div class="empty-state">No arc yet — start a session and the Director will architect it.</div>'; return; }
    var bp = a.blueprint;
    var h = '';
    if (a.genMeta) h += '<div class="gen-badge" style="padding:0 0 14px;border:0;">' + genBadgeHtml(a.genMeta, a.stale) + '</div>';
    if (bp) {
      h += '<div class="arc-sec"><h3>Premise</h3><div class="kv">' + esc(bp.premise || '—') + '</div></div>';
      h += '<div class="arc-sec"><h3>Central problem</h3><div class="kv arc-problem">' + esc(bp.centralProblem || '—') + '</div></div>';
      h += '<div class="arc-sec"><h3>Intended ending — north star</h3><div class="arc-ending">' + esc(bp.intendedEnding || '—') + '</div></div>';
      h += '<div class="arc-sec"><h3>Opening</h3><div class="kv">' + esc(bp.opening || '—') + '</div></div>';
      if (bp.spine && bp.spine.length) {
        h += '<div class="arc-sec"><h3>Spine — route to the ending</h3><ul class="spine">' + bp.spine.map(function (s) {
          var done = s.sceneId && a.beats.some(function (b) { return b.id === s.sceneId && b.done; });
          var cur = s.sceneId && s.sceneId === a.currentScene;
          return '<li class="' + (done ? 'done' : cur ? 'current' : '') + '"><div class="ms">' + esc(s.milestone || s.sceneId || '') + (s.sceneId ? ' <span style="color:#6b7080">[' + esc(s.sceneId) + ']</span>' : '') + (cur ? ' <span style="color:#6ab0ff">● here</span>' : done ? ' <span style="color:#8fd6a2">✓</span>' : '') + '</div><div class="mi">' + esc(s.intent || '') + '</div></li>';
        }).join('') + '</ul></div>';
      }
    }
    if (a.beats && a.beats.length) {
      h += '<div class="arc-sec"><h3>Beats</h3><div class="beatmap">' + a.beats.map(function (b) {
        var cls = b.current ? 'current' : b.done ? 'done' : b.reachable ? 'reach' : '';
        var tag = b.current ? '● here' : b.done ? '✓ done' : b.reachable ? '→ reachable' : '';
        return '<span class="beat ' + cls + '">' + esc(b.title) + (tag ? ' <span style="color:#6b7080">' + tag + '</span>' : '') + '</span>';
      }).join('') + '</div></div>';
    }
    if (a.brief) {
      var br = a.brief;
      h += '<div class="arc-sec"><h3>Current steering brief</h3>';
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
    el.innerHTML = h;
  }
  function setPending(rr) {
    pendingRoll = rr || null;
    $('rollbar').style.display = pendingRoll ? 'flex' : 'none';
    $('msgbar').style.display = pendingRoll ? 'none' : 'flex';
    if (pendingRoll) { $('rollask').textContent = '🎲 ' + pendingRoll.expr + ' — ' + pendingRoll.reason; $('rollval').value = ''; $('rollval').focus(); }
    else if (sessionId) { $('msg').focus(); }
  }
  function setBusy(b) { $('send').disabled = b || !sessionId; $('declare').disabled = b; $('autoroll').disabled = b; }

  function newSession() {
    $('status').innerHTML = '<span class="spin"></span>starting session…';
    return fetch('/dm/lab/session', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        scenario: $('scenario').value.trim() || 'the-sunken-bell',
        startScene: $('startScene').value,
        temperature: Number($('temp').value),
        playbook: $('ed-playbook').value,
        scenarioJson: $('ed-scenario').value,
      }),
    }).then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); }).then(function (x) {
      if (!x.ok) { $('status').textContent = 'error: ' + (x.body.error || 'failed'); return false; }
      sessionStarted(x.body);
      $('status').textContent = 'session live — talk to the DM (the Arc tab shows the plan)';
      return true;
    }).catch(function (e) { $('status').textContent = 'error: ' + (e.message || e); return false; });
  }

  // Shared success handler for both authored and generated session starts.
  function sessionStarted(b) {
    sessionId = b.sessionId; pendingRoll = null;
    convo().innerHTML = '';
    addSys('Session started · scene "' + b.scene + '" · party: ' + (b.party || []).map(function (p) { return p.name; }).join(', '));
    var sp = $('speaker'); sp.innerHTML = '';
    var grp = document.createElement('option'); grp.value = 'The party'; grp.textContent = 'The party'; sp.appendChild(grp);
    (b.party || []).forEach(function (p) { var o = document.createElement('option'); o.value = p.name; o.textContent = p.name; sp.appendChild(o); });
    latestArc = b.arc || null; renderArc();
    setPending(null); setBusy(false);
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
        if (x.body.arc) { latestArc = x.body.arc; renderArc(); } // Director may have re-planned this turn
        if (t.kind !== 'message') addPlayer('roll', t.input); // show the actual declared/auto total
        addDm(t, latestArc && latestArc.brief);
        setPending(x.body.pendingRoll);
        setBusy(false);
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

  // Quick-start: new session, then auto-play a preset transcript to seed context, then continue manually.
  function playPreset(turns) {
    newSession().then(function (ok) {
      if (!ok) return;
      var i = 0;
      function next() {
        if (i >= turns.length) { $('status').textContent = 'preset seeded — continue the conversation'; return; }
        var e = turns[i++];
        if ('roll' in e) { if (pendingRoll) { submitTurn({ roll: e.roll }).then(next); } else { next(); } return; }
        addPlayer(e.as || 'player', e.say);
        var payload = { say: e.say }; if (e.as) payload.as = e.as;
        submitTurn(payload).then(function resolveRolls() {
          if (!pendingRoll) { next(); return; }
          var nxt = turns[i];
          if (nxt && ('roll' in nxt)) { i++; submitTurn({ roll: nxt.roll }).then(resolveRolls); }
          else { submitTurn({ auto: true }).then(resolveRolls); }
        });
      }
      next();
    });
  }

  // --- load / save editable files ---
  function loadFiles() {
    var slug = $('scenario').value.trim() || 'the-sunken-bell';
    gstatus('loading files…');
    fetch('/dm/lab/files?scenario=' + encodeURIComponent(slug)).then(function (r) { return r.json(); }).then(function (b) {
      if (b.error) { gstatus('load error: ' + b.error); return; }
      $('ed-playbook').value = b.playbook || '';
      $('ed-scenario').value = b.scenarioJson || '';
      $('ed-director-architect').value = b.directorArchitect || '';
      $('ed-director-planner').value = b.directorPlanner || '';
      $('ed-director-composer').value = b.directorComposer || '';
      composerOn = b.composerOn !== false;
      if (!composerOn) $('gen-status').textContent = 'arc generation is OFF — set MYTHWEAVER_ARC_COMPOSER=llm and restart the server';
      $('scenario-name').textContent = 'content/scenarios/' + (b.scenario || slug) + '/scenario.json';
      var sel = $('startScene');
      sel.innerHTML = '';
      (b.scenes || []).forEach(function (s, i) {
        var o = document.createElement('option');
        o.value = s.id;
        o.textContent = s.title + (i === 0 ? ' (start)' : '');
        sel.appendChild(o);
      });
      gstatus('files loaded');
      setTimeout(function () { gstatus(''); }, 1500);
    }).catch(function (e) { gstatus('load error: ' + (e.message || e)); });
  }
  function save(kind) {
    var st = $('status-' + kind);
    var payload;
    if (kind === 'playbook') payload = { playbook: $('ed-playbook').value };
    else if (kind === 'scenario') payload = { scenario: $('scenario').value.trim() || 'the-sunken-bell', scenarioJson: $('ed-scenario').value };
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

  // --- presets + session controls + temp ---
  Object.keys(TRANSCRIPTS).forEach(function (name) {
    var b = document.createElement('button');
    b.className = 'ghost';
    b.textContent = name;
    b.title = 'start a new session and auto-play the "' + name + '" transcript, then continue manually';
    b.onclick = function () { playPreset(TRANSCRIPTS[name]); };
    $('presets').appendChild(b);
  });
  $('temp').oninput = function () { $('tempVal').textContent = Number($('temp').value).toFixed(2); };
  $('newSession').onclick = newSession;
  $('send').onclick = sendMsg;
  $('msg').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); sendMsg(); } });
  $('declare').onclick = declareRoll;
  $('autoroll').onclick = autoRoll;
  $('rollval').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); declareRoll(); } });
  $('arc-refresh').onclick = renderArc;

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
    row.innerHTML = '<select class="seg prole">' + roleOptions(role) + '</select>' +
      '<input class="pname" type="text" placeholder="name (optional)" value="' + esc(name || '') + '" />' +
      '<button class="ghost premove" title="remove">×</button>';
    row.querySelector('.premove').onclick = function () { row.remove(); };
    $('party-list').appendChild(row);
  }
  function collectParty() {
    return [].slice.call(document.querySelectorAll('#party-list .prow')).map(function (row) {
      var role = row.querySelector('.prole').value;
      var name = row.querySelector('.pname').value.trim();
      return name ? { role: role, name: name } : { role: role };
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
        $('gen-badge').style.display = 'flex';
        $('gen-badge').innerHTML = genBadgeHtml(x.body.arc.genMeta, false) + '<span class="det">· ' + fmtCost(x.body.costUsd) + '</span>';
        renderGenPreview(x.body.arc);
        $('gen-start').disabled = false;
        $('gen-status').textContent = 'arc ready — review it, then Start session (or Reroll for a different one)';
      })
      .catch(function (e) { $('gen-status').textContent = 'error: ' + (e.message || e); })
      .finally(function () { $('gen-run').disabled = false; });
  }
  function startGeneratedSession() {
    if (!lastGeneratedArc) { $('gen-status').textContent = 'generate an arc first'; return; }
    $('gen-status').innerHTML = '<span class="spin"></span>starting generated session…';
    fetch('/dm/lab/session', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        generatedArc: lastGeneratedArc,
        party: collectParty(), // resolved to character sheets server-side
        temperature: Number($('temp').value), // DM narration temp (Run tab)
        arcTemperature: Number($('gen-temp').value), // Director temp (this tab)
        playbook: $('ed-playbook').value,
      }),
    }).then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); }).then(function (x) {
      if (!x.ok) { $('gen-status').textContent = 'error: ' + (x.body.error || 'failed'); return; }
      sessionStarted(x.body);
      showTab('run');
      $('status').textContent = 'generated session live — talk to the DM (Arc tab shows the generated plan)';
    }).catch(function (e) { $('gen-status').textContent = 'error: ' + (e.message || e); });
  }
  var REROLL = ['ember', 'hollow', 'tide', 'lantern', 'thornwood', 'saltmarsh', 'ravenfall', 'gravemoor', 'witchlight', 'ironvale', 'mistral', 'cinder'];
  $('gen-temp').oninput = function () { $('gen-tempVal').textContent = Number($('gen-temp').value).toFixed(2); };
  $('gen-reroll').onclick = function () { $('gen-seedphrase').value = REROLL[Math.floor(Math.random() * REROLL.length)] + '-' + Math.floor(Math.random() * 1000); };
  $('gen-run').onclick = generateArc;
  $('gen-start').onclick = startGeneratedSession;
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
</script>
</body>
</html>`;
}
