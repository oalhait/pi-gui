import type { KeyboardEvent } from "react";
import {
  applyComposerListKey,
  type ComposerListKey,
  type ComposerTextState,
} from "./composer-lists";

function listKeyFor(event: KeyboardEvent<HTMLTextAreaElement>): ComposerListKey | null {
  if (event.nativeEvent.isComposing || event.keyCode === 229) return null;
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  if (event.key === "Tab") return event.shiftKey ? "ShiftTab" : "Tab";
  if (event.shiftKey) return null;
  if (event.key === "Enter") return "Enter";
  if (event.key === "Backspace") return "Backspace";
  return null;
}

/**
 * Replaces only the changed span through the browser's editing commands, so the edit is one
 * native undo step and React sees an ordinary input event.
 */
function applyTextareaEdit(textarea: HTMLTextAreaElement, next: ComposerTextState): void {
  const current = textarea.value;
  let prefix = 0;
  const maxPrefix = Math.min(current.length, next.text.length);
  while (prefix < maxPrefix && current[prefix] === next.text[prefix]) prefix += 1;
  let suffix = 0;
  const maxSuffix = maxPrefix - prefix;
  while (
    suffix < maxSuffix &&
    current[current.length - 1 - suffix] === next.text[next.text.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const replacement = next.text.slice(prefix, next.text.length - suffix);
  textarea.setSelectionRange(prefix, current.length - suffix);
  const applied =
    replacement.length > 0
      ? document.execCommand("insertText", false, replacement)
      : prefix === current.length - suffix || document.execCommand("delete");
  if (!applied || textarea.value !== next.text) {
    textarea.setRangeText(replacement, prefix, current.length - suffix);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }
  textarea.setSelectionRange(next.selectionStart, next.selectionEnd);
}

/**
 * Handles list continuation, nesting and marker removal. Returns true when the key was a
 * list action, so the caller must not also treat it as send or focus navigation.
 */
export function handleComposerListKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
  const key = listKeyFor(event);
  if (!key) return false;
  const textarea = event.currentTarget;
  const next = applyComposerListKey(
    {
      text: textarea.value,
      selectionStart: textarea.selectionStart,
      selectionEnd: textarea.selectionEnd,
    },
    key,
  );
  if (!next) return false;
  event.preventDefault();
  applyTextareaEdit(textarea, next);
  return true;
}
