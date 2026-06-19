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
  <button class="tab" data-tab="distill">Distill</button>
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
          <input id="speaker" type="text" placeholder="who (optional)" style="width:130px" />
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
    ['run', 'playbook', 'scenario', 'distill'].forEach(function (n) {
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
  function addDm(t) {
    var tools = (t.tools || []).map(function (c) {
      var res = c.result ? '<span class="res">→ ' + esc(c.result) + '</span>' : '';
      return '<div class="tool"><span class="name">' + esc(c.name) + '</span><span class="inp">(' + esc(JSON.stringify(c.input)) + ')</span>' + res + '</div>';
    }).join('');
    var diff = (t.diff && t.diff.length) ? '<div class="diff"><b>state Δ</b> ' + t.diff.map(esc).join('  |  ') + '</div>' : '';
    var details = (tools || diff) ? ('<details><summary>tools + state Δ</summary>' + tools + diff + '</details>') : '';
    var roll = t.rollRequest ? '<div class="roll-pending">⏸ needs a roll: ' + esc(t.rollRequest.expr) + ' — ' + esc(t.rollRequest.reason) + '</div>' : '';
    var narr = t.narration ? '<div class="narr">' + esc(t.narration) + '</div>' : '<div class="narr" style="color:#6b7080;font-style:italic">(no narration — awaiting your roll)</div>';
    var meta = esc(t.model || '?') + ' · ' + t.steps + ' step(s) · ' + fmtTime(t.latencyMs) + ' · ' + fmtCost(t.costUsd);
    var d = document.createElement('div'); d.className = 'bubble dm';
    d.innerHTML = '<div class="who">Dungeon Master</div>' + narr + roll + '<div class="meta">' + meta + '</div>' + details;
    convo().appendChild(d); scrollConvo();
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
      sessionId = x.body.sessionId; pendingRoll = null;
      convo().innerHTML = '';
      addSys('Session started · scene "' + x.body.scene + '" · party: ' + (x.body.party || []).map(function (p) { return p.name; }).join(', '));
      setPending(null); setBusy(false);
      $('status').textContent = 'session live — talk to the DM';
      return true;
    }).catch(function (e) { $('status').textContent = 'error: ' + (e.message || e); return false; });
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
        if (t.kind !== 'message') addPlayer('roll', t.input); // show the actual declared/auto total
        addDm(t);
        setPending(x.body.pendingRoll);
        setBusy(false);
        $('status').textContent = 'turn ' + t.index + ' · total ' + fmtCost(x.body.totalCostUsd) + ' · ' + fmtTime(x.body.totalLatencyMs);
      }).catch(function (e) { addSys('error: ' + (e.message || e)); setBusy(false); $('status').textContent = ''; });
  }

  function sendMsg() {
    if (!sessionId || pendingRoll) return;
    var text = $('msg').value.trim(); if (!text) return;
    var as = $('speaker').value.trim();
    $('msg').value = '';
    addPlayer(as || 'player', text);
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
    var payload = kind === 'playbook'
      ? { playbook: $('ed-playbook').value }
      : { scenario: $('scenario').value.trim() || 'the-sunken-bell', scenarioJson: $('ed-scenario').value };
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
