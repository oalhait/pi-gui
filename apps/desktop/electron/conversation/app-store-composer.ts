import { randomUUID } from "node:crypto";
import { sessionKey } from "@pi-gui/session-driver";
import type { SessionConfig, SessionQueuedMessage, SessionRef } from "@pi-gui/session-driver";
import type { PiSdkDriver } from "@pi-gui/pi-sdk-driver";
import type { RuntimeCommandRecord, RuntimeSnapshot } from "@pi-gui/session-driver/runtime-types";
import type {
  ComposerAttachment,
  DesktopAppState,
  ExtensionCommandCompatibilityRecord,
  QueuedComposerMessage,
  WorkspaceSessionTarget,
} from "../../contracts/desktop-state";
import { toSessionRef } from "../application/app-store-utils";
import { assertComposerAttachmentsAccepted } from "../../contracts/composer-attachments";
import { stripThreadReferences } from "../../contracts/thread-references";
import {
  formatSessionConfigStatus,
  composerSubmitNeedsSenderView,
  hasRuntimeSlashCommand,
  incompleteComposerCommandMessage,
  parseComposerCommand,
  resolveRuntimeSlashCommand,
} from "../../contracts/composer-commands";
import {
  appendQueuedUserMessage,
  appendUserMessage,
  trackUnpersistedUserMessage,
  clearActiveAssistantMessage,
} from "./app-store-timeline";
import {
  cloneComposerAttachments,
  makeActivityItem,
  previewFromTranscript,
  toSessionAttachments,
  toSessionQueuedMessages,
  toTranscriptAttachments,
} from "../application/app-store-utils";
import type { RefreshStateOptions } from "../application/refresh-state-options";
import type { PendingRuntimeCommandExecution } from "./extension-command-compatibility";
import type {
  MessageEditState,
  QueuedComposerEditState,
  SessionStateMap,
} from "./session-state-map";
import { composerAttachmentsFromRow, findEditableUserRow } from "./message-edit";

type ConversationMutableState = Pick<
  SessionStateMap,
  | "activeAssistantMessageBySession"
  | "composerAttachmentsBySession"
  | "composerDraftsBySession"
  | "loadedTranscriptKeys"
  | "sessionCommandsBySession"
  | "sessionConfigBySession"
  | "sessionErrorsBySession"
  | "transcriptCache"
  | "unpersistedUserMessagesBySession"
>;

type ConversationDriver = Pick<
  PiSdkDriver,
  | "cancelCurrentRun"
  | "compactSession"
  | "reloadSession"
  | "renameSession"
  | "replaceQueuedMessages"
  | "sendUserMessage"
  | "setSessionModel"
  | "setSessionThinkingLevel"
  | "unarchiveSession"
>;

interface ConversationOwnerHost {
  readonly driver: ConversationDriver;
  readonly conversationState: ConversationMutableState;
  runtimeForWorkspace(workspaceId: string): RuntimeSnapshot | undefined;
  initialize(): Promise<void>;
  refreshState(options?: RefreshStateOptions): Promise<DesktopAppState>;
  emit(): DesktopAppState;
  withError(error: unknown): Promise<DesktopAppState>;
  withSessionError(sessionRef: SessionRef, error: unknown): Promise<DesktopAppState>;
  withErrorHandling(fn: () => Promise<DesktopAppState>): Promise<DesktopAppState>;
  sessionFromState(
    sessionRef: SessionRef,
  ):
    | { archivedAt?: string; updatedAt: string; title: string; status: string; preview?: string }
    | undefined;
  describeSession(
    sessionRef: SessionRef,
  ):
    { readonly workspaceName: string; readonly title: string; readonly status: string } | undefined;
  isSelectedSession(sessionRef: SessionRef): boolean;
  clearConversationError(): void;
  publishComposerAttachments(
    sessionRef: SessionRef,
    attachments: readonly ComposerAttachment[],
  ): void;
  applyLocalSessionUpdate(
    sessionRef: SessionRef,
    update: {
      readonly title?: string;
      readonly preview?: string;
      readonly config?: SessionConfig;
    },
  ): void;
  setComposerDraftForSession(
    sessionRef: SessionRef,
    draft: string,
    source:
      "persist" | "command" | "extension-editor-text" | "queued-message-edit" | "message-edit",
  ): void;
  ensureSessionReady(sessionRef: SessionRef): Promise<unknown>;
  refreshSessionCommandsFor(sessionRef: SessionRef): Promise<void>;
  getLearnedRuntimeCommandCompatibility(
    workspaceId: string,
    command: RuntimeCommandRecord,
  ): ExtensionCommandCompatibilityRecord | undefined;
  beginRuntimeCommandExecution(sessionRef: SessionRef, command: RuntimeCommandRecord): void;
  finishRuntimeCommandExecution(
    sessionRef: SessionRef,
    timestamp?: string,
  ): PendingRuntimeCommandExecution | undefined;
  clearExtensionUiForSession(sessionRef: SessionRef): void;
  persistComposerAttachments(
    key: string,
    attachments: readonly ComposerAttachment[],
  ): Promise<void>;
  schedulePersistUiState(): void;
  recordUserMessageRecency(sessionRef: SessionRef): boolean;
  getQueuedComposerMessages(sessionRef: SessionRef): readonly QueuedComposerMessage[];
  setQueuedComposerEditState(
    sessionRef: SessionRef,
    editState: QueuedComposerEditState | undefined,
  ): void;
  getQueuedComposerEditState(sessionRef: SessionRef): QueuedComposerEditState | undefined;
  setMessageEditState(sessionRef: SessionRef, editState: MessageEditState | undefined): void;
  getMessageEditState(sessionRef: SessionRef): MessageEditState | undefined;
  /** Pi's entry id for a user row on the thread's current branch; throws when it has none. */
  resolveEditableEntryId(sessionRef: SessionRef, messageId: string): Promise<string>;
  /** Moves the thread to just before a user entry and reloads its transcript. */
  rewindToUserEntry(sessionRef: SessionRef, entryId: string): Promise<void>;
  reloadTranscriptFromDriver(sessionRef: SessionRef): Promise<void>;
  publishSelectedTranscriptFor(sessionRef: SessionRef): void;
  clearPendingAutoTitle(sessionRef: SessionRef): void;
  markSessionTitledByUser(sessionRef: SessionRef): void;
}

