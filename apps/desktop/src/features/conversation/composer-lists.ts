/**
 * Markdown list editing for the composer: plain text and a selection in, plain text and a
 * selection out. Bullets (`-`, `*`, `+`), ordered items (`1.`, `1)`) and task items
 * (`- [ ] `) continue on Enter, nest with Tab and renumber per level. `null` means the key
 * is not a list action and should keep its default behaviour.
 */

export interface ComposerTextState {
  readonly text: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
}

export type ComposerListKey = "Enter" | "Tab" | "ShiftTab" | "Backspace";

interface ListItem {
  /** Leading whitespace. */
  readonly indent: string;
  /** `-`, `*` or `+` for bullets; undefined for ordered items. */
  readonly bullet?: string;
  readonly number?: number;
  /** `.` or `)` for ordered items. */
  readonly delimiter?: string;
  /** Spaces between the marker and the content (or task box). */
  readonly spacing: string;
  /** `[ ]`, `[x]` or `[X]` when this is a task item. */
  readonly task?: string;
  /** Characters from the line start to the content start. */
  readonly contentStart: number;
  readonly content: string;
}

interface Position {
  line: number;
  col: number;
}

const LIST_ITEM_PATTERN = /^([ \t]*)(?:([-*+])|(\d{1,9})([.)]))( +|$)(?:(\[[ xX]\])( +|$))?/;

function parseListItem(line: string): ListItem | null {
  const match = LIST_ITEM_PATTERN.exec(line);
  if (!match) return null;
  const [whole, indent = "", bullet, digits, delimiter, spacing = "", task] = match;
  return {
    indent,
    ...(bullet ? { bullet } : { number: Number(digits), delimiter }),
    // An item typed as `-` at the end of a line still gets a space when continued.
    spacing: spacing || " ",
    ...(task ? { task } : {}),
    contentStart: whole.length,
    content: line.slice(whole.length),
  };
}

/** The marker a new item after `item` gets: the same bullet, the next number, an open task. */
function continuationMarker(item: ListItem): string {
  return markerText(item, {
    ...(item.number !== undefined ? { number: item.number + 1 } : {}),
    ...(item.task ? { task: "[ ]" } : {}),
  });
}

function markerText(item: ListItem, overrides: { number?: number; task?: string } = {}): string {
  const marker = item.bullet ?? `${overrides.number ?? item.number}${item.delimiter}`;
  const task = overrides.task ?? item.task;
  return `${marker}${item.spacing}${task ? `${task} ` : ""}`;
}

/** Width of the marker and its spacing, excluding any task box: the child indent unit. */
function markerWidth(item: ListItem): number {
  return (item.bullet ?? `${item.number}${item.delimiter}`).length + item.spacing.length;
}

function toPosition(lines: readonly string[], offset: number): Position {
  let remaining = offset;
  for (let line = 0; line < lines.length; line += 1) {
    const length = lines[line]!.length;
    if (remaining <= length) return { line, col: remaining };
    remaining -= length + 1;
  }
  const last = lines.length - 1;
  return { line: last, col: lines[last]!.length };
}

function toOffset(lines: readonly string[], position: Position): number {
  let offset = 0;
  for (let line = 0; line < position.line; line += 1) offset += lines[line]!.length + 1;
  return offset + position.col;
}

function finish(
  lines: string[],
  start: Position,
  end: Position,
  renumberFrom: readonly number[],
): ComposerTextState {
  for (const line of renumberFrom) renumberList(lines, line, [start, end]);
  return {
    text: lines.join("\n"),
    selectionStart: toOffset(lines, start),
    selectionEnd: toOffset(lines, end),
  };
}

/** Replaces a line's indentation, shifting positions on that line that sit after it. */
function setIndent(
  lines: string[],
  line: number,
  oldIndentLength: number,
  newIndent: string,
  positions: Position[],
): void {
  lines[line] = newIndent + lines[line]!.slice(oldIndentLength);
  const delta = newIndent.length - oldIndentLength;
  for (const position of positions) {
    if (position.line !== line) continue;
    // A caret at the very line start (a selection's edge) stays there.
    position.col =
      position.col > 0 && position.col >= oldIndentLength
        ? position.col + delta
        : Math.min(position.col, newIndent.length);
  }
}

function isBlank(line: string): boolean {
  return line.trim().length === 0;
}

