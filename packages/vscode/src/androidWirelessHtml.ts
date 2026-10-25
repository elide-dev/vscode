import { randomBytes } from "node:crypto";

/** Device-controlled content is assigned with textContent, never interpolated into HTML. */
export function wirelessHtml(): string {
  const nonce = randomBytes(18).toString("base64");
  return String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src data:; base-uri 'none'; form-action 'none'">
<title>Pair Android over Wi-Fi</title>
<style nonce="${nonce}">
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { margin: 0; color: var(--vscode-foreground, #ddd); background: var(--vscode-editor-background, #202124); font: 13px/1.5 var(--vscode-font-family, system-ui, sans-serif); }
header { padding: 16px 20px; border-bottom: 1px solid var(--vscode-panel-border, #555); }
h1 { font-size: 17px; margin: 0 0 6px; } h2 { font-size: 14px; margin: 0 0 10px; }
p { margin: 8px 0; }
main { max-width: 680px; margin: 0 auto; padding: 16px 20px; }
section { padding: 16px 0; border-bottom: 1px solid var(--vscode-panel-border, #555); }
section:first-child { padding-top: 0; }
.hint { color: var(--vscode-descriptionForeground, #aaa); font-size: 12px; }
.actions, .choices { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.actions { margin-top: 12px; }
fieldset { border: 0; padding: 0; margin: 0 0 14px; }
legend { margin-bottom: 6px; }
.choices label { display: inline-flex; align-items: center; gap: 5px; }
.field { margin-top: 12px; }
.field > label { display: block; margin-bottom: 4px; }
button, select, input { font: inherit; color: inherit; }
button, select, input:not([type="radio"]) { min-height: 32px; border: 1px solid var(--vscode-input-border, #666); border-radius: 3px; padding: 5px 9px; }
input:not([type="radio"]), select { width: 100%; background: var(--vscode-input-background, #292929); color: var(--vscode-input-foreground, #ddd); }
input::placeholder { color: var(--vscode-input-placeholderForeground, #aaa); }
input[type="radio"] { accent-color: var(--vscode-focusBorder, #3794ff); }
#code { max-width: 180px; font-family: var(--vscode-editor-font-family, monospace); letter-spacing: .2em; }
button { cursor: pointer; background: var(--vscode-button-secondaryBackground, #383838); color: var(--vscode-button-secondaryForeground, #fff); }
button:hover:enabled { background: var(--vscode-button-secondaryHoverBackground, #484848); }
button.primary { background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #fff); border-color: transparent; }
button.primary:hover:enabled { background: var(--vscode-button-hoverBackground, #1177bb); }
button:disabled, input:disabled, select:disabled { opacity: .55; cursor: default; }
button:focus-visible, input:focus-visible, select:focus-visible, summary:focus-visible { outline: 2px solid var(--vscode-focusBorder, #3794ff); outline-offset: 2px; }
#qr-display { margin: 14px 0 0; }
#qr-image { display: block; width: 240px; max-width: 100%; height: auto; background: white; border: 10px solid white; image-rendering: pixelated; }
figcaption { margin-top: 8px; }
#status { min-height: 26px; margin-top: 12px; overflow-wrap: anywhere; white-space: pre-wrap; }
#status.error { color: var(--vscode-errorForeground, #f48771); }
details { margin-top: 16px; } summary { cursor: pointer; }
ul { padding-left: 20px; } li { margin: 6px 0; }
[hidden] { display: none !important; }
</style></head><body>
<header><h1>Pair Android over Wi-Fi</h1><p class="hint">Android 11 or newer &middot; Connect your device and computer to the same Wi-Fi network.</p></header>
<main>
<section aria-labelledby="pair-title">
<h2 id="pair-title">1. Pair your device</h2>
<p>On your device, open <strong>Developer options &rarr; Wireless debugging</strong> and turn it on.</p>
<fieldset id="method"><legend>Pairing method</legend><div class="choices">
<label><input type="radio" name="method" value="qr" checked aria-controls="qr-panel">QR code</label>
<label><input type="radio" name="method" value="code" aria-controls="code-panel">Six-digit code</label>
</div></fieldset>
<div id="qr-panel">
<p class="hint" id="qr-help">Choose <strong>Pair device with QR code</strong> on your device, then scan the code generated here. Keep this panel open while pairing.</p>
<button id="qr" class="primary" aria-describedby="qr-help">Generate QR code</button>
<figure id="qr-display" hidden><img id="qr-image" alt="Wireless debugging pairing QR code"><figcaption class="hint">Scan with the Wireless debugging scanner, not the Camera app. This code is temporary; cancel to discard it.</figcaption></figure>
</div>
<form id="code-panel" autocomplete="off" hidden>
<p class="hint">Tap <strong>Pair device with pairing code</strong> on your device. Leave that dialog open to keep its pairing address and six-digit code available.</p>
<div class="field"><label for="pairing-service">Discovered pairing device</label><select id="pairing-service" aria-describedby="discovery-help"><option value="">Enter an address manually</option></select><p id="discovery-help" class="hint">Refresh while the pairing dialog is open to discover devices.</p></div>
<div class="field" id="manual-pairing"><label for="pairing-endpoint">Pairing address and port</label><input id="pairing-endpoint" type="text" placeholder="192.168.1.42:37123" spellcheck="false" autocapitalize="off" autocomplete="off" aria-describedby="pairing-help"><p id="pairing-help" class="hint">Use the IP address and port from the pairing-code dialog, including the port. IPv6 example: [fe80::1234]:37123.</p></div>
<div class="field"><label for="code">Six-digit pairing code</label><input id="code" type="password" inputmode="numeric" pattern="[0-9]{6}" minlength="6" maxlength="6" required autocomplete="off" aria-describedby="code-help"><p id="code-help" class="hint">The code is sent only when you choose Pair. It is not saved.</p></div>
<div class="actions"><button id="pair" type="submit" class="primary">Pair device</button></div>
</form>
</section>
<section aria-labelledby="connect-title">
<h2 id="connect-title">2. Connect an already-paired device</h2>
<p class="hint" id="connect-help">If your device is paired but not connected, use <strong>IP address &amp; port</strong> on the main Wireless debugging screen. The connection port is different from the pairing port.</p>
<form id="connect-form" autocomplete="off"><div class="field"><label for="connect-endpoint">Connection address and port</label><input id="connect-endpoint" type="text" list="connections" placeholder="192.168.1.42:40555" required spellcheck="false" autocapitalize="off" autocomplete="off" aria-describedby="connect-help"><datalist id="connections"></datalist></div><div class="actions"><button id="connect" type="submit">Connect device</button></div></form>
</section>
<div class="actions"><button id="refresh">Refresh discovery</button><button id="cancel" hidden>Cancel</button></div>
<div id="status" role="status" aria-live="polite" aria-atomic="true">Ready to pair.</div>
<details><summary>Troubleshooting</summary><ul class="hint">
<li>No devices found? Keep the device unlocked with its pairing dialog open, then refresh. Discovery uses mDNS; if your network blocks it, enter the address and port manually.</li>
<li>Pairing and connection use different ports. Copy the current port from the appropriate screen; ports can change when Wireless debugging restarts.</li>
<li>Check that both devices are on the same network. Guest Wi-Fi isolation, VPNs, and firewalls can block discovery or connections.</li>
<li>If the code expires, reopen the pairing-code dialog. For QR pairing, cancel and generate a new QR code.</li>
<li>Wireless debugging requires Android 11 or newer and Android SDK Platform-Tools with wireless pairing support.</li>
<li>In Remote SSH or containers, ADB runs on the extension host. That host needs SDK Platform-Tools and network access to the device.</li>
</ul></details>
</main>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const $ = id => document.getElementById(id);
let busy = true;
let cancelling = false;
const send = (type, data = {}) => vscode.postMessage({ type, ...data });
function clearQr() {
  $('qr-image').removeAttribute('src');
  $('qr-display').hidden = true;
}
function controls() {
  for (const element of document.querySelectorAll('button, input, select')) {
    if (element.id !== 'cancel') element.disabled = busy;
  }
  $('cancel').hidden = !busy && $('qr-display').hidden;
  $('cancel').disabled = cancelling;
  $('manual-pairing').hidden = !!$('pairing-service').value;
  $('pairing-endpoint').required = !$('pairing-service').value;
  $('pair').disabled = busy || !($('pairing-service').value || $('pairing-endpoint').value.trim()) || !/^[0-9]{6}$/.test($('code').value);
  $('connect').disabled = busy || !$('connect-endpoint').value.trim();
}
function start(type, data = {}) {
  if (busy) return;
  busy = true;
  clearQr();
  $('status').textContent = type === 'refresh' ? 'Discovering devices…' : 'Working…';
  $('status').classList.remove('error');
  controls();
  send(type, data);
}
function renderServices(services) {
  const selection = $('pairing-service').value;
  const previousLabel = $('pairing-service').selectedOptions[0]?.textContent;
  const manual = document.createElement('option');
  manual.value = ''; manual.textContent = 'Enter an address manually';
  $('pairing-service').replaceChildren(manual);
  $('connections').replaceChildren();
  let pairingCount = 0;
  for (const service of services) {
    const option = document.createElement('option');
    option.value = service.endpoint;
    option.textContent = service.name + ' — ' + service.endpoint;
    if (service.type === 'pairing') { $('pairing-service').append(option); pairingCount++; }
    else if (service.type === 'connect') $('connections').append(option);
  }
  if (selection && !Array.from($('pairing-service').options).some(option => option.value === selection)) {
    const option = document.createElement('option');
    option.value = selection;
    option.textContent = (previousLabel || selection).replace(/ \(not currently discovered\)$/, '') + ' (not currently discovered)';
    $('pairing-service').append(option);
  }
  $('pairing-service').value = selection;
  $('discovery-help').textContent = pairingCount ? 'Select a discovered device, or enter its pairing address manually.' : 'No pairing devices discovered. Open the pairing-code dialog and refresh, or enter its address manually.';
}
for (const radio of document.querySelectorAll('input[name="method"]')) radio.onchange = () => {
  $('qr-panel').hidden = radio.value !== 'qr';
  $('code-panel').hidden = radio.value !== 'code';
  controls();
};
$('pairing-service').onchange = controls;
for (const id of ['pairing-endpoint', 'code', 'connect-endpoint']) $(id).oninput = controls;
$('qr').onclick = () => start('qr');
$('refresh').onclick = () => start('refresh');
$('code-panel').onsubmit = event => {
  event.preventDefault();
  if (busy || $('pair').disabled || !$('code-panel').reportValidity()) return;
  const data = { endpoint: $('pairing-service').value || $('pairing-endpoint').value, code: $('code').value };
  $('code').value = '';
  start('pair', data);
};
$('connect-form').onsubmit = event => {
  event.preventDefault();
  if (busy || $('connect').disabled || !$('connect-form').reportValidity()) return;
  start('connect', { endpoint: $('connect-endpoint').value });
};
$('cancel').onclick = () => {
  if (cancelling) return;
  cancelling = true;
  busy = true;
  clearQr();
  $('status').textContent = 'Cancelling…';
  controls();
  send('cancel');
};
window.addEventListener('message', event => {
  const data = event.data;
  if (!data || data.type !== 'state') return;
  busy = !!data.busy;
  if (!busy) cancelling = false;
  $('status').textContent = data.status;
  $('status').classList.toggle('error', !!data.error);
  renderServices(data.services);
  if (!cancelling && typeof data.qr === 'string' && data.qr.startsWith('data:image/png;base64,')) {
    $('qr-image').src = data.qr;
    $('qr-display').hidden = false;
  } else clearQr();
  controls();
});
controls();
send('ready');
</script></body></html>`;
}