type ComposerStore = ConversationOwnerHost;

export interface ConversationOwner {
  updateComposerDraft(
    sessionRef: SessionRef | undefined,
    composerDraft: string,
  ): Promise<DesktopAppState>;
  addComposerAttachments(
    sessionRef: SessionRef | undefined,
    attachments: readonly ComposerAttachment[],
  ): Promise<DesktopAppState>;
  removeComposerAttachment(
    sessionRef: SessionRef | undefined,
    attachmentId: string,
  ): Promise<DesktopAppState>;
  editQueuedComposerMessage(
    sessionRef: SessionRef | undefined,
    messageId: string,
    currentDraft?: string,
  ): Promise<DesktopAppState>;
  cancelQueuedComposerEdit(sessionRef: SessionRef | undefined): Promise<DesktopAppState>;
  startMessageEdit(sessionRef: SessionRef | undefined, messageId: string): Promise<DesktopAppState>;
  cancelMessageEdit(sessionRef: SessionRef | undefined): Promise<DesktopAppState>;
  /**
   * Ends a message edit without touching the thread, putting the earlier draft back. Returns
   * false when the thread was not editing. Synchronous so a session event can apply it.
   */
  abandonMessageEdit(sessionRef: SessionRef): boolean;
  removeQueuedComposerMessage(
    sessionRef: SessionRef | undefined,
    messageId: string,
  ): Promise<DesktopAppState>;
  steerQueuedComposerMessage(
    sessionRef: SessionRef | undefined,
    messageId: string,
  ): Promise<DesktopAppState>;
  submitComposer(
    sessionRef: SessionRef | undefined,
    textInput: string,
    options?: { readonly deliverAs?: "steer" | "followUp" },
  ): Promise<DesktopAppState>;
  composerSubmitNeedsSenderView(sessionRef: SessionRef | undefined, textInput: string): boolean;
  /**
   * Runs an extension command for a card button. It is not a user message: nothing is added
   * to the thread or taken from the composer, and the driver refuses anything that is not an
   * extension command. Throws on failure so the caller shows one kind of error.
   */
  runExtensionCommand(sessionRef: SessionRef, command: string): Promise<DesktopAppState>;
  submitComposerToSession(
    sessionRef: SessionRef,
    textInput: string,
    attachments: readonly ComposerAttachment[],
    options?: { readonly deliverAs?: "steer" | "followUp"; readonly allowCommands?: boolean },
  ): Promise<DesktopAppState>;
  setSessionModel(
    target: WorkspaceSessionTarget,
    provider: string,
    modelId: string,
  ): Promise<DesktopAppState>;
  setSessionThinkingLevel(sessionRef: SessionRef, thinkingLevel: string): Promise<DesktopAppState>;
  cancelCurrentRun(sessionRef: SessionRef | undefined): Promise<DesktopAppState>;
  sendMessageToSession(
    sessionRef: SessionRef,
    text: string,
    attachments: readonly ComposerAttachment[],
    options?: { readonly rollbackOptimisticMessageOnError?: boolean },
  ): Promise<void>;
  deliverBackgroundInstruction(
    sessionRef: SessionRef,
    text: string,
    options?: { readonly rollbackOnError?: boolean },
  ): Promise<string | undefined>;
}

export function createConversationOwner(store: ConversationOwnerHost): ConversationOwner {
  return {
    updateComposerDraft: (sessionRef, draft) => updateComposerDraft(store, sessionRef, draft),
    addComposerAttachments: (sessionRef, attachments) =>
      addComposerAttachments(store, sessionRef, attachments),
    removeComposerAttachment: (sessionRef, attachmentId) =>
      removeComposerAttachment(store, sessionRef, attachmentId),
    editQueuedComposerMessage: (sessionRef, messageId, currentDraft) =>
      editQueuedComposerMessage(store, sessionRef, messageId, currentDraft),
    cancelQueuedComposerEdit: (sessionRef) => cancelQueuedComposerEdit(store, sessionRef),
    startMessageEdit: (sessionRef, messageId) => startMessageEdit(store, sessionRef, messageId),
    cancelMessageEdit: (sessionRef) => cancelMessageEdit(store, sessionRef),
    abandonMessageEdit: (sessionRef) => abandonMessageEdit(store, sessionRef),
    removeQueuedComposerMessage: (sessionRef, messageId) =>
      removeQueuedComposerMessage(store, sessionRef, messageId),
    steerQueuedComposerMessage: (sessionRef, messageId) =>
      steerQueuedComposerMessage(store, sessionRef, messageId),
    submitComposer: (sessionRef, text, options) => submitComposer(store, sessionRef, text, options),
    runExtensionCommand: (sessionRef, command) => runExtensionCommand(store, sessionRef, command),
    composerSubmitNeedsSenderView: (sessionRef, text) =>
      sessionRef
        ? composerSubmitNeedsSenderView(
            text,
            store.runtimeForWorkspace(sessionRef.workspaceId),
            store.conversationState.sessionCommandsBySession.get(sessionKey(sessionRef)),
          )
        : text.trimStart().startsWith("/"),
    submitComposerToSession: (sessionRef, text, attachments, options) =>
      submitComposerToSession(store, sessionRef, text, attachments, options),
    setSessionModel: (target, provider, modelId) =>
      setSessionModel(store, target, provider, modelId),
    setSessionThinkingLevel: (sessionRef, thinkingLevel) =>
      setSessionThinkingLevel(store, sessionRef, thinkingLevel),
    cancelCurrentRun: (sessionRef) => cancelCurrentRun(store, sessionRef),
    sendMessageToSession: (sessionRef, text, attachments, options) =>
      sendMessageToSession(store, sessionRef, text, attachments, options),
    deliverBackgroundInstruction: (sessionRef, text, options) =>
      deliverBackgroundInstruction(store, sessionRef, text, options),
  };
}