/** Lines that keep a list together: list items and indented continuation text. */
function belongsToList(line: string): boolean {
  return parseListItem(line) !== null || (!isBlank(line) && /^[ \t]/.test(line));
}

/**
 * Renumbers the ordered items of the list containing `line`, per nesting level. A top-level
 * run keeps its first number (a list can start at 3); nested runs start at 1.
 */
function renumberList(lines: string[], line: number, positions: Position[]): void {
  if (line < 0 || line >= lines.length || !belongsToList(lines[line]!)) return;
  let first = line;
  while (first > 0 && belongsToList(lines[first - 1]!)) first -= 1;

  const levels: { indent: number; nested: boolean; next?: number }[] = [];
  for (let index = first; index < lines.length && belongsToList(lines[index]!); index += 1) {
    const item = parseListItem(lines[index]!);
    if (!item) continue;
    const indent = item.indent.length;
    while (levels.length > 0 && levels[levels.length - 1]!.indent > indent) levels.pop();
    let level = levels[levels.length - 1];
    if (!level || level.indent < indent) {
      level = { indent, nested: levels.length > 0 };
      levels.push(level);
    }
    if (item.number === undefined) {
      delete level.next;
      continue;
    }
    const number = level.next ?? (level.nested ? 1 : item.number);
    level.next = number + 1;
    if (number === item.number) continue;

    const oldMarker = `${item.number}`;
    const newMarker = `${number}`;
    const markerStart = item.indent.length;
    lines[index] =
      lines[index]!.slice(0, markerStart) +
      newMarker +
      lines[index]!.slice(markerStart + oldMarker.length);
    const delta = newMarker.length - oldMarker.length;
    for (const position of positions) {
      if (position.line === index && position.col > markerStart) {
        position.col = Math.max(markerStart, position.col + delta);
      }
    }
  }
}

/** Lines covered by the selection; a selection ending at a line start excludes that line. */
function selectedLines(start: Position, end: Position): number[] {
  const last = end.line > start.line && end.col === 0 ? end.line - 1 : end.line;
  const result: number[] = [];
  for (let line = start.line; line <= last; line += 1) result.push(line);
  return result;
}

function indentTarget(lines: readonly string[], line: number, item: ListItem): string {
  const indent = item.indent.length;
  for (let index = line - 1; index >= 0 && belongsToList(lines[index]!); index -= 1) {
    const previous = parseListItem(lines[index]!);
    if (!previous) continue;
    if (previous.indent.length === indent) {
      return previous.indent + " ".repeat(markerWidth(previous));
    }
    if (previous.indent.length < indent) break;
  }
  return item.indent + " ".repeat(markerWidth(item));
}

function parentItem(lines: readonly string[], line: number, indent: string): ListItem | null {
  for (let index = line - 1; index >= 0 && belongsToList(lines[index]!); index -= 1) {
    const previous = parseListItem(lines[index]!);
    if (previous && previous.indent.length < indent.length) return previous;
  }
  return null;
}

/** Indent of the parent item, or null when the item is already at the top level. */
function outdentTarget(lines: readonly string[], line: number, indent: string): string | null {
  if (indent.length === 0) return null;
  return parentItem(lines, line, indent)?.indent ?? "";
}

function shiftItems(
  lines: string[],
  targetLines: readonly number[],
  direction: "in" | "out",
  start: Position,
  end: Position,
): boolean {
  // Targets come from the original structure so a multi-line selection moves as one level.
  const original = lines.slice();
  let changed = false;
  for (const line of targetLines) {
    const item = parseListItem(original[line]!);
    if (!item) continue;
    const target =
      direction === "in"
        ? indentTarget(original, line, item)
        : outdentTarget(original, line, item.indent);
    if (target === null) continue;
    setIndent(lines, line, item.indent.length, target, [start, end]);
    changed = true;
  }
  return changed;
}

function handleTab(
  lines: string[],
  start: Position,
  end: Position,
  direction: "in" | "out",
): ComposerTextState | null {
  const targetLines = selectedLines(start, end);
  if (!targetLines.some((line) => parseListItem(lines[line]!))) return null;
  if (!shiftItems(lines, targetLines, direction, start, end)) return null;
  return finish(lines, start, end, uniqueListStarts(lines, targetLines));
}

