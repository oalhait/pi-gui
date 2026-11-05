import { expect, test } from "@playwright/test";
import type { TranscriptMessage } from "../../contracts/desktop-state";
import {
  completionNotificationBody,
  failureNotificationBody,
  finalRunReplyText,
  GENERIC_COMPLETION_BODY,
  notificationPreviewText,
} from "../../electron/platform/notification-preview";

test.describe("notificationPreviewText", () => {
  test("strips headings, emphasis, inline code and strikethrough", () => {
    expect(
      notificationPreviewText(
        "## Summary\n\nI **fixed** the _flaky_ test in `parser.ts` and ~~removed~~ the retry.",
      ),
    ).toBe("Summary: I fixed the flaky test in parser.ts and removed the retry.");
  });

  test("keeps underscores and asterisks inside words and code", () => {
    expect(notificationPreviewText("Renamed snake_case_name to `a*b*c` and 2*3*4 stays.")).toBe(
      "Renamed snake_case_name to a*b*c and 2*3*4 stays.",
    );
  });

  test("skips fenced code blocks entirely", () => {
    expect(
      notificationPreviewText(
        "Run this:\n\n```ts\nconst secret = 1;\n// # not a heading\n```\n\nThen restart the app.",
      ),
    ).toBe("Run this: Then restart the app.");
    expect(notificationPreviewText("~~~\nonly code\n~~~")).toBeUndefined();
  });

  test("reduces links to their text and drops images", () => {
    expect(
      notificationPreviewText(
        "See [the PR](https://github.com/x/y/pull/1) ![diagram](img.png) and <https://example.com>.",
      ),
    ).toBe("See the PR and https://example.com.");
  });

  test("marks list items and joins them into one line", () => {
    expect(
      notificationPreviewText("Done:\n- Added tests\n- [x] Fixed lint\n  across files\n1. Shipped"),
    ).toBe("Done: • Added tests • Fixed lint across files • Shipped");
  });

  test("handles blockquotes, rules, setext headings and tables", () => {
    expect(
      notificationPreviewText(
        "Result\n======\n\n> quoted line\n\n---\n\n| a | b |\n|---|---|\n| 1 | 2 |",
      ),
    ).toBe("Result: quoted line a, b 1, 2");
  });

  test("collapses whitespace and newlines", () => {
    expect(notificationPreviewText("  line one\n   line\ttwo  \n\n\n line three ")).toBe(
      "line one line two line three",
    );
  });

  test("cuts long text at a word boundary with an ellipsis", () => {
    const words = Array.from({ length: 60 }, (_, index) => `word${index}`).join(" ");
    const preview = notificationPreviewText(words) ?? "";
    expect(preview.endsWith("…")).toBe(true);
    expect(preview.length).toBeLessThanOrEqual(160);
    expect(preview.length).toBeGreaterThan(120);
    expect(words.startsWith(preview.slice(0, -1))).toBe(true);
    expect(words.charAt(preview.length - 1)).toBe(" ");
  });

  test("does not cut through an emoji", () => {
    const text = `${"a".repeat(150)}${"👩‍💻".repeat(20)}`;
    const preview = notificationPreviewText(text) ?? "";
    expect(preview.endsWith("👩‍💻…")).toBe(true);
    expect(notificationPreviewText("Shipped it 🎉 — all green ✅")).toBe(
      "Shipped it 🎉 — all green ✅",
    );
  });

  test("removes the hidden thread-references block", () => {
    expect(
      notificationPreviewText(
        "Checked @other-thread.\n\n<thread-references>\nThreads mentioned above.\n- a:b\n</thread-references>",
      ),
    ).toBe("Checked @other-thread.");
  });

  test("returns undefined when nothing readable remains", () => {
    expect(notificationPreviewText("")).toBeUndefined();
    expect(notificationPreviewText("![only image](x.png)\n\n---")).toBeUndefined();
  });
});

function message(
  role: "user" | "assistant",
  text: string,
  createdAt: string,
  id = `${role}-${createdAt}`,
): TranscriptMessage {
  return { kind: "message", id, role, text, createdAt };
}

