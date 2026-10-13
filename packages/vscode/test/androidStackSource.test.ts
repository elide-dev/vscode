import { describe, expect, test } from "bun:test";
import { AndroidStackSourceIndex, parseAndroidStackFrame } from "../src/androidStackSource.js";

function frame(text = "at app.Main.onCreate(Main.kt:2)") {
  const parsed = parseAndroidStackFrame(text);
  if (!parsed) throw new Error(`Invalid test frame: ${text}`);
  return parsed;
}

function fixture(files: Map<string, string>, inventory = () => [...files.keys()]) {
  let scans = 0;
  let reads = 0;
  const index = new AndroidStackSourceIndex(async () => { scans++; return inventory(); }, async (file) => {
    reads++;
    const content = files.get(file);
    if (content === undefined) throw new Error(`Missing fixture source: ${file}`);
    return content;
  });
  return { index, scans: () => scans, reads: () => reads };
}

describe("Android stack frame parsing", () => {
  test("handles logcat prefixes, nested classes and UTF-16 link ranges", () => {
    const text = "10-13 12:00:00.123 100 200 E AndroidRuntime: 🐛\tat app.Main$Listener$1.invoke(Main.kt:12)";
    const parsed = frame(text);
    expect(parsed.packageName).toBe("app");
    expect(parsed.className).toBe("app.Main$Listener$1");
    expect(parsed.line).toBe(12);
    expect(text.slice(parsed.start, parsed.end)).toBe("Main.kt:12");
  });

  test("supports Kotlin facades, default packages and Java module prefixes", () => {
    expect(frame("at app.HelpersKt.work(Helpers.kt:1)").fileName).toBe("Helpers.kt");
    expect(frame("at Main.main(Main.java:1)").packageName).toBe("");
    expect(frame("at app.module@1.0/app.Main.main(Main.java:1)").packageName).toBe("app");
  });

  test("rejects unknown/native frames, paths, invalid lines and non-frame prose", () => {
    for (const text of [
      "at app.Main.run(Unknown Source)", "at app.Main.run(Native Method)",
      "at app.Main.run(Main.kt)", "at app.Main.run(Main.kt:0)",
      "at app.Main.run(Main.kt:-1)", "at app.Main.run(Main.kt:9007199254740992)",
      "at app.Main.run(../Main.kt:1)", "at app.Main.run(C:\\Main.java:1)",
      "at app.Main.run(command:evil.kt:1)", "look at Main.kt:2", "format app.Main.run(Main.kt:2)",
    ]) expect(parseAndroidStackFrame(text)).toBeUndefined();
  });
});