function uniqueListStarts(lines: readonly string[], targetLines: readonly number[]): number[] {
  const candidates = [...targetLines];
  const first = targetLines[0];
  if (first !== undefined && first > 0) candidates.push(first - 1);
  const last = targetLines[targetLines.length - 1];
  if (last !== undefined && last + 1 < lines.length) candidates.push(last + 1);
  return candidates;
}

function handleEnter(lines: string[], caret: Position): ComposerTextState | null {
  const line = lines[caret.line]!;
  const item = parseListItem(line);
  if (!item) return null;

  if (isBlank(item.content)) {
    if (item.indent.length > 0) {
      // Outdent one level first, continuing the parent's list as Word does.
      const parent = parentItem(lines, caret.line, item.indent);
      const outdented = parent
        ? parent.indent + continuationMarker(parent)
        : markerText(item, item.task ? { task: "[ ]" } : {});
      lines[caret.line] = outdented;
      const placed = { line: caret.line, col: outdented.length };
      return finish(lines, placed, { ...placed }, [caret.line]);
    }
    // Leave the list: the empty item becomes an empty line. At the end of a list a blank
    // separator follows, so Markdown doesn't read the next paragraph as part of the last item.
    const previous = lines[caret.line - 1];
    const next = lines[caret.line + 1];
    const separate =
      previous !== undefined && belongsToList(previous) && (next === undefined || isBlank(next));
    lines.splice(caret.line, 1, ...(separate ? ["", ""] : [""]));
    const placed = { line: caret.line + (separate ? 1 : 0), col: 0 };
    return finish(lines, placed, { ...placed }, []);
  }

  const splitAt = Math.max(caret.col, item.contentStart);
  const before = line.slice(0, splitAt).replace(/[ \t]+$/, "");
  const after = line.slice(splitAt).replace(/^[ \t]+/, "");
  const nextMarker = continuationMarker(item);
  // Splitting at the content start leaves an empty marker on the first line, so keep it intact.
  const first = splitAt === item.contentStart ? line.slice(0, item.contentStart) : before;
  const nextLine = item.indent + nextMarker;
  lines.splice(caret.line, 1, first, nextLine + after);
  const placed = { line: caret.line + 1, col: nextLine.length };
  return finish(lines, placed, { ...placed }, [caret.line]);
}

function handleBackspace(lines: string[], caret: Position): ComposerTextState | null {
  const line = lines[caret.line]!;
  const item = parseListItem(line);
  if (item) {
    if (caret.col !== item.contentStart) return null;
    lines[caret.line] = item.indent + item.content;
    const placed = { line: caret.line, col: item.indent.length };
    return finish(lines, placed, { ...placed }, [caret.line - 1, caret.line + 1]);
  }

  // A former item (indented text right after a list item or its continuation) outdents.
  const indent = /^[ \t]*/.exec(line)![0];
  if (indent.length === 0 || caret.col !== indent.length || isBlank(line)) return null;
  if (caret.line === 0 || !belongsToList(lines[caret.line - 1]!)) return null;
  const target = outdentTarget(lines, caret.line, indent);
  if (target === null) return null;
  const placed = { ...caret };
  setIndent(lines, caret.line, indent.length, target, [placed]);
  return finish(lines, placed, { ...placed }, []);
}

export function applyComposerListKey(
  state: ComposerTextState,
  key: ComposerListKey,
): ComposerTextState | null {
  const text = state.text.replace(/\r\n?/g, "\n");
  if (text !== state.text) return null;
  const selectionStart = Math.min(state.selectionStart, state.selectionEnd);
  const selectionEnd = Math.max(state.selectionStart, state.selectionEnd);
  const lines = text.split("\n");
  const start = toPosition(lines, selectionStart);
  const end = toPosition(lines, selectionEnd);

  if (key === "Tab" || key === "ShiftTab") {
    return handleTab(lines, start, end, key === "Tab" ? "in" : "out");
  }

  if (key === "Backspace") {
    if (selectionStart !== selectionEnd) return null;
    return handleBackspace(lines, start);
  }

  // Enter replaces a selection first, like typing does.
  if (selectionStart === selectionEnd) return handleEnter(lines, start);
  if (!parseListItem(lines[start.line]!)) return null;
  const collapsed = text.slice(0, selectionStart) + text.slice(selectionEnd);
  const collapsedLines = collapsed.split("\n");
  return handleEnter(collapsedLines, toPosition(collapsedLines, selectionStart));
}
