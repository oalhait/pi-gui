import type { TranscriptMessage } from "../../contracts/desktop-state";

/** Body for a finished run without reply text, and when reply previews are turned off. */
export const GENERIC_COMPLETION_BODY = "Agent finished responding";

const REPLY_PREVIEW_LENGTH = 160;
const FAILURE_ERROR_LENGTH = 110;
const FAILURE_REPLY_LENGTH = 120;

const THREAD_REFERENCES_BLOCK = /<thread-references>[\s\S]*?<\/thread-references>/g;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)(?:\s+#+\s*)?$/;
const SETEXT_UNDERLINE = /^\s{0,3}(=+|-+)\s*$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const LIST_ITEM = /^\s*(?:[-*+]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/;
const BLOCKQUOTE = /^\s{0,3}>\s?/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const ENDS_SENTENCE = /[.!?:;…]["')\]]?$/u;

/**
 * Plain-text start of a Markdown reply for a notification body: formatting, fenced code,
 * images and the hidden thread-references block removed, links reduced to their text,
 * list items marked "•", whitespace collapsed, and cut at a word with "…".
 * Undefined when nothing readable remains.
 */
export function notificationPreviewText(
  markdown: string,
  maxLength = REPLY_PREVIEW_LENGTH,
): string | undefined {
  const plain = markdownToPlainText(markdown);
  return plain ? truncateAtWord(plain, maxLength) : undefined;
}

/**
 * Text of the final assistant reply of the run that just ended. It looks back from the end of
 * the transcript and stops at the run's prompt (the last user message) or, when known, at
 * rows older than the run's start, so an earlier turn's reply is never reused. Thinking,
 * tool and activity rows are not reply text.
 */
export function finalRunReplyText(
  transcript: readonly TranscriptMessage[],
  runStartedAt?: string,
): string | undefined {
  const startedAtMs = runStartedAt ? Date.parse(runStartedAt) : Number.NaN;
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const item = transcript[index];
    if (!item) continue;
    if (Number.isFinite(startedAtMs) && Date.parse(item.createdAt) < startedAtMs) return undefined;
    if (item.kind !== "message") continue;
    if (item.role === "user") return undefined;
    if (item.role === "assistant" && markdownToPlainText(item.text)) return item.text;
  }
  return undefined;
}

export function completionNotificationBody(replyText: string | undefined): string {
  return (replyText && notificationPreviewText(replyText)) || GENERIC_COMPLETION_BODY;
}

/** "Timed out: …" or "Failed: …", followed on a new line by the start of any partial reply. */
export function failureNotificationBody(
  errorMessage: string,
  replyText: string | undefined,
): string {
  const error = readableErrorMessage(errorMessage);
  const timedOut = /\btime[ds]?[\s-]?out\b|\btimeout\b|ETIMEDOUT/i.test(error);
  const label = timedOut ? "Timed out" : "Failed";
  const errorText = truncateAtWord(error, FAILURE_ERROR_LENGTH);
  const headline = !errorText
    ? label
    : timedOut && /^(timed out|timeout)\b/i.test(errorText)
      ? capitalize(errorText)
      : `${label}: ${errorText}`;
  const reply = replyText ? notificationPreviewText(replyText, FAILURE_REPLY_LENGTH) : undefined;
  return reply ? `${headline}\n${reply}` : headline;
}

function readableErrorMessage(message: string): string {
  // Provider errors often arrive as `400 {"type":"error","error":{"message":"…"}}`.
  const nested = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(message)?.[1];
  const text = nested ? unescapeJsonString(nested) : message;
  return collapseWhitespace(text.replace(/^(?:Error|\w*Error):\s*/, ""));
}

function unescapeJsonString(value: string): string {
  try {
    return JSON.parse(`"${value}"`) as string;
  } catch {
    return value;
  }
}

export function markdownToPlainText(markdown: string): string {
  const lines = markdown.replace(THREAD_REFERENCES_BLOCK, "").replace(/\r\n?/g, "\n").split("\n");
  const blocks: string[] = [];
  let paragraph: string[] = [];
  let fence: string | undefined;

  const flush = () => {
    const text = collapseWhitespace(paragraph.join(" "));
    paragraph = [];
    if (text) blocks.push(text);
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const fenceMarker = FENCE.exec(line)?.[1];
    if (fence) {
      if (fenceMarker && fenceMarker[0] === fence[0] && fenceMarker.length >= fence.length) {
        fence = undefined;
      }
      continue;
    }
    if (fenceMarker) {
      flush();
      fence = fenceMarker;
      continue;
    }

    let content = line.replace(BLOCKQUOTE, "");
    while (BLOCKQUOTE.test(content)) content = content.replace(BLOCKQUOTE, "");
    if (!content.trim()) {
      flush();
      continue;
    }

    const heading = HEADING.exec(content);
    const next = lines[index + 1] ?? "";
    const setext = paragraph.length === 0 && content.trim() && SETEXT_UNDERLINE.test(next);
    if (heading || setext) {
      flush();
      const text = collapseWhitespace(inlineToPlainText(heading ? (heading[1] ?? "") : content));
      if (text) blocks.push(ENDS_SENTENCE.test(text) ? text : `${text}:`);
      if (setext) index += 1;
      continue;
    }
    if (RULE.test(content) || (TABLE_SEPARATOR.test(content) && content.includes("-"))) {
      flush();
      continue;
    }

    const listItem = LIST_ITEM.exec(content);
    if (listItem) {
      flush();
      paragraph.push(`• ${inlineToPlainText(listItem[1] ?? "")}`);
      continue;
    }

    const tableRow = content.trim().startsWith("|")
      ? content
          .trim()
          .replace(/^\||\|$/g, "")
          .split("|")
          .map((cell) => cell.trim())
          .filter(Boolean)
          .join(", ")
      : content;
    paragraph.push(inlineToPlainText(tableRow));
  }
  flush();

  return collapseWhitespace(
    blocks
      .map((block) => (block === "•" ? "" : block))
      .filter(Boolean)
      .join(" "),
  );
}

/** Inline Markdown to text; code spans keep their content verbatim. */
function inlineToPlainText(text: string): string {
  let result = "";
  let last = 0;
  for (const match of text.matchAll(/(`+)([\s\S]*?[^`])\1(?!`)/g)) {
    result += stripInlineFormatting(text.slice(last, match.index));
    result += (match[2] ?? "").trim();
    last = match.index + match[0].length;
  }
  return result + stripInlineFormatting(text.slice(last));
}

function stripInlineFormatting(text: string): string {
  return (
    text
      // Images first, so their alt text doesn't survive as a link.
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/!\[[^\]]*\]\[[^\]]*\]/g, "")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
      .replace(/<((?:https?|mailto):[^>\s]+)>/g, "$1")
      .replace(/<\/?[a-zA-Z][\w-]*(?:\s[^<>]*)?\/?>/g, " ")
      .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")
      .replace(/(^|[^\w*])\*(?=\S)([^*]*?\S)\*(?![\w*])/g, "$1$2")
      .replace(/(^|[^\w])_(?=\S)([^_]*?\S)_(?!\w)/g, "$1$2")
      .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1")
      .replace(/\\([\\`*_{}[\]()#+\-.!>~|])/g, "$1")
  );
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Cut at a word boundary at or before `maxLength` characters, never inside a grapheme. */
export function truncateAtWord(text: string, maxLength: number): string {
  const graphemes = Array.from(
    new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text),
    (part) => part.segment,
  );
  if (graphemes.length <= maxLength) return text;

  const limit = maxLength - 1;
  let cut = limit;
  // Prefer the last space within the limit unless that drops more than a third of the preview.
  for (let index = limit; index >= Math.floor(limit * 0.66); index -= 1) {
    if (/\s/.test(graphemes[index] ?? "")) {
      cut = index;
      break;
    }
  }
  const head = graphemes
    .slice(0, cut)
    .join("")
    .replace(/[\s,;:.\-–—•]+$/u, "");
  return `${head}…`;
}
