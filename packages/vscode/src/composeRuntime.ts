import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream } from "node:stream/web";
import * as yauzl from "yauzl";

export interface ComposeRuntime {
  rendererJar: string;
  layoutlibPath: string;
  rendererClassPath: string[];
}

// These versions match the released screenshot-test-gradle-plugin:0.0.1-alpha16,
// including its embedded layoutlib dependency (not an Android SDK layoutlib).
const RENDERER_VERSION = "0.0.1-alpha16";
const LAYOUTLIB_VERSION = "16.1.0-jdk17";
const MAVEN = "https://dl.google.com/dl/android/maven2";
const RECIPE = "1";

interface Artifact {
  url: string;
  sha256: string;
  file: string;
}

const RENDERER: Artifact = {
  url: `${MAVEN}/com/android/tools/compose/compose-preview-renderer/${RENDERER_VERSION}/compose-preview-renderer-${RENDERER_VERSION}.jar`,
  sha256: "9c5913a07f35b27fc31d543d4d91c92f4ecc9526fca071a514c80f37e102eeef",
  file: "compose-preview-renderer.jar",
};

function layoutlibArtifact(name: string, sha256: string, file: string, classifier = ""): Artifact {
  return {
    url: `${MAVEN}/com/android/tools/layoutlib/${name}/${LAYOUTLIB_VERSION}/${name}-${LAYOUTLIB_VERSION}${classifier}.jar`,
    sha256,
    file,
  };
}

const RESOURCES = layoutlibArtifact("layoutlib-resources", "2f7beb5e9f441b9f32c12df0a34121155163dfd047804b116262eaad33928388", "layoutlib-resources.jar");
const API = layoutlibArtifact("layoutlib", "cc2f6e01c9d5904b0896a3d66d8b1b169ea8163d762d1ddd3c51548c72ca6182", "layoutlib.jar");

// SHA-256 values are published in layoutlib-runtime-16.1.0-jdk17.module;
// renderer, API and resources hashes were also established from downloaded jars.
const PLATFORMS: Record<string, { classifier: string; sha256: string; nativeLibrary: string }> = {
  "darwin-arm64": {
    classifier: "mac-arm", sha256: "94d226071f0407a1f23e55dcd7e8b0c4cc8cfc10cccdf3f1366b401ee0c694e0",
    nativeLibrary: "data/mac-arm/lib64/layoutlib_jni.dylib",
  },
  "darwin-x64": {
    classifier: "mac", sha256: "92fe9aedf7a3684e24f604b94b4adf3453d8fe7bfeeb06ef46010f44f71a76be",
    nativeLibrary: "data/mac/lib64/layoutlib_jni.dylib",
  },
  "linux-x64": {
    classifier: "linux", sha256: "72b3730d2a8c20b302fcbe4abb4654388bdb4168cf26c86bab8b83065826ab1b",
    nativeLibrary: "data/linux/lib64/layoutlib_jni.so",
  },
  "win32-x64": {
    classifier: "win", sha256: "300d50af7b65befe5e82dfae73652487fc560000da0659410468d5e293f2187f",
    nativeLibrary: "data/win/lib64/layoutlib_jni.dll",
  },
};

function runtimeAt(directory: string): ComposeRuntime {
  const rendererJar = path.join(directory, RENDERER.file);
  return {
    rendererJar,
    layoutlibPath: path.join(directory, "layoutlib"),
    rendererClassPath: [rendererJar, path.join(directory, API.file)],
  };
}

