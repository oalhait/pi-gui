import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkspaceRecord } from "../../../contracts/desktop-state";
import type { PiDesktopApi } from "../../../contracts/ipc";
import { FileExplorer } from "./file-explorer";

interface FileWorkbenchProps {
  readonly api: PiDesktopApi;
  readonly workspace: WorkspaceRecord;
  readonly sessionStatus: string | undefined;
  /** The file tab most recently shown, revealed in the tree. */
  readonly selectedPath: string | null;
  /** Opens or focuses the file's own tab. */
  readonly onOpenFile: (path: string) => void;
}

/** The Files tab: this checkout's file tree. Each opened file gets its own tab. */
export function FileWorkbench({
  api,
  workspace,
  sessionStatus,
  selectedPath,
  onOpenFile,
}: FileWorkbenchProps) {
  const [files, setFiles] = useState<readonly string[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const refresh = useCallback(
    (options: { readonly force?: boolean } = {}) => {
      const requestId = ++requestIdRef.current;
      setLoading(true);
      setListError(null);
      void api
        .listWorkspaceFiles(workspace.id, { force: options.force ?? false })
        .then((listed) => {
          if (requestIdRef.current !== requestId) {
            return;
          }
          setFiles(listed);
        })
        .catch((error: unknown) => {
          if (requestIdRef.current !== requestId) {
            return;
          }
          console.error("[renderer] listWorkspaceFiles failed", error);
          setListError("Couldn't load files");
        })
        .finally(() => {
          if (requestIdRef.current !== requestId) {
            return;
          }
          setLoading(false);
        });
    },
    [api, workspace.id],
  );

  const prevStatusRef = useRef(sessionStatus);
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = sessionStatus;
    if (prev === "running" && sessionStatus !== "running") {
      refresh({ force: true });
    }
  }, [refresh, sessionStatus]);

  useEffect(() => {
    setFiles(null);
    setListError(null);
    refresh();
    return () => {
      requestIdRef.current += 1;
    };
  }, [refresh]);

  return (
    <section className="side-panel file-workbench" data-testid="file-workbench">
      <FileExplorer
        viewStateKey={workspace.id}
        error={listError}
        files={files}
        loading={loading}
        selectedPath={selectedPath}
        onRefresh={() => refresh({ force: true })}
        onSelect={(path) => {
          onOpenFile(path);
          // The tree leaves with the Files tab; keep keyboard focus on the opened file's tab.
          window.requestAnimationFrame(() =>
            document
              .querySelector<HTMLElement>('#task-workbench [role="tab"][aria-selected="true"]')
              ?.focus(),
          );
        }}
      />
    </section>
  );
}
