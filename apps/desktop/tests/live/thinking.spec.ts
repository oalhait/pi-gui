import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  getDesktopState,
  getRealAuthConfig,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  selectSession,
  waitForTimelineLayout,
} from "../helpers/electron-app";

/**
 * Real-provider reasoning: what each provider actually sends as thinking, and how the
 * timeline shows it live and after a restart. Models come from PI_GUI_THINKING_MODELS
 * (comma-separated provider/model); the copied settings supply the thinking level.
 */
const models = (
  process.env.PI_GUI_THINKING_MODELS ?? "anthropic/claude-sonnet-5-5,openai-codex/gpt-5.6-luna"
)
  .split(",")
  .map((model) => model.trim())
  .filter(Boolean);
const evidenceDir = process.env.PI_GUI_THINKING_EVIDENCE_DIR;

async function sessionFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => join(entry.parentPath, entry.name));
}

/** The shape of each saved thinking block, without its text. */
async function savedThinkingBlocks(agentDir: string) {
  const blocks: unknown[] = [];
  for (const file of await sessionFiles(join(agentDir, "sessions"))) {
    for (const line of (await readFile(file, "utf8")).split("\n")) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line) as {
        type?: string;
        message?: {
          role?: string;
          durationMs?: number;
          usage?: { output?: number; reasoning?: number };
          content?: {
            type: string;
            thinking?: string;
            thinkingSignature?: string;
            redacted?: boolean;
          }[];
        };
      };
      if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
      const content = entry.message.content ?? [];
      blocks.push({
        contentTypes: content.map((part) => part.type),
        durationMs: entry.message.durationMs,
        usage: entry.message.usage
          ? { output: entry.message.usage.output, reasoning: entry.message.usage.reasoning }
          : undefined,
        thinking: content
          .filter((part) => part.type === "thinking")
          .map((part) => ({
            textChars: part.thinking?.length ?? 0,
            redacted: part.redacted === true,
            signatureChars: part.thinkingSignature?.length ?? 0,
          })),
      });
    }
  }
  return blocks;
}

for (const model of models) {
  test(`shows ${model} reasoning live and after restart`, async () => {
    test.setTimeout(300_000);
    const realAuth = getRealAuthConfig();
    test.skip(!realAuth.enabled, realAuth.skipReason);
    const slug = model.replace(/[^a-z0-9]+/gi, "-");
    const outDir = evidenceDir ? join(evidenceDir, slug) : undefined;
    if (outDir) await mkdir(outDir, { recursive: true });
    const shot = async (window: import("@playwright/test").Page, name: string, settle = true) => {
      if (!outDir) return;
      // Rows move once measured; shoot the settled layout (a streaming one keeps changing).
      if (settle) await waitForTimelineLayout(window);
      await window.screenshot({ path: join(outDir, `${name}.png`) });
    };

    const userDataDir = await makeUserDataDir();
    const workspacePath = await makeWorkspace(`live-thinking-${slug}`);
    const launch = () =>
      launchDesktop(userDataDir, {
        initialWorkspaces: [workspacePath],
        testMode: "background",
        realAuthSourceDir: realAuth.sourceDir,
        enabledModels: [model],
      });
    const report: Record<string, unknown> = { model };

    let harness = await launch();
    try {
      const window = await harness.firstWindow();
      await window
        .getByRole("complementary")
        .getByRole("button", { name: "New thread", exact: true })
        .click();
      await window
        .getByLabel("New thread prompt")
        .fill(
          "How many positive integers below 1000 are divisible by 7 or by 11, but not by " +
            "both? Reason it through carefully, then reply with only the number.",
        );
      await window.getByRole("button", { name: "Start thread" }).click();

      const thinking = window.getByTestId("transcript").getByTestId("timeline-thinking");
      const answer = window.locator(".timeline-item--assistant .message__content").last();
      // Whether a Thinking… row was seen streaming before the answer arrived.
      const sawStreaming = await window
        .locator('[data-testid="timeline-thinking"][data-state="streaming"]')
        .first()
        .waitFor({ timeout: 60_000 })
        .then(() => true)
        .catch(() => false);
      report.sawStreamingRow = sawStreaming;
      if (sawStreaming) {
        report.streamingText = (await thinking.first().innerText()).slice(0, 200);
        await shot(window, "1-streaming", false);
      }
      await expect(answer).toContainText("208", { timeout: 180_000 });
      await expect
        .poll(
          async () => {
            const state = await getDesktopState(window);
            return state.workspaces[0]?.sessions[0]?.status ?? "";
          },
          { timeout: 120_000 },
        )
        .toBe("idle");
      report.liveRows = await thinking.evaluateAll((rows) =>
        rows.map((row) => ({
          state: row.getAttribute("data-state"),
          label: row.querySelector(".timeline-thinking__label")?.textContent,
          expandable: row.querySelector("button.timeline-thinking__header") !== null,
        })),
      );
      await shot(window, "2-done-collapsed");
      const header = thinking.first().locator("button.timeline-thinking__header");
      if ((await header.count()) > 0) {
        await header.click();
        await expect(header).toHaveAttribute("aria-expanded", "true");
        report.expandedTextChars = (
          await thinking.first().locator(".timeline-thinking__text").innerText()
        ).length;
        await shot(window, "3-expanded");
      }
      report.sessionTitle = (await getDesktopState(window)).workspaces[0]?.sessions[0]?.title;
    } finally {
      await harness.close();
    }

    report.saved = await savedThinkingBlocks(join(userDataDir, "agent"));
    harness = await launch();
    try {
      const window = await harness.firstWindow();
      await selectSession(window, String(report.sessionTitle));
      const thinking = window.getByTestId("transcript").getByTestId("timeline-thinking");
      report.reloadedRows = await thinking.evaluateAll((rows) =>
        rows.map((row) => ({
          state: row.getAttribute("data-state"),
          label: row.querySelector(".timeline-thinking__label")?.textContent,
          expandable: row.querySelector("button.timeline-thinking__header") !== null,
        })),
      );
      await shot(window, "4-reloaded");
    } finally {
      await harness.close();
      if (outDir) await writeFile(join(outDir, "report.json"), JSON.stringify(report, null, 2));
    }
    // Whatever the provider sent, a restart shows the same reasoning rows, all finished.
    const live = report.liveRows as { state: string; expandable: boolean }[];
    const reloaded = report.reloadedRows as { state: string; expandable: boolean }[];
    expect(reloaded.length).toBe(live.length);
    expect(reloaded.map((row) => [row.state, row.expandable])).toEqual(
      live.map((row) => [row.state, row.expandable]),
    );
  });
}