function runtimeInstallation(cacheRoot: string) {
  const host = `${process.platform}-${process.arch}`;
  const platform = PLATFORMS[host];
  if (!platform) {
    throw new Error(`Compose host rendering does not support ${host}. Use VS Code on macOS arm64/x64, Linux x64, or Windows x64 (including a supported remote extension host).`);
  }
  const key = `compose-${RENDERER_VERSION}-layoutlib-${LAYOUTLIB_VERSION}-${host}-r${RECIPE}`;
  const root = path.join(cacheRoot, "compose-runtime");
  const destination = path.join(root, key);
  const marker = JSON.stringify({ recipe: RECIPE, renderer: RENDERER.sha256, layoutlib: API.sha256, resources: RESOURCES.sha256, runtime: platform.sha256 });
  const required = [RENDERER.file, API.file, RESOURCES.file, "layoutlib-runtime.jar", "layoutlib/build.prop", "layoutlib/data/framework_res.jar", `layoutlib/${platform.nativeLibrary}`];
  const isReady = async (): Promise<boolean> => {
    try {
      if (await readFile(path.join(destination, "ready.json"), "utf8") !== marker) return false;
      const files = await Promise.all(required.map((file) => stat(path.join(destination, file))));
      return files.every((file) => file.isFile() && file.size > 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  };
  return { platform, key, root, destination, marker, required, isReady };
}

/** The verified runtime when it is already cached; never downloads. */
export async function installedComposeRuntime(cacheRoot: string): Promise<ComposeRuntime | undefined> {
  if (!PLATFORMS[`${process.platform}-${process.arch}`]) return undefined;
  const installation = runtimeInstallation(cacheRoot);
  return await installation.isReady() ? runtimeAt(installation.destination) : undefined;
}

/** Installs into private staging directories, publishing only a complete, immutable runtime.
 * Competing extension hosts can provision independently: one atomic rename wins and the
 * others reuse that installation. Cancellation never invalidates another host's cache.
 */
export async function ensureComposeRuntime(
  cacheRoot: string, signal: AbortSignal, onProgress: (text: string) => void,
): Promise<ComposeRuntime> {
  signal.throwIfAborted();
  const { platform, key, root, destination, marker, required, isReady } = runtimeInstallation(cacheRoot);
  if (await isReady()) {
    signal.throwIfAborted();
    return runtimeAt(destination);
  }
  await mkdir(root, { recursive: true });
  signal.throwIfAborted();
  const staging = await mkdtemp(path.join(root, `${key}.install-`));
  try {
    const archive = layoutlibArtifact("layoutlib-runtime", platform.sha256, "layoutlib-runtime.jar", `-${platform.classifier}`);
    const artifacts = [RENDERER, API, RESOURCES, archive];
    for (const [index, artifact] of artifacts.entries()) {
      signal.throwIfAborted();
      const label = `Downloading ${artifact.file} (${index + 1} of ${artifacts.length}) for host Compose rendering…`;
      onProgress(label);
      await download(artifact, staging, signal, (received, total) => {
        const mib = (bytes: number) => (bytes / 1_048_576).toFixed(1);
        onProgress(`${label} ${mib(received)}${total ? ` of ${mib(total)} MiB (${Math.floor((received / total) * 100)}%)` : " MiB"}`);
      });
    }
    signal.throwIfAborted();
    onProgress("Extracting the host layoutlib runtime…");
    const layoutlib = path.join(staging, "layoutlib");
    await mkdir(layoutlib);
    // Preserve licenses/, META-INF and all other upstream entries. Original jars
    // (including the renderer's Apache LICENSE/NOTICE) remain in the cache too.
    await extractZip(path.join(staging, archive.file), layoutlib, signal);
    await copyFile(path.join(staging, RESOURCES.file), path.join(layoutlib, "data", "framework_res.jar"));
    for (const file of required) {
      signal.throwIfAborted();
      const info = await stat(path.join(staging, file));
      if (!info.isFile() || info.size === 0) throw new Error(`Incomplete Compose runtime: ${file}`);
    }
    signal.throwIfAborted();
    await writeFile(path.join(staging, "ready.json"), marker, { flag: "wx", signal });
    signal.throwIfAborted();
    try {
      await rename(staging, destination);
    } catch (error) {
      // Another process may have published the exact same verified runtime.
      if (!await isReady()) {
        throw new Error(`Cannot publish the Compose runtime at ${destination}. Remove that cache directory if it is incomplete, then retry.`, { cause: error });
      }
    }
    signal.throwIfAborted();
    return runtimeAt(destination);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** `onBytes` hears how much has arrived, at most every quarter second, against the advertised size if any. */
async function download(artifact: Artifact, directory: string, signal: AbortSignal, onBytes: (received: number, total: number | undefined) => void): Promise<void> {
  const response = await fetch(artifact.url, { signal });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(`Cannot download Compose runtime (${response.status} ${response.statusText}): ${artifact.url}. Check access to dl.google.com.`);
  }
  const partial = path.join(directory, `${artifact.file}.part`);
  const hash = createHash("sha256");
  const total = Number(response.headers.get("content-length")) || undefined;
  let received = 0;
  let reportedAt = 0;
  const digest = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      received += chunk.length;
      if (Date.now() - reportedAt >= 250) {
        reportedAt = Date.now();
        onBytes(received, total);
      }
      callback(null, chunk);
    },
  });
  await pipeline(
    Readable.fromWeb(response.body as ReadableStream<Uint8Array>), digest,
    createWriteStream(partial, { flags: "wx" }), { signal },
  );
  signal.throwIfAborted();
  if (hash.digest("hex") !== artifact.sha256) {
    throw new Error(`SHA-256 verification failed for ${artifact.url}. The downloaded Compose runtime was not installed.`);
  }
  await rename(partial, path.join(directory, artifact.file));
}

