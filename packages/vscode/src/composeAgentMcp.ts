import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import type { AgentAction, AgentActionType, AgentPreviewItem, ComposeAgentPreviews } from "./composeAgent.js";
import type { PreviewConfiguration } from "./composeAgentSource.js";
import { readConfig } from "./config.js";
import { McpHttpServer, type McpTool } from "./mcpServer.js";
import type { ElideUi } from "./output.js";

const PROVIDER_ID = "elide.composePreview";
const LABEL = "Elide Compose Preview";
const TOKEN_KEY = "elide.composePreviewMcp.token";
const PORT_KEY = "elide.composePreviewMcp.port";
export const MCP_URL_VARIABLE = "ELIDE_COMPOSE_PREVIEW_MCP_URL";
export const MCP_TOKEN_VARIABLE = "ELIDE_COMPOSE_PREVIEW_MCP_TOKEN";

const INSTRUCTIONS = `Renders Jetpack Compose UI of this VS Code workspace's Elide Android projects and returns PNG images plus each
card's layout tree (composable calls with pixel bounds and source call sites).
- Name composables by code reference: package.Function, Function, or path/to/File.kt#Function (path relative to the
  workspace folder; add :line to pick an overload). The composable does not need @Preview: a wrapper calling it is
  generated for the preview only and never saved. Required parameters without defaults get placeholders where the type
  allows (strings, numbers, lambdas, Modifier, collections, nullable types); pass others, or better values, as Kotlin
  expressions in "arguments" (they compile in the composable's own file, so its imports and private declarations apply).
- Use compose_preview_list to find composables and their parameters.
- live: true keeps an interactive session (komodo engine): compose_preview_interact taps, drags, scrolls and types into
  a card and returns its new frame; compose_preview_refresh renders again after you edit the source; close the session
  with compose_preview_close when done (it pauses the user's own preview panel while open).
- Coordinates are image pixels of the returned PNG; actions may instead target a layout node id (n3) of the last report.`;

const configurationSchema = {
  type: "object",
  description: "@Preview configuration; unset fields use the renderer's defaults (showBackground defaults to true).",
  properties: {
    widthDp: { type: "integer", minimum: 1, maximum: 4096 },
    heightDp: { type: "integer", minimum: 1, maximum: 8192 },
    showBackground: { type: "boolean" },
    backgroundColor: { type: "string", description: "ARGB as 0xAARRGGBB, or #RRGGBB / #AARRGGBB." },
    darkTheme: { type: "boolean", description: "Night mode (uiMode UI_MODE_NIGHT_YES)." },
    fontScale: { type: "number", exclusiveMinimum: 0, maximum: 4 },
    locale: { type: "string", description: "A locale qualifier, such as fr or en-rGB." },
    device: { type: "string", description: "A @Preview device, such as id:pixel_5 or spec:width=411dp,height=891dp." },
    showSystemUi: { type: "boolean" },
    apiLevel: { type: "integer", minimum: 21, maximum: 100 },
  },
  additionalProperties: false,
} as const;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optional<T>(args: Record<string, unknown>, name: string, type: "string" | "boolean" | "number"): T | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== type) throw new Error(`${name} must be a ${type}.`);
  return value as T;
}

