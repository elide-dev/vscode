#!/usr/bin/env node
// Release-time only: bazel run //tools/bazel/bun -- "$PWD/tools/build-database-inspector.ts"
// Node alternative (Node 22.6+): node --experimental-strip-types tools/build-database-inspector.ts
// Pin ANDROID_DATABASE_PLATFORM (e.g. android-35) and ANDROID_DATABASE_BUILD_TOOLS
// (e.g. 35.0.0) for reproducible builds with the same JDK and Android toolchain.
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'packages', 'vscode', 'media', 'database');
const source = join(output, 'DatabaseInspector.java');

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function sdkDirectory(): Promise<string> {
  const configured = process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME;
  if (configured) {
    const sdk = resolve(configured);
    if (!await exists(sdk)) throw new Error(`Android SDK does not exist: ${sdk}`);
    return sdk;
  }
  const candidates = [
    join(homedir(), 'Library', 'Android', 'sdk'),
    join(homedir(), 'Android', 'Sdk'),
    ...(process.env.LOCALAPPDATA ? [join(process.env.LOCALAPPDATA, 'Android', 'Sdk')] : []),
  ];
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  throw new Error('Android SDK not found. Set ANDROID_SDK_ROOT or ANDROID_HOME to an installed SDK.');
}

function compareVersions(a: string, b: string): number {
  const left = a.replace(/^android-/, '').split('.').map(Number);
  const right = b.replace(/^android-/, '').split('.').map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (right[index] ?? 0) - (left[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return a.localeCompare(b, 'en');
}

async function sdkComponent(directory: string, pin: string | undefined,
  pattern: RegExp, requiredFile: string, label: string): Promise<string> {
  if (pin) {
    if (!pattern.test(pin)) throw new Error(`Invalid ${label} version: ${pin}`);
    const component = join(directory, pin);
    if (!await exists(join(component, requiredFile))) {
      throw new Error(`Requested ${label} is not installed: ${component}`);
    }
    return component;
  }
  if (!await exists(directory)) throw new Error(`No ${label} installed under ${directory}`);
  const names = (await readdir(directory)).filter(name => pattern.test(name)).sort(compareVersions);
  for (const name of names) {
    const component = join(directory, name);
    if (await exists(join(component, requiredFile))) return component;
  }
  throw new Error(`No usable ${label} installed under ${directory}`);
}

function javaTool(name: string): string {
  const executable = process.platform === 'win32' ? `${name}.exe` : name;
  return process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin', executable) : executable;
}

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: false });
  if (result.error) {
    throw new Error(`Could not launch ${command}: ${result.error.message}. Install a JDK and set JAVA_HOME if necessary.`);
  }
  if (result.status !== 0) {
    throw new Error(`${command} failed (${result.signal ?? `exit ${result.status}`}).`);
  }
}

async function classFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await classFiles(path));
    else if (entry.isFile() && entry.name.endsWith('.class')) files.push(path);
  }
  return files.sort();
}

async function main(): Promise<void> {
  const sdk = await sdkDirectory();
  const platform = await sdkComponent(join(sdk, 'platforms'), process.env.ANDROID_DATABASE_PLATFORM,
    /^android-(?:2[89]|[3-9]\d|[1-9]\d{2,})(?:\.\d+)?$/, 'android.jar', 'Android platform (API 28 or newer)');
  const buildTools = await sdkComponent(join(sdk, 'build-tools'), process.env.ANDROID_DATABASE_BUILD_TOOLS,
    /^\d+\.\d+\.\d+$/, join('lib', 'd8.jar'), 'Android build-tools with d8');
  const androidJar = join(platform, 'android.jar');
  const temporary = await mkdtemp(join(tmpdir(), 'elide-database-inspector-'));
  try {
    const classes = join(temporary, 'classes');
    const dex = join(temporary, 'dex');
    await mkdir(classes);
    await mkdir(dex);
    console.log(`Compiling database inspector with ${platform}, ${buildTools}`);
    run(javaTool('javac'), [
      '-encoding', 'UTF-8', '-source', '8', '-target', '8', '-g:none',
      '-bootclasspath', androidJar, '-d', classes, source,
    ]);
    // Invoke the SDK's d8 entry point directly, avoiding platform-specific shell wrappers.
    run(javaTool('java'), [
      '-cp', join(buildTools, 'lib', 'd8.jar'), 'com.android.tools.r8.D8',
      '--release', '--min-api', '26', '--lib', androidJar, '--output', dex,
      ...await classFiles(classes),
    ]);
    const dexFiles = (await readdir(dex)).filter(name => name.endsWith('.dex'));
    if (dexFiles.length !== 1 || dexFiles[0] !== 'classes.dex') {
      throw new Error('Expected exactly one classes.dex from d8; refusing an incomplete helper.');
    }
    await copyFile(join(dex, 'classes.dex'), join(output, 'inspector.dex'));
    console.log(`Wrote ${join(output, 'inspector.dex')} (minimum Android API 26).`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
