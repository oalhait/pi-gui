import { expect, test } from "@playwright/test";
import {
  applyComposerListKey,
  type ComposerListKey,
} from "../../src/features/conversation/composer-lists";

// `|` marks a caret; `«…»` marks a selection.
function parse(marked: string) {
  const caret = marked.indexOf("|");
  if (caret >= 0) {
    return { text: marked.replace("|", ""), selectionStart: caret, selectionEnd: caret };
  }
  const start = marked.indexOf("«");
  const end = marked.indexOf("»") - 1;
  return {
    text: marked.replace("«", "").replace("»", ""),
    selectionStart: start,
    selectionEnd: end,
  };
}

function render(state: { text: string; selectionStart: number; selectionEnd: number }): string {
  const { text, selectionStart, selectionEnd } = state;
  if (selectionStart === selectionEnd) {
    return text.slice(0, selectionStart) + "|" + text.slice(selectionStart);
  }
  return (
    text.slice(0, selectionStart) +
    "«" +
    text.slice(selectionStart, selectionEnd) +
    "»" +
    text.slice(selectionEnd)
  );
}

function press(marked: string, key: ComposerListKey): string | null {
  const next = applyComposerListKey(parse(marked), key);
  return next ? render(next) : null;
}

function pressAll(marked: string, keys: readonly ComposerListKey[]): string {
  let current = marked;
  for (const key of keys) {
    const next = press(current, key);
    if (next === null)
      throw new Error(`${key} was not a list action on ${JSON.stringify(current)}`);
    current = next;
  }
  return current;
}

test.describe("composer list editing: Enter", () => {
  test("continues bullets with the same marker", () => {
    expect(press("- one|", "Enter")).toBe("- one\n- |");
    expect(press("* one|", "Enter")).toBe("* one\n* |");
    expect(press("+ one|", "Enter")).toBe("+ one\n+ |");
  });

  test("increments ordered items and keeps the delimiter", () => {
    expect(press("1. one|", "Enter")).toBe("1. one\n2. |");
    expect(press("1) one|", "Enter")).toBe("1) one\n2) |");
    expect(press("9. nine|", "Enter")).toBe("9. nine\n10. |");
  });

  test("continues task items unchecked", () => {
    expect(press("- [ ] todo|", "Enter")).toBe("- [ ] todo\n- [ ] |");
    expect(press("- [x] done|", "Enter")).toBe("- [x] done\n- [ ] |");
    expect(press("1. [X] done|", "Enter")).toBe("1. [X] done\n2. [ ] |");
  });

  test("keeps the indentation and marker spacing", () => {
    expect(press("- a\n  - b|", "Enter")).toBe("- a\n  - b\n  - |");
    expect(press("-   wide|", "Enter")).toBe("-   wide\n-   |");
    expect(press("\t- tab|", "Enter")).toBe("\t- tab\n\t- |");
  });

  test("splits an item in the middle and renumbers the rest", () => {
    expect(press("1. ab|cd\n2. next", "Enter")).toBe("1. ab\n2. |cd\n3. next");
    expect(press("- hello| world", "Enter")).toBe("- hello\n- |world");
  });

  test("at the content start inserts an empty item above", () => {
    expect(press("1. |one\n2. two", "Enter")).toBe("1. \n2. |one\n3. two");
    expect(press("|- one", "Enter")).toBe("- \n- |one");
  });

  test("replaces a selection inside an item", () => {
    expect(press("- a«bc»d", "Enter")).toBe("- a\n- |d");
  });

  test("exits the list from an empty top-level item, separating the next paragraph", () => {
    expect(press("- one\n- |", "Enter")).toBe("- one\n\n|");
    expect(press("1. one\n2. |", "Enter")).toBe("1. one\n\n|");
    expect(press("- [ ] one\n- [ ] |", "Enter")).toBe("- [ ] one\n\n|");
    expect(press("- one\n-|", "Enter")).toBe("- one\n\n|");
    expect(press("- |", "Enter")).toBe("|");
  });

  test("outdents an empty nested item before exiting", () => {
    expect(press("- a\n  - |", "Enter")).toBe("- a\n- |");
    expect(press("1. a\n   1. b\n   2. |", "Enter")).toBe("1. a\n   1. b\n2. |");
    expect(press("1. a\n   - [ ] b\n   - [ ] |\n2. c", "Enter")).toBe(
      "1. a\n   - [ ] b\n2. |\n3. c",
    );
    expect(pressAll("- a\n    - |", ["Enter", "Enter"])).toBe("- a\n\n|");
  });

  test("an empty item exit leaves a later run's numbers alone", () => {
    expect(press("1. a\n2. |\n3. c", "Enter")).toBe("1. a\n|\n3. c");
  });

  test("is not a list action outside a list", () => {
    expect(press("plain text|", "Enter")).toBeNull();
    expect(press("|", "Enter")).toBeNull();
    expect(press("- one\n\nafter|", "Enter")).toBeNull();
    expect(press("-not a list|", "Enter")).toBeNull();
    expect(press("1.not a list|", "Enter")).toBeNull();
    expect(press("«- one\nplain»", "Enter")).toBeNull();
  });

  test("a selection starting outside a list is not a list action", () => {
    expect(press("pl«ain\n- o»ne", "Enter")).toBeNull();
  });

  test("handles emoji and wide characters by UTF-16 offsets", () => {
    expect(press("- 👍🏽 日本|語", "Enter")).toBe("- 👍🏽 日本\n- |語");
    expect(press("1. 🎉|\n2. 👩‍👩‍👧", "Enter")).toBe("1. 🎉\n2. |\n3. 👩‍👩‍👧");
  });

  test("never produces carriage returns and leaves CRLF text alone", () => {
    const next = applyComposerListKey(parse("- a\n- b|"), "Enter");
    expect(next?.text.includes("\r")).toBe(false);
    expect(applyComposerListKey(parse("- a\r\n- b|"), "Enter")).toBeNull();
  });
});