/* ── Public methods ─────────────────────────────────────── */

async function updateComposerDraft(
  store: ComposerStore,
  sessionRef: SessionRef | undefined,
  composerDraft: string,
): Promise<DesktopAppState> {
  await store.initialize();
  if (!sessionRef || !store.sessionFromState(sessionRef)) {
    return store.emit();
  }
  store.setComposerDraftForSession(sessionRef, composerDraft, "persist");
  store.clearConversationError();
  store.schedulePersistUiState();
  return store.emit();
}

async function addComposerAttachments(
  store: ComposerStore,
  sessionRef: SessionRef | undefined,
  attachments: readonly ComposerAttachment[],
): Promise<DesktopAppState> {
  await store.initialize();
  if (!sessionRef || !store.sessionFromState(sessionRef) || attachments.length === 0) {
    return store.emit();
  }

  const key = sessionKey(sessionRef);
  const existing = store.conversationState.composerAttachmentsBySession.get(key) ?? [];
  const accepted = assertComposerAttachmentsAccepted(existing, attachments);
  const next = [...existing, ...accepted];
  store.conversationState.composerAttachmentsBySession.set(key, next);
  store.clearConversationError();
  store.publishComposerAttachments(sessionRef, next);
  await store.persistComposerAttachments(key, next);
  return store.emit();
}

async function removeComposerAttachment(
  store: ComposerStore,
  sessionRef: SessionRef | undefined,
  attachmentId: string,
): Promise<DesktopAppState> {
  await store.initialize();
  if (!sessionRef || !store.sessionFromState(sessionRef)) {
    return store.emit();
  }

  const key = sessionKey(sessionRef);
  const existing = store.conversationState.composerAttachmentsBySession.get(key) ?? [];
  const next = existing.filter((attachment) => attachment.id !== attachmentId);
  if (next.length > 0) {
    store.conversationState.composerAttachmentsBySession.set(key, next);
  } else {
    store.conversationState.composerAttachmentsBySession.delete(key);
  }
  store.publishComposerAttachments(sessionRef, next);
  await store.persistComposerAttachments(key, next);
  return store.emit();
}

async function editQueuedComposerMessage(
  store: ComposerStore,
  sessionRef: SessionRef | undefined,
  messageId: string,
  currentDraft = "",
): Promise<DesktopAppState> {
  await store.initialize();
  if (!sessionRef || !store.sessionFromState(sessionRef)) {
    return store.emit();
  }

  const key = sessionKey(sessionRef);
  const message = store
    .getQueuedComposerMessages(sessionRef)
    .find((entry) => entry.id === messageId);
  if (!message) {
    return store.emit();
  }

  store.setQueuedComposerEditState(sessionRef, {
    messageId,
    restoreDraft: currentDraft || store.conversationState.composerDraftsBySession.get(key) || "",
    restoreAttachments: cloneComposerAttachments(
      store.conversationState.composerAttachmentsBySession.get(key) ?? [],
    ),
  });
  // The composer shows the readable @mentions; sending adds the thread ids back.
  store.setComposerDraftForSession(
    sessionRef,
    stripThreadReferences(message.text),
    "queued-message-edit",
  );
  store.conversationState.composerAttachmentsBySession.set(
    key,
    cloneComposerAttachments(message.attachments),
  );
  await store.persistComposerAttachments(key, message.attachments);

  return store.refreshState({
    clearLastError: true,
    markSelectedSessionViewed: false,
  });
}

async function cancelQueuedComposerEdit(
  store: ComposerStore,
  sessionRef: SessionRef | undefined,
): Promise<DesktopAppState> {
  await store.initialize();
  if (!sessionRef || !store.sessionFromState(sessionRef)) {
    return store.emit();
  }

  const editState = store.getQueuedComposerEditState(sessionRef);
  if (!editState) {
    return store.emit();
  }

  const key = sessionKey(sessionRef);
  store.setQueuedComposerEditState(sessionRef, undefined);
  store.setComposerDraftForSession(sessionRef, editState.restoreDraft, "queued-message-edit");
  if (editState.restoreAttachments.length > 0) {
    store.conversationState.composerAttachmentsBySession.set(
      key,
      cloneComposerAttachments(editState.restoreAttachments),
    );
  } else {
    store.conversationState.composerAttachmentsBySession.delete(key);
  }
  await store.persistComposerAttachments(key, editState.restoreAttachments);

  return store.refreshState({
    clearLastError: true,
    markSelectedSessionViewed: false,
  });
}

