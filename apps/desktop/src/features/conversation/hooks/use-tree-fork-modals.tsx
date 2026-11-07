import type { SessionTranscriptMessage } from "@pi-gui/session-driver";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { SessionTreeSnapshot } from "@pi-gui/session-driver/types";
import {
  type DesktopAppState,
  type ForkThreadInput,
  type NewThreadEnvironment,
  type SessionRecord,
  type WorkspaceRecord,
} from "../../../../contracts/desktop-state";
import { applySnapshotIfNewer } from "../../../app/desktop-app-state";
import type { PiDesktopApi } from "../../../../contracts/ipc";
import { resolveRepoWorkspaceId } from "../../../../contracts/workspace-roots";

interface TreeModalState {
  readonly open: boolean;
  readonly loading: boolean;
  readonly submitting: boolean;
  readonly tree?: SessionTreeSnapshot;
  readonly error?: string;
}

interface ForkModalState {
  readonly open: boolean;
  readonly submitting: boolean;
  readonly sourceMessageIndex: number;
  readonly messagePreview?: string;
  readonly error?: string;
}

interface UseTreeForkModalsParams {
  readonly api: PiDesktopApi | undefined;
  readonly snapshot: DesktopAppState | null;
  readonly setSnapshot: Dispatch<SetStateAction<DesktopAppState | null>>;
  readonly selectedWorkspace: WorkspaceRecord | undefined;
  readonly selectedSession: SessionRecord | undefined;
  readonly selectedSessionKey: string;
  readonly rootWorkspace: WorkspaceRecord | undefined;
  readonly setComposerDraft: Dispatch<SetStateAction<string>>;
  /**
   * Sends a pending debounced draft write now. Edit and Cancel go after it, so a late write
   * cannot replace the text they put in the composer.
   */
  readonly flushComposerDraft: () => void;
  readonly focusComposer: () => void;
}

/** An IPC rejection's own message, without Electron's "Error invoking remote method" prefix. */
function ipcErrorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, "");
}

