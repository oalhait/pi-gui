import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

export const renameThreadToolName = "rename_thread";
export const renameThreadAction = "pi_gui_rename_thread";

export const AGENT_THREAD_TITLE_MIN_LENGTH = 3;
export const AGENT_THREAD_TITLE_MAX_LENGTH = 80;
export const FIRST_EXCHANGE_ONLY_MESSAGE =
  "rename_thread is only available during the chat's first exchange.";

export interface RenameThreadToolDetails {
  readonly action: typeof renameThreadAction;
  readonly title: string;
}

/**
 * Renames the calling chat and returns the applied title; throws when refused, such as after the
 * user named the chat.
 */
export type RenameThreadFromAgent = (ctx: ExtensionContext, title: string) => Promise<string>;

/** The parts of a pi session entry the first-exchange rules read. */
export interface TitleGateEntry {
  readonly type: string;
  readonly message?: { readonly role?: string; readonly stopReason?: string };
}

/** One line, whitespace collapsed, 3-80 characters. */
export function normalizeAgentThreadTitle(
  raw: unknown,
): { readonly title: string } | { readonly error: string } {
  if (typeof raw !== "string") {
    return { error: "rename_thread requires a title." };
  }
  if (/[\r\n]/.test(raw.trim())) {
    return { error: "The title must be a single line." };
  }
  const title = raw.replace(/\s+/g, " ").trim();
  if (
    title.length < AGENT_THREAD_TITLE_MIN_LENGTH ||
    title.length > AGENT_THREAD_TITLE_MAX_LENGTH
  ) {
    return {
      error: `The title must be ${AGENT_THREAD_TITLE_MIN_LENGTH}-${AGENT_THREAD_TITLE_MAX_LENGTH} characters.`,
    };
  }
  return { title };
}

/**
 * Whether a session is still in its first exchange: its first user message and the run answering
 * it. A message steered into that run (after a tool call) still belongs to it; a message sent after
 * a reply ended starts a later exchange.
 */
export function isFirstExchange(entries: readonly TitleGateEntry[]): boolean {
  let userMessages = 0;
  let lastAssistantStop: string | undefined;
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const role = entry.message?.role;
    if (role === "assistant") {
      lastAssistantStop = entry.message?.stopReason;
    } else if (role === "user") {
      userMessages += 1;
      if (userMessages > 1 && lastAssistantStop !== "toolUse") return false;
    }
  }
  return userMessages > 0;
}

function hasUserMessage(entries: readonly TitleGateEntry[]): boolean {
  return entries.some((entry) => entry.type === "message" && entry.message?.role === "user");
}

function renameThreadResult(title: string): AgentToolResult<RenameThreadToolDetails> {
  return {
    content: [{ type: "text", text: `Renamed this chat to "${title}".` }],
    details: { action: renameThreadAction, title },
  };
}

export function createRenameThreadTool(
  rename: RenameThreadFromAgent,
): ToolDefinition<any, RenameThreadToolDetails> {
  return {
    name: renameThreadToolName,
    label: "Rename chat",
    // Declared directly from the first run; later runs withdraw it (see the extension below).
    exposure: "direct",
    description:
      "Set this chat's title in the pi-gui sidebar. Only works during the chat's first exchange.",
    promptSnippet: "rename_thread: set this chat's sidebar title during its first exchange.",
    promptGuidelines: [
      "At the end of your first reply, if the chat title doesn't describe the task, call rename_thread with a short (2-6 word) sentence-case title. Don't call it in later turns.",
    ],
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short sentence-case title, 2-6 words." },
      },
      required: ["title"],
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const parsed = normalizeAgentThreadTitle(
        params && typeof params === "object" ? (params as { title?: unknown }).title : undefined,
      );
      if ("error" in parsed) {
        throw new Error(parsed.error);
      }
      if (!isFirstExchange(ctx.sessionManager.getBranch())) {
        throw new Error(FIRST_EXCHANGE_ONLY_MESSAGE);
      }
      const applied = await rename(ctx, parsed.title);
      return renameThreadResult(applied);
    },
  };
}

/**
 * Offers rename_thread only to the run answering a chat's first message. Each run decides before
 * it starts, so later runs never see the tool; the tool itself still refuses outside that exchange.
 */
export function createThreadTitleRuntimeExtension(rename: RenameThreadFromAgent): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    pi.registerTool(createRenameThreadTool(rename));
    pi.on("before_agent_start", (event, ctx) => {
      const offer = event.messageType === "user" && !hasUserMessage(ctx.sessionManager.getBranch());
      const active = pi.getActiveTools();
      if (active.includes(renameThreadToolName) === offer) return;
      pi.setActiveTools(
        offer
          ? [...active, renameThreadToolName]
          : active.filter((name) => name !== renameThreadToolName),
      );
    });
  };
}
