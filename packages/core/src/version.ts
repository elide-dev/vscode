/** A parsed Elide release: `elide --version` prints `<major>.<minor>.<patch>[+<suffix>]`. */
export interface ElideVersion {
  major: number;
  minor: number;
  patch: number;
}

/** Oldest Elide release this integration is known to work against. */
export const MIN_ELIDE_VERSION: ElideVersion = { major: 1, minor: 5, patch: 0 };

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)/;

/** Parse the leading `<major>.<minor>.<patch>` of a version display string; `undefined` when it has none. */
export function parseElideVersion(display: string): ElideVersion | undefined {
  const m = VERSION_PATTERN.exec(display.trim());
  if (!m) return undefined;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/** Compare two versions component-wise: negative when `a` is older, positive when newer, `0` when equal. */
export function compareElideVersions(a: ElideVersion, b: ElideVersion): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/**
 * Whether a version display string names a release at least as new as {@link MIN_ELIDE_VERSION}.
 *
 * An unparsable string is treated as supported: a format this code does not know is not a reason to refuse to work
 * with the distribution the user pointed at.
 */
export function isSupportedElideVersion(display: string): boolean {
  const version = parseElideVersion(display);
  return version === undefined || compareElideVersions(version, MIN_ELIDE_VERSION) >= 0;
}