async function startMessageEdit(
  store: ComposerStore,
  sessionRef: SessionRef | undefined,
  messageId: string,
): Promise<DesktopAppState> {
  await store.initialize();
  if (!sessionRef || !store.sessionFromState(sessionRef)) {
    return store.emit();
  }
  if (store.sessionFromState(sessionRef)?.status === "running") {
    throw new Error("Stop the run, or wait for it to finish, before editing a message.");
  }

  const key = sessionKey(sessionRef);
  const entryId = await store.resolveEditableEntryId(sessionRef, messageId);
  const row = findEditableUserRow(
    store.conversationState.transcriptCache.get(key) ?? [],
    messageId,
  );
  if (!row) {
    throw new Error(`No user message ${messageId} in session ${key}.`);
  }
  // Picking another message while editing keeps the draft from before the first Edit.
  const previous = store.getMessageEditState(sessionRef);
  store.setMessageEditState(sessionRef, {
    messageId: row.id,
    entryId,
    restoreDraft:
      previous?.restoreDraft ?? store.conversationState.composerDraftsBySession.get(key) ?? "",
    restoreAttachments:
      previous?.restoreAttachments ??
      cloneComposerAttachments(store.conversationState.composerAttachmentsBySession.get(key) ?? []),
  });
  // The composer shows the readable @mentions; sending adds the thread ids back.
  store.setComposerDraftForSession(sessionRef, stripThreadReferences(row.text), "message-edit");
  // Not written to disk: while editing, the saved attachments stay the ones from before Edit.
  setComposerAttachments(store, sessionRef, composerAttachmentsFromRow(row));
  return store.refreshState({
    clearLastError: true,
    markSelectedSessionViewed: false,
  });
}

async function cancelMessageEdit(
  store: ComposerStore,
  sessionRef: SessionRef | undefined,
): Promise<DesktopAppState> {
  await store.initialize();
  if (
    !sessionRef ||
    !store.sessionFromState(sessionRef) ||
    !abandonMessageEdit(store, sessionRef)
  ) {
    return store.emit();
  }
  return store.refreshState({
    clearLastError: true,
    markSelectedSessionViewed: false,
  });
}

function abandonMessageEdit(store: ComposerStore, sessionRef: SessionRef): boolean {
  const edit = store.getMessageEditState(sessionRef);
  if (!edit) return false;
  store.setMessageEditState(sessionRef, undefined);
  store.setComposerDraftForSession(sessionRef, edit.restoreDraft, "message-edit");
  setComposerAttachments(store, sessionRef, edit.restoreAttachments);
  // Already what is saved (see persistComposerAttachments); written again in case an edit raced it.
  void store
    .persistComposerAttachments(sessionKey(sessionRef), edit.restoreAttachments)
    .catch((error: unknown) => {
      console.error("[app-store] saving the restored attachments failed", error);
    });
  return true;
}

function setComposerAttachments(
  store: ComposerStore,
  sessionRef: SessionRef,
  attachments: readonly ComposerAttachment[],
): void {
  const key = sessionKey(sessionRef);
  if (attachments.length > 0) {
    store.conversationState.composerAttachmentsBySession.set(
      key,
      cloneComposerAttachments(attachments),
    );
  } else {
    store.conversationState.composerAttachmentsBySession.delete(key);
  }
  store.publishComposerAttachments(sessionRef, attachments);
}

async function removeQueuedComposerMessage(
  store: ComposerStore,
  sessionRef: SessionRef | undefined,
  messageId: string,
): Promise<DesktopAppState> {
  await store.initialize();
  if (!sessionRef || !store.sessionFromState(sessionRef)) {
    return store.emit();
  }

  const current = store.getQueuedComposerMessages(sessionRef);
  const next = current.filter((message) => message.id !== messageId);
  const editState = store.getQueuedComposerEditState(sessionRef);
  const key = sessionKey(sessionRef);

  if (editState?.messageId === messageId) {
    store.setQueuedComposerEditState(sessionRef, undefined);
    store.setComposerDraftForSession(sessionRef, editState.restoreDraft, "queued-message-edit");
    if (editState.restoreAttachments.length > 0) {
      store.conversationState.composerAttachmentsBySession.set(
        key,
        cloneComposerAttachments(editState.restoreAttachments),
      );
    } else {
      store.conversationState.composerAttachmentsBySession.delete(key);
    }
    await store.persistComposerAttachments(key, editState.restoreAttachments);
  }

  await store.driver.replaceQueuedMessages(sessionRef, toSessionQueuedMessages(next));
  return store.refreshState({
    clearLastError: true,
    markSelectedSessionViewed: false,
  });
}

async function steerQueuedComposerMessage(
  store: ComposerStore,
  sessionRef: SessionRef | undefined,
  messageId: string,
): Promise<DesktopAppState> {
  await store.initialize();
  if (!sessionRef || !store.sessionFromState(sessionRef)) {
    return store.emit();
  }

  const current = store.getQueuedComposerMessages(sessionRef);
  const queuedMessage = current.find((message) => message.id === messageId);
  if (!queuedMessage) {
    return store.emit();
  }

  const steeredMessage = {
    ...queuedMessage,
    mode: "steer" as const,
    updatedAt: new Date().toISOString(),
  };
  const next = current.map((message) => (message.id === messageId ? steeredMessage : message));
  const nextSessionQueuedMessages = toSessionQueuedMessages(next);
  const optimisticSteerMessage = nextSessionQueuedMessages.find(
    (message) => message.id === messageId,
  );

  if (optimisticSteerMessage) {
    appendQueuedUserMessage(
      store.conversationState.transcriptCache,
      sessionRef,
      optimisticSteerMessage,
    );
    trackUnpersistedUserMessage(
      store.conversationState.unpersistedUserMessagesBySession,
      sessionRef,
      optimisticSteerMessage.id,
    );
    store.publishSelectedTranscriptFor(sessionRef);
  }

  try {
    await store.driver.replaceQueuedMessages(sessionRef, nextSessionQueuedMessages);
    return store.refreshState({
      clearLastError: true,
      markSelectedSessionViewed: false,
    });
  } catch (error) {
    if (optimisticSteerMessage) {
      removeOptimisticQueuedUserMessage(store, sessionRef, optimisticSteerMessage.id);
    }
    return store.withSessionError(sessionRef, error);
  }
}

