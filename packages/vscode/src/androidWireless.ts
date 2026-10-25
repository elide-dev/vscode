import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import {
  adbExecutable, connectAndroidWireless, createAndroidWirelessQr, discoverAndroidWireless,
  pairAndroidWireless, validateAndroidWirelessEndpoint, type AndroidWirelessService,
} from "@elide/ide-core";
import QRCode from "qrcode";
import * as vscode from "vscode";
import { androidSdkFor, toAndroidTarget } from "./android.js";
import { NO_ANDROID_PROJECT, preferredAndroidProject, type AndroidDeploymentTarget } from "./androidDeploymentState.js";
import { wirelessHtml } from "./androidWirelessHtml.js";
import type { ElideProject, ElideWorkspace } from "./projects.js";

/** One operation per panel; cancellation revokes every outstanding discovery and pairing result. */
class WirelessPanel implements vscode.Disposable {
  private readonly panel: vscode.WebviewPanel;
  private readonly subscriptions: vscode.Disposable[] = [];
  private operation: AbortController | undefined;
  private disposed = false;
  private services: AndroidWirelessService[] = [];
  private status = "Enable Wireless debugging on an Android 11+ device on the same Wi-Fi network.";
  private error = false;
  private qr: string | undefined;

  constructor(readonly adb: string, private readonly valid: () => boolean, closed: () => void) {
    this.panel = vscode.window.createWebviewPanel("elide.androidWireless", "Pair Android Device over Wi-Fi", vscode.ViewColumn.Active,
      { enableScripts: true, localResourceRoots: [], retainContextWhenHidden: true });
    this.subscriptions.push(
      this.panel.onDidDispose(() => { this.dispose(); closed(); }),
      this.panel.webview.onDidReceiveMessage((message: unknown) => { void this.receive(message); }),
    );
    this.panel.webview.html = wirelessHtml();
  }

  reveal(): void { this.panel.reveal(); }

  private publish(): void {
    if (!this.disposed) void this.panel.webview.postMessage({ type: "state", busy: !!this.operation,
      services: this.services, status: this.status, error: this.error, qr: this.qr });
  }

  private cancel(): void {
    this.operation?.abort();
    this.operation = undefined;
    this.qr = undefined;
  }

  private async receive(value: unknown): Promise<void> {
    if (this.disposed || !this.valid() || !value || typeof value !== "object" || !("type" in value)) return;
    const message = value as Record<string, unknown>;
    if (message.type === "cancel") {
      this.cancel();
      this.status = "Cancelled. Pairing already accepted by the device is not undone; use Forget on the device to revoke it.";
      this.error = false;
      this.publish();
      return;
    }
    if (this.operation) { if (message.type === "ready") this.publish(); return; }
    if (!["ready", "refresh", "qr", "pair", "connect"].includes(String(message.type))) return;
    const controller = new AbortController();
    this.operation = controller;
    const current = () => !this.disposed && this.valid() && this.operation === controller && !controller.signal.aborted;
    const signal = controller.signal;
    this.error = false;
    this.status = message.type === "qr" ? "Preparing QR code…" : message.type === "pair" ? "Pairing…"
      : message.type === "connect" ? "Connecting…" : "Discovering wireless devices…";
    this.publish();
    try {
      if (message.type === "ready" || message.type === "refresh") {
        const services = await discoverAndroidWireless(this.adb, signal);
        if (!current()) return;
        this.services = services;
        this.status = services.length ? "Select a discovered device, or enter its address manually."
          : "No wireless services found. Open ‘Pair device with pairing code’ on the phone, then refresh. Manual pairing also works when mDNS is blocked.";
      } else if (message.type === "qr") {
        const credentials = createAndroidWirelessQr();
        const image = await QRCode.toDataURL(credentials.payload, { width: 280, margin: 4, errorCorrectionLevel: "M" });
        if (!current()) return;
        this.qr = image;
        this.status = "On the device, open Wireless debugging → Pair device with QR code and scan. Waiting up to two minutes…";
        this.publish();
        const deadline = Date.now() + 120_000;
        let endpoint: string | undefined;
        while (current() && Date.now() < deadline) {
          const services = await discoverAndroidWireless(this.adb, signal);
          if (!current()) return;
          this.services = services;
          endpoint = services.find((service) => service.type === "pairing" && service.name === credentials.name)?.endpoint;
          if (endpoint) break;
          await delay(1_000, undefined, { signal });
        }
        if (!current()) return;
        if (!endpoint) throw new Error("QR code expired. Try again, or use a pairing code and manual address if your network blocks mDNS.");
        this.qr = undefined;
        this.status = "Device found. Pairing…";
        this.publish();
        await pairAndroidWireless(this.adb, endpoint, credentials.secret, signal);
        if (!current()) return;
        await this.paired();
      } else {
        const endpoint = typeof message.endpoint === "string" ? message.endpoint.trim() : "";
        const invalid = validateAndroidWirelessEndpoint(endpoint);
        if (invalid) throw new Error(invalid);
        if (message.type === "pair") {
          const code = typeof message.code === "string" ? message.code.trim() : "";
          if (!/^\d{6}$/.test(code)) throw new Error("Enter the six-digit code shown in ‘Pair device with pairing code’.");
          await pairAndroidWireless(this.adb, endpoint, code, signal);
          if (!current()) return;
          await this.paired();
        } else {
          await connectAndroidWireless(this.adb, endpoint, signal);
          if (!current()) return;
          this.status = `Connected to ${endpoint}. Use Select Android Deployment Target to choose it for Run and Debug.`;
          await vscode.commands.executeCommand("elide.androidRefreshDevices");
        }
      }
    } catch (error) {
      if (current()) {
        this.error = true;
        this.status = error instanceof Error ? error.message : "Wireless pairing failed.";
      }
    } finally {
      if (this.operation === controller) {
        this.operation = undefined;
        this.qr = undefined;
        this.publish();
      }
    }
  }

