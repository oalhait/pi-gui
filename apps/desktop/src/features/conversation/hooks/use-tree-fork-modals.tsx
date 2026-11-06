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
  type AppView,
  type DesktopAppState,
  type ForkThreadInput,
  type NewThreadEnvironment,
  type SessionRecord,
  type WorkspaceRecord,
} from "../../../../contracts/desktop-state";
import { applySnapshotIfNewer } from "../../../app/desktop-app-state";
import type { PiDesktopApi } from "../../../../contracts/ipc";
import { resolveRepoWorkspaceId } from "../../../../contracts/workspace-roots";
import { stripThreadReferences } from "../../../../contracts/thread-references";

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
  readonly activeView: AppView | undefined;
  readonly setComposerDraft: Dispatch<SetStateAction<string>>;
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
    activeView,
    setComposerDraft,
    focusComposer,
  } = params;

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
      // Rewind in place, as pi's /tree does for a user entry: the thread moves to just before
      // the message, its text returns to the composer, and later turns stay in /tree.
      void api
        .rewindToMessage(
          { workspaceId: selectedWorkspace.id, sessionId: selectedSession.id },
          message.sourceMessageId ?? message.id,
        )
        .then(async ({ state, result }) => {
          applySnapshotIfNewer(setSnapshot, state);
          if (result.cancelled || result.aborted) return;
          // Sending again adds the mentioned threads' ids back.
          setComposerDraft(stripThreadReferences(result.editorText ?? ""));
          if (message.attachments?.length) {
            const attachments = message.attachments.map((attachment) => ({
              ...attachment,
              name: attachment.name ?? "Image",
              id: crypto.randomUUID(),
            }));
            applySnapshotIfNewer(setSnapshot, await api.addComposerAttachments(attachments));
          }
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
      setComposerDraft,
      focusComposer,
    ],
  );
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
    /** A failed Edit for the selected thread, shown until dismissed or the next Edit. */
    editError: editError?.sessionKey === selectedSessionKey ? editError.message : undefined,
    dismissEditError,
    handleForkSubmit,
    canUseWorktree: Boolean(rootWorkspace),
  };
}