async function submitComposer(
  store: ComposerStore,
  sessionRef: SessionRef | undefined,
  textInput: string,
  options: {
    readonly deliverAs?: "steer" | "followUp";
    readonly allowCommands?: boolean;
  } = {},
): Promise<DesktopAppState> {
  await store.initialize();
  const text = textInput.trim();
  const attachments = sessionRef
    ? (store.conversationState.composerAttachmentsBySession.get(sessionKey(sessionRef)) ?? [])
    : [];
  if (!text && attachments.length === 0) {
    return store.emit();
  }
  if (!sessionRef || !store.sessionFromState(sessionRef)) {
    return store.withError("Create or select a session before sending a message.");
  }

  return submitComposerToSession(store, sessionRef, textInput, attachments, options);
}

async function submitComposerToSession(
  store: ComposerStore,
  sessionRef: SessionRef,
  textInput: string,
  attachments: readonly ComposerAttachment[],
  options: {
    readonly deliverAs?: "steer" | "followUp";
    readonly allowCommands?: boolean;
  } = {},
): Promise<DesktopAppState> {
  const text = textInput.trim();
  const key = sessionKey(sessionRef);
  const runtime = store.runtimeForWorkspace(sessionRef.workspaceId);
  const sessionCommands =
    store.conversationState.sessionCommandsBySession.get(sessionKey(sessionRef)) ?? [];
  const allowCommands = options.allowCommands ?? true;
  const runtimeSlashCommand =
    allowCommands && hasRuntimeSlashCommand(text, runtime, sessionCommands);
  const resolvedRuntimeSlashCommand = runtimeSlashCommand
    ? resolveRuntimeSlashCommand(text, runtime, sessionCommands)
    : undefined;

  if (allowCommands && text.startsWith("/") && !runtimeSlashCommand) {
    const handled = await runComposerCommand(store, sessionRef, text);
    if (handled) {
      return handled;
    }
  }

  const selectedSession = store.sessionFromState(sessionRef);
  const isRunning = selectedSession?.status === "running";
  const editingState = store.getQueuedComposerEditState(sessionRef);
  // Sending an edited message is when the thread rewinds: the new message starts a sibling
  // branch of the one it replaces. An extension command is not a message, so it leaves the edit.
  const messageEdit =
    isRunning || resolvedRuntimeSlashCommand?.source === "extension"
      ? undefined
      : store.getMessageEditState(sessionRef);
  let rewound = false;
  let optimisticSteerMessage: SessionQueuedMessage | undefined;
  try {
    if (messageEdit) {
      store.setMessageEditState(sessionRef, undefined);
      await store.rewindToUserEntry(sessionRef, messageEdit.entryId);
      rewound = true;
    }
    if (resolvedRuntimeSlashCommand) {
      const learnedCompatibility = store.getLearnedRuntimeCommandCompatibility(
        sessionRef.workspaceId,
        resolvedRuntimeSlashCommand,
      );
      if (learnedCompatibility?.status === "terminal-only") {
        if (attachments.length > 0) {
          store.conversationState.composerAttachmentsBySession.set(
            key,
            cloneComposerAttachments(attachments),
          );
          await store.persistComposerAttachments(key, attachments);
        }
        store.setComposerDraftForSession(sessionRef, textInput, "command");
        store.publishComposerAttachments(sessionRef, attachments);
        return store.withSessionError(sessionRef, learnedCompatibility.message);
      }

      store.beginRuntimeCommandExecution(sessionRef, resolvedRuntimeSlashCommand);
    }

    if (isRunning && !resolvedRuntimeSlashCommand) {
      const deliverAs = options.deliverAs ?? "followUp";
      const nextMessage = buildQueuedComposerMessage({
        existing: editingState
          ? store
              .getQueuedComposerMessages(sessionRef)
              .find((message) => message.id === editingState.messageId)
          : undefined,
        text,
        attachments,
        mode: deliverAs,
      });
      const nextQueuedMessages = editingState
        ? replaceQueuedComposerMessage(
            store.getQueuedComposerMessages(sessionRef),
            editingState.messageId,
            nextMessage,
          )
        : [...store.getQueuedComposerMessages(sessionRef), nextMessage];

      store.conversationState.composerDraftsBySession.delete(key);
      store.conversationState.composerAttachmentsBySession.delete(key);
      store.setQueuedComposerEditState(sessionRef, undefined);
      const nextSessionQueuedMessages = toSessionQueuedMessages(nextQueuedMessages);
      optimisticSteerMessage =
        deliverAs === "steer"
          ? nextSessionQueuedMessages.find((message) => message.id === nextMessage.id)
          : undefined;
      if (optimisticSteerMessage) {
        appendQueuedUserMessage(
          store.conversationState.transcriptCache,
          sessionRef,
          optimisticSteerMessage,
        );
        trackUnpersistedUserMessage(
          store.conversationState.unpersistedUserMessagesBySession,
          sessionRef,
          optimisticSteerMessage.id,
        );
        store.publishSelectedTranscriptFor(sessionRef);
      }
      store.recordUserMessageRecency(sessionRef);
      // Hand the message to the driver before any await: the session may settle meanwhile, and
      // the driver must see the queued send before an agent archive can (see archiveSessionIfIdle).
      await store.driver.replaceQueuedMessages(sessionRef, nextSessionQueuedMessages);
      await store.persistComposerAttachments(key, []);
      return store.refreshState({
        clearLastError: true,
        markSelectedSessionViewed: false,
      });
    }

    if (resolvedRuntimeSlashCommand?.source === "extension") {
      // pi runs an extension command and ignores attachments, so it is not a message: only the
      // typed text is used up.
      store.setComposerDraftForSession(sessionRef, "", "command");
      await sendExtensionCommand(store, sessionRef, text);
    } else {
      await sendMessageToSession(store, sessionRef, text, attachments);
    }
    const runtimeCommandOutcome = resolvedRuntimeSlashCommand
      ? store.finishRuntimeCommandExecution(sessionRef)
      : undefined;
    if (runtimeSlashCommand) {
      await store.refreshSessionCommandsFor(sessionRef);
    }
    return store.refreshState({
      clearLastError: !runtimeCommandOutcome?.blockedMessage,
      markSelectedSessionViewed: false,
    });
  } catch (error) {
    if (messageEdit && !rewound) {
      // The thread is unchanged, so the composer is still editing that message. Restored
      // before the attachments are saved, so the saved ones stay those from before Edit.
      store.setMessageEditState(sessionRef, messageEdit);
    }
    if (resolvedRuntimeSlashCommand) {
      store.finishRuntimeCommandExecution(sessionRef);
    }
    if (resolvedRuntimeSlashCommand?.source === "extension") {
      // The command path cleared the shown draft before sending, so hand the text back there too.
      store.setComposerDraftForSession(sessionRef, textInput, "command");
    } else if (textInput) {
      store.conversationState.composerDraftsBySession.set(key, textInput);
    }
    if (attachments.length > 0) {
      store.conversationState.composerAttachmentsBySession.set(
        key,
        cloneComposerAttachments(attachments),
      );
      await store.persistComposerAttachments(key, attachments);
    }
    if (editingState) {
      store.setQueuedComposerEditState(sessionRef, editingState);
    }
    if (optimisticSteerMessage) {
      removeOptimisticQueuedUserMessage(store, sessionRef, optimisticSteerMessage.id);
    }
    return store.withSessionError(sessionRef, error);
  }
}

