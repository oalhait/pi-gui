import { expect, test } from "@playwright/test";
import { sessionKey, type SessionRef } from "@pi-gui/session-driver";
import type { ComposerAttachment, TranscriptMessage } from "../../contracts/desktop-state";
import type { DisplayTimelineItem } from "../../contracts/timeline-types";
import { createConversationOwner } from "../../electron/conversation/app-store-composer";
import {
  attachmentsToPersist,
  composerAttachmentsFromRow,
  draftsToPersist,
  findEditableUserRow,
} from "../../electron/conversation/message-edit";
import type { MessageEditState } from "../../electron/conversation/session-state-map";
import { supersededRowIds } from "../../src/features/conversation/message-edit-rows";

const sessionRef: SessionRef = { workspaceId: "ws", sessionId: "sess" };
const key = sessionKey(sessionRef);

const image: ComposerAttachment = {
  id: "draft-image",
  kind: "image",
  name: "draft.png",
  mimeType: "image/png",
  data: "AAAA",
};

function userRow(id: string, text: string, extra: Partial<TranscriptMessage> = {}) {
  return {
    kind: "message",
    role: "user",
    id,
    text,
    createdAt: "2026-11-05T00:00:00.000Z",
    ...extra,
  } as TranscriptMessage;
}

const transcript: TranscriptMessage[] = [
  userRow("row-1", "First question", { sourceMessageId: "entry-1" }),
  {
    kind: "message",
    role: "assistant",
    id: "row-2",
    text: "Answer",
    createdAt: "2026-11-05T00:00:01.000Z",
  } as TranscriptMessage,
  userRow("row-3", "Second question", {
    attachments: [{ kind: "image", data: "BBBB", mimeType: "image/png" }],
  }),
];

/** A conversation-owner host that records what the owner does to the thread. */
function editHost(options: { status?: "idle" | "running"; rewindError?: Error } = {}) {
  const drafts = new Map<string, string>([[key, "My unsent draft"]]);
  const attachments = new Map<string, ComposerAttachment[]>([[key, [image]]]);
  const edits = new Map<string, MessageEditState>();
  const rewinds: string[] = [];
  const sent: string[] = [];
  const persistedAttachments: (readonly ComposerAttachment[])[] = [];
  const errors: unknown[] = [];
  let status = options.status ?? "idle";
  const host = {
    conversationState: {
      transcriptCache: new Map([[key, transcript]]),
      composerDraftsBySession: drafts,
      composerAttachmentsBySession: attachments,
      activeAssistantMessageBySession: new Map<string, string>(),
      sessionErrorsBySession: new Map<string, string>(),
      unpersistedUserMessagesBySession: new Map<string, string[]>(),
      sessionCommandsBySession: new Map(),
      loadedTranscriptKeys: new Set([key]),
    },
    driver: {
      sendUserMessage: async (_ref: SessionRef, message: { text: string }) => {
        sent.push(message.text);
      },
    },
    initialize: async () => undefined,
    emit: () => ({}) as never,
    refreshState: async () => ({}) as never,
    withSessionError: async (_ref: SessionRef, error: unknown) => {
      errors.push(error);
      return {} as never;
    },
    runtimeForWorkspace: () => undefined,
    ensureSessionReady: async () => undefined,
    sessionFromState: () => ({ updatedAt: "", title: "Thread", status }),
    setComposerDraftForSession: (_ref: SessionRef, draft: string) => {
      if (draft) drafts.set(key, draft);
      else drafts.delete(key);
    },
    publishComposerAttachments: () => undefined,
    persistComposerAttachments: async (persistKey: string, next: readonly ComposerAttachment[]) => {
      persistedAttachments.push(attachmentsToPersist(next, edits.get(persistKey)));
    },
    getQueuedComposerEditState: () => undefined,
    getMessageEditState: () => edits.get(key),
    setMessageEditState: (_ref: SessionRef, edit: MessageEditState | undefined) => {
      if (edit) edits.set(key, edit);
      else edits.delete(key);
    },
    resolveEditableEntryId: async (_ref: SessionRef, messageId: string) =>
      messageId === "row-3" ? "entry-3" : messageId === "row-1" ? "entry-1" : messageId,
    rewindToUserEntry: async (_ref: SessionRef, entryId: string) => {
      if (options.rewindError) throw options.rewindError;
      rewinds.push(entryId);
    },
    recordUserMessageRecency: () => true,
    publishSelectedTranscriptFor: () => undefined,
  };
  return {
    owner: createConversationOwner(host as never),
    drafts,
    attachments,
    edits,
    rewinds,
    sent,
    persistedAttachments,
    errors,
    setStatus: (next: "idle" | "running") => {
      status = next;
    },
  };
}

test("Edit puts the message in the composer without touching the thread", async () => {
  const { owner, drafts, attachments, edits, rewinds, sent, persistedAttachments } = editHost();
  await owner.startMessageEdit(sessionRef, "row-3");

  expect(drafts.get(key)).toBe("Second question");
  expect(attachments.get(key)?.map(({ kind, name }) => ({ kind, name }))).toEqual([
    { kind: "image", name: "Image" },
  ]);
  expect(edits.get(key)).toMatchObject({
    messageId: "row-3",
    entryId: "entry-3",
    restoreDraft: "My unsent draft",
    restoreAttachments: [image],
  });
  expect(rewinds).toEqual([]);
  expect(sent).toEqual([]);
  // Nothing on disk changed: the saved attachments are still the draft's.
  expect(persistedAttachments).toEqual([]);
});

