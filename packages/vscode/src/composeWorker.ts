import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

const MAX_FRAME = 64 * 1024 * 1024;

function varint(value: number): Buffer {
  const bytes: number[] = [];
  do {
    const next = value % 128;
    value = Math.floor(value / 128);
    bytes.push(next | (value ? 128 : 0));
  } while (value);
  return Buffer.from(bytes);
}

function readVarint(bytes: Buffer, offset: number): { value: number; end: number } | undefined {
  let value = 0;
  for (let index = 0; index < 10; index++) {
    const byte = bytes[offset + index];
    if (byte === undefined) return undefined;
    // Negative int32 responses use ten bytes. Only the low 32 bits are needed.
    if (index < 5) value += (byte & 127) * 2 ** (index * 7);
    if (!(byte & 128)) return { value, end: offset + index + 1 };
  }
  throw new Error("Malformed Elide worker varint.");
}

/** Bazel worker_protocol.proto: repeated arguments = 1, request_id = 3. */
export function encodeWorkRequest(args: readonly string[], requestId: number): Buffer {
  const parts: Buffer[] = [];
  for (const arg of args) {
    const text = Buffer.from(arg, "utf8");
    parts.push(Buffer.from([10]), varint(text.length), text);
  }
  parts.push(Buffer.from([24]), varint(requestId));
  const body = Buffer.concat(parts);
  if (body.length > MAX_FRAME) throw new Error("Elide compiler request exceeds 64 MiB.");
  return Buffer.concat([varint(body.length), body]);
}

export interface WorkResponse {
  exitCode: number;
  output: string;
  requestId: number;
  wasCancelled: boolean;
}

export function decodeWorkResponse(bytes: Buffer): WorkResponse {
  const response: WorkResponse = { exitCode: 0, output: "", requestId: 0, wasCancelled: false };
  let offset = 0;
  const integer = (): number => {
    const decoded = readVarint(bytes, offset);
    if (!decoded) throw new Error("Truncated Elide worker response.");
    offset = decoded.end;
    return decoded.value;
  };
  while (offset < bytes.length) {
    const tag = integer();
    const field = Math.floor(tag / 8);
    const wire = tag & 7;
    if (!field) throw new Error("Invalid Elide worker response tag.");
    if (wire === 0) {
      const value = integer();
      if (field === 1) response.exitCode = value | 0;
      else if (field === 3) response.requestId = value | 0;
      else if (field === 4) response.wasCancelled = value !== 0;
    } else if (wire === 2) {
      const length = integer();
      const end = offset + length;
      if (end > bytes.length) throw new Error("Truncated Elide worker response field.");
      if (field === 2) response.output = bytes.toString("utf8", offset, end);
      offset = end;
    } else if (wire === 1 || wire === 5) {
      offset += wire === 1 ? 8 : 4;
      if (offset > bytes.length) throw new Error("Truncated Elide worker response field.");
    } else {
      throw new Error(`Unsupported Elide worker wire type ${wire}.`);
    }
  }
  return response;
}

/** One serial request stream per tool. stdout is exclusively length-delimited protobuf. */
export class ComposeWorker {
  private readonly process: ChildProcessWithoutNullStreams;
  private buffer: Buffer = Buffer.alloc(0);
  private stderr = "";
  private nextRequest = 1;
  private failure: Error | undefined;
  private pending: { id: number; resolve: (response: WorkResponse) => void; reject: (error: Error) => void; timer: NodeJS.Timeout } | undefined;
  private readonly abort = () => this.close(new Error("Compose compilation cancelled."));

  constructor(bin: string, private readonly tool: "kotlinc" | "javac", cwd: string, private readonly signal: AbortSignal) {
    signal.throwIfAborted();
    this.process = spawn(bin, [tool, "--persistent_worker"], {
      cwd, stdio: "pipe", windowsHide: true, detached: process.platform !== "win32",
    });
    this.process.stdout.on("data", (chunk: Buffer) => this.receive(chunk));
    this.process.stderr.setEncoding("utf8");
    this.process.stderr.on("data", (text: string) => { this.stderr = (this.stderr + text).slice(-64 * 1024); });
    this.process.on("error", (error) => this.close(new Error(`Cannot start Elide ${tool} worker: ${error.message}`, { cause: error })));
    this.process.stdin.on("error", (error) => this.close(new Error(`Cannot write to Elide ${tool} worker: ${error.message}`, { cause: error })));
    this.process.on("exit", (code, reason) => this.close(new Error(
      `Elide ${tool} worker exited (${reason ?? code}). The selected Elide distribution must support persistent workers.\n${this.stderr}`,
    )));
    signal.addEventListener("abort", this.abort, { once: true });
    if (signal.aborted) this.abort();
  }

  async request(args: readonly string[]): Promise<WorkResponse> {
    if (this.failure) throw this.failure;
    if (this.pending) throw new Error("Concurrent Compose compiler requests are not supported.");
    const id = this.nextRequest++;
    const frame = encodeWorkRequest(args, id);
    return await new Promise<WorkResponse>((resolve, reject) => {
      const timer = setTimeout(() => this.close(new Error(`Elide ${this.tool} worker timed out.\n${this.stderr}`)), 120_000);
      timer.unref();
      this.pending = { id, resolve, reject, timer };
      this.process.stdin.write(frame);
    });
  }

  dispose(): void { this.close(new Error("Compose compiler disposed.")); }

  private receive(chunk: Buffer): void {
    if (this.failure) return;
    try {
      this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
      while (this.buffer.length) {
        const length = readVarint(this.buffer, 0);
        if (!length) return;
        if (length.end > 5 || length.value > MAX_FRAME) throw new Error("Invalid Elide worker frame length; stdout must contain only worker protocol messages.");
        const end = length.end + length.value;
        if (this.buffer.length < end) return;
        const response = decodeWorkResponse(this.buffer.subarray(length.end, end));
        this.buffer = this.buffer.subarray(end);
        const pending = this.pending;
        if (!pending || response.requestId !== pending.id) throw new Error(`Unexpected Elide worker response ${response.requestId}.`);
        this.pending = undefined;
        clearTimeout(pending.timer);
        if (response.wasCancelled) pending.reject(new Error("Elide cancelled Compose compilation."));
        else pending.resolve(response);
      }
    } catch (error) {
      this.close(new Error(`Elide ${this.tool} worker protocol failed: ${String(error)}\n${this.stderr}`, { cause: error }));
    }
  }

  get alive(): boolean { return this.failure === undefined; }

  private close(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    this.signal.removeEventListener("abort", this.abort);
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(error);
      this.pending = undefined;
    }
    // The configured binary can be a shell/builder wrapper. Killing just that PID leaks its JVM.
    if (this.process.pid) {
      if (process.platform === "win32") {
        const kill = spawn("taskkill", ["/pid", String(this.process.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        kill.on("error", () => { this.process.kill("SIGKILL"); });
      } else {
        try { process.kill(-this.process.pid, "SIGKILL"); }
        catch { this.process.kill("SIGKILL"); }
      }
    }
    this.process.stdin.destroy();
    this.process.stdout.destroy();
    this.process.stderr.destroy();
  }
}
