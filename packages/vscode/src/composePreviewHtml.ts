import { randomBytes } from "node:crypto";
import { PREVIEW_KEY_NAMES } from "./composeBackend.js";

/** Self-contained webview: preview pixels and tooling coordinates share one canvas. */
export function previewHtml(): string {
  const nonce = randomBytes(18).toString("base64");
  return String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'">
<title>Compose previews</title>
<style nonce="${nonce}">
:root { color-scheme: light dark; --surface: var(--vscode-editor-background, #202124); --raised: var(--vscode-sideBar-background, #252629); --text: var(--vscode-foreground, #ddd); --muted: var(--vscode-descriptionForeground, #999); --border: var(--vscode-panel-border, #555); --focus: var(--vscode-focusBorder, #3794ff); --accent: var(--vscode-textLink-foreground, #75beff); --error: var(--vscode-errorForeground, #f48771); }
* { box-sizing: border-box; }
body { margin: 0; color: var(--text); background: var(--surface); font: 13px/1.5 var(--vscode-font-family, system-ui, sans-serif); }
button, select { font: inherit; }
button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 30px; padding: 4px 9px; color: var(--text); background: transparent; border: 1px solid transparent; border-radius: 5px; cursor: pointer; white-space: nowrap; }
button:hover:not(:disabled) { background: var(--vscode-toolbar-hoverBackground, #80808026); }
button[aria-pressed="true"] { color: var(--vscode-inputOption-activeForeground, var(--text)); background: var(--vscode-inputOption-activeBackground, #3794ff26); border-color: var(--vscode-inputOption-activeBorder, var(--focus)); }
button:disabled { cursor: default; opacity: .5; }
button:focus-visible, select:focus-visible, .canvas:focus-visible, a:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
button svg, .brand svg { width: 16px; height: 16px; flex: 0 0 16px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
[hidden] { display: none !important; }
.toolbar { position: sticky; top: 0; z-index: 5; background: var(--surface); border-bottom: 1px solid var(--border); }
.toolbar-main { display: flex; align-items: center; justify-content: space-between; gap: 10px; min-height: 54px; padding: 10px 18px 8px; flex-wrap: wrap; }
.brand { display: flex; align-items: center; gap: 9px; min-width: 0; }
.brand svg { color: var(--accent); }
h1 { font-size: 13px; font-weight: 650; margin: 0; letter-spacing: .01em; }
.count { font-size: 11px; color: var(--muted); border: 1px solid var(--border); border-radius: 10px; padding: 0 6px; }
.actions { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
.separator { height: 18px; width: 1px; background: var(--border); margin: 0 3px; }
.status-row { display: flex; align-items: center; gap: 8px; height: 37px; min-width: 0; padding: 0 18px 7px; color: var(--muted); font-size: 12px; }
.status-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--muted); flex: 0 0 6px; }
.status-row[data-state="working"] .status-dot { background: var(--vscode-progressBar-background, var(--accent)); }
.status-row[data-state="ready"] .status-dot { background: var(--vscode-testing-iconPassed, #73c991); }
.status-row[data-state="error"] .status-dot { background: var(--error); }
#status-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
#diagnostics-toggle, #log-toggle, #status-action { font-size: 11px; min-height: 24px; padding: 1px 6px; }
#status-action { color: var(--accent); border-color: var(--border); }
#status-elapsed { font-variant-numeric: tabular-nums; white-space: nowrap; }
#retained { font-size: 10px; text-transform: uppercase; letter-spacing: .04em; border: 1px solid var(--border); border-radius: 3px; padding: 0 5px; white-space: nowrap; }
#gallery { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 320px), 1fr)); align-items: start; gap: 18px; padding: 20px 18px 32px; }
.preview-card { min-width: 0; overflow: hidden; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); }
.card-header { display: flex; align-items: center; gap: 8px; padding: 12px 14px; min-height: 65px; border-bottom: 1px solid var(--border); }
.card-heading { flex: 1; min-width: 0; }
.card-title { font-size: 13px; font-weight: 600; margin: 0; overflow-wrap: anywhere; }
.card-detail { font-size: 11px; color: var(--muted); margin: 2px 0 0; overflow-wrap: anywhere; }
.card-error { color: var(--error); font-size: 11px; border-color: var(--border); }
.viewport { overflow: auto; padding: 16px; text-align: center; background: var(--raised); scrollbar-gutter: stable; }
.canvas { display: inline-block; position: relative; text-align: left; vertical-align: top; line-height: 0; }
.fit .canvas { max-width: 100%; }
.preview-image { display: block; width: auto; height: auto; max-width: none; }
.fit .preview-image { max-width: 100%; max-height: 68vh; object-fit: contain; }
.inspect .canvas { cursor: crosshair; }
.layout-overlay { position: absolute; inset: 0; width: 100%; height: 100%; overflow: hidden; pointer-events: none; }
.layout-outline { fill: none; stroke: var(--accent); stroke-opacity: .42; stroke-width: 1; vector-effect: non-scaling-stroke; }
.layout-outline.selected { stroke: var(--focus); stroke-opacity: 1; stroke-width: 2; fill: var(--focus); fill-opacity: .09; }
.layout-outline.hovered { stroke: var(--focus); stroke-opacity: 1; stroke-width: 2; fill: var(--focus); fill-opacity: .13; }
body:not(.inspect) .layout-overlay { display: none; }
.unavailable { min-height: 180px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 5px; padding: 24px; color: var(--muted); line-height: 1.5; }
.unavailable strong { font-size: 12px; color: var(--text); font-weight: 500; }
.inspector { padding: 9px 12px; min-height: 103px; border-top: 1px solid var(--border); }
.component-row { display: flex; align-items: center; gap: 6px; min-height: 28px; }
.component-name { font-size: 12px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 1; }
.open-source { color: var(--accent); padding: 2px 5px; font-size: 11px; min-height: 26px; }
.source-context { font-size: 11px; color: var(--muted); white-space: nowrap; text-overflow: ellipsis; overflow: hidden; min-height: 17px; }
.inspector-controls { display: flex; align-items: center; gap: 4px; min-height: 28px; margin-top: 3px; }
.component-picker { min-width: 0; flex: 1; width: 0; height: 25px; border: 1px solid var(--vscode-dropdown-border, var(--border)); border-radius: 3px; color: var(--vscode-dropdown-foreground, var(--text)); background: var(--vscode-dropdown-background, var(--surface)); font-size: 11px; padding: 0 5px; }
.parent-node { min-height: 25px; padding: 1px 5px; font-size: 11px; }
.inspection-hint { margin: 0; color: var(--muted); font-size: 11px; line-height: 1.6; }
.card-size { font-size: 11px; color: var(--muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
.inspect-hint { margin: 14px 18px -6px; color: var(--muted); font-size: 12px; }
.inspect-hint strong { color: var(--text); font-weight: 600; }
#empty { max-width: 400px; margin: 15vh auto 0; padding: 0 24px; text-align: center; color: var(--muted); }
.empty-icon { display: inline-flex; padding: 14px; border: 1px solid var(--border); border-radius: 12px; margin-bottom: 12px; color: var(--accent); }
.empty-icon svg { width: 26px; height: 26px; fill: none; stroke: currentColor; stroke-width: 1.25; }
#empty-title { color: var(--text); font-size: 15px; font-weight: 600; margin: 0 0 8px; }
#empty-description { margin: 0; font-size: 12px; }
#diagnostics, #build-log { position: fixed; z-index: 10; bottom: 12px; left: 12px; right: 12px; max-height: min(55vh, 460px); display: flex; flex-direction: column; background: var(--surface); border: 1px solid var(--border); border-radius: 7px; box-shadow: 0 4px 18px var(--vscode-widget-shadow, #0005); }
.diagnostics-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; border-bottom: 1px solid var(--border); padding: 6px 12px; }
.panel-actions { display: flex; align-items: center; gap: 4px; }
#diagnostics-title, #build-log-title { margin: 0; font-size: 12px; }
#diagnostics-body { margin: 0; padding: 12px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font: 11px/1.6 var(--vscode-editor-font-family, monospace); user-select: text; color: var(--error); }
#diagnostics-body a { color: var(--accent); }
#build-log-body { min-height: 120px; padding: 8px 12px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font: 11px/1.5 var(--vscode-editor-font-family, monospace); user-select: text; }
.log-error { color: var(--error); }
.log-warning { color: var(--vscode-editorWarning-foreground, #cca700); }
.log-command { color: var(--muted); }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
.vscode-high-contrast .preview-card, .vscode-high-contrast-light .preview-card, .vscode-high-contrast button, .vscode-high-contrast-light button { border-color: var(--vscode-contrastBorder, var(--border)); }
.vscode-high-contrast .layout-outline, .vscode-high-contrast-light .layout-outline { stroke-opacity: 1; stroke-width: 2; }
@media (max-width: 420px) { .toolbar-main { padding: 9px 10px 5px; gap: 6px; } .actions { gap: 3px; } .actions button { padding: 4px 6px; font-size: 11px; } .status-row { padding-left: 10px; padding-right: 10px; } #gallery { padding: 12px 10px 24px; gap: 12px; } .viewport { padding: 10px; } #retained { display: none; } .inspect-hint { margin: 10px 10px -2px; } }
@media (forced-colors: active) { .layout-outline { stroke: Highlight; stroke-opacity: 1; } .layout-outline.selected, .layout-outline.hovered { stroke: Highlight; fill: Highlight; } button { border-color: ButtonText; } }
</style>
</head>
<body>
<header class="toolbar">
  <div class="toolbar-main">
    <div class="brand"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5"/></svg><h1>Compose previews</h1><span id="count" class="count" aria-label="Preview count">0</span></div>
    <div class="actions" role="group" aria-label="Preview controls">
      <button id="refresh" type="button" title="Rebuild previews"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1"/></svg><span>Rebuild</span></button>
      <span class="separator" aria-hidden="true"></span>
      <button id="fit" type="button" aria-pressed="true" title="Fit previews to their cards; toggle for actual pixel size"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3H3v6m12-6h6v6M3 15v6h6m12-6v6h-6M8 8h8v8H8z"/></svg><span id="fit-label">Fit</span></button>
      <button id="inspect" type="button" aria-pressed="false" title="Show layout outlines and inspect components"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3h18v18H3zM3 9h18M9 9v12"/></svg><span>Inspect</span></button>
    </div>
  </div>
  <div id="status" class="status-row" data-state="working"><span class="status-dot" aria-hidden="true"></span><span id="status-text" role="status" aria-live="polite">Starting preview…</span><span id="status-elapsed" title="Time since this build started" hidden></span><span id="retained" hidden>Last good preview</span><button id="status-action" type="button" hidden></button><button id="log-toggle" type="button" aria-controls="build-log" aria-expanded="false" title="Follow the output of the preview build" hidden>Build log</button><button id="diagnostics-toggle" type="button" aria-controls="diagnostics" aria-expanded="false" hidden>Details</button></div>
</header>
<main aria-label="Compose preview gallery">
  <div id="empty"><div class="empty-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 9v12"/></svg></div><h2 id="empty-title">Preparing your previews</h2><p id="empty-description">Rendered composables will appear here. You can keep editing while they build.</p></div>
  <p id="inspect-hint" class="inspect-hint" hidden>Turn on <strong>Inspect</strong> to explore measured layout bounds. Source navigation is available when the renderer supplies source locations.</p>
  <div id="gallery" aria-busy="true"></div>
</main>
<p id="keyboard-help" class="sr-only">Use arrow keys to select components, Home or End for the first or last component, Alt plus Up for the enclosing component, and Enter to open source. Click to select, or double-click to open source.</p>
<p id="input-help" class="sr-only">Click or Tab to a live preview to send keyboard input to that card. Tab then moves between its Compose controls. Press F6 or Shift+F6 to leave using VS Code's next or previous part focus commands, or click outside the preview. Escape remains available to Compose. IME composition and clipboard paste are not supported.</p>
<div id="announcement" class="sr-only" role="status" aria-live="polite"></div>
<section id="diagnostics" aria-labelledby="diagnostics-title" hidden><div class="diagnostics-header"><h2 id="diagnostics-title">Preview diagnostics</h2><button id="diagnostics-close" type="button" aria-label="Close diagnostics">Close</button></div><pre id="diagnostics-body" tabindex="0"></pre></section>
<section id="build-log" aria-labelledby="build-log-title" hidden><div class="diagnostics-header"><h2 id="build-log-title">Build log</h2><div class="panel-actions"><button id="build-log-open" type="button" title="Open the complete output of this build, with timestamps, in an editor">Open in editor</button><button id="build-log-activity" type="button" title="Show each step of the preview build and how long it took">Timing</button><button id="build-log-close" type="button" aria-label="Close build log">Close</button></div></div><div id="build-log-body" tabindex="0" role="log" aria-label="Preview build output"></div></section>
<script nonce="${nonce}">
const api = acquireVsCodeApi();
const gallery = document.getElementById('gallery');
const saved = api.getState() || {};
let fitted = saved.fitted !== false;
let inspecting = saved.inspecting === true;
let currentRevision = -1;
let imageRevision = -1;
let generation = 0;
let statusState = 'working';
let statusText = 'Starting preview…';
let diagnosticsText = '';
let diagnosticOrigin = null;
/** The recovery the extension offers for the current error, if the next ordinary build cannot fix it. */
let statusAction = null;
/** Epoch milliseconds the running phase began; the status row counts up from it. */
let since = null;
let logLines = 0;
const LOG_LIMIT = 2000;
const cards = new Map();
const inputKeys = ${JSON.stringify(PREVIEW_KEY_NAMES)};
let inputEpoch = 0;
let inputFocus = 0;
let focusedInput = null;
let composing = false;
const heldKeys = new Set();

function releaseInput(notify = true) {
  const previous = focusedInput;
  focusedInput = null;
  heldKeys.clear();
  if (previous && notify) api.postMessage({ type: 'focusInput', imageId: null, epoch: inputEpoch, focus: previous.focus });
}
function focusInput(card) {
  if (inspecting || composing || !card.live || !card.keyboard || !card.image || !isFresh()) return false;
  if (focusedInput && focusedInput.card === card) return true;
  releaseInput();
  focusedInput = { card, focus: ++inputFocus };
  api.postMessage({ type: 'focusInput', imageId: card.id, epoch: inputEpoch, focus: inputFocus });
  return true;
}
function resetInput(epoch) {
  const canvas = focusedInput && focusedInput.card.canvas;
  releaseInput(false);
  inputEpoch = epoch;
  composing = false;
  for (const card of cards.values()) { card.keyboard = false; updateInspector(card); }
  if (canvas && document.activeElement === canvas) canvas.blur();
}
function keyboard(card, action, event) {
  if (composing || event.isComposing || event.keyCode === 229) {
    if (focusedInput && focusedInput.card === card) releaseInput();
    return;
  }
  if (inspecting || !focusedInput || focusedInput.card !== card || document.activeElement !== card.canvas
    || !card.live || !card.keyboard || !isFresh()) return;
  // Preserve VS Code's keyboard-only exit from a webview instead of trapping its focus-navigation keys.
  if (event.key === 'F6' && !event.ctrlKey && !event.altKey && !event.metaKey) {
    if (action === 'down') {
      releaseInput();
      card.canvas.blur();
    }
    return; // Bubble to the webview host's existing Focus Next/Previous Part bindings.
  }
  const point = event.key.codePointAt(0);
  if (!inputKeys.includes(event.key)
    && !([...event.key].length === 1 && point >= 32 && point !== 127 && !(point >= 0xd800 && point <= 0xdfff))) return;
  const key = event.code || event.key;
  if ((action === 'up' || event.repeat) && !heldKeys.has(key)) return;
  if (action === 'down') heldKeys.add(key);
  else heldKeys.delete(key);
  api.postMessage({ type: 'keyboard', imageId: card.id, epoch: inputEpoch, focus: focusedInput.focus,
    event: { action, key: event.key, code: event.code, shiftKey: event.shiftKey, ctrlKey: event.ctrlKey,
      altKey: event.altKey, metaKey: event.metaKey, repeat: event.repeat } });
  event.preventDefault();
  event.stopPropagation();
}
const svgNS = 'http://www.w3.org/2000/svg';
function element(tag, className, text) {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (text !== undefined) result.textContent = text;
  return result;
}
function button(className, text, title) {
  const result = element('button', className, text);
  result.type = 'button';
  if (title) result.title = title;
  return result;
}
function preferences() {
  if (inspecting) releaseInput();
  document.body.classList.toggle('fit', fitted);
  document.body.classList.toggle('inspect', inspecting);
  document.getElementById('fit').setAttribute('aria-pressed', String(fitted));
  document.getElementById('fit-label').textContent = fitted ? 'Fit' : '1:1';
  document.getElementById('inspect').setAttribute('aria-pressed', String(inspecting));
  document.getElementById('inspect-hint').hidden = inspecting || cards.size === 0;
  for (const card of cards.values()) updateInspector(card);
}
function isFresh() { return imageRevision === currentRevision && imageRevision >= 0; }
function canNavigate(card, node) { return inspecting && isFresh() && !!node && !!node.source && card.nodes.includes(node); }
function sourceLabel(node) {
  if (!node || !node.source) return 'No source location available';
  const source = node.source;
  return source.fileName + (Number.isFinite(source.lineNumber) && source.lineNumber > 0 ? ':' + source.lineNumber : '');
}
function selectedNode(card) { return card.nodes.find(node => node.id === card.selectedId); }
function activeNode(card) { return card.nodes.find(node => node.id === card.hoveredId) || selectedNode(card); }
function contains(outer, inner) {
  return outer.x <= inner.x + .5 && outer.y <= inner.y + .5 && outer.x + outer.width >= inner.x + inner.width - .5 && outer.y + outer.height >= inner.y + inner.height - .5;
}
function parentNode(card, node) {
  if (!node) return undefined;
  const index = card.nodes.indexOf(node);
  const area = node.width * node.height;
  let parent;
  let parentArea = Infinity;
  for (let candidateIndex = 0; candidateIndex < card.nodes.length; candidateIndex++) {
    const candidate = card.nodes[candidateIndex];
    const candidateArea = candidate.width * candidate.height;
    if (candidate !== node && contains(candidate, node) && (candidateArea > area || (candidateArea === area && candidateIndex > index)) && candidateArea < parentArea) {
      parent = candidate;
      parentArea = candidateArea;
    }
  }
  return parent;
}
function updateInspector(card) {
  const node = activeNode(card);
  const selected = selectedNode(card);
  card.canvas.tabIndex = inspecting ? card.nodes.length ? 0 : -1 : card.live && card.image ? 0 : -1;
  card.canvas.setAttribute('aria-label', card.name + (inspecting ? selected ? ', selected ' + selected.name : ', layout inspector'
    : card.keyboard ? ', interactive preview' : card.live ? ', keyboard input unavailable' : ', preview image'));
  card.canvas.setAttribute('aria-roledescription', inspecting ? 'layout inspector' : 'Compose preview');
  card.canvas.setAttribute('aria-describedby', inspecting ? 'keyboard-help' : 'input-help');
  card.canvas.title = !inspecting && card.live && !card.keyboard
    ? 'Keyboard input unavailable: this Komodo does not support it. Use an Elide distribution with a newer Komodo.' : '';
  card.size.textContent = card.image ? card.dimensions : '';
  // Inspection details take room only while Inspect is on; the toolbar's Inspect toggle is the one way in.
  card.inspector.hidden = !inspecting;
  card.controls.hidden = !card.nodes.length;
  card.hint.hidden = card.nodes.length > 0;
  card.open.hidden = !card.nodes.length;
  card.open.disabled = !canNavigate(card, node);
  card.open.title = !isFresh() ? 'Source navigation resumes after a successful rebuild' : node && node.source ? 'Open ' + sourceLabel(node) : 'Select a component with source information';
  card.component.textContent = node ? node.name : card.nodes.length ? 'Select a component' : 'No layout information';
  card.context.textContent = (node ? Math.round(node.width) + ' × ' + Math.round(node.height) + ' px · x ' + node.x + ', y ' + node.y + (node.source ? ' · ' + sourceLabel(node) : ' · No source location') : card.nodes.length ? card.nodes.length + ' layouts · click an outline' : card.layoutError || 'This render did not provide layout bounds.') + (!isFresh() ? ' · Last rendered layout; awaiting update' : '');
  card.context.title = card.context.textContent;
  card.picker.value = card.selectedId || '';
  card.parent.disabled = !parentNode(card, selected);
  for (const [id, rect] of card.rects) {
    rect.classList.toggle('selected', id === card.selectedId);
    rect.classList.toggle('hovered', id === card.hoveredId);
  }
}
function selectNode(card, node, announce) {
  card.selectedId = node ? node.id : null;
  card.hoveredId = null;
  updateInspector(card);
  if (announce && node) document.getElementById('announcement').textContent = node.name + ', ' + node.width + ' by ' + node.height + ' pixels';
}
function navigate(card, node) {
  if (!canNavigate(card, node)) return;
  api.postMessage({ type: 'navigate', revision: imageRevision, imageId: card.id, nodeId: node.id });
}
function hitNode(card, event) {
  const bounds = card.image && card.image.getBoundingClientRect();
  if (!bounds || !bounds.width || !bounds.height) return undefined;
  const x = (event.clientX - bounds.left) * card.width / bounds.width;
  const y = (event.clientY - bounds.top) * card.height / bounds.height;
  let hit;
  let area = Infinity;
  // Tooling emits children first; equal bounds prefer the earlier, deeper node.
  for (const node of card.nodes) {
    const candidateArea = node.width * node.height;
    if (candidateArea < area && x >= node.x && y >= node.y && x <= node.x + node.width && y <= node.y + node.height) {
      hit = node;
      area = candidateArea;
    }
  }
  return hit;
}
function inspectKey(card, event) {
  if (!inspecting || !card.nodes.length) return;
  const node = selectedNode(card);
  let next;
  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); navigate(card, node); return; }
  if (event.key === 'Escape') { event.preventDefault(); selectNode(card, null, false); return; }
  if (event.altKey && event.key === 'ArrowUp') next = parentNode(card, node);
  else if (event.key === 'Home') next = card.nodes[0];
  else if (event.key === 'End') next = card.nodes[card.nodes.length - 1];
  else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = card.nodes[(card.nodes.indexOf(node) + 1) % card.nodes.length];
  else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = card.nodes[node ? (card.nodes.indexOf(node) - 1 + card.nodes.length) % card.nodes.length : card.nodes.length - 1];
  else return;
  event.preventDefault();
  if (next) selectNode(card, next, true);
}
function createCard(id) {
  const root = element('article', 'preview-card');
  root.dataset.imageId = id;
  const header = element('div', 'card-header');
  const heading = element('div', 'card-heading');
  const title = element('h2', 'card-title');
  const detail = element('p', 'card-detail');
  heading.append(title, detail);
  const error = button('card-error', 'Details', 'Show preview diagnostics');
  error.hidden = true;
  const size = element('span', 'card-size');
  header.append(heading, size, error);
  const viewport = element('div', 'viewport');
  const canvas = element('div', 'canvas');
  canvas.setAttribute('role', 'group');
  canvas.setAttribute('aria-roledescription', 'Compose preview');
  canvas.setAttribute('aria-describedby', 'input-help');
  const overlay = document.createElementNS(svgNS, 'svg');
  overlay.classList.add('layout-overlay');
  overlay.setAttribute('aria-hidden', 'true');
  overlay.setAttribute('preserveAspectRatio', 'none');
  const unavailable = element('div', 'unavailable');
  unavailable.append(element('strong', '', 'Preview unavailable'), element('span', '', 'See diagnostics for build or render details.'));
  canvas.append(overlay);
  viewport.append(canvas, unavailable);
  const inspector = element('div', 'inspector');
  const row = element('div', 'component-row');
  const component = element('span', 'component-name');
  const open = button('open-source', 'Open source ↗', 'Open selected component source');
  row.append(component, open);
  const context = element('div', 'source-context');
  const controls = element('div', 'inspector-controls');
  const picker = element('select', 'component-picker');
  picker.setAttribute('aria-label', 'Select component');
  const parent = button('parent-node', '↑ Parent', 'Select enclosing component (Alt+Up)');
  controls.append(picker, parent);
  const hint = element('p', 'inspection-hint', 'Rebuild this preview to refresh layout information.');
  inspector.append(row, context, controls, hint);
  inspector.hidden = true;
  root.append(header, viewport, inspector);
  const card = { id, root, title, detail, size, error, viewport, canvas, overlay, unavailable, inspector, component, open, context, controls, picker, parent, hint, nodes: [], rects: new Map(), image: null, data: null, selectedId: null, hoveredId: null, width: 0, height: 0, dimensions: '', name: '', errorText: '', errorLinks: [], live: false, keyboard: false };
  error.onclick = () => showDiagnostics(card.errorText, card.name, error, card);
  open.onclick = () => navigate(card, activeNode(card));
  picker.onchange = () => selectNode(card, card.nodes.find(node => node.id === picker.value), true);
  parent.onclick = () => selectNode(card, parentNode(card, selectedNode(card)), true);
  canvas.addEventListener('pointermove', event => {
    if (!inspecting) return;
    const node = hitNode(card, event);
    const id = node ? node.id : null;
    if (id !== card.hoveredId) { card.hoveredId = id; updateInspector(card); }
  });
  canvas.addEventListener('pointerleave', () => { if (card.hoveredId) { card.hoveredId = null; updateInspector(card); } });
  canvas.addEventListener('click', event => {
    if (!inspecting) return;
    selectNode(card, hitNode(card, event), true);
    canvas.focus({ preventScroll: true });
  });
  canvas.addEventListener('dblclick', event => { if (inspecting) navigate(card, hitNode(card, event)); });
  // A live card (the Komodo engine) takes pointer input while not inspecting, in the image's pixels.
  const forward = (action, event) => {
    if (inspecting || !card.live || !card.image || !isFresh()) return;
    const bounds = card.image.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    api.postMessage({ type: 'pointer', imageId: card.id, epoch: inputEpoch, action,
      x: Math.round((event.clientX - bounds.left) * card.width / bounds.width), y: Math.round((event.clientY - bounds.top) * card.height / bounds.height) });
  };
  canvas.addEventListener('pointerdown', event => {
    if (card.live && !inspecting) {
      canvas.focus({ preventScroll: true });
      focusInput(card);
      canvas.setPointerCapture(event.pointerId);
      forward('down', event);
    }
  });
  canvas.addEventListener('pointerup', event => forward('up', event));
  canvas.addEventListener('pointermove', event => { if (event.buttons) forward('move', event); });
  canvas.addEventListener('focus', () => focusInput(card));
  canvas.addEventListener('blur', () => { if (focusedInput && focusedInput.card === card) releaseInput(); });
  canvas.addEventListener('keydown', event => { if (inspecting) inspectKey(card, event); else keyboard(card, 'down', event); });
  canvas.addEventListener('keyup', event => keyboard(card, 'up', event));
  canvas.addEventListener('compositionstart', () => { composing = true; releaseInput(); });
  canvas.addEventListener('compositionend', () => {
    composing = false;
    if (document.activeElement === canvas) focusInput(card);
  });
  return card;
}
function installNodes(card, nodes) {
  card.nodes = nodes.filter(node => node && typeof node.id === 'string' && [node.x, node.y, node.width, node.height].every(Number.isFinite) && node.width > 0 && node.height > 0);
  if (!selectedNode(card)) card.selectedId = null;
  card.hoveredId = null;
  card.overlay.replaceChildren();
  card.rects.clear();
  const placeholder = element('option', '', 'Choose a component…');
  placeholder.value = '';
  card.picker.replaceChildren(placeholder);
  for (const node of card.nodes) {
    const rect = document.createElementNS(svgNS, 'rect');
    rect.classList.add('layout-outline');
    rect.setAttribute('x', String(node.x));
    rect.setAttribute('y', String(node.y));
    rect.setAttribute('width', String(node.width));
    rect.setAttribute('height', String(node.height));
    card.overlay.append(rect);
    card.rects.set(node.id, rect);
    const option = element('option', '', node.name + ' — ' + (node.source ? sourceLabel(node) : node.width + ' × ' + node.height + ' px at ' + node.x + ', ' + node.y));
    option.value = node.id;
    card.picker.append(option);
  }
}
function emptyState() {
  document.getElementById('empty').hidden = cards.size > 0;
  document.getElementById('empty-title').textContent = statusState === 'error' ? 'Preview could not be built' : statusState === 'working' ? 'Preparing your previews' : 'No previews to display';
  document.getElementById('empty-description').textContent = statusState === 'error' ? 'Open Details for diagnostics, or Build log for the build output. ' + (statusAction ? statusAction.detail : 'Your previews will appear after the next successful build.') : statusState === 'working' ? 'Rendered composables will appear here. You can keep editing while they build' + (logLines ? '; open Build log to follow the build.' : '.') : 'Add a @Preview composable to this file, then rebuild.';
}
function closeDiagnostics() {
  document.getElementById('diagnostics').hidden = true;
  document.getElementById('diagnostics-toggle').setAttribute('aria-expanded', 'false');
  if (diagnosticOrigin && diagnosticOrigin.isConnected) diagnosticOrigin.focus({ preventScroll: true });
}
/** Diagnostics text; a card's project stack frames link to their source, by line and UTF-16 span. */
function diagnosticsContent(text, card) {
  const body = document.getElementById('diagnostics-body');
  const links = card ? card.errorLinks : [];
  if (!links.length) { body.textContent = text; return; }
  const fragment = document.createDocumentFragment();
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    let cursor = 0;
    links.forEach((link, linkIndex) => {
      if (link.line !== index || link.start < cursor || link.end > line.length) return;
      fragment.append(line.slice(cursor, link.start));
      const anchor = element('a', '', line.slice(link.start, link.end));
      anchor.href = '#';
      anchor.title = 'Open ' + anchor.textContent;
      anchor.onclick = event => {
        event.preventDefault();
        api.postMessage({ type: 'openFrame', revision: imageRevision, imageId: card.id, link: linkIndex });
      };
      fragment.append(anchor);
      cursor = link.end;
    });
    fragment.append(line.slice(cursor) + (index < lines.length - 1 ? '\n' : ''));
  }
  body.replaceChildren(fragment);
}
function showDiagnostics(text, title, origin, card) {
  closeBuildLog(false);
  diagnosticOrigin = origin;
  document.getElementById('diagnostics-title').textContent = title || 'Preview diagnostics';
  diagnosticsContent(text, card);
  document.getElementById('diagnostics').hidden = false;
  document.getElementById('diagnostics-toggle').setAttribute('aria-expanded', 'true');
  document.getElementById('diagnostics-close').focus({ preventScroll: true });
}
function closeBuildLog(restoreFocus) {
  if (document.getElementById('build-log').hidden) return;
  document.getElementById('build-log').hidden = true;
  document.getElementById('log-toggle').setAttribute('aria-expanded', 'false');
  if (restoreFocus) document.getElementById('log-toggle').focus({ preventScroll: true });
}
function showBuildLog() {
  if (!document.getElementById('diagnostics').hidden) closeDiagnostics();
  const body = document.getElementById('build-log-body');
  document.getElementById('build-log').hidden = false;
  document.getElementById('log-toggle').setAttribute('aria-expanded', 'true');
  body.scrollTop = body.scrollHeight;
  body.focus({ preventScroll: true });
}
function logClass(line) {
  if (/^(?:\[[^\]]*\]\s+)?(?:error:|✗)/.test(line) || /^\s*✗/.test(line)) return 'log-error';
  if (/^(?:\[[^\]]*\]\s+)?warning:/.test(line)) return 'log-warning';
  return /^\$ /.test(line) ? 'log-command' : '';
}
function appendLog(lines, reset) {
  const body = document.getElementById('build-log-body');
  if (reset) { body.replaceChildren(); logLines = 0; }
  // Follow the output unless the reader scrolled up to look at something.
  const following = body.scrollTop + body.clientHeight >= body.scrollHeight - 8;
  const fragment = document.createDocumentFragment();
  for (const line of lines) if (typeof line === 'string') { fragment.append(element('div', logClass(line), line)); logLines++; }
  body.append(fragment);
  for (; logLines > LOG_LIMIT && body.firstChild; logLines--) body.firstChild.remove();
  if (following) body.scrollTop = body.scrollHeight;
  document.getElementById('log-toggle').hidden = logLines === 0;
  if (logLines === 0) closeBuildLog(false);
  emptyState();
}
function updateElapsed() {
  const elapsed = document.getElementById('status-elapsed');
  if (since === null || statusState !== 'working') { elapsed.hidden = true; return; }
  const seconds = Math.max(0, Math.floor((Date.now() - since) / 1000));
  elapsed.textContent = seconds < 60 ? seconds + ' s' : Math.floor(seconds / 60) + ' m ' + String(seconds % 60).padStart(2, '0') + ' s';
  elapsed.hidden = false;
}
function applyStatus(data) {
  statusState = ['working', 'ready', 'error'].includes(data.state) ? data.state : 'working';
  statusText = typeof data.text === 'string' ? data.text : '';
  diagnosticsText = statusState === 'error' ? statusText : '';
  statusAction = statusState === 'error' && data.action && typeof data.action.id === 'string' ? data.action : null;
  document.getElementById('status').dataset.state = statusState;
  const summary = (typeof data.headline === 'string' && data.headline) || statusText.split(/\r?\n/).find(line => line.trim()) || (statusState === 'error' ? 'Preview build failed' : 'Preparing previews');
  document.getElementById('status-text').textContent = summary;
  document.getElementById('status-text').title = summary;
  document.getElementById('retained').hidden = data.retained !== true;
  document.getElementById('diagnostics-toggle').hidden = !diagnosticsText;
  document.getElementById('status-action').hidden = !statusAction;
  if (statusAction) {
    document.getElementById('status-action').textContent = statusAction.label;
    document.getElementById('status-action').title = statusAction.detail;
  }
  since = Number.isFinite(data.since) ? data.since : null;
  updateElapsed();
  gallery.setAttribute('aria-busy', String(statusState === 'working'));
  if (!document.getElementById('diagnostics').hidden && diagnosticOrigin === document.getElementById('diagnostics-toggle')) {
    if (diagnosticsText) document.getElementById('diagnostics-body').textContent = diagnosticsText;
    else closeDiagnostics();
  }
  emptyState();
}
async function receiveImages(message) {
  if (!Array.isArray(message.images) || !Number.isFinite(message.revision)) return;
  // A restored webview may receive old pixels with the current invalidation revision.
  const expectedRevision = Number.isFinite(message.currentRevision) ? message.currentRevision : message.revision;
  if (expectedRevision < currentRevision || message.revision > expectedRevision) return;
  if (!Number.isFinite(message.inputEpoch) || message.inputEpoch < inputEpoch) return;
  if (message.inputEpoch !== inputEpoch) resetInput(message.inputEpoch);
  if (focusedInput && (!Array.isArray(message.keyboard) || !message.keyboard.includes(focusedInput.card.id)
    || !message.images.some(image => image.id === focusedInput.card.id && image.live && image.data && !image.error))) releaseInput();
  currentRevision = expectedRevision;
  const ticket = ++generation;
  for (const card of cards.values()) updateInspector(card);
  const prepared = await Promise.all(message.images.map(async preview => {
    const previous = cards.get(preview.id);
    if (!preview.data || (previous && previous.data === preview.data)) return { preview, image: null, decodeError: '' };
    const image = element('img', 'preview-image');
    image.alt = preview.name;
    image.draggable = false;
    image.src = 'data:image/png;base64,' + preview.data;
    try { await image.decode(); return { preview, image, decodeError: '' }; }
    catch { return { preview, image: null, decodeError: 'The rendered PNG could not be decoded. Rebuild to try again.' }; }
  }));
  if (ticket !== generation || currentRevision !== expectedRevision) return;
  // An input reset during decoding already released input: the pixels stand, the keyboard cards wait for the next publication.
  const keyboard = inputEpoch === message.inputEpoch && Array.isArray(message.keyboard) ? message.keyboard : [];
  const scrollX = window.scrollX;
  const scrollY = window.scrollY;
  const keep = new Set();
  imageRevision = message.revision;
  let position = 0;
  for (const entry of prepared) {
    const preview = entry.preview;
    if (typeof preview.id !== 'string' || keep.has(preview.id)) continue;
    keep.add(preview.id);
    let card = cards.get(preview.id);
    if (!card) { card = createCard(preview.id); cards.set(preview.id, card); }
    card.name = preview.name;
    card.title.textContent = preview.name;
    card.detail.textContent = preview.detail || '';
    card.errorText = [preview.error, entry.decodeError].filter(Boolean).join('\n\n');
    card.layoutError = typeof preview.layoutError === 'string' ? preview.layoutError : '';
    card.errorLinks = message.errorLinks && Array.isArray(message.errorLinks[preview.id]) ? message.errorLinks[preview.id] : [];
    card.error.hidden = !card.errorText;
    card.live = preview.live === true && !!preview.data && !card.errorText;
    card.keyboard = card.live && keyboard.includes(card.id);
    if (focusedInput && focusedInput.card === card && !card.keyboard) releaseInput();
    if (entry.image) {
      const left = card.viewport.scrollLeft;
      const top = card.viewport.scrollTop;
      if (card.image) card.image.replaceWith(entry.image);
      else card.canvas.insertBefore(entry.image, card.overlay);
      card.image = entry.image;
      card.data = preview.data;
      card.viewport.scrollLeft = left;
      card.viewport.scrollTop = top;
    }
    if (card.image) {
      card.image.alt = preview.name;
      const retainedPixels = !!entry.decodeError || !preview.data;
      card.width = !retainedPixels && preview.width > 0 ? preview.width : card.image.naturalWidth;
      card.height = !retainedPixels && preview.height > 0 ? preview.height : card.image.naturalHeight;
      card.dimensions = card.image.naturalWidth + ' × ' + card.image.naturalHeight + ' px';
      card.overlay.setAttribute('viewBox', '0 0 ' + card.width + ' ' + card.height);
      installNodes(card, retainedPixels ? [] : Array.isArray(preview.nodes) ? preview.nodes : []);
    } else installNodes(card, []);
    card.canvas.hidden = !card.image;
    card.unavailable.hidden = !!card.image;
    updateInspector(card);
    const atPosition = gallery.children[position];
    if (atPosition !== card.root) gallery.insertBefore(card.root, atPosition || null);
    position++;
  }
  for (const [id, card] of cards) if (!keep.has(id)) {
    if (focusedInput && focusedInput.card === card) releaseInput();
    card.root.remove();
    cards.delete(id);
  }
  document.getElementById('count').textContent = String(cards.size);
  document.getElementById('inspect-hint').hidden = inspecting || cards.size === 0;
  gallery.setAttribute('aria-busy', 'false');
  emptyState();
  window.scrollTo(scrollX, scrollY);
  // Acknowledged even when a newer publication is decoding: the extension reports this one's pixels as painted.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (currentRevision === expectedRevision) api.postMessage({ type: 'painted', revision: message.revision, publication: message.publication });
  }));
}
document.getElementById('refresh').onclick = () => api.postMessage({ type: 'refresh' });
document.getElementById('status-action').onclick = () => { if (statusAction) api.postMessage({ type: 'action', id: statusAction.id }); };
document.getElementById('fit').onclick = () => { fitted = !fitted; preferences(); api.setState(Object.assign({}, saved, { fitted, inspecting })); };
document.getElementById('inspect').onclick = () => {
  inspecting = !inspecting;
  preferences();
  api.setState(Object.assign({}, saved, { fitted, inspecting }));
  api.postMessage({ type: 'inspect', enabled: inspecting });
};
document.getElementById('diagnostics-toggle').onclick = event => {
  if (document.getElementById('diagnostics').hidden) showDiagnostics(diagnosticsText, 'Preview diagnostics', event.currentTarget);
  else closeDiagnostics();
};
document.getElementById('diagnostics-close').onclick = closeDiagnostics;
document.getElementById('log-toggle').onclick = () => {
  if (document.getElementById('build-log').hidden) showBuildLog();
  else closeBuildLog(true);
};
document.getElementById('build-log-close').onclick = () => closeBuildLog(true);
document.getElementById('build-log-open').onclick = () => api.postMessage({ type: 'openLog' });
document.getElementById('build-log-activity').onclick = () => api.postMessage({ type: 'showActivity' });
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  if (!document.getElementById('diagnostics').hidden) { event.preventDefault(); closeDiagnostics(); }
  else if (!document.getElementById('build-log').hidden) { event.preventDefault(); closeBuildLog(true); }
});
window.addEventListener('blur', () => {
  const canvas = focusedInput && focusedInput.card.canvas;
  releaseInput();
  composing = false;
  if (canvas) canvas.blur();
});
document.addEventListener('visibilitychange', () => { if (document.hidden) releaseInput(); });
window.addEventListener('pagehide', () => releaseInput());
setInterval(updateElapsed, 1000);
window.addEventListener('message', ({ data }) => {
  if (!data || typeof data !== 'object') return;
  if (data.type === 'inputReset' && Number.isFinite(data.epoch) && data.epoch >= inputEpoch) resetInput(data.epoch);
  else if (data.type === 'inputBlur' && data.epoch === inputEpoch && focusedInput && data.focus === focusedInput.focus) {
    const canvas = focusedInput.card.canvas;
    releaseInput(false);
    if (document.activeElement === canvas) canvas.blur();
  }
  if (data.type === 'status') applyStatus(data);
  else if (data.type === 'invalidate' && Number.isFinite(data.revision) && data.revision >= currentRevision) {
    if (data.revision > currentRevision) { currentRevision = data.revision; generation++; }
    releaseInput();
    gallery.setAttribute('aria-busy', 'true');
    for (const card of cards.values()) updateInspector(card);
  } else if (data.type === 'images') void receiveImages(data);
  else if (data.type === 'source' && typeof data.uri === 'string') {
    // What the extension reopens after a window reload.
    saved.source = data.uri;
    api.setState(Object.assign({}, saved, { fitted, inspecting }));
  } else if (data.type === 'log' && Array.isArray(data.lines)) appendLog(data.lines, data.reset === true);
  else if (data.type === 'inspect' && typeof data.enabled === 'boolean') {
    inspecting = data.enabled;
    preferences();
    api.setState(Object.assign({}, saved, { fitted, inspecting }));
  }
});
preferences();
api.postMessage({ type: 'ready' });
if (inspecting) api.postMessage({ type: 'inspect', enabled: true });
</script>
</body>
</html>`;
}