function tool(createdAt: string): TranscriptMessage {
  return {
    kind: "tool",
    id: `tool-${createdAt}`,
    callId: `tool-${createdAt}`,
    toolName: "bash",
    status: "success",
    label: "Ran ls",
    createdAt,
  };
}

test.describe("finalRunReplyText", () => {
  test("returns the run's last assistant reply, not thinking or tool rows", () => {
    const transcript: TranscriptMessage[] = [
      message("user", "first", "2026-01-01T00:00:00.000Z"),
      message("assistant", "Earlier reply", "2026-01-01T00:00:01.000Z"),
      message("user", "second", "2026-01-01T00:01:00.000Z"),
      message("assistant", "Let me look.", "2026-01-01T00:01:01.000Z"),
      tool("2026-01-01T00:01:02.000Z"),
      message("assistant", "Final answer", "2026-01-01T00:01:03.000Z"),
      {
        kind: "thinking",
        id: "thinking",
        text: "reasoning about it",
        createdAt: "2026-01-01T00:01:04.000Z",
      },
      {
        kind: "summary",
        id: "summary",
        label: "Ran 1 command",
        presentation: "inline",
        createdAt: "2026-01-01T00:01:05.000Z",
      },
    ];
    expect(finalRunReplyText(transcript)).toBe("Final answer");
  });

  test("does not reuse an earlier turn's reply when the run produced only tool calls", () => {
    const transcript: TranscriptMessage[] = [
      message("user", "first", "2026-01-01T00:00:00.000Z"),
      message("assistant", "Earlier reply", "2026-01-01T00:00:01.000Z"),
      message("user", "second", "2026-01-01T00:01:00.000Z"),
      tool("2026-01-01T00:01:02.000Z"),
    ];
    expect(finalRunReplyText(transcript)).toBeUndefined();
    expect(completionNotificationBody(finalRunReplyText(transcript))).toBe(GENERIC_COMPLETION_BODY);
  });

  test("stops at the run start for runs without a user prompt", () => {
    const transcript: TranscriptMessage[] = [
      message("user", "first", "2026-01-01T00:00:00.000Z"),
      message("assistant", "Earlier reply", "2026-01-01T00:00:01.000Z"),
      tool("2026-01-01T00:05:01.000Z"),
    ];
    expect(finalRunReplyText(transcript, "2026-01-01T00:05:00.000Z")).toBeUndefined();
    expect(
      finalRunReplyText(
        [...transcript, message("assistant", "Follow-up", "2026-01-01T00:05:02.000Z")],
        "2026-01-01T00:05:00.000Z",
      ),
    ).toBe("Follow-up");
  });

  test("skips assistant rows with no readable text", () => {
    const transcript: TranscriptMessage[] = [
      message("user", "go", "2026-01-01T00:00:00.000Z"),
      message("assistant", "Here is the summary.", "2026-01-01T00:00:01.000Z"),
      message("assistant", "```\ncode only\n```", "2026-01-01T00:00:02.000Z"),
    ];
    expect(finalRunReplyText(transcript)).toBe("Here is the summary.");
  });
});

test.describe("failureNotificationBody", () => {
  test("labels failures and timeouts", () => {
    expect(failureNotificationBody("Connection reset by peer", undefined)).toBe(
      "Failed: Connection reset by peer",
    );
    expect(failureNotificationBody("Request exceeded the 600s timeout", undefined)).toBe(
      "Timed out: Request exceeded the 600s timeout",
    );
    expect(failureNotificationBody("timed out waiting for the provider", undefined)).toBe(
      "Timed out waiting for the provider",
    );
    expect(failureNotificationBody("Error: boom", undefined)).toBe("Failed: boom");
  });

  test("extracts a provider's nested JSON error message", () => {
    expect(
      failureNotificationBody(
        '400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long"}}',
        undefined,
      ),
    ).toBe("Failed: prompt is too long");
  });

  test("adds the start of a partial reply after the error", () => {
    expect(failureNotificationBody("Terminated", "I updated **three** files and")).toBe(
      "Failed: Terminated\nI updated three files and",
    );
  });
});