test.describe("composer list editing: Tab and Shift+Tab", () => {
  test("nests a bullet under its previous sibling's content", () => {
    expect(press("- a\n- b|", "Tab")).toBe("- a\n  - b|");
    expect(press("- a\n- |", "Tab")).toBe("- a\n  - |");
    expect(press("- a\n- b|", "ShiftTab")).toBeNull();
  });

  test("nests an ordered item by its marker width and restarts numbering", () => {
    expect(press("1. a\n2. b|", "Tab")).toBe("1. a\n   1. b|");
    expect(press("1. a\n2. b|\n3. c", "Tab")).toBe("1. a\n   1. b|\n2. c");
    expect(press("9. a\n10. b|", "Tab")).toBe("9. a\n   1. b|");
  });

  test("joins an existing nested run and renumbers per level", () => {
    expect(press("1. a\n   1. b\n2. c|\n3. d", "Tab")).toBe("1. a\n   1. b\n   2. c|\n2. d");
  });

  test("outdents to the parent level and renumbers", () => {
    expect(press("1. a\n   1. b\n   2. c|\n2. d", "ShiftTab")).toBe("1. a\n   1. b\n2. c|\n3. d");
    expect(press("- a\n  - b|", "ShiftTab")).toBe("- a\n- b|");
  });

  test("moves the caret with the item, including inside the indentation", () => {
    expect(press("- a\n- b|c", "Tab")).toBe("- a\n  - b|c");
    expect(press("- a\n|- b", "Tab")).toBe("- a\n|  - b");
  });

  test("indents every item in a multi-line selection by one level", () => {
    expect(press("- a\n- «b\n- c»", "Tab")).toBe("- a\n  - «b\n  - c»");
    expect(press("- a\n  - «b\n  - c»", "ShiftTab")).toBe("- a\n- «b\n- c»");
    expect(press("1. a\n2. «b\n3. c»", "Tab")).toBe("1. a\n   1. «b\n   2. c»");
  });

  test("a selection ending at a line start excludes that line", () => {
    expect(press("- a\n«- b\n»- c", "Tab")).toBe("- a\n«  - b\n»- c");
  });

  test("leaves non-list lines in a mixed selection alone", () => {
    expect(press("- a\n«- b\nplain»", "Tab")).toBe("- a\n«  - b\nplain»");
  });

  test("is not a list action outside a list", () => {
    expect(press("plain|", "Tab")).toBeNull();
    expect(press("plain|", "ShiftTab")).toBeNull();
    expect(press("«one\ntwo»", "Tab")).toBeNull();
  });
});

test.describe("composer list editing: Backspace", () => {
  test("removes the marker but keeps the indentation", () => {
    expect(press("- a\n  - |b", "Backspace")).toBe("- a\n  |b");
    expect(press("- |", "Backspace")).toBe("|");
    expect(press("1. a\n2. |b", "Backspace")).toBe("1. a\n|b");
    expect(press("- [ ] |task", "Backspace")).toBe("|task");
  });

  test("a second Backspace outdents the former item", () => {
    expect(pressAll("- a\n  - |b", ["Backspace", "Backspace"])).toBe("- a\n|b");
    expect(press("- a\n  |b", "Backspace")).toBe("- a\n|b");
  });

  test("renumbers a nested run after a removed marker", () => {
    expect(press("1. a\n   1. |b\n   2. c", "Backspace")).toBe("1. a\n   |b\n   1. c");
  });

  test("keeps the default elsewhere", () => {
    expect(press("- a|b", "Backspace")).toBeNull();
    expect(press("- «ab»", "Backspace")).toBeNull();
    expect(press("plain|", "Backspace")).toBeNull();
    expect(press("    |code", "Backspace")).toBeNull();
    expect(press("text\n  |indented", "Backspace")).toBeNull();
  });
});

test.describe("composer list editing: typing a nested list", () => {
  test("builds a mixed nested list from keystrokes", () => {
    const type = (marked: string, typed: string) => marked.replace("|", `${typed}|`);
    let current = pressAll("1. first|", ["Enter", "Tab"]);
    expect(current).toBe("1. first\n   1. |");
    current = pressAll(current, ["Backspace"]);
    expect(current).toBe("1. first\n   |");
    current = pressAll(type(current, "- [ ] sub"), ["Enter"]);
    expect(current).toBe("1. first\n   - [ ] sub\n   - [ ] |");
    current = pressAll(current, ["Enter"]);
    expect(current).toBe("1. first\n   - [ ] sub\n2. |");
    current = pressAll(type(current, "second"), ["Enter", "Enter"]);
    expect(current).toBe("1. first\n   - [ ] sub\n2. second\n\n|");
    expect(press(type(current, "after"), "Enter")).toBeNull();
  });
});