async function runExtensionCommand(
  store: ComposerStore,
  sessionRef: SessionRef,
  commandText: string,
): Promise<DesktopAppState> {
  await store.initialize();
  const text = commandText.trim();
  const command = resolveRuntimeSlashCommand(
    text,
    store.runtimeForWorkspace(sessionRef.workspaceId),
    store.conversationState.sessionCommandsBySession.get(sessionKey(sessionRef)) ?? [],
  );
  // The driver is the check that matters (`extensionCommandOnly`); this only keeps the
  // terminal-only bookkeeping the same as a typed command.
  const tracked = command?.source === "extension" ? command : undefined;
  if (tracked) {
    const compatibility = store.getLearnedRuntimeCommandCompatibility(
      sessionRef.workspaceId,
      tracked,
    );
    if (compatibility?.status === "terminal-only") throw new Error(compatibility.message);
    store.beginRuntimeCommandExecution(sessionRef, tracked);
  }
  // A button is not typed text, so the draft stays too.
  try {
    await sendExtensionCommand(store, sessionRef, text);
  } finally {
    if (tracked) store.finishRuntimeCommandExecution(sessionRef);
  }
  await store.refreshSessionCommandsFor(sessionRef);
  return store.refreshState({ markSelectedSessionViewed: false });
}

/**
 * Run an extension command. Not a message from the user: no bubble, no recency bump, no
 * unarchive, and attachments and a streaming reply stay as they are. pi saves nothing for the
 * command itself, so the live thread matches the reopened one.
 */
async function sendExtensionCommand(
  store: ComposerStore,
  sessionRef: SessionRef,
  text: string,
): Promise<void> {
  if (!store.conversationState.loadedTranscriptKeys.has(sessionKey(sessionRef))) {
    await store.ensureSessionReady(sessionRef);
  }
  await store.driver.sendUserMessage(sessionRef, { text, extensionCommandOnly: true });
}

async function setSessionModel(
  store: ComposerStore,
  target: WorkspaceSessionTarget,
  provider: string,
  modelId: string,
): Promise<DesktopAppState> {
  await store.initialize();
  const sessionRef = toSessionRef(target);
  const key = sessionKey(sessionRef);

  return store.withErrorHandling(async () => {
    await store.driver.setSessionModel(sessionRef, { provider, modelId });
    syncSessionConfig(store, key, { provider, modelId });
    return finishSessionChange(store, sessionRef, key, `Model set to ${provider}:${modelId}`);
  });
}

async function setSessionThinkingLevel(
  store: ComposerStore,
  sessionRef: SessionRef,
  thinkingLevel: string,
): Promise<DesktopAppState> {
  await store.initialize();
  const key = sessionKey(sessionRef);
  return store.withErrorHandling(async () => {
    await store.driver.setSessionThinkingLevel(sessionRef, thinkingLevel);
    syncSessionConfig(store, key, { thinkingLevel });
    return finishSessionChange(store, sessionRef, key, `Thinking set to ${thinkingLevel}`);
  });
}