export function useTreeForkModals(params: UseTreeForkModalsParams) {
  const {
    api,
    snapshot,
    setSnapshot,
    selectedWorkspace,
    selectedSession,
    selectedSessionKey,
    rootWorkspace,
    setComposerDraft,
    flushComposerDraft,
    focusComposer,
  } = params;
  const activeView = snapshot?.activeView;

  const [treeModalState, setTreeModalState] = useState<TreeModalState>({
    open: false,
    loading: false,
    submitting: false,
  });
  const [forkModalState, setForkModalState] = useState<ForkModalState>({
    open: false,
    submitting: false,
    sourceMessageIndex: -1,
  });

  const editingMessage = useRef(false);
  const [editError, setEditError] = useState<{ sessionKey: string; message: string }>();
  // Edit only puts the message in the composer; the thread rewinds when the edit is sent, so
  // Cancel (or Esc) leaves it exactly as it was and gives the earlier draft back.
  const editFromMessage = useCallback(
    (message: SessionTranscriptMessage) => {
      if (
        !api ||
        !selectedWorkspace ||
        !selectedSession ||
        selectedSession.status === "running" ||
        editingMessage.current
      )
        return;
      editingMessage.current = true;
      const sessionKey = selectedSessionKey;
      setEditError(undefined);
      // Main keeps the saved draft for Cancel to give back.
      flushComposerDraft();
      void api
        .startMessageEdit(message.sourceMessageId ?? message.id)
        .then((state) => {
          applySnapshotIfNewer(setSnapshot, state);
          focusComposer();
        })
        .catch((error: unknown) => {
          // Kept apart from lastError, which the next app snapshot replaces, so the failure
          // stays readable until the person dismisses it.
          setEditError({
            sessionKey,
            message: `Couldn't edit the message. ${ipcErrorText(error)}`,
          });
        })
        .finally(() => {
          editingMessage.current = false;
        });
    },
    [
      api,
      selectedWorkspace,
      selectedSession,
      selectedSessionKey,
      setSnapshot,
      flushComposerDraft,
      focusComposer,
    ],
  );
  const editingMessageId = snapshot?.editingMessageId;
  const cancelMessageEdit = useCallback(() => {
    if (!api) return;
    flushComposerDraft();
    void api
      .cancelMessageEdit()
      .then((state) => {
        applySnapshotIfNewer(setSnapshot, state);
        focusComposer();
      })
      .catch((error: unknown) => {
        console.error("[renderer] cancelMessageEdit failed", error);
      });
  }, [api, setSnapshot, flushComposerDraft, focusComposer]);
  const dismissEditError = useCallback(() => setEditError(undefined), []);

  const closeTreeModal = useCallback(() => {
    setTreeModalState((current) =>
      current.submitting
        ? current
        : {
            open: false,
            loading: false,
            submitting: false,
          },
    );
    focusComposer();
  }, [focusComposer]);

  const openTreeModal = useCallback(() => {
    if (!api || !selectedWorkspace || !selectedSession) {
      return;
    }

    setTreeModalState({
      open: true,
      loading: true,
      submitting: false,
    });
    setComposerDraft("");

    void api
      .getSessionTree({
        workspaceId: selectedWorkspace.id,
        sessionId: selectedSession.id,
      })
      .then((tree) => {
        setTreeModalState({
          open: true,
          loading: false,
          submitting: false,
          tree,
        });
      })
      .catch((error) => {
        setTreeModalState({
          open: true,
          loading: false,
          submitting: false,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }, [api, selectedSession, selectedWorkspace, setComposerDraft]);

  const navigateTreeSelection = useCallback(
    (
      targetId: string,
      options?: { readonly summarize?: boolean; readonly customInstructions?: string },
    ) => {
      if (!api || !selectedWorkspace || !selectedSession) {
        return;
      }

      setTreeModalState((current) => ({ ...current, submitting: true, error: undefined }));
      void api
        .navigateSessionTree(
          {
            workspaceId: selectedWorkspace.id,
            sessionId: selectedSession.id,
          },
          targetId,
          options,
        )
        .then(({ state, result }) => {
          applySnapshotIfNewer(setSnapshot, state);
          setTreeModalState({
            open: false,
            loading: false,
            submitting: false,
          });
          setComposerDraft((current) =>
            !current.trim() && result.editorText ? result.editorText : state.composerDraft,
          );
          focusComposer();
        })
        .catch((error) => {
          setTreeModalState((current) => ({
            ...current,
            submitting: false,
            error: error instanceof Error ? error.message : String(error),
          }));
        });
    },
    [api, selectedSession, selectedWorkspace, setSnapshot, setComposerDraft, focusComposer],
  );

  const closeForkModal = useCallback(() => {
    setForkModalState((current) =>
      current.submitting
        ? current
        : {
            open: false,
            submitting: false,
            sourceMessageIndex: -1,
          },
    );
  }, []);

  const openForkModal = useCallback(
    (sourceMessageIndex: number, preview?: string) => {
      if (!api || !selectedWorkspace || !selectedSession) {
        return;
      }
      const trimmed = preview?.trim();
      setForkModalState({
        open: true,
        submitting: false,
        sourceMessageIndex,
        messagePreview: trimmed ? trimmed.slice(0, 280) : undefined,
      });
    },
    [api, selectedSession, selectedWorkspace],
  );

  const handleForkSubmit = useCallback(
    (environment: NewThreadEnvironment) => {
      if (!api || !selectedWorkspace || !selectedSession) {
        return;
      }
      const rootWorkspaceId =
        (snapshot
          ? resolveRepoWorkspaceId(snapshot.workspaces, selectedWorkspace.id)
          : undefined) ?? selectedWorkspace.id;
      const input: ForkThreadInput = {
        sourceWorkspaceId: selectedWorkspace.id,
        sourceSessionId: selectedSession.id,
        rootWorkspaceId,
        environment,
        sourceMessageIndex: forkModalState.sourceMessageIndex,
        position: "after",
      };
      setForkModalState((current) => ({ ...current, submitting: true, error: undefined }));
      void api
        .forkThread(input)
        .then((state) => {
          applySnapshotIfNewer(setSnapshot, state);
          setForkModalState({
            open: false,
            submitting: false,
            sourceMessageIndex: -1,
          });
          focusComposer();
        })
        .catch((error) => {
          setForkModalState((current) => ({
            ...current,
            submitting: false,
            error: error instanceof Error ? error.message : String(error),
          }));
        });
    },
    [
      api,
      forkModalState.sourceMessageIndex,
      selectedSession,
      selectedWorkspace,
      snapshot,
      setSnapshot,
      focusComposer,
    ],
  );

  useEffect(() => {
    setTreeModalState((current) =>
      current.open
        ? {
            open: false,
            loading: false,
            submitting: false,
          }
        : current,
    );
  }, [selectedSessionKey, activeView]);

  return {
    treeModalState,
    forkModalState,
    closeTreeModal,
    openTreeModal,
    navigateTreeSelection,
    closeForkModal,
    openForkModal,
    editFromMessage: selectedSession?.status === "running" ? undefined : editFromMessage,
    cancelMessageEdit: editingMessageId ? cancelMessageEdit : undefined,
    /** A failed Edit for the selected thread, shown until dismissed or the next Edit. */
    editError: editError?.sessionKey === selectedSessionKey ? editError.message : undefined,
    dismissEditError,
    handleForkSubmit,
    canUseWorktree: rootWorkspace !== undefined && rootWorkspace.kind !== "chats",
  };
}