test("Cancel gives back the earlier draft and attachments and leaves the thread alone", async () => {
  const { owner, drafts, attachments, edits, rewinds, sent } = editHost();
  await owner.startMessageEdit(sessionRef, "row-3");
  drafts.set(key, "Second question, half edited");
  await owner.cancelMessageEdit(sessionRef);

  expect(drafts.get(key)).toBe("My unsent draft");
  expect(attachments.get(key)).toEqual([image]);
  expect(edits.size).toBe(0);
  expect(rewinds).toEqual([]);
  expect(sent).toEqual([]);
  // A second cancel has nothing to do.
  expect(owner.abandonMessageEdit(sessionRef)).toBe(false);
});

test("editing another message keeps the draft from before the first Edit", async () => {
  const { owner, drafts, edits } = editHost();
  await owner.startMessageEdit(sessionRef, "row-3");
  await owner.startMessageEdit(sessionRef, "entry-1");

  expect(drafts.get(key)).toBe("First question");
  expect(edits.get(key)).toMatchObject({
    messageId: "row-1",
    entryId: "entry-1",
    restoreDraft: "My unsent draft",
  });
});

test("sending the edit rewinds to just before the message, then sends", async () => {
  const { owner, edits, rewinds, sent } = editHost();
  await owner.startMessageEdit(sessionRef, "row-3");
  await owner.submitComposer(sessionRef, "Second question, edited");

  expect(rewinds).toEqual(["entry-3"]);
  expect(sent).toEqual(["Second question, edited"]);
  expect(edits.size).toBe(0);
});

test("a send whose rewind fails keeps the edit and sends nothing", async () => {
  const { owner, edits, sent, errors } = editHost({ rewindError: new Error("not on branch") });
  await owner.startMessageEdit(sessionRef, "row-3");
  await owner.submitComposer(sessionRef, "Second question, edited");

  expect(sent).toEqual([]);
  expect(edits.get(key)?.messageId).toBe("row-3");
  expect(errors).toHaveLength(1);
});

test("Edit is refused while the thread runs, and a run that starts ends the edit", async () => {
  const running = editHost({ status: "running" });
  await expect(running.owner.startMessageEdit(sessionRef, "row-3")).rejects.toThrow(
    /before editing/,
  );
  expect(running.edits.size).toBe(0);

  const { owner, drafts, edits, setStatus } = editHost();
  await owner.startMessageEdit(sessionRef, "row-3");
  setStatus("running");
  expect(owner.abandonMessageEdit(sessionRef)).toBe(true);
  expect(drafts.get(key)).toBe("My unsent draft");
  expect(edits.size).toBe(0);
});

test("a thread mid-edit is saved with its draft and attachments from before Edit", () => {
  const edit: MessageEditState = {
    messageId: "row-3",
    entryId: "entry-3",
    restoreDraft: "My unsent draft",
    restoreAttachments: [image],
  };
  const emptyEdit: MessageEditState = { ...edit, restoreDraft: "", restoreAttachments: [] };
  const drafts = new Map([
    ["ws:sess", "Second question, edited"],
    ["ws:other", "Other draft"],
    ["ws:empty", "Edit text"],
  ]);
  expect(
    Object.fromEntries(
      draftsToPersist(
        drafts,
        new Map([
          ["ws:sess", edit],
          ["ws:empty", emptyEdit],
        ]),
      ),
    ),
  ).toEqual({ "ws:sess": "My unsent draft", "ws:other": "Other draft" });
  expect(attachmentsToPersist([], edit)).toEqual([image]);
  expect(attachmentsToPersist([image], undefined)).toEqual([image]);
});

test("rows are found by row or entry id, and attachments get fresh ids", () => {
  expect(findEditableUserRow(transcript, "entry-1")?.id).toBe("row-1");
  expect(findEditableUserRow(transcript, "row-2")).toBeUndefined();
  const row = findEditableUserRow(transcript, "row-3")!;
  expect(composerAttachmentsFromRow(row, () => "fresh")).toEqual([
    { id: "fresh", kind: "image", name: "Image", mimeType: "image/png", data: "BBBB" },
  ]);
});

test("the edited message and everything after it are marked for replacement", () => {
  const rows = [
    ...transcript,
    { kind: "working", id: "working-indicator" },
  ] as unknown as DisplayTimelineItem[];
  expect([...supersededRowIds(rows, "row-3")]).toEqual(["row-3", "working-indicator"]);
  expect([...supersededRowIds(rows, "entry-1")]).toEqual([
    "row-1",
    "row-2",
    "row-3",
    "working-indicator",
  ]);
  expect(supersededRowIds(rows, undefined).size).toBe(0);
  expect(supersededRowIds(rows, "missing").size).toBe(0);
});
