/** The configured Elide home does not contain a CLI binary. */
export class InvalidElideHomeError extends Error {
  constructor(readonly home: string) {
    super(`Not an Elide distribution: ${home} (missing bin/elide)`);
    this.name = "InvalidElideHomeError";
  }
}

/** No Elide distribution could be located. */
export class ElideNotFoundError extends Error {
  constructor(readonly candidates: readonly string[]) {
    super(`Elide CLI not found. Looked in: ${candidates.join(", ")}`);
    this.name = "ElideNotFoundError";
  }
}

/** The Elide CLI exited with a non-zero status. */
export class ElideCommandFailedError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(`elide ${args.join(" ")} failed (exit ${exitCode ?? "signal"})${stderr ? `:\n${stderr}` : ""}`);
    this.name = "ElideCommandFailedError";
  }
}

/** `elide manifest` printed something the decoder does not understand. */
export class ManifestParseError extends Error {
  constructor(message: string, override readonly cause?: unknown) {
    super(`Failed to parse Elide project manifest: ${message}`);
    this.name = "ManifestParseError";
  }
}