function required(args: Record<string, unknown>, name: string): string {
  const value = optional<string>(args, name, "string");
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function configuration(value: unknown, where: string): PreviewConfiguration | undefined {
  if (value === undefined || value === null) return undefined;
  if (!object(value)) throw new Error(`${where} must be an object.`);
  const known = new Set(Object.keys(configurationSchema.properties));
  const unknown = Object.keys(value).filter((key) => !known.has(key));
  if (unknown.length) throw new Error(`${where} has unknown fields: ${unknown.join(", ")}.`);
  const integer = (name: string, minimum: number, maximum: number) => {
    const field = optional<number>(value, name, "number");
    if (field !== undefined && (!Number.isInteger(field) || field < minimum || field > maximum)) throw new Error(`${where}.${name} must be an integer from ${minimum} to ${maximum}.`);
    return field;
  };
  const background = optional<string>(value, "backgroundColor", "string");
  let backgroundColor: number | undefined;
  if (background !== undefined) {
    const hex = /^(?:0x|#)?([0-9a-f]{6}|[0-9a-f]{8})$/i.exec(background)?.[1];
    if (!hex) throw new Error(`${where}.backgroundColor must be 0xAARRGGBB, #RRGGBB or #AARRGGBB.`);
    backgroundColor = Number.parseInt(hex.length === 6 ? `ff${hex}` : hex, 16);
  }
  const fontScale = optional<number>(value, "fontScale", "number");
  if (fontScale !== undefined && !(fontScale > 0 && fontScale <= 4)) throw new Error(`${where}.fontScale must be above 0 and at most 4.`);
  return {
    widthDp: integer("widthDp", 1, 4096), heightDp: integer("heightDp", 1, 8192),
    showBackground: optional(value, "showBackground", "boolean"), backgroundColor,
    darkTheme: optional(value, "darkTheme", "boolean"), fontScale,
    locale: optional(value, "locale", "string"), device: optional(value, "device", "string"),
    showSystemUi: optional(value, "showSystemUi", "boolean"), apiLevel: integer("apiLevel", 21, 100),
  };
}

function items(value: unknown): AgentPreviewItem[] {
  if (!Array.isArray(value) || !value.length || value.length > 12) throw new Error("composables must list 1 to 12 composables.");
  return value.map((item, index) => {
    if (typeof item === "string") return { reference: item };
    if (!object(item)) throw new Error(`composables[${index}] must be an object with a reference.`);
    const reference = required(item, "reference");
    const given = item.arguments;
    if (given !== undefined && (!object(given) || !Object.values(given).every((argument) => typeof argument === "string"))) {
      throw new Error(`composables[${index}].arguments maps parameter names to Kotlin expressions (strings).`);
    }
    return { reference, arguments: given as Record<string, string> | undefined, preview: configuration(item.preview, `composables[${index}].preview`) };
  });
}

const ACTIONS: readonly AgentActionType[] = ["tap", "longPress", "drag", "scroll", "type", "key", "wait"];

function actions(value: unknown): AgentAction[] {
  if (!Array.isArray(value) || !value.length || value.length > 100) throw new Error("actions must list 1 to 100 actions.");
  return value.map((action, index) => {
    if (!object(action) || typeof action.type !== "string" || !ACTIONS.some((type) => type === action.type)) {
      throw new Error(`actions[${index}].type must be one of ${ACTIONS.join(", ")}.`);
    }
    const number = (name: string) => optional<number>(action, name, "number");
    const durationMs = number("durationMs");
    if (durationMs !== undefined && !(durationMs >= 0 && durationMs <= 60_000)) throw new Error(`actions[${index}].durationMs must be from 0 to 60000.`);
    return {
      type: action.type as AgentActionType, x: number("x"), y: number("y"), node: optional(action, "node", "string"),
      toX: number("toX"), toY: number("toY"), toNode: optional(action, "toNode", "string"), dx: number("dx"), dy: number("dy"),
      text: optional(action, "text", "string"), key: optional(action, "key", "string"), shift: optional(action, "shift", "boolean"),
      ctrl: optional(action, "ctrl", "boolean"), alt: optional(action, "alt", "boolean"), meta: optional(action, "meta", "boolean"),
      durationMs,
    };
  });
}

/** The Compose preview tools, over the agent service. */
export function composePreviewTools(previews: ComposeAgentPreviews): McpTool[] {
  const sessionSchema = { type: "string", description: "A live session id from compose_preview_render (s1)." };
  return [
    {
      name: "compose_preview_render",
      title: "Render Compose previews",
      description: "Render one or more composables of this workspace (named by code reference; @Preview not required) and return "
        + "each card's PNG and layout tree. With live: true the session stays open for compose_preview_interact/refresh.",
      inputSchema: {
        type: "object",
        properties: {
          composables: {
            type: "array", minItems: 1, maxItems: 12,
            items: {
              type: "object",
              properties: {
                reference: { type: "string", description: "package.Function, Function, or path/to/File.kt#Function[:line]." },
                arguments: { type: "object", additionalProperties: { type: "string" },
                  description: "Kotlin expressions by parameter name, e.g. {\"title\": \"\\\"Hello\\\"\", \"count\": \"3\"}; they compile in the composable's file." },
                preview: configurationSchema,
              },
              required: ["reference"],
              additionalProperties: false,
            },
          },
          preview: { ...configurationSchema, description: "Configuration for every composable; each composable's own preview overrides it." },
          theme: { type: "string", description: "A theme composable to call each composable in (last parameter a @Composable content lambda), e.g. com.example.ui.AppTheme or androidx.compose.material3.MaterialTheme." },
          live: { type: "boolean", description: "Keep an interactive session open (komodo engine; layoutlib sessions only refresh)." },
          rebuild: { type: "boolean", description: "Run the Elide build of the preview inputs first: after resource changes, or edits the preview's own compile does not include." },
          layout: { type: "boolean", description: "Include each card's layout tree (default true)." },
        },
        required: ["composables"],
        additionalProperties: false,
      },
      annotations: { title: "Render Compose previews", readOnlyHint: true, openWorldHint: false },
      call: async (args, context) => {
        const theme = optional<string>(args, "theme", "string");
        return { content: await previews.render({
          composables: items(args.composables), preview: configuration(args.preview, "preview"), theme,
          live: optional(args, "live", "boolean"), rebuild: optional(args, "rebuild", "boolean"), layout: optional(args, "layout", "boolean"),
        }, context.signal, context.progress) };
      },
    },
    {
      name: "compose_preview_interact",
      title: "Interact with a live Compose preview",
      description: "Send taps, long presses, drags, scrolls and keyboard input to a live card, then return its settled frame and layout.",
      inputSchema: {
        type: "object",
        properties: {
          session: sessionSchema,
          card: { type: "string", description: "A card id of the session (c1)." },
          actions: {
            type: "array", minItems: 1, maxItems: 100,
            items: {
              type: "object",
              properties: {
                type: { type: "string", enum: ACTIONS },
                x: { type: "number", description: "Image pixels (tap, longPress, drag start, scroll)." },
                y: { type: "number" },
                node: { type: "string", description: "Instead of x/y: the center of a layout node of the card's last report (n3)." },
                toX: { type: "number", description: "Drag end." },
                toY: { type: "number" },
                toNode: { type: "string" },
                dx: { type: "number", description: "Scroll amount, pixels." },
                dy: { type: "number" },
                text: { type: "string", description: "type: characters to type into the focused field (tap it first)." },
                key: { type: "string", description: "key: one character, or Enter, Tab, Backspace, Delete, Escape, ArrowLeft/Right/Up/Down, Home, End, PageUp, PageDown, Insert, F1-F12." },
                shift: { type: "boolean" },
                ctrl: { type: "boolean" },
                alt: { type: "boolean" },
                meta: { type: "boolean" },
                durationMs: { type: "number", minimum: 0, maximum: 60000, description: "longPress hold, drag duration, or wait." },
              },
              required: ["type"],
              additionalProperties: false,
            },
          },
          settleMs: { type: "integer", minimum: 0, maximum: 30000, description: "Longest wait for frames to settle after the actions (default 3000)." },
        },
        required: ["session", "card", "actions"],
        additionalProperties: false,
      },
      annotations: { title: "Interact with a live Compose preview", readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      call: async (args, context) => {
        const settle = optional<number>(args, "settleMs", "number");
        if (settle !== undefined && !(Number.isInteger(settle) && settle >= 0 && settle <= 30_000)) throw new Error("settleMs must be an integer from 0 to 30000.");
        return { content: await previews.interact(required(args, "session"), required(args, "card"), actions(args.actions), settle, context.signal) };
      },
    },
    {
      name: "compose_preview_refresh",
      title: "Refresh a Compose preview session",
      description: "Render a session's composables again from the current source (after you edited it) and return every card.",
      inputSchema: { type: "object", properties: { session: sessionSchema }, required: ["session"], additionalProperties: false },
      annotations: { title: "Refresh a Compose preview session", readOnlyHint: true, openWorldHint: false },
      call: async (args, context) => ({ content: await previews.refresh(required(args, "session"), context.signal, context.progress) }),
    },
    {
      name: "compose_preview_close",
      title: "Close a Compose preview session",
      description: "Close a live session (the user's preview panel resumes).",
      inputSchema: { type: "object", properties: { session: sessionSchema }, required: ["session"], additionalProperties: false },
      annotations: { title: "Close a Compose preview session", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      call: async (args) => ({ content: [{ type: "text", text: previews.closeSession(required(args, "session")) }] }),
    },
    {
      name: "compose_preview_list",
      title: "List composables",
      description: "List top-level @Composable functions (with their references, parameters and whether they have @Preview) of a file or the workspace.",
      inputSchema: {
        type: "object",
        properties: {
          file: { type: "string", description: "A Kotlin file, relative to the workspace folder or absolute." },
          query: { type: "string", description: "Substring of the function or package name." },
        },
        additionalProperties: false,
      },
      annotations: { title: "List composables", readOnlyHint: true, openWorldHint: false },
      call: async (args) => ({ content: [{ type: "text", text: await previews.list(optional(args, "file", "string"), optional(args, "query", "string")) }] }),
    },
  ];
}

/** The running server's address and token; consumed by the extension-host integration test, as an external agent connects. */
export interface ElideComposePreviewMcpApi {
  endpoint(): Promise<{ url: string; token: string } | undefined>;
}

/**
 * Serves the Compose preview tools over MCP for this window: a loopback Streamable HTTP server with a per-workspace bearer token,
 * offered to VS Code's agents by an MCP server definition provider, to agents in the integrated terminal by environment variables,
 * and to any other client by the Copy MCP Server Configuration command. Port and token stay the same across reloads when they can.
 */
export function registerComposePreviewMcp(context: vscode.ExtensionContext, previews: ComposeAgentPreviews, ui: ElideUi, version: string):
  { disposable: vscode.Disposable; api: ElideComposePreviewMcpApi } {
  const changed = new vscode.EventEmitter<void>();
  let server: McpHttpServer | undefined;
  let token: string | undefined;
  let starting: Promise<void> = Promise.resolve();
  let disposed = false;
  const enabled = () => readConfig().composePreviewMcp;

  const stop = async () => {
    const running = server;
    server = undefined;
    context.environmentVariableCollection.delete(MCP_URL_VARIABLE);
    context.environmentVariableCollection.delete(MCP_TOKEN_VARIABLE);
    changed.fire();
    await running?.close();
  };
  const start = async () => {
    if (disposed || server || !enabled()) return;
    const key = `${TOKEN_KEY}:${context.storageUri?.toString() ?? ""}`;
    token = await context.secrets.get(key);
    if (!token) {
      token = randomBytes(32).toString("hex");
      await context.secrets.store(key, token);
    }
    const started = await McpHttpServer.start({
      name: "elide-compose-preview", version, instructions: INSTRUCTIONS, tools: composePreviewTools(previews), token,
      port: context.workspaceState.get<number>(PORT_KEY) ?? 0, log: (line) => ui.log(`Compose preview MCP: ${line}`),
    });
    if (disposed || !enabled()) {
      await started.close();
      return;
    }
    server = started;
    await context.workspaceState.update(PORT_KEY, started.port);
    context.environmentVariableCollection.description = "Lets agents in this terminal reach the Elide Compose preview MCP server.";
    context.environmentVariableCollection.replace(MCP_URL_VARIABLE, started.url);
    context.environmentVariableCollection.replace(MCP_TOKEN_VARIABLE, token);
    ui.log(`Compose preview MCP server at ${started.url}`);
    changed.fire();
  };
  const reconcile = () => {
    starting = starting.then(() => enabled() ? start() : stop()).catch((error: unknown) => {
      ui.log(`Compose preview MCP server failed to start: ${error instanceof Error ? error.message : String(error)}`);
    });
  };

  const subscriptions: vscode.Disposable[] = [
    changed,
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("elide.android.composePreview.mcp")) reconcile();
    }),
    vscode.commands.registerCommand("elide.composePreviewMcp.copyConfiguration", async () => {
      await starting;
      if (!server || !token) {
        void vscode.window.showWarningMessage("Elide: the Compose preview MCP server is off (elide.android.composePreview.mcp.enabled).");
        return;
      }
      const configuration = { mcpServers: { "elide-compose-preview": { type: "http", url: server.url, headers: { Authorization: `Bearer ${token}` } } } };
      await vscode.env.clipboard.writeText(JSON.stringify(configuration, null, 2));
      void vscode.window.showInformationMessage(`Elide: copied the Compose preview MCP server configuration (${server.url}). It holds this workspace's access token.`);
    }),
    vscode.commands.registerCommand("elide.composePreviewMcp.closeSessions", () => {
      const closed = previews.closeAll();
      void vscode.window.showInformationMessage(`Elide: closed ${closed} agent Compose preview session${closed === 1 ? "" : "s"}.`);
    }),
  ];
  // Editors without VS Code's MCP API (older builds, some forks) still serve the URL to terminals and the copied configuration.
  if (typeof vscode.lm?.registerMcpServerDefinitionProvider === "function") {
    subscriptions.push(vscode.lm.registerMcpServerDefinitionProvider(PROVIDER_ID, {
      onDidChangeMcpServerDefinitions: changed.event,
      provideMcpServerDefinitions: async () => {
        await starting;
        return server && token ? [new vscode.McpHttpServerDefinition(LABEL, vscode.Uri.parse(server.url), { Authorization: `Bearer ${token}` }, version)] : [];
      },
      resolveMcpServerDefinition: async (definition) => {
        await starting;
        if (!server) throw new Error("The Elide Compose preview MCP server is off (elide.android.composePreview.mcp.enabled).");
        return definition;
      },
    }));
  }
  reconcile();
  const disposable = new vscode.Disposable(() => {
    disposed = true;
    for (const subscription of subscriptions) subscription.dispose();
    void stop();
  });
  return { disposable, api: { endpoint: async () => {
    await starting;
    return server && token ? { url: server.url, token } : undefined;
  } } };
}