  private async paired(): Promise<void> {
    this.status = "Paired successfully. ADB normally connects automatically. Refresh Devices, then select your deployment target. If it is missing, connect below using the IP address and port on the main Wireless debugging screen (not the pairing port).";
    await vscode.commands.executeCommand("elide.androidRefreshDevices");
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancel();
    for (const subscription of this.subscriptions) subscription.dispose();
    this.panel.dispose();
  }
}

export function registerAndroidWireless(
  workspace: ElideWorkspace,
  deploymentTarget: () => Readonly<AndroidDeploymentTarget> | undefined,
): vscode.Disposable {
  const panels = new Map<string, WirelessPanel>();
  let disposed = false;
  let generation = 0;
  const valid = (root: string) => !disposed && vscode.workspace.isTrusted && !!workspace.projectAt(root)?.model?.android;
  const subscriptions = [
    vscode.commands.registerCommand("elide.androidPairWireless", async (value: unknown) => {
      if (disposed || !vscode.workspace.isTrusted) return;
      const revision = ++generation;
      const target = toAndroidTarget(value);
      const projects = workspace.projects.filter((project) => project.model?.android);
      const editor = vscode.window.activeTextEditor;
      const owner = editor?.document.uri.scheme === "file" ? workspace.projectFor(editor.document.uri.fsPath) : undefined;
      let project: ElideProject | undefined = target ? workspace.projectAt(target.root)
        : preferredAndroidProject(projects, owner, deploymentTarget()?.root) ?? (projects.length === 1 ? projects[0] : undefined);
      if (!project && !target && projects.length) {
        project = (await vscode.window.showQuickPick(projects.map((project) => ({ label: project.model?.name ?? project.root, description: project.root, project })),
          { placeHolder: "Android project whose SDK will pair the device" }))?.project;
      }
      if (project) project = workspace.projectAt(project.root);
      if (disposed || revision !== generation) return;
      if (!project?.model?.android) {
        if (target || !projects.length) void vscode.window.showWarningMessage(NO_ANDROID_PROJECT);
        return;
      }
      const root = project.root;
      if (!valid(root)) return;
      const sdk = androidSdkFor(project);
      if (!sdk || !existsSync(adbExecutable(sdk))) {
        void vscode.window.showErrorMessage("Elide: Android platform-tools are missing. Install current SDK platform-tools or set elide.android.sdk.");
        return;
      }
      const adb = adbExecutable(sdk);
      const existing = panels.get(root);
      if (existing?.adb === adb) { existing.reveal(); return; }
      existing?.dispose();
      const panel = new WirelessPanel(adb, () => valid(root), () => { if (panels.get(root) === panel) panels.delete(root); });
      panels.set(root, panel);
    }),
    workspace.onDidChange(() => {
      for (const [root, panel] of panels) {
        const project = workspace.projectAt(root);
        const sdk = project ? androidSdkFor(project) : undefined;
        if (!valid(root) || !sdk || panel.adb !== adbExecutable(sdk)) { panel.dispose(); panels.delete(root); }
      }
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("elide.android.sdk")) {
        for (const panel of panels.values()) panel.dispose();
        panels.clear();
      }
    }),
  ];
  return new vscode.Disposable(() => {
    disposed = true;
    generation++;
    for (const panel of panels.values()) panel.dispose();
    panels.clear();
    for (const subscription of subscriptions) subscription.dispose();
  });
}