async function extractZip(archive: string, destination: string, signal: AbortSignal): Promise<void> {
  const opened = Promise.withResolvers<yauzl.ZipFile>();
  yauzl.open(archive, { lazyEntries: true, autoClose: false, strictFileNames: true }, (error, file) => {
    if (error) opened.reject(error);
    else if (file) opened.resolve(file);
    else opened.reject(new Error(`Cannot open layoutlib archive: ${archive}`));
  });
  const zip = await opened.promise;
  try {
    while (true) {
      signal.throwIfAborted();
      const entry = await nextEntry(zip, signal);
      if (!entry) break;
      const file = path.resolve(destination, entry.fileName);
      const relative = path.relative(destination, file);
      if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`Unsafe layoutlib archive entry: ${entry.fileName}`);
      }
      const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
      const kind = mode & 0o170000;
      if (kind !== 0 && kind !== 0o100000 && kind !== 0o040000) {
        throw new Error(`Unsupported layoutlib archive entry: ${entry.fileName}`);
      }
      if (entry.fileName.endsWith("/")) {
        await mkdir(file, { recursive: true });
        continue;
      }
      await mkdir(path.dirname(file), { recursive: true });
      const openedStream = Promise.withResolvers<Readable>();
      zip.openReadStream(entry, (error, stream) => {
        if (error) openedStream.reject(error);
        else if (stream) openedStream.resolve(stream);
        else openedStream.reject(new Error(`Cannot read layoutlib archive entry: ${entry.fileName}`));
      });
      const input = await openedStream.promise;
      await pipeline(input, createWriteStream(file, { flags: "wx", mode: (mode & 0o777) || 0o644 }), { signal });
    }
  } finally {
    zip.close();
  }
}

function nextEntry(zip: yauzl.ZipFile, signal: AbortSignal): Promise<yauzl.Entry | undefined> {
  const { promise, resolve, reject } = Promise.withResolvers<yauzl.Entry | undefined>();
  const cleanup = () => {
    zip.off("entry", onEntry);
    zip.off("end", onEnd);
    zip.off("error", onError);
    signal.removeEventListener("abort", onAbort);
  };
  const onEntry = (entry: yauzl.Entry) => { cleanup(); resolve(entry); };
  const onEnd = () => { cleanup(); resolve(undefined); };
  const onError = (error: Error) => { cleanup(); reject(error); };
  const onAbort = () => { cleanup(); reject(signal.reason); };
  zip.once("entry", onEntry);
  zip.once("end", onEnd);
  zip.once("error", onError);
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  else zip.readEntry();
  return promise;
}