async function cancelCurrentRun(
  store: ComposerStore,
  sessionRef: SessionRef | undefined,
): Promise<DesktopAppState> {
  await store.initialize();
  if (!sessionRef) {
    return store.emit();
  }

  try {
    await store.driver.cancelCurrentRun(sessionRef);
    // The queued message-end event owns this clear, so a delayed host event queue
    // can still associate the partial live row with its persisted Pi entry.
    store.conversationState.sessionErrorsBySession.delete(sessionKey(sessionRef));
    store.clearConversationError();
    store.schedulePersistUiState();
    return store.emit();
  } catch (error) {
    return store.withSessionError(sessionRef, error);
  }
}

/* ── Internal helpers ───────────────────────────────────── */

async function deliverBackgroundInstruction(
  store: ComposerStore,
  sessionRef: SessionRef,
  text: string,
  options: { readonly rollbackOnError?: boolean } = {},
): Promise<string | undefined> {
  const instruction = text.trim();
  if (!instruction) {
    throw new Error("The instruction is empty.");
  }
  await store.ensureSessionReady(sessionRef);
  const session = store.sessionFromState(sessionRef);
  if (!session) {
    throw new Error(`Unknown session: ${sessionRef.workspaceId}:${sessionRef.sessionId}`);
  }
  if (session.archivedAt) {
    throw new Error("The target thread is archived.");
  }

  store.recordUserMessageRecency(sessionRef);

  if (session.status === "running") {
    const nextMessage = buildQueuedComposerMessage({
      text: instruction,
      attachments: [],
      mode: "followUp",
    });
    const nextQueuedMessages = [...store.getQueuedComposerMessages(sessionRef), nextMessage];
    await store.driver.replaceQueuedMessages(
      sessionRef,
      toSessionQueuedMessages(nextQueuedMessages),
    );
    await store.refreshState({
      clearLastError: true,
      markSelectedSessionViewed: false,
    });
    return undefined;
  }

  const key = sessionKey(sessionRef);
  const optimisticMessageId = appendUserMessage(
    store.conversationState.transcriptCache,
    sessionRef,
    instruction,
  );
  trackUnpersistedUserMessage(
    store.conversationState.unpersistedUserMessagesBySession,
    sessionRef,
    optimisticMessageId,
  );
  store.publishSelectedTranscriptFor(sessionRef);
  clearActiveAssistantMessage(store.conversationState.activeAssistantMessageBySession, sessionRef);
  store.conversationState.sessionErrorsBySession.delete(key);
  try {
    await store.driver.sendUserMessage(sessionRef, {
      text: instruction,
      attachments: [],
    });
  } catch (error) {
    // A caller that reports the failure and may retry must not leave an undelivered row.
    // A scheduled run keeps it, labelled with the run's error.
    if (!options.rollbackOnError) throw error;
    const transcript = store.conversationState.transcriptCache.get(key) ?? [];
    store.conversationState.transcriptCache.set(
      key,
      transcript.filter((message) => message.id !== optimisticMessageId),
    );
    store.publishSelectedTranscriptFor(sessionRef);
    throw error;
  }
  return optimisticMessageId;
}

async function sendMessageToSession(
  store: ComposerStore,
  sessionRef: SessionRef,
  text: string,
  attachments: readonly ComposerAttachment[],
  options: {
    readonly rollbackOptimisticMessageOnError?: boolean;
  } = {},
): Promise<void> {
  const key = sessionKey(sessionRef);
  const rollbackOptimisticMessageOnError = options.rollbackOptimisticMessageOnError ?? true;
  if (!store.conversationState.loadedTranscriptKeys.has(key)) {
    await store.ensureSessionReady(sessionRef);
  }
  if (store.sessionFromState(sessionRef)?.archivedAt) {
    await store.driver.unarchiveSession(sessionRef);
  }
  store.recordUserMessageRecency(sessionRef);
  const optimisticMessageId = appendUserMessage(
    store.conversationState.transcriptCache,
    sessionRef,
    text,
    toTranscriptAttachments(attachments),
  );
  trackUnpersistedUserMessage(
    store.conversationState.unpersistedUserMessagesBySession,
    sessionRef,
    optimisticMessageId,
  );
  store.publishSelectedTranscriptFor(sessionRef);
  clearActiveAssistantMessage(store.conversationState.activeAssistantMessageBySession, sessionRef);
  store.conversationState.sessionErrorsBySession.delete(key);
  store.conversationState.composerDraftsBySession.delete(key);
  store.conversationState.composerAttachmentsBySession.delete(key);
  await store.persistComposerAttachments(key, []);
  try {
    await store.driver.sendUserMessage(sessionRef, {
      text,
      attachments: toSessionAttachments(attachments),
    });
  } catch (error) {
    if (rollbackOptimisticMessageOnError) {
      const transcript = store.conversationState.transcriptCache.get(key) ?? [];
      store.conversationState.transcriptCache.set(
        key,
        transcript.filter((message) => message.id !== optimisticMessageId),
      );
      store.publishSelectedTranscriptFor(sessionRef);
    }
    throw error;
  }
}

function buildQueuedComposerMessage(options: {
  readonly text: string;
  readonly attachments: readonly ComposerAttachment[];
  readonly mode: "steer" | "followUp";
  readonly existing?: QueuedComposerMessage;
}): QueuedComposerMessage {
  const timestamp = new Date().toISOString();
  return {
    id: options.existing?.id ?? randomUUID(),
    text: options.text,
    mode: options.mode,
    attachments: cloneComposerAttachments(options.attachments),
    createdAt: options.existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
  };
}

function replaceQueuedComposerMessage(
  messages: readonly QueuedComposerMessage[],
  messageId: string,
  replacement: QueuedComposerMessage,
): QueuedComposerMessage[] {
  return messages.map((message) => (message.id === messageId ? replacement : message));
}

