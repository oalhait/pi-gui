import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { SessionRef, WorkspaceRef } from "@pi-gui/session-driver";

/**
 * Pi publishes message_end before append; turn_end supplies the persisted identities: the
 * turn's assistant entry and any user entries Pi appended since the turn started.
 */
export function createTranscriptIdentityExtension(options: {
  readonly workspace: WorkspaceRef;
  readonly onPersisted: (
    sessionRef: SessionRef,
    persisted: { readonly userEntryIds: readonly string[]; readonly assistantEntryId: string },
  ) => void;
}): ExtensionFactory {
  return (pi) => {
    // A prompt, steer or follow-up is appended after turn_start and before turn_end.
    let turnStartLeafId: string | null = null;
    pi.on("turn_start", (_event, context) => {
      turnStartLeafId = context.sessionManager.getLeafId();
    });
    pi.on("turn_end", (event, context) => {
      const branch = context.sessionManager.getBranch();
      const start =
        turnStartLeafId === null ? -1 : branch.findIndex((entry) => entry.id === turnStartLeafId);
      // The branch moved under the turn (a tree navigation): report no user entries.
      const branchChanged = turnStartLeafId !== null && start < 0;
      const userEntryIds = (branchChanged ? [] : branch.slice(start + 1))
        .filter((entry) => entry.type === "message" && entry.message.role === "user")
        .map((entry) => entry.id);
      options.onPersisted(
        {
          workspaceId: options.workspace.workspaceId,
          sessionId: context.sessionManager.getSessionId(),
        },
        { userEntryIds, assistantEntryId: event.messageEntryId },
      );
    });
  };
}
