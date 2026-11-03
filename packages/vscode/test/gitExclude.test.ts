import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { addGitExclude, gitExcludeCandidate } from "../src/gitExclude.js";

test("workspace.json is offered for the clone's exclude file only while Git would list it as untracked", async () => {
  const repo = realpathSync(mkdtempSync(path.join(os.tmpdir(), "elide-git-exclude-")));
  try {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
    git("init", "-q");
    const folder = path.join(repo, "apps", "[demo]");
    mkdirSync(folder, { recursive: true });
    writeFileSync(path.join(folder, "workspace.json"), "{}");
    writeFileSync(path.join(folder, "tracked.json"), "{}");
    git("add", "apps/[demo]/tracked.json");

    expect(await gitExcludeCandidate(folder, "tracked.json")).toBeUndefined();
    const target = await gitExcludeCandidate(folder, "workspace.json");
    expect(target).toEqual({ exclude: path.join(repo, ".git", "info", "exclude"), pattern: "/apps/\\[demo]/workspace.json" });
    writeFileSync(target!.exclude, "# local\n.DS_Store");
    await addGitExclude(target!);
    await addGitExclude(target!);
    expect(readFileSync(target!.exclude, "utf8")).toBe("# local\n.DS_Store\n/apps/\\[demo]/workspace.json\n");
    expect(git("status", "--porcelain", "--untracked-files=all").toString()).not.toContain("workspace.json");
    expect(await gitExcludeCandidate(folder, "workspace.json")).toBeUndefined();
    expect(await gitExcludeCandidate(os.tmpdir(), "workspace.json")).toBeUndefined();
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