function removeOptimisticQueuedUserMessage(
  store: ComposerStore,
  sessionRef: SessionRef,
  messageId: string,
): void {
  const key = sessionKey(sessionRef);
  const transcript = store.conversationState.transcriptCache.get(key) ?? [];
  store.conversationState.transcriptCache.set(
    key,
    transcript.filter((message) => message.id !== messageId),
  );
  store.publishSelectedTranscriptFor(sessionRef);
}

/** Eagerly merge config fields so finishSessionChange sees them before the async sessionUpdated event arrives. */
function syncSessionConfig(store: ComposerStore, key: string, patch: Partial<SessionConfig>): void {
  const current = store.conversationState.sessionConfigBySession.get(key) ?? {};
  store.conversationState.sessionConfigBySession.set(key, { ...current, ...patch });
}

async function runComposerCommand(
  store: ComposerStore,
  sessionRef: SessionRef,
  commandText: string,
): Promise<DesktopAppState | undefined> {
  const parsed = parseComposerCommand(commandText);
  if (!parsed) {
    const message = incompleteComposerCommandMessage(commandText);
    if (message) {
      return store.withSessionError(sessionRef, message);
    }
    return undefined;
  }

  const key = sessionKey(sessionRef);

  if (parsed.type === "model") {
    await store.driver.setSessionModel(sessionRef, {
      provider: parsed.provider,
      modelId: parsed.modelId,
    });
    syncSessionConfig(store, key, { provider: parsed.provider, modelId: parsed.modelId });
    return finishComposerCommand(
      store,
      sessionRef,
      key,
      `Model set to ${parsed.provider}:${parsed.modelId}`,
    );
  }

  if (parsed.type === "thinking") {
    await store.driver.setSessionThinkingLevel(sessionRef, parsed.thinkingLevel);
    syncSessionConfig(store, key, { thinkingLevel: parsed.thinkingLevel });
    return finishComposerCommand(store, sessionRef, key, `Thinking set to ${parsed.thinkingLevel}`);
  }

  if (parsed.type === "status") {
    return finishComposerCommand(
      store,
      sessionRef,
      key,
      formatSessionConfigStatus(store.conversationState.sessionConfigBySession.get(key)),
    );
  }

  if (parsed.type === "session") {
    const session = store.describeSession(sessionRef);
    const parts = [
      `Session ${session?.title ?? sessionRef.sessionId}`,
      `ID ${sessionRef.sessionId}`,
      session ? `Workspace ${session.workspaceName}` : undefined,
      session ? `Status ${session.status}` : undefined,
    ].filter(Boolean);
    return finishComposerCommand(store, sessionRef, key, parts.join(" · "));
  }

  if (parsed.type === "name") {
    store.clearPendingAutoTitle(sessionRef);
    store.markSessionTitledByUser(sessionRef);
    await store.driver.renameSession(sessionRef, parsed.title);
    return finishComposerCommand(store, sessionRef, key, `Session renamed to ${parsed.title}`, {
      sessionTitle: parsed.title,
    });
  }

  if (parsed.type === "compact") {
    void store.driver
      .compactSession(sessionRef, parsed.customInstructions)
      .then(async () => {
        await store.reloadTranscriptFromDriver(sessionRef);
        finishSessionChange(store, sessionRef, key, "Compacted session context");
      })
      .catch((error: unknown) => {
        if (error instanceof Error && error.message === "Compaction cancelled") {
          finishSessionChange(store, sessionRef, key, "Compaction cancelled");
          return;
        }
        return store.withSessionError(sessionRef, error);
      })
      .catch((error: unknown) => console.error("[main] compaction failed", error));
    return finishComposerCommand(store, sessionRef, key, "Compacting session context…");
  }

  if (parsed.type === "reload") {
    store.clearExtensionUiForSession(sessionRef);
    await store.driver.reloadSession(sessionRef);
    await store.refreshSessionCommandsFor(sessionRef);
    return finishComposerCommand(store, sessionRef, key, "Reloaded session resources");
  }

  return store.withSessionError(sessionRef, `Unsupported slash command: ${commandText}`);
}

function appendLocalActivity(store: ComposerStore, sessionRef: SessionRef, label: string): void {
  const key = sessionKey(sessionRef);
  const transcript = [...(store.conversationState.transcriptCache.get(key) ?? [])];
  transcript.push(makeActivityItem(label));
  store.conversationState.transcriptCache.set(key, transcript);
}

/**
 * A typed slash command ran: it consumed the command text, so clear the draft, then record the
 * change. Attachments stay for the next message, since a command is not a message.
 */
function finishComposerCommand(
  store: ComposerStore,
  sessionRef: SessionRef,
  key: string,
  label: string,
  options: { readonly sessionTitle?: string } = {},
): DesktopAppState {
  store.setComposerDraftForSession(sessionRef, "", "command");
  return finishSessionChange(store, sessionRef, key, label, options);
}

/** Record a session change in the transcript and sidebar without touching the composer. */
function finishSessionChange(
  store: ComposerStore,
  sessionRef: SessionRef,
  key: string,
  label: string,
  options: { readonly sessionTitle?: string } = {},
): DesktopAppState {
  appendLocalActivity(store, sessionRef, label);
  const transcript = store.conversationState.transcriptCache.get(key) ?? [];
  const preview = previewFromTranscript(transcript);
  store.applyLocalSessionUpdate(sessionRef, {
    ...(options.sessionTitle ? { title: options.sessionTitle } : {}),
    ...(preview ? { preview } : {}),
    config: store.conversationState.sessionConfigBySession.get(key),
  });
  store.schedulePersistUiState();
  const snapshot = store.emit();
  store.publishSelectedTranscriptFor(sessionRef);
  return snapshot;
}
