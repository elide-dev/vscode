import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

test("settings are declared and read in matching scopes, so a folder's own values apply without VS Code warnings", () => {
  // The extension's own manifest, read as the shape VS Code validates it against.
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    contributes: { configuration: { properties: Record<string, { scope?: string }> } };
  };
  const scopes = Object.fromEntries(Object.entries(manifest.contributes.configuration.properties).map(([key, value]) => [key.replace(/^elide\./, ""), value.scope ?? "window"]));
  const source = new URL("../src/config.ts", import.meta.url).pathname;
  const result = spawnSync(process.execPath, ["--eval", `
    import assert from "node:assert/strict";
    import { mock } from "bun:test";
    const scopes = ${JSON.stringify(scopes)};
    const folder = { uri: { fsPath: "/work/app" }, name: "app", index: 0 };
    const reads = [];
    // Values the user set, by key without the elide. prefix.
    const values = {};
    mock.module("vscode", () => ({
      workspace: {
        getConfiguration: (section, scope) => ({
          get: (key, fallback) => {
            reads.push({ key, resource: scope === undefined ? "none" : scope === null ? "null" : "folder" });
            return values[key] ?? fallback;
          },
          inspect: (key) => {
            reads.push({ key, resource: scope === undefined ? "none" : scope === null ? "null" : "folder" });
            return { key, globalValue: values[key] };
          },
        }),
      },
    }));
    // Load only after the child process has installed its VS Code module boundary.
    const { readConfig, configuredInvocation, importsWorkspaceJson, WINDOW_SETTINGS } = await import(${JSON.stringify(source)});
    for (const [key, scope] of Object.entries(scopes)) {
      assert.equal(scope === "window", WINDOW_SETTINGS.includes(key), key + " is declared " + scope);
      assert.ok(["window", "resource", "machine-overridable"].includes(scope), key + " has a scope readConfig handles");
    }
    for (const scope of [folder, undefined]) {
      reads.length = 0;
      const config = readConfig(scope);
      assert.deepEqual([...new Set(reads.map((read) => read.key))].sort(), Object.keys(scopes).sort(), "every declared setting is read");
      for (const read of reads) {
        const expected = scopes[read.key] === "window" ? "none" : scope ? "folder" : "null";
        assert.equal(read.resource, expected, read.key);
      }
      assert.deepEqual(configuredInvocation(config, "install"), { options: { slim: true, with: ["sources"] } });
      assert.deepEqual(configuredInvocation(config, "build"), {});
    }
    // A folder on Komodo writes no workspace.json and debugs with Komodo's adapter unless another is chosen.
    assert.equal(importsWorkspaceJson(readConfig(folder)), true);
    assert.equal(readConfig(folder).debugAdapter, "intellij");
    values["kotlinLsp.server"] = "komodo";
    assert.equal(importsWorkspaceJson(readConfig(folder)), false);
    assert.equal(readConfig(folder).debugAdapter, "komodo", "a Komodo folder debugs with Komodo's adapter by default");
    values["debug.adapter"] = "intellij";
    assert.equal(readConfig(folder).debugAdapter, "intellij", "an explicit adapter stays");
    values["debug.adapter"] = "java";
    assert.equal(readConfig(folder).debugAdapter, "java");
    values["kotlinLsp.server"] = "jetbrains";
    values["debug.adapter"] = "komodo";
    assert.equal(readConfig(folder).debugAdapter, "komodo", "Komodo's adapter can be chosen explicitly");
  `], { encoding: "utf8", timeout: 10_000 });
  expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
});