describe("Android stack source resolution", () => {
  test("resolves real package declarations across module roots, not directory guesses", async () => {
    const { index } = fixture(new Map([
      ["/workspace/app/src/unusual/Main.kt", "package app\nclass Main"],
      ["/workspace/library/src/Main.kt", "package library\nclass Main"],
      ["/workspace/library/src/Helpers.kt", "package library\nfun helper() = Unit"],
      ["/workspace/java/src/Peer.java", "package peer;\nclass Peer {}"],
    ]));
    expect(await index.resolve(frame("at app.Main$Listener.run(Main.kt:2)")))
      .toEqual({ file: "/workspace/app/src/unusual/Main.kt", line: 1 });
    expect(await index.resolve(frame("at library.HelpersKt$helper$1.invoke(Helpers.kt:2)")))
      .toEqual({ file: "/workspace/library/src/Helpers.kt", line: 1 });
    expect(await index.resolve(frame("at peer.Peer$Inner.run(Peer.java:1)")))
      .toEqual({ file: "/workspace/java/src/Peer.java", line: 0 });
    expect(await index.resolve(frame("at other.Main.run(Main.kt:2)"))).toBeUndefined();
  });

  test("never chooses a duplicate package/file by order, project preference or line count", async () => {
    const { index } = fixture(new Map([
      ["/workspace/app/Main.kt", "package app\nclass Main\nfun work() {}"],
      ["/workspace/sibling/Main.kt", "package app"],
    ]));
    expect(await index.resolve(frame())).toBeUndefined();
    expect(await index.resolve(frame("at app.Main.work(Main.kt:3)"))).toBeUndefined();
  });

  test("deduplicates overlapping source roots and only reads matching filenames", async () => {
    const files = new Map([["/app/Main.kt", "package app\nclass Main"], ["/app/Other.kt", "package app"]]);
    const f = fixture(files, () => [...files.keys(), "/app/Main.kt"]);
    expect(f.scans()).toBe(0);
    await Promise.all([f.index.resolve(frame()), f.index.resolve(frame())]);
    expect(f.scans()).toBe(1);
    expect(f.reads()).toBe(1);
    expect(await f.index.resolve(frame())).toEqual({ file: "/app/Main.kt", line: 1 });
  });

  test("respects CRLF lines, rejects out-of-range lines and missing filenames", async () => {
    const { index } = fixture(new Map([["/app/Main.kt", "package app\r\nclass Main"]]));
    expect((await index.resolve(frame()))?.line).toBe(1);
    expect(await index.resolve(frame("at app.Main.run(Main.kt:3)"))).toBeUndefined();
    expect(await index.resolve(frame("at app.Missing.run(Missing.kt:1)"))).toBeUndefined();
  });

  test("ignores comment/literal package declarations, including Kotlin nested comments", async () => {
    const content = '/* outer\n/* nested */\npackage fake\n*/\npackage app\nval example = """\npackage fake\n"""';
    const { index } = fixture(new Map([["/app/Main.kt", content]]));
    expect((await index.resolve(frame()))?.file).toBe("/app/Main.kt");
    expect(await index.resolve(frame("at fake.Main.run(Main.kt:2)"))).toBeUndefined();
  });

  test("handles escaped Kotlin packages and files in the default package", async () => {
    const { index } = fixture(new Map([
      ["/app/Main.kt", "package app.`when`\nclass Main"],
      ["/default/Main.java", "class Main {}"],
    ]));
    expect((await index.resolve(frame("at app.when.Main.run(Main.kt:2)")))?.file).toBe("/app/Main.kt");
    expect((await index.resolve(frame("at Main.run(Main.java:1)")))?.line).toBe(0);
  });

  test("invalidates inventories and source metadata on file or project changes", async () => {
    const files = new Map([["/app/Main.kt", "package app\nclass Main"]]);
    const f = fixture(files);
    expect(await f.index.resolve(frame())).toBeDefined();
    files.set("/app/Main.kt", "package moved\nclass Main");
    f.index.invalidate();
    expect(await f.index.resolve(frame())).toBeUndefined();
    files.clear();
    f.index.invalidate();
    expect(await f.index.resolve(frame("at moved.Main.run(Main.kt:2)"))).toBeUndefined();
    expect(f.scans()).toBe(3);
    expect(f.reads()).toBe(2);
  });

  test("disposal prevents new scans and drops in-flight inventory results", async () => {
    const inventory = Promise.withResolvers<string[]>();
    let reads = 0;
    const index = new AndroidStackSourceIndex(() => inventory.promise, async () => {
      reads++;
      return "package app\nclass Main";
    });
    const pending = index.resolve(frame());
    index.dispose();
    inventory.resolve(["/app/Main.kt"]);
    expect(await pending).toBeUndefined();
    expect(await index.resolve(frame())).toBeUndefined();
    expect(reads).toBe(0);
  });

  test("project removal while reading source cannot publish a stale location", async () => {
    const reading = Promise.withResolvers<void>();
    const content = Promise.withResolvers<string>();
    const index = new AndroidStackSourceIndex(async () => ["/app/Main.kt"], () => {
      reading.resolve();
      return content.promise;
    });
    const pending = index.resolve(frame());
    await reading.promise;
    index.invalidate();
    content.resolve("package app\nclass Main");
    expect(await pending).toBeUndefined();
  });
});
