import { randomBytes } from "node:crypto";

/** All device-controlled content is assigned with textContent, never interpolated into HTML. */
export function databaseHtml(): string {
  const nonce = randomBytes(18).toString("base64");
  return String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'">
<title>Android database explorer</title>
<style nonce="${nonce}">
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { margin: 0; color: var(--vscode-foreground, #ddd); background: var(--vscode-editor-background, #202124); font: 13px/1.5 var(--vscode-font-family, system-ui, sans-serif); }
header { padding: 16px 20px; border-bottom: 1px solid var(--vscode-panel-border, #555); }
h1 { font-size: 16px; margin: 0 0 4px; } h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; margin: 0 0 8px; }
#identity, .hint { color: var(--vscode-descriptionForeground, #aaa); overflow-wrap: anywhere; }
.badge { font-size: 10px; font-weight: normal; text-transform: uppercase; padding: 2px 6px; border: 1px solid var(--vscode-panel-border, #555); border-radius: 4px; vertical-align: middle; margin-left: 8px; }
.toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding: 12px 20px; border-bottom: 1px solid var(--vscode-panel-border, #555); }
button, select, textarea { font: inherit; color: inherit; }
button, select { min-height: 30px; border: 1px solid var(--vscode-input-border, #666); border-radius: 3px; padding: 4px 10px; background: var(--vscode-button-secondaryBackground, #383838); }
button { cursor: pointer; } button:hover:enabled { background: var(--vscode-button-secondaryHoverBackground, #484848); }
button.primary { background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #fff); border-color: transparent; }
button:disabled, select:disabled { opacity: .5; cursor: default; }
button:focus-visible, select:focus-visible, textarea:focus-visible { outline: 2px solid var(--vscode-focusBorder, #3794ff); outline-offset: 2px; }
select { background: var(--vscode-dropdown-background, #303030); max-width: 340px; }
#database { flex: 1; min-width: 140px; }
main { display: grid; grid-template-columns: minmax(180px, 240px) minmax(0, 1fr); min-height: calc(100vh - 160px); }
aside { padding: 16px; border-right: 1px solid var(--vscode-panel-border, #555); overflow: auto; }
#objects { display: flex; flex-direction: column; gap: 4px; }
#objects button { text-align: left; background: transparent; border-color: transparent; overflow-wrap: anywhere; }
#objects button[aria-pressed="true"] { background: var(--vscode-list-activeSelectionBackground, #094771); color: var(--vscode-list-activeSelectionForeground, #fff); }
.object-type { font-size: 11px; color: var(--vscode-descriptionForeground, #aaa); margin-right: 8px; }
.content { min-width: 0; padding: 16px 20px; }
textarea { display: block; width: 100%; min-height: 110px; resize: vertical; padding: 10px; border: 1px solid var(--vscode-input-border, #666); border-radius: 3px; background: var(--vscode-input-background, #292929); font-family: var(--vscode-editor-font-family, monospace); }
.actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin: 10px 0; }
.hint { font-size: 12px; margin: 8px 0; }
#status { min-height: 26px; padding: 6px 0; overflow-wrap: anywhere; white-space: pre-wrap; }
#status.error { color: var(--vscode-errorForeground, #f48771); }
.grid { overflow: auto; max-height: 55vh; border: 1px solid var(--vscode-panel-border, #555); }
.grid:empty { border: 0; }
table { border-collapse: separate; border-spacing: 0; width: 100%; text-align: left; font: 12px/1.5 var(--vscode-editor-font-family, monospace); }
th, td { padding: 7px 10px; border-bottom: 1px solid var(--vscode-panel-border, #444); border-right: 1px solid var(--vscode-panel-border, #444); white-space: pre-wrap; overflow-wrap: anywhere; min-width: 70px; max-width: 400px; }
th { position: sticky; top: 0; background: var(--vscode-sideBar-background, #292929); }
td.null, td.blob { color: var(--vscode-descriptionForeground, #aaa); }
#pager { display: flex; gap: 8px; align-items: center; margin: 10px 0; }
#rows { flex: 1; }
details { margin: 12px 0; } summary { cursor: pointer; }
#ddl { white-space: pre-wrap; overflow-wrap: anywhere; padding: 10px; background: var(--vscode-textCodeBlock-background, #292929); }
[hidden] { display: none !important; }
@media (max-width: 620px) { main { grid-template-columns: 1fr; } aside { border-right: 0; border-bottom: 1px solid var(--vscode-panel-border, #555); max-height: 200px; } }
</style></head><body>
<header><h1>Database explorer <span class="badge">Experimental</span></h1><div id="identity">Connecting to the application…</div></header>
<div class="toolbar"><label for="database">Database</label><select id="database" disabled><option>No database selected</option></select><button id="refresh">Refresh</button><label for="auto">Auto-refresh</label><select id="auto"><option value="0">Off</option><option value="2000">2 seconds</option><option value="5000">5 seconds</option></select><button id="cancel" hidden>Cancel request</button></div>
<main><aside><h2>Schema</h2><div id="objects"></div><p id="empty" class="hint">Loading databases…</p></aside>
<section class="content" aria-label="SQL and results">
<label for="sql"><h2>SQL statement</h2></label><textarea id="sql" spellcheck="false" aria-label="SQL statement" placeholder="Select a table or enter a SELECT query"></textarea>
<div class="actions"><button id="query" class="primary" disabled>Run read-only query</button><button id="execute" disabled>Execute write…</button><span class="hint">Ctrl/⌘ Enter to query</span></div>
<p class="hint">Live SQLite access, including committed WAL data. Writes require confirmation and do not notify Room observers. No in-memory or encrypted databases.</p>
<details id="schema" hidden><summary>Schema definition</summary><pre id="ddl"></pre></details>
<div id="status" role="status" aria-live="polite"></div><div id="result" class="grid" tabindex="0" aria-label="Query results"></div>
<div id="pager" hidden><button id="previous">Previous</button><span id="rows" class="hint"></span><button id="next">Next</button></div>
<p class="hint">100 rows per page. Each page is a new read, not a retained snapshot; use ORDER BY for predictable paging. BLOBs display as Base64; 64-bit integers retain their exact values.</p>
</section></main>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const $ = id => document.getElementById(id);
let busy = false, database, objects = [], selected, result, timer;
const saved = vscode.getState();
$('sql').value = saved && typeof saved.sql === 'string' ? saved.sql : '';
const send = (type, data = {}) => vscode.postMessage({ type, ...data });
const status = (message, error = false) => { $('status').textContent = message; $('status').classList.toggle('error', error); };
function controls() {
  $('database').disabled = busy || !$('database').options.length || !database;
  $('refresh').disabled = busy;
  $('query').disabled = $('execute').disabled = busy || !database;
  $('sql').readOnly = busy;
  $('cancel').hidden = !busy;
  for (const button of $('objects').querySelectorAll('button')) button.disabled = busy;
  $('previous').disabled = busy || !result || result.offset === 0;
  $('next').disabled = busy || !result || !result.hasMore;
}
function clearRows() { result = undefined; $('result').replaceChildren(); $('pager').hidden = true; }
function renderObjects() {
  $('objects').replaceChildren();
  $('empty').hidden = objects.length > 0;
  $('empty').textContent = !database ? 'No SQLite databases found. Launch the app and open a screen that uses Room, then refresh.' : 'This database has no schema objects.';
  for (const item of objects) {
    const button = document.createElement('button');
    const kind = document.createElement('span'); kind.className = 'object-type'; kind.textContent = item.type;
    button.append(kind, document.createTextNode(item.name)); button.setAttribute('aria-pressed', String(item.name === selected?.name && item.type === selected?.type));
    button.onclick = () => {
      selected = item; renderObjects();
      if (item.type === 'table' || item.type === 'view') send('browse', { name: item.name });
    };
    $('objects').append(button);
  }
  const item = objects.find(item => item.name === selected?.name && item.type === selected?.type);
  $('schema').hidden = !item; $('ddl').textContent = item ? (item.sql || 'No SQL definition (SQLite internal object).') : '';
  controls();
}
function renderResult(data) {
  result = data;
  if (data.updateEditor) { $('sql').value = data.sql; vscode.setState({ sql: data.sql }); }
  const table = document.createElement('table'), head = document.createElement('thead'), heading = document.createElement('tr'), body = document.createElement('tbody');
  for (const name of data.columns) { const cell = document.createElement('th'); cell.scope = 'col'; cell.textContent = name; heading.append(cell); }
  head.append(heading); table.append(head, body);
  for (const row of data.rows) {
    const tr = document.createElement('tr');
    for (const value of row) {
      const cell = document.createElement('td');
      if (value === null) { cell.textContent = 'NULL'; cell.className = 'null'; }
      else if (typeof value === 'object' && value.type === 'blob') { cell.textContent = 'BLOB · ' + value.base64; cell.className = 'blob'; }
      else cell.textContent = typeof value === 'object' ? value.value : String(value);
      tr.append(cell);
    }
    body.append(tr);
  }
  $('result').replaceChildren(table); $('pager').hidden = false;
  $('rows').textContent = data.rows.length ? 'Rows ' + (data.offset + 1) + '–' + (data.offset + data.rows.length) + (data.hasMore ? ' · more available' : '') : 'No rows';
  status('Read at ' + data.at + ' · ' + data.rows.length + ' rows returned');
  controls();
}
$('database').onchange = () => send('database', { database: $('database').value });
$('refresh').onclick = () => send('refresh');
$('cancel').onclick = () => send('cancel');
$('query').onclick = () => send('query', { sql: $('sql').value });
$('execute').onclick = () => { $('auto').value = '0'; clearInterval(timer); send('execute', { sql: $('sql').value }); };
$('previous').onclick = () => send('page', { direction: -1 });
$('next').onclick = () => send('page', { direction: 1 });
$('sql').oninput = () => vscode.setState({ sql: $('sql').value });
$('sql').onkeydown = event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !busy && database) { event.preventDefault(); send('query', { sql: $('sql').value }); } };
$('auto').onchange = () => { clearInterval(timer); const delay = Number($('auto').value); if (delay) timer = setInterval(() => { if (!busy && !document.hidden) send('refresh', { automatic: true }); }, delay); };
window.addEventListener('message', event => {
  const data = event.data;
  switch (data.type) {
    case 'identity': $('identity').textContent = data.packageName + ' · ' + data.device + ' · current Android user'; break;
    case 'busy': busy = data.busy; if (busy) status('Working…'); controls(); break;
    case 'catalog': {
      if (database !== data.database) { clearRows(); selected = undefined; }
      database = data.database; objects = data.objects;
      $('database').replaceChildren();
      for (const name of data.databases) { const option = document.createElement('option'); option.value = option.textContent = name; $('database').append(option); }
      if (database) $('database').value = database;
      renderObjects();
      if (!result) status(database ? 'Select a table to browse, or enter a SQL query.' : 'No databases found. Launch the app, then refresh.');
      break;
    }
    case 'result': renderResult(data); break;
    case 'written': clearRows(); status('Write committed · ' + data.changes + ' rows changed. Re-run a query to inspect the result. Room observers were not notified.'); break;
    case 'notice': status(data.message); break;
    case 'error': clearRows(); $('auto').value = '0'; clearInterval(timer); status(data.message, true); break;
  }
});
send('ready');
</script></body></html>`;
}
