import { randomUUID } from "node:crypto";
import type { ComposerAttachment, TranscriptMessage } from "../../contracts/desktop-state";
import { cloneComposerAttachments } from "../application/app-store-utils";
import type { MessageEditState } from "./session-state-map";

type UserRow = Extract<TranscriptMessage, { kind: "message" }>;

/** The user row someone asked to edit, by its row id or its session entry id. */
export function findEditableUserRow(
  transcript: readonly TranscriptMessage[],
  messageId: string,
): UserRow | undefined {
  return transcript.find(
    (item): item is UserRow =>
      item.kind === "message" &&
      item.role === "user" &&
      (item.id === messageId || item.sourceMessageId === messageId),
  );
}

/** A sent message's images and files as composer attachments, each with a fresh id. */
export function composerAttachmentsFromRow(
  row: UserRow,
  newId: () => string = randomUUID,
): ComposerAttachment[] {
  return cloneComposerAttachments(
    (row.attachments ?? []).map((attachment) => ({
      ...attachment,
      id: newId(),
      name: attachment.name ?? (attachment.kind === "image" ? "Image" : "File"),
    })),
  );
}

/**
 * The draft each thread should be saved with. A thread editing a message saves the draft it had
 * before Edit, so quitting mid-edit comes back to that draft with the thread untouched.
 */
export function draftsToPersist(
  drafts: ReadonlyMap<string, string>,
  edits: ReadonlyMap<string, MessageEditState>,
): Map<string, string> {
  const persisted = new Map(drafts);
  for (const [key, edit] of edits) {
    if (edit.restoreDraft) persisted.set(key, edit.restoreDraft);
    else persisted.delete(key);
  }
  return persisted;
}

/** The attachments to save for a thread: the pre-edit ones while it is editing a message. */
export function attachmentsToPersist(
  attachments: readonly ComposerAttachment[],
  edit: MessageEditState | undefined,
): readonly ComposerAttachment[] {
  return edit ? edit.restoreAttachments : attachments;
}
