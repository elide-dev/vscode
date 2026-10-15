/**
 * Maven version ordering, as maven-resolver's `GenericVersionScheme` orders versions: the scheme Elide uses to pick
 * the version of a library that ships when workspace members resolved it at several.
 */

const QUALIFIERS: Record<string, number> = {
  alpha: -5, beta: -4, milestone: -3, cr: -2, rc: -2, snapshot: -1, ga: 0, final: 0, release: 0, "": 0, sp: 1,
};

/** Kinds in their cross-kind order; a number outranks any string, a string any known qualifier. */
const NUMBER = 4;
const STRING = 3;
const QUALIFIER = 2;

type Item = { kind: typeof NUMBER; value: bigint } | { kind: typeof STRING; value: string } | { kind: typeof QUALIFIER; value: number };

/** Compares `item` with the padding a shorter version is extended by: `0` among numbers, `ga` among qualifiers. */
function againstPadding(item: Item): number {
  if (item.kind === NUMBER) return item.value > 0n ? 1 : 0;
  if (item.kind === STRING) return 1;
  return Math.sign(item.value);
}

function compareItems(a: Item, b: Item): number {
  if (a.kind !== b.kind) return Math.sign(a.kind - b.kind);
  if (a.kind === NUMBER) return a.value === b.value ? 0 : a.value < (b.value as bigint) ? -1 : 1;
  if (a.kind === STRING) return a.value === b.value ? 0 : a.value < (b.value as string) ? -1 : 1;
  return Math.sign(a.value - (b.value as number));
}

function parse(version: string): Item[] {
  const text = version.length > 0 ? version : "0";
  const items: Item[] = [];
  let index = 0;
  while (index < text.length) {
    // -2 nothing yet, -1 letters, 0 leading zeros, 1 significant digits.
    let state = -2;
    let start = index;
    let end = text.length;
    let terminatedByNumber = false;
    for (; index < text.length; index++) {
      const c = text[index]!;
      if (c === "." || c === "-" || c === "_") {
        end = index;
        index++;
        break;
      }
      if (c >= "0" && c <= "9") {
        if (state === -1) {
          end = index;
          terminatedByNumber = true;
          break;
        }
        if (state === 0) start++;
        state = state > 0 || c !== "0" ? 1 : 0;
      } else {
        if (state >= 0) {
          end = index;
          break;
        }
        state = -1;
      }
    }
    const token = end > start ? text.slice(start, end) : "0";
    if (end <= start || state >= 0) {
      items.push({ kind: NUMBER, value: BigInt(token) });
      continue;
    }
    const lower = token.toLowerCase();
    const abbreviated = terminatedByNumber && lower.length === 1 ? { a: "alpha", b: "beta", m: "milestone" }[lower] : undefined;
    const qualifier = QUALIFIERS[abbreviated ?? lower];
    items.push(qualifier === undefined ? { kind: STRING, value: lower } : { kind: QUALIFIER, value: qualifier });
  }
  return trimPadding(items);
}

/** Drops trailing padding-equivalent items of each run (`1.0.0` is `1`, `1-ga` is `1`). */
function trimPadding(items: Item[]): Item[] {
  let number: boolean | undefined;
  let end = items.length - 1;
  for (let i = end; i > 0; i--) {
    const item = items[i]!;
    const isNumber = item.kind === NUMBER;
    if (isNumber !== number) {
      end = i;
      number = isNumber;
    }
    if (end === i && (i === items.length - 1 || (items[i - 1]!.kind === NUMBER) === isNumber) && againstPadding(item) === 0) {
      items.splice(i, 1);
      end--;
    }
  }
  return items;
}

function comparePadding(items: readonly Item[], index: number, number: boolean | undefined): number {
  for (let i = index; i < items.length; i++) {
    const item = items[i]!;
    if (number !== undefined && number !== (item.kind === NUMBER)) break;
    const relation = againstPadding(item);
    if (relation !== 0) return relation;
  }
  return 0;
}

/** Negative, zero or positive as `a` orders before, with or after `b`. */
export function compareMavenVersions(a: string, b: string): number {
  const these = parse(a);
  const those = parse(b);
  let number = true;
  for (let index = 0; ; index++) {
    if (index >= these.length && index >= those.length) return 0;
    if (index >= these.length) return -comparePadding(those, index, undefined);
    if (index >= those.length) return comparePadding(these, index, undefined);
    const thisItem = these[index]!;
    const thatItem = those[index]!;
    const thisNumber = thisItem.kind === NUMBER;
    if (thisNumber !== (thatItem.kind === NUMBER)) {
      return number === thisNumber ? comparePadding(these, index, number) : -comparePadding(those, index, number);
    }
    const relation = compareItems(thisItem, thatItem);
    if (relation !== 0) return relation;
    number = thisNumber;
  }
}
