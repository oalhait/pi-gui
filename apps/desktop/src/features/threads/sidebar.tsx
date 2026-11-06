import {
  createContext,
  forwardRef,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type MutableRefObject,
} from "react";
import { createPortal } from "react-dom";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DraggableAttributes,
  type DraggableSyntheticListeners,
  type DragEndEvent,
  type DragStartEvent,
  type Modifier,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type {
  AppView,
  SessionRecord,
  ThreadGrouping,
  WorkspaceRecord,
  WorktreeRecord,
} from "../../../contracts/desktop-state";
import {
  ArchiveIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CustomizeSidebarIcon,
  ExtensionIcon,
  FolderIcon,
  PinIcon,
  PlusIcon,
  RestoreIcon,
  SettingsIcon,
  SkillIcon,
  ClockIcon,
  WorktreeIcon,
} from "../../ui/icons";
import {
  getDesktopShortcutLabel,
  THREAD_SHORTCUT_SLOT_COUNT,
  type PiDesktopApi,
} from "../../../contracts/ipc";
import { formatRelativeTime } from "../../lib/string-utils";
import { PaneResizeHandle, type PaneWidthBounds } from "../../ui/pane-resize-handle";
import { usePersistedPaneWidth } from "../../ui/use-persisted-pane-width";
import { sessionLastInteractedAt } from "../../../contracts/thread-recency";
import type { WorkspaceMenuState } from "./hooks/use-workspace-menu";
import type { ThreadMenuState } from "./hooks/use-thread-actions";
import { archiveThreadShortcut, ThreadActionsMenu } from "./thread-actions";
import {
  recencyHistoryExpansionKey,
  TOP_LEVEL_HISTORY_EXPANSION_KEY,
  flattenThreadTrees,
  sessionThreadKey,
  threadHistoryPreview,
  visibleThreadShortcutOrder,
  workspaceHistoryExpansionKey,
  type RecencyThreadSection,
  type ThreadSidebarModel,
  type ThreadListEntry,
  type WorkspaceThreadGroup,
} from "./thread-groups";
import { useThreadShortcutHintsVisible } from "./thread-shortcut-hints";
import type { Dispatch, SetStateAction } from "react";
import type { DesktopAppState } from "../../../contracts/desktop-state";
import { applySnapshotIfNewer } from "../../app/desktop-app-state";

interface SidebarProps {
  readonly activeView: AppView;
  readonly selectedWorkspace: WorkspaceRecord | undefined;
  readonly selectedSession: SessionRecord | undefined;
  readonly visibleWorkspaces: readonly WorkspaceRecord[];
  readonly threadSidebarModel: ThreadSidebarModel;
  readonly threadGrouping: ThreadGrouping;
  readonly collapsedWorkspaceIds: readonly string[];
  readonly linkedWorktreeByWorkspaceId: ReadonlyMap<string, WorktreeRecord>;
  readonly wsMenu: WorkspaceMenuState;
  readonly threadMenu: ThreadMenuState;
  readonly api: PiDesktopApi;
  readonly setSnapshot: Dispatch<SetStateAction<DesktopAppState | null>>;
  readonly updateSnapshot: (
    setSnapshot: Dispatch<SetStateAction<DesktopAppState | null>>,
    action: () => Promise<DesktopAppState>,
  ) => Promise<DesktopAppState>;
  readonly onNewThread: (workspaceId?: string) => void;
  readonly onSetActiveView: (view: AppView) => void;
  readonly onOpenSkills: (workspaceId?: string) => void;
  readonly onOpenExtensions: (workspaceId?: string) => void;
  readonly onOpenSettings: (workspaceId?: string) => void;
  readonly onArchiveSession: (target: { workspaceId: string; sessionId: string }) => void;
  readonly onSelectSession: (target: { workspaceId: string; sessionId: string }) => void;
  readonly onSetSessionPinned: (
    target: { workspaceId: string; sessionId: string },
    pinned: boolean,
  ) => void;
  readonly onUnarchiveSession: (target: { workspaceId: string; sessionId: string }) => void;
  readonly threadShortcutOrderRef: MutableRefObject<readonly ThreadListEntry[] | null>;
}

const SIDEBAR_WIDTH_RANGE = { min: 200, max: 520 } as const;

function sidebarWidthBounds(_sidebar: HTMLElement, shell: HTMLElement): PaneWidthBounds {
  return {
    min: SIDEBAR_WIDTH_RANGE.min,
    max: Math.floor(Math.min(SIDEBAR_WIDTH_RANGE.max, shell.clientWidth * 0.45)),
  };
}

const IS_MAC = typeof navigator !== "undefined" && /Mac/i.test(navigator.userAgent);

interface ThreadShortcutBadge {
  readonly slot: number;
  readonly label: string;
}

const ThreadListContext = createContext<
  | {
      readonly shortcuts: ReadonlyMap<string, ThreadShortcutBadge> | undefined;
      readonly props: SidebarProps;
      readonly collapsed: ReadonlySet<string>;
      readonly toggle: (key: string) => void;
    }
  | undefined
>(undefined);

export function Sidebar(props: SidebarProps) {
  const {
    activeView,
    selectedWorkspace,
    selectedSession,
    visibleWorkspaces,
    threadSidebarModel,
    threadGrouping,
    collapsedWorkspaceIds,
    linkedWorktreeByWorkspaceId,
    wsMenu,
    threadMenu,
    api,
    setSnapshot,
    updateSnapshot,
    onNewThread,
    onSetActiveView,
    onOpenSkills,
    onOpenExtensions,
    onOpenSettings,
    onArchiveSession,
    onSelectSession,
    onSetSessionPinned,
    onUnarchiveSession,
    threadShortcutOrderRef,
  } = props;

  const [sidebarWidth, setSidebarWidth] = usePersistedPaneWidth(
    "pi-gui.sidebar-width",
    SIDEBAR_WIDTH_RANGE,
  );
  const sidebarWidthStyle: (CSSProperties & { "--sidebar-width": string }) | undefined =
    sidebarWidth === undefined ? undefined : { "--sidebar-width": `${sidebarWidth}px` };
  const [activeId, setActiveId] = useState<string | null>(null);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [expandedHistory, setExpandedHistory] = useState<ReadonlySet<string>>(() => new Set());
  const [collapsedThreads, setCollapsedThreads] = useState<ReadonlySet<string>>(() => new Set());
  const toggleThread = (key: string) =>
    setCollapsedThreads((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const commandHeld = useThreadShortcutHintsVisible(api.platform);
  const collapsedFolderIds = new Set(collapsedWorkspaceIds);
  const setFolderCollapsed = (workspaceId: string, collapsed: boolean) => {
    void updateSnapshot(setSnapshot, () => api.setWorkspaceCollapsed(workspaceId, collapsed)).catch(
      (error: unknown) => {
        console.error("[renderer] setWorkspaceCollapsed failed", error);
      },
    );
  };
  const topLevelThreads = threadSidebarModel.topLevelThreads;
  const shortcutOrder = visibleThreadShortcutOrder({
    grouping: threadGrouping,
    model: threadSidebarModel,
    expandedHistory,
    archivedOpen,
    collapsedWorkspaceIds,
    collapsedThreadKeys: collapsedThreads,
  });
  threadShortcutOrderRef.current = shortcutOrder;
  const shortcutByKey = commandHeld
    ? new Map(
        shortcutOrder.slice(0, THREAD_SHORTCUT_SLOT_COUNT).map((thread, index) => {
          const slot = index + 1;
          return [
            sessionThreadKey(thread),
            { slot, label: getDesktopShortcutLabel(api.platform, String(slot)) },
          ] as const;
        }),
      )
    : undefined;

  useEffect(() => {
    return () => {
      threadShortcutOrderRef.current = null;
    };
  }, [threadShortcutOrderRef]);

  // Rename can start from the header, Cmd-K or its shortcut, so reveal the
  // row that holds the rename field when it sits in a collapsed group.
  const renameSessionId = threadMenu.renameSessionId;
  useEffect(() => {
    if (!renameSessionId) return;
    const holds = (threads: readonly ThreadListEntry[]) =>
      flattenThreadTrees(threads).some((thread) => thread.session.id === renameSessionId);
    if (holds(threadSidebarModel.archivedThreads)) {
      setArchivedOpen(true);
      return;
    }
    const keys = [
      ...threadSidebarModel.recencySections
        .filter((section) => holds(section.threads))
        .map((section) => recencyHistoryExpansionKey(section.bucket)),
      ...threadSidebarModel.workspaceGroups
        .filter((group) => holds(group.threads))
        .map((group) => workspaceHistoryExpansionKey(group.workspace.id)),
      ...(holds(topLevelThreads) ? [TOP_LEVEL_HISTORY_EXPANSION_KEY] : []),
    ];
    setExpandedHistory((current) =>
      keys.every((key) => current.has(key)) ? current : new Set([...current, ...keys]),
    );
    // A folded folder hides the rename field; open it so the input is reachable.
    // Time grouping shows no folder threads, so leave the folded set alone there.
    for (const group of threadGrouping === "workspace" ? threadSidebarModel.workspaceGroups : []) {
      if (holds(group.threads) && collapsedFolderIds.has(group.workspace.id)) {
        setFolderCollapsed(group.workspace.id, false);
      }
    }
    // Reveal once per rename; later list changes should not reopen groups.
  }, [renameSessionId]);

  // Reveal ancestors when another surface selects or renames a nested thread. It runs
  // once per target and ancestor path, so a parent the user collapses stays collapsed
  // through later state pushes; a path that changes (links arriving late) reveals again.
  const revealedPathRef = useRef<{ select?: string; rename?: string }>({});
  useEffect(() => {
    const entries = new Map(
      threadSidebarModel.recencyOrder.map((entry) => [sessionThreadKey(entry), entry]),
    );
    let entry = renameSessionId
      ? threadSidebarModel.recencyOrder.find((item) => item.session.id === renameSessionId)
      : entries.get(`${selectedWorkspace?.id}:${selectedSession?.id}`);
    const target = entry ? sessionThreadKey(entry) : "";
    const ancestors = new Set<string>();
    while (entry?.parentKey && !ancestors.has(entry.parentKey)) {
      ancestors.add(entry.parentKey);
      entry = entries.get(entry.parentKey);
    }
    // Rename and selection reveal separately: renaming the selected thread needs its row
    // mounted, and ending a rename must not reopen what the user collapsed since.
    const path = [target, ...ancestors].join("\n");
    const kind = renameSessionId ? "rename" : "select";
    // Each rename is its own reveal, even of the same thread.
    if (!renameSessionId) revealedPathRef.current = { select: revealedPathRef.current.select };
    if (revealedPathRef.current[kind] === path) return;
    revealedPathRef.current = { ...revealedPathRef.current, [kind]: path };
    setCollapsedThreads((current) => {
      if (![...ancestors].some((key) => current.has(key))) return current;
      return new Set([...current].filter((key) => !ancestors.has(key)));
    });
  }, [
    selectedWorkspace?.id,
    selectedSession?.id,
    renameSessionId,
    threadSidebarModel.recencyOrder,
  ]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const pinnedSortableId = (thread: ThreadListEntry) => `pinned:${sessionThreadKey(thread)}`;
  const pinnedSessionKeyFromSortableId = (id: string) =>
    id.startsWith("pinned:") ? id.slice("pinned:".length) : id;
  // recencyOrder holds every unarchived thread, nested ones included.
  const threadByKey = new Map(
    threadSidebarModel.recencyOrder.map((thread) => [sessionThreadKey(thread), thread] as const),
  );
  const threadByDndId = (id: string) =>
    id.startsWith(THREAD_DND_PREFIX)
      ? threadByKey.get(id.slice(THREAD_DND_PREFIX.length))
      : undefined;
  /** The thread a drop on this row would nest under: history rows, and pinned rows too. */
  const dropTargetThread = (id: string) =>
    threadByDndId(id) ??
    (id.startsWith("pinned:") ? threadByKey.get(pinnedSessionKeyFromSortableId(id)) : undefined);

  // Collision detection based on workspace row headers only (~30px top of each group),
  // not the full group height including all sessions.
  const headerCollision: CollisionDetection = (args) => {
    if (String(args.active.id).startsWith(THREAD_DND_PREFIX)) {
      // A thread drops onto the row under the pointer, never onto itself or its own children.
      const pointer = args.pointerCoordinates;
      const dragged = threadByDndId(String(args.active.id));
      if (!pointer || !dragged) return [];
      const excluded = descendantKeys(dragged);
      excluded.add(sessionThreadKey(dragged));
      for (const container of args.droppableContainers) {
        const target = dropTargetThread(String(container.id));
        const rect = container.rect.current;
        if (!target || !rect || excluded.has(sessionThreadKey(target))) continue;
        const inside =
          pointer.x >= rect.left &&
          pointer.x <= rect.left + rect.width &&
          pointer.y >= rect.top &&
          pointer.y <= rect.top + rect.height;
        if (inside) return [{ id: container.id, data: { droppableContainer: container } }];
      }
      return [];
    }
    if (String(args.active.id).startsWith("pinned:")) {
      const pointerY = args.pointerCoordinates?.y;
      if (pointerY == null) return [];
      let closest: { id: string; distance: number } | null = null;
      for (const container of args.droppableContainers) {
        const containerId = String(container.id);
        if (!containerId.startsWith("pinned:") || containerId === String(args.active.id)) {
          continue;
        }
        const rect = container.rect.current;
        if (!rect) continue;
        const rowCenter = rect.top + rect.height / 2;
        const distance = Math.abs(pointerY - rowCenter);
        if (!closest || distance < closest.distance) {
          closest = { id: containerId, distance };
        }
      }
      return closest
        ? [
            {
              id: closest.id,
              data: {
                droppableContainer: args.droppableContainers.find(
                  (c) => String(c.id) === closest!.id,
                )!,
              },
            },
          ]
        : [];
    }
    const pointerY = args.pointerCoordinates?.y;
    if (pointerY == null) return [];

    let closest: { id: string; distance: number } | null = null;
    for (const container of args.droppableContainers) {
      const containerId = String(container.id);
      if (containerId.startsWith("pinned:") || containerId.startsWith(THREAD_DND_PREFIX)) {
        continue;
      }
      const rect = container.rect.current;
      if (!rect) continue;
      const headerCenter = rect.top + 15; // center of the ~30px workspace row header
      const distance = Math.abs(pointerY - headerCenter);
      if (!closest || distance < closest.distance) {
        closest = { id: String(container.id), distance };
      }
    }
    return closest
      ? [
          {
            id: closest.id,
            data: {
              droppableContainer: args.droppableContainers.find(
                (c) => String(c.id) === closest!.id,
              )!,
            },
          },
        ]
      : [];
  };

  // recencyOrder holds every unarchived thread, including children nested under another folder's parent.
  const folderHasThreads = (folderId: string) =>
    threadSidebarModel.recencyOrder.some((thread) => thread.folderId === folderId) ||
    threadSidebarModel.archivedThreads.some((thread) => thread.folderId === folderId);
  const showFolderRow = (group: WorkspaceThreadGroup) =>
    threadGrouping === "workspace" || !folderHasThreads(group.workspace.id);
  const rootGroups = threadSidebarModel.workspaceGroups.filter(
    (group) => group.workspace.kind === "primary" && showFolderRow(group),
  );
  const orphanGroups = threadSidebarModel.workspaceGroups.filter(
    (group) => group.workspace.kind !== "primary" && showFolderRow(group),
  );
  const pinnedThreads = threadSidebarModel.pinnedThreads;
  const pinnedSortableIds = pinnedThreads.map(pinnedSortableId);
  const rootGroupIds = rootGroups.map((group) => group.workspace.id);
  const canDrag = rootGroups.length > 1;

  function handleDragStart(event: DragStartEvent) {
    setActiveId(String(event.active.id));
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveId(null);
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const dragged = threadByDndId(String(active.id));
    if (dragged) {
      const parent = dropTargetThread(String(over.id));
      if (!parent || dragged.parentKey === sessionThreadKey(parent)) return;
      void updateSnapshot(setSnapshot, () =>
        api.setThreadParent({
          workspaceId: dragged.workspaceId,
          sessionId: dragged.session.id,
          parent: { workspaceId: parent.workspaceId, sessionId: parent.session.id },
        }),
      ).catch((error: unknown) => {
        console.error("[renderer] setThreadParent failed", error);
      });
      return;
    }

    if (String(active.id).startsWith("pinned:")) {
      const oldIndex = pinnedSortableIds.indexOf(String(active.id));
      const newIndex = pinnedSortableIds.indexOf(String(over.id));
      if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) return;

      const newOrder = arrayMove(pinnedSortableIds, oldIndex, newIndex).map(
        pinnedSessionKeyFromSortableId,
      );
      applyOptimisticReorder("pinnedSessionOrder", newOrder, () =>
        api.reorderPinnedSessions(newOrder),
      );
      return;
    }

    const oldIndex = rootGroupIds.indexOf(String(active.id));
    const newIndex = rootGroupIds.indexOf(String(over.id));
    if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) return;

    const newOrder = arrayMove(rootGroupIds, oldIndex, newIndex);
    applyOptimisticReorder("workspaceOrder", newOrder, () => api.reorderWorkspaces(newOrder));
  }

  // Optimistically update local state to avoid snap-back animation, then reconcile with the
  // authoritative state the IPC call returns; on rejection, put back only the previous order.
  // Neither path may restore an older whole snapshot: pushes only carry the model catalog when
  // it changes, so an older snapshot would leave an old catalog in the window.
  function applyOptimisticReorder(
    field: "workspaceOrder" | "pinnedSessionOrder",
    order: readonly string[],
    commit: () => Promise<DesktopAppState>,
  ) {
    let previousOrder: readonly string[] | undefined;
    setSnapshot((prev) => {
      previousOrder = prev?.[field];
      return prev ? { ...prev, [field]: order } : prev;
    });
    void commit().then(
      (state) => applySnapshotIfNewer(setSnapshot, state),
      () =>
        setSnapshot((current) =>
          current && previousOrder && current[field] === order
            ? { ...current, [field]: previousOrder }
            : current,
        ),
    );
  }

  const activeFolder = activeId
    ? rootGroups.find((group) => group.workspace.id === activeId)?.workspace
    : undefined;
  const activeThread = activeId ? threadByDndId(activeId) : undefined;
  const activePinnedThread = activeId?.startsWith("pinned:")
    ? pinnedThreads.find((thread) => pinnedSortableId(thread) === activeId)
    : undefined;

  function toggleHistoryExpanded(key: string) {
    setExpandedHistory((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  return (
    <aside className="sidebar" id="primary-sidebar" style={sidebarWidthStyle}>
      <PaneResizeHandle
        className="sidebar__resize-handle"
        label="Sidebar width"
        controls="primary-sidebar"
        edge="right"
        bounds={sidebarWidthBounds}
        onResize={setSidebarWidth}
        onReset={() => setSidebarWidth(undefined)}
      />
      <div className="sidebar__top">
        <button
          className="sidebar__new"
          type="button"
          disabled={!selectedWorkspace}
          onClick={() => onNewThread()}
        >
          <PlusIcon />
          <span>New thread</span>
        </button>

        <div className="sidebar__nav">
          <button
            className={`sidebar__nav-item ${activeView === "threads" ? "sidebar__nav-item--active" : ""}`}
            type="button"
            onClick={() => onSetActiveView("threads")}
          >
            <FolderIcon />
            <span>Threads</span>
          </button>
          <button
            className={`sidebar__nav-item ${activeView === "scheduled" ? "sidebar__nav-item--active" : ""}`}
            type="button"
            data-testid="sidebar-scheduled"
            onClick={() => onSetActiveView("scheduled")}
          >
            <ClockIcon />
            <span>Scheduled</span>
          </button>
          <button
            className="sidebar__nav-item"
            type="button"
            onClick={() =>
              onOpenSkills(selectedWorkspace?.rootWorkspaceId ?? selectedWorkspace?.id)
            }
          >
            <SkillIcon />
            <span>Skills</span>
          </button>
          <button
            className="sidebar__nav-item"
            type="button"
            onClick={() =>
              onOpenExtensions(selectedWorkspace?.rootWorkspaceId ?? selectedWorkspace?.id)
            }
          >
            <ExtensionIcon />
            <span>Extensions</span>
          </button>
          <button
            className="sidebar__nav-item"
            type="button"
            onClick={() =>
              onOpenSettings(selectedWorkspace?.rootWorkspaceId ?? selectedWorkspace?.id)
            }
          >
            <SettingsIcon />
            <span>Settings</span>
          </button>
        </div>
      </div>

      <div className="sidebar__section">
        <div className="section__head">
          <span>Threads</span>
          <div className="section__tools">
            <ThreadGroupingControl
              grouping={threadGrouping}
              onChange={(grouping) => {
                void updateSnapshot(setSnapshot, () => api.setThreadGrouping(grouping)).catch(
                  (error: unknown) => {
                    console.error("[renderer] setThreadGrouping failed", error);
                  },
                );
              }}
            />
            <button
              aria-label="Open folder"
              className="icon-button"
              type="button"
              onClick={() => {
                void updateSnapshot(setSnapshot, () => api.pickWorkspace()).catch(
                  (error: unknown) => {
                    console.error("[renderer] pickWorkspace failed", error);
                  },
                );
              }}
            >
              <FolderIcon />
            </button>
          </div>
        </div>

        {visibleWorkspaces.length === 0 &&
        threadSidebarModel.recencyOrder.length === 0 &&
        threadSidebarModel.archivedThreads.length === 0 ? (
          <div className="empty-state" data-testid="empty-state">
            <h2>No folders yet</h2>
            <p>Start a chat with New thread, or open a project folder to work in it.</p>
            <button
              className="button button--primary"
              type="button"
              onClick={() => {
                void updateSnapshot(setSnapshot, () => api.pickWorkspace()).catch(
                  (error: unknown) => {
                    console.error("[renderer] pickWorkspace failed", error);
                  },
                );
              }}
            >
              Open first folder
            </button>
          </div>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={headerCollision}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
          >
            <ThreadListContext.Provider
              value={{
                shortcuts: shortcutByKey,
                props,
                collapsed: collapsedThreads,
                toggle: toggleThread,
              }}
            >
              <div className="workspace-list" data-testid="workspace-list">
                {pinnedThreads.length > 0 ? (
                  <PinnedThreadsSection
                    pinnedThreads={pinnedThreads}
                    sortableIds={pinnedSortableIds}
                    sortableIdForThread={pinnedSortableId}
                    selectedWorkspace={selectedWorkspace}
                    selectedSession={selectedSession}
                    threadMenu={threadMenu}
                    onArchiveSession={onArchiveSession}
                    onSelectSession={onSelectSession}
                    onSetSessionPinned={onSetSessionPinned}
                  />
                ) : null}
                {threadGrouping === "workspace" && topLevelThreads.length > 0 ? (
                  <TopLevelThreadsView
                    threads={topLevelThreads}
                    historyExpanded={expandedHistory.has(TOP_LEVEL_HISTORY_EXPANSION_KEY)}
                    onToggleHistory={() => toggleHistoryExpanded(TOP_LEVEL_HISTORY_EXPANSION_KEY)}
                    selectedWorkspace={selectedWorkspace}
                    selectedSession={selectedSession}
                    threadMenu={threadMenu}
                    onArchiveSession={onArchiveSession}
                    onSelectSession={onSelectSession}
                    onSetSessionPinned={onSetSessionPinned}
                  />
                ) : null}
                <SortableContext items={rootGroupIds} strategy={verticalListSortingStrategy}>
                  {rootGroups.map((group) => (
                    <SortableWorkspaceFolder
                      key={group.workspace.id}
                      workspace={group.workspace}
                      threads={threadGrouping === "workspace" ? group.threads : undefined}
                      historyExpanded={expandedHistory.has(
                        workspaceHistoryExpansionKey(group.workspace.id),
                      )}
                      onToggleHistory={() =>
                        toggleHistoryExpanded(workspaceHistoryExpansionKey(group.workspace.id))
                      }
                      collapsed={collapsedFolderIds.has(group.workspace.id)}
                      onToggleCollapsed={() =>
                        setFolderCollapsed(
                          group.workspace.id,
                          !collapsedFolderIds.has(group.workspace.id),
                        )
                      }
                      canDrag={canDrag}
                      selectedWorkspace={selectedWorkspace}
                      selectedSession={selectedSession}
                      linkedWorktreeByWorkspaceId={linkedWorktreeByWorkspaceId}
                      wsMenu={wsMenu}
                      api={api}
                      threadMenu={threadMenu}
                      onNewThread={onNewThread}
                      onArchiveSession={onArchiveSession}
                      onSelectSession={onSelectSession}
                      onSetSessionPinned={onSetSessionPinned}
                    />
                  ))}
                </SortableContext>
                {orphanGroups.map((group) => (
                  <section
                    key={group.workspace.id}
                    className="workspace-group"
                    data-workspace-id={group.workspace.id}
                  >
                    <WorkspaceFolderContent
                      workspace={group.workspace}
                      threads={threadGrouping === "workspace" ? group.threads : undefined}
                      historyExpanded={expandedHistory.has(
                        workspaceHistoryExpansionKey(group.workspace.id),
                      )}
                      onToggleHistory={() =>
                        toggleHistoryExpanded(workspaceHistoryExpansionKey(group.workspace.id))
                      }
                      collapsed={collapsedFolderIds.has(group.workspace.id)}
                      onToggleCollapsed={() =>
                        setFolderCollapsed(
                          group.workspace.id,
                          !collapsedFolderIds.has(group.workspace.id),
                        )
                      }
                      canDrag={false}
                      selectedWorkspace={selectedWorkspace}
                      selectedSession={selectedSession}
                      linkedWorktreeByWorkspaceId={linkedWorktreeByWorkspaceId}
                      wsMenu={wsMenu}
                      api={api}
                      threadMenu={threadMenu}
                      onNewThread={onNewThread}
                      onArchiveSession={onArchiveSession}
                      onSelectSession={onSelectSession}
                      onSetSessionPinned={onSetSessionPinned}
                    />
                  </section>
                ))}
                {threadGrouping === "time"
                  ? threadSidebarModel.recencySections.map((section) => (
                      <RecencyThreadSectionView
                        key={section.bucket}
                        section={section}
                        historyExpanded={expandedHistory.has(
                          recencyHistoryExpansionKey(section.bucket),
                        )}
                        onToggleHistory={() =>
                          toggleHistoryExpanded(recencyHistoryExpansionKey(section.bucket))
                        }
                        selectedWorkspace={selectedWorkspace}
                        selectedSession={selectedSession}
                        threadMenu={threadMenu}
                        onArchiveSession={onArchiveSession}
                        onSelectSession={onSelectSession}
                        onSetSessionPinned={onSetSessionPinned}
                      />
                    ))
                  : null}
                {threadSidebarModel.archivedThreads.length > 0 ? (
                  <ArchivedThreadsSection
                    archivedThreads={threadSidebarModel.archivedThreads}
                    open={archivedOpen}
                    onToggle={() => setArchivedOpen((current) => !current)}
                    selectedWorkspace={selectedWorkspace}
                    selectedSession={selectedSession}
                    threadMenu={threadMenu}
                    onUnarchiveSession={onUnarchiveSession}
                    onSelectSession={onSelectSession}
                    onSetSessionPinned={onSetSessionPinned}
                  />
                ) : null}
              </div>
              <DragOverlay modifiers={activeThread ? [besidePointer] : undefined}>
                {activeThread ? (
                  <div className="thread-drag-pill">{activeThread.session.title}</div>
                ) : activePinnedThread ? (
                  <ThreadSessionRow
                    active={
                      activePinnedThread.workspaceId === selectedWorkspace?.id &&
                      activePinnedThread.session.id === selectedSession?.id
                    }
                    thread={activePinnedThread}
                    showContext
                    overlay
                    onAction={() => undefined}
                    onSelect={() => undefined}
                    onTogglePinned={() => undefined}
                  />
                ) : activeFolder ? (
                  <div className="workspace-group workspace-group--overlay">
                    <WorkspaceFolderContent
                      workspace={activeFolder}
                      canDrag={false}
                      selectedWorkspace={selectedWorkspace}
                      linkedWorktreeByWorkspaceId={linkedWorktreeByWorkspaceId}
                      wsMenu={wsMenu}
                      api={api}
                    />
                  </div>
                ) : null}
              </DragOverlay>
            </ThreadListContext.Provider>
          </DndContext>
        )}
      </div>
    </aside>
  );
}

/* ── Sortable workspace folder ─────────────────────────── */

interface WorkspaceFolderProps {
  readonly workspace: WorkspaceRecord;
  readonly threads?: readonly ThreadListEntry[];
  readonly historyExpanded?: boolean;
  readonly onToggleHistory?: () => void;
  readonly collapsed?: boolean;
  readonly onToggleCollapsed?: () => void;
  readonly canDrag: boolean;
  readonly selectedWorkspace: WorkspaceRecord | undefined;
  readonly selectedSession?: SessionRecord;
  readonly linkedWorktreeByWorkspaceId: ReadonlyMap<string, WorktreeRecord>;
  readonly wsMenu: WorkspaceMenuState;
  readonly api: PiDesktopApi;
  readonly threadMenu?: ThreadMenuState;
  readonly onNewThread?: (workspaceId: string) => void;
  readonly onArchiveSession?: (target: { workspaceId: string; sessionId: string }) => void;
  readonly onSelectSession?: (target: { workspaceId: string; sessionId: string }) => void;
  readonly onSetSessionPinned?: (
    target: { workspaceId: string; sessionId: string },
    pinned: boolean,
  ) => void;
}

function SortableWorkspaceFolder(props: WorkspaceFolderProps) {
  const { workspace, wsMenu } = props;
  const isRenaming = wsMenu.workspaceRenameId === workspace.id;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: workspace.id,
    disabled: isRenaming,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.3 : undefined,
  };

  return (
    <section
      ref={setNodeRef}
      style={style}
      className={`workspace-group ${isDragging ? "workspace-group--dragging" : ""}`}
      data-workspace-id={workspace.id}
    >
      <WorkspaceFolderContent
        {...props}
        dragHandleProps={props.canDrag && !isRenaming ? { attributes, listeners } : undefined}
      />
    </section>
  );
}

interface DragHandleProps {
  readonly attributes: DraggableAttributes;
  readonly listeners: DraggableSyntheticListeners;
}

function WorkspaceFolderContent(
  props: WorkspaceFolderProps & { readonly dragHandleProps?: DragHandleProps },
) {
  const {
    workspace,
    threads,
    historyExpanded = false,
    onToggleHistory,
    collapsed = false,
    onToggleCollapsed,
    selectedWorkspace,
    selectedSession,
    linkedWorktreeByWorkspaceId,
    wsMenu,
    api,
    threadMenu,
    onNewThread,
    onArchiveSession,
    onSelectSession,
    onSetSessionPinned,
    dragHandleProps,
  } = props;
  // Folder grouping lists threads under each folder, so the row folds them
  // like Codex; with no threads to fold, the row just selects the folder.
  const toggleCollapsed = threads?.length ? onToggleCollapsed : undefined;
  const collapsible = toggleCollapsed !== undefined;
  const history =
    threads && !collapsed ? threadHistoryPreview(threads, historyExpanded) : undefined;

  const workspaceActive =
    workspace.id === selectedWorkspace?.id || workspace.id === selectedWorkspace?.rootWorkspaceId;
  const linkedWorktree = linkedWorktreeByWorkspaceId.get(workspace.id);

  return (
    <>
      <div className={`workspace-row ${workspaceActive ? "workspace-row--active" : ""}`}>
        <button
          className={`workspace-row__select ${dragHandleProps ? "workspace-row__select--draggable" : ""}`}
          onClick={() => {
            if (toggleCollapsed) toggleCollapsed();
            else wsMenu.selectWorkspace(workspace.id);
          }}
          type="button"
          {...(dragHandleProps
            ? { ...dragHandleProps.attributes, ...dragHandleProps.listeners }
            : {})}
          aria-expanded={collapsible ? !collapsed : undefined}
        >
          <span
            className="workspace-row__icon"
            aria-hidden="true"
            data-state={collapsible ? (collapsed ? "collapsed" : "expanded") : undefined}
          >
            <span className="workspace-row__icon-folder">
              <FolderIcon />
            </span>
            {collapsible ? (
              <span className="workspace-row__icon-chevron">
                {collapsed ? <ChevronRightIcon /> : <ChevronDownIcon />}
              </span>
            ) : null}
          </span>
          <span className="workspace-row__name">{workspace.name}</span>
        </button>
        <span className="workspace-row__actions">
          {onNewThread ? (
            <button
              aria-label={`New thread in ${workspace.name}`}
              className="icon-button workspace-row__action-button"
              title="New thread"
              type="button"
              onClick={() => {
                // The new thread lands in this folder, so open it to keep the row in view.
                // Gate on folder grouping, not on toggleCollapsed: a folder saved as
                // folded may be empty now, and its new thread would land hidden.
                if (collapsed && threads) onToggleCollapsed?.();
                onNewThread(workspace.id);
              }}
            >
              <PlusIcon />
            </button>
          ) : null}
          <span
            className="workspace-row__menu-wrap"
            ref={wsMenu.workspaceMenuId === workspace.id ? wsMenu.workspaceMenuWrapRef : undefined}
          >
            <button
              aria-label={`Workspace actions for ${workspace.name}`}
              aria-haspopup="menu"
              className="icon-button workspace-row__menu-button"
              aria-expanded={wsMenu.workspaceMenuId === workspace.id}
              type="button"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                wsMenu.openWorkspaceMenu(workspace.id);
              }}
            >
              …
            </button>
            {wsMenu.workspaceMenuId === workspace.id ? (
              <div className="workspace-menu">
                <button
                  className="workspace-menu__item"
                  type="button"
                  onClick={(event) =>
                    wsMenu.runWorkspaceMenuAction(event, () => {
                      void api.openWorkspaceInFinder(workspace.id).catch((error: unknown) => {
                        console.error("[renderer] openWorkspaceInFinder failed", error);
                      });
                    })
                  }
                >
                  Open folder
                </button>
                {linkedWorktree ? (
                  <button
                    className="workspace-menu__item workspace-menu__item--danger"
                    type="button"
                    onClick={(event) =>
                      wsMenu.runWorkspaceMenuAction(event, () =>
                        wsMenu.removeWorktree(
                          linkedWorktree.rootWorkspaceId || workspace.id,
                          linkedWorktree,
                        ),
                      )
                    }
                  >
                    Remove worktree
                  </button>
                ) : (
                  <button
                    className="workspace-menu__item"
                    type="button"
                    onClick={(event) =>
                      wsMenu.runWorkspaceMenuAction(event, () =>
                        wsMenu.createWorktree(workspace.id),
                      )
                    }
                  >
                    Create permanent worktree
                  </button>
                )}
                <button
                  className="workspace-menu__item"
                  type="button"
                  onClick={(event) =>
                    wsMenu.runWorkspaceMenuAction(event, () => wsMenu.startRename(workspace))
                  }
                >
                  Edit name
                </button>
                <button
                  className="workspace-menu__item workspace-menu__item--danger"
                  type="button"
                  onClick={(event) =>
                    wsMenu.runWorkspaceMenuAction(event, () => wsMenu.removeWorkspace(workspace))
                  }
                >
                  Remove
                </button>
              </div>
            ) : null}
          </span>
        </span>
      </div>
      {wsMenu.workspaceRenameId === workspace.id ? (
        <form
          className="workspace-rename"
          ref={wsMenu.workspaceRenamePanelRef}
          onSubmit={(event) => {
            event.preventDefault();
            wsMenu.submitRename(workspace);
          }}
        >
          <input
            aria-label={`Rename ${workspace.name}`}
            className="workspace-rename__input"
            ref={wsMenu.workspaceRenameInputRef}
            value={wsMenu.workspaceRenameDraft}
            onChange={(event) => {
              wsMenu.setWorkspaceRenameDraft(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                wsMenu.cancelRename();
              }
            }}
          />
          <div className="workspace-rename__actions">
            <button
              className="workspace-rename__button"
              type="button"
              onClick={wsMenu.cancelRename}
            >
              Cancel
            </button>
            <button
              className="workspace-rename__button workspace-rename__button--primary"
              type="submit"
            >
              Save
            </button>
          </div>
        </form>
      ) : null}
      {history && onSelectSession && onArchiveSession && onSetSessionPinned ? (
        <>
          <div className="session-list session-list--history">
            {history.visible.map((thread) => (
              <HistoryThreadRow
                key={`${thread.workspaceId}:${thread.session.id}`}
                thread={thread}
                selectedWorkspace={selectedWorkspace}
                selectedSession={selectedSession}
                threadMenu={threadMenu}
                onArchiveSession={onArchiveSession}
                onSelectSession={onSelectSession}
                onSetSessionPinned={onSetSessionPinned}
              />
            ))}
          </div>
          {history.overflow && onToggleHistory ? (
            <HistoryToggle
              expanded={historyExpanded}
              label={workspace.name}
              onToggle={onToggleHistory}
            />
          ) : null}
        </>
      ) : null}
    </>
  );
}

/** Threads outside any folder, drawn as loose rows above the folders in folder grouping. */
function TopLevelThreadsView({
  threads,
  historyExpanded,
  onToggleHistory,
  selectedWorkspace,
  selectedSession,
  threadMenu,
  onArchiveSession,
  onSelectSession,
  onSetSessionPinned,
}: {
  readonly threads: readonly ThreadListEntry[];
  readonly historyExpanded: boolean;
  readonly onToggleHistory: () => void;
  readonly selectedWorkspace: WorkspaceRecord | undefined;
  readonly selectedSession: SessionRecord | undefined;
  readonly threadMenu: ThreadMenuState;
  readonly onArchiveSession: (target: { workspaceId: string; sessionId: string }) => void;
  readonly onSelectSession: (target: { workspaceId: string; sessionId: string }) => void;
  readonly onSetSessionPinned: (
    target: { workspaceId: string; sessionId: string },
    pinned: boolean,
  ) => void;
}) {
  const history = threadHistoryPreview(threads, historyExpanded);
  return (
    <section className="top-level-threads" data-testid="top-level-threads">
      <div className="session-list session-list--history">
        {history.visible.map((thread) => (
          <HistoryThreadRow
            key={`${thread.workspaceId}:${thread.session.id}`}
            thread={thread}
            selectedWorkspace={selectedWorkspace}
            selectedSession={selectedSession}
            threadMenu={threadMenu}
            onArchiveSession={onArchiveSession}
            onSelectSession={onSelectSession}
            onSetSessionPinned={onSetSessionPinned}
          />
        ))}
      </div>
      {history.overflow ? (
        <HistoryToggle
          expanded={historyExpanded}
          label="threads without a folder"
          onToggle={onToggleHistory}
        />
      ) : null}
    </section>
  );
}

function RecencyThreadSectionView({
  section,
  historyExpanded,
  onToggleHistory,
  selectedWorkspace,
  selectedSession,
  threadMenu,
  onArchiveSession,
  onSelectSession,
  onSetSessionPinned,
}: {
  readonly section: RecencyThreadSection;
  readonly historyExpanded: boolean;
  readonly onToggleHistory: () => void;
  readonly selectedWorkspace: WorkspaceRecord | undefined;
  readonly selectedSession: SessionRecord | undefined;
  readonly threadMenu: ThreadMenuState;
  readonly onArchiveSession: (target: { workspaceId: string; sessionId: string }) => void;
  readonly onSelectSession: (target: { workspaceId: string; sessionId: string }) => void;
  readonly onSetSessionPinned: (
    target: { workspaceId: string; sessionId: string },
    pinned: boolean,
  ) => void;
}) {
  const history = threadHistoryPreview(section.threads, historyExpanded);
  return (
    <section
      className="recency-thread-group"
      aria-label={section.label}
      data-recency-bucket={section.bucket}
    >
      <div className="recency-thread-group__head">{section.label}</div>
      <div className="session-list session-list--history">
        {history.visible.map((thread) => (
          <HistoryThreadRow
            key={`${thread.workspaceId}:${thread.session.id}`}
            showContext
            thread={thread}
            selectedWorkspace={selectedWorkspace}
            selectedSession={selectedSession}
            threadMenu={threadMenu}
            onArchiveSession={onArchiveSession}
            onSelectSession={onSelectSession}
            onSetSessionPinned={onSetSessionPinned}
          />
        ))}
      </div>
      {history.overflow ? (
        <HistoryToggle
          expanded={historyExpanded}
          label={section.label}
          onToggle={onToggleHistory}
        />
      ) : null}
    </section>
  );
}

function HistoryThreadRow({
  thread,
  showContext = false,
  selectedWorkspace,
  selectedSession,
  threadMenu,
  onArchiveSession,
  onSelectSession,
  onSetSessionPinned,
}: {
  readonly thread: ThreadListEntry;
  readonly showContext?: boolean;
  readonly selectedWorkspace: WorkspaceRecord | undefined;
  readonly selectedSession: SessionRecord | undefined;
  readonly threadMenu: ThreadMenuState | undefined;
  readonly onArchiveSession: (target: { workspaceId: string; sessionId: string }) => void;
  readonly onSelectSession: (target: { workspaceId: string; sessionId: string }) => void;
  readonly onSetSessionPinned: (
    target: { workspaceId: string; sessionId: string },
    pinned: boolean,
  ) => void;
}) {
  const active =
    thread.workspaceId === selectedWorkspace?.id && thread.session.id === selectedSession?.id;
  // Drag a row onto another to nest it there; every row is also a place to drop one.
  const dndId = threadDndId(thread);
  const drag = useDraggable({ id: dndId, data: { thread } });
  const drop = useDroppable({ id: dndId, data: { thread } });
  return (
    <ThreadSessionRow
      ref={(node) => {
        drag.setNodeRef(node);
        drop.setNodeRef(node);
      }}
      active={active}
      showContext={showContext}
      thread={thread}
      threadMenu={threadMenu}
      dragging={drag.isDragging}
      dropTarget={drop.isOver && !drag.isDragging}
      dragAttributes={drag.attributes}
      dragListeners={drag.listeners}
      onAction={() =>
        onArchiveSession({
          workspaceId: thread.workspaceId,
          sessionId: thread.session.id,
        })
      }
      onSelect={() =>
        onSelectSession({
          workspaceId: thread.workspaceId,
          sessionId: thread.session.id,
        })
      }
      onTogglePinned={() =>
        onSetSessionPinned(
          { workspaceId: thread.workspaceId, sessionId: thread.session.id },
          !thread.session.pinnedAt,
        )
      }
    />
  );
}

function HistoryToggle({
  expanded,
  label,
  onToggle,
}: {
  readonly expanded: boolean;
  readonly label: string;
  readonly onToggle: () => void;
}) {
  const text = expanded ? "Show less" : "Show more";
  return (
    <button
      aria-expanded={expanded}
      aria-label={`${text} ${label}`}
      className="thread-history-toggle"
      type="button"
      onClick={onToggle}
    >
      {text}
    </button>
  );
}

function ThreadGroupingControl({
  grouping,
  onChange,
}: {
  readonly grouping: ThreadGrouping;
  readonly onChange: (grouping: ThreadGrouping) => void;
}) {
  const [open, setOpen] = useState(false);
  const [submenuOpen, setSubmenuOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
  const [submenuStyle, setSubmenuStyle] = useState<CSSProperties>({});
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const groupingRef = useRef<HTMLButtonElement | null>(null);
  const submenuRef = useRef<HTMLDivElement | null>(null);
  const submenuTimer = useRef<number | null>(null);

  const closeSubmenuSoon = () => {
    if (submenuTimer.current !== null) {
      window.clearTimeout(submenuTimer.current);
    }
    submenuTimer.current = window.setTimeout(() => {
      submenuTimer.current = null;
      setSubmenuOpen(false);
    }, 140);
  };

  const keepSubmenu = () => {
    if (submenuTimer.current !== null) {
      window.clearTimeout(submenuTimer.current);
      submenuTimer.current = null;
    }
    setSubmenuOpen(true);
  };

  const closeMenu = () => {
    if (submenuTimer.current !== null) {
      window.clearTimeout(submenuTimer.current);
      submenuTimer.current = null;
    }
    setSubmenuOpen(false);
    setOpen(false);
  };

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (wrapRef.current?.contains(target) || menuRef.current?.contains(target)) {
        return;
      }
      closeMenu();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeMenu();
      }
    };
    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  useEffect(
    () => () => {
      if (submenuTimer.current !== null) {
        window.clearTimeout(submenuTimer.current);
      }
    },
    [],
  );

  useLayoutEffect(() => {
    if (!open || !buttonRef.current) {
      return;
    }
    const rect = buttonRef.current.getBoundingClientRect();
    setMenuStyle({
      top: rect.bottom + 6,
      left: rect.right,
      right: "auto",
      width: "max-content",
      transform: "translateX(-100%)",
    });
  }, [open]);

  useLayoutEffect(() => {
    if (!submenuOpen || !groupingRef.current) {
      return;
    }
    const rect = groupingRef.current.getBoundingClientRect();
    const gap = 6;
    const width = submenuRef.current?.offsetWidth ?? 0;
    const openRight = rect.right + gap;
    const left =
      width > 0 && openRight + width > window.innerWidth - 8
        ? Math.max(8, rect.left - gap - width)
        : openRight;
    setSubmenuStyle({
      top: rect.top - 6,
      left,
      right: "auto",
      width: "max-content",
    });
  }, [submenuOpen]);

  return (
    <span className="shortcut-tooltip-wrap thread-grouping" ref={wrapRef}>
      <button
        ref={buttonRef}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="Customize Sidebar"
        className="icon-button"
        type="button"
        onClick={() => {
          if (open) {
            closeMenu();
            return;
          }
          setOpen(true);
        }}
      >
        <CustomizeSidebarIcon />
      </button>
      {open ? null : (
        <span className="shortcut-tooltip" role="tooltip">
          Customize Sidebar
        </span>
      )}
      {open
        ? createPortal(
            <div ref={menuRef}>
              <div
                aria-label="Customize Sidebar"
                className="workspace-menu thread-grouping__menu"
                role="menu"
                style={menuStyle}
              >
                <button
                  ref={groupingRef}
                  aria-expanded={submenuOpen}
                  aria-haspopup="menu"
                  className={`workspace-menu__item${submenuOpen ? " thread-grouping__parent--open" : ""}`}
                  role="menuitem"
                  type="button"
                  onClick={() => {
                    keepSubmenu();
                  }}
                  onMouseEnter={keepSubmenu}
                  onMouseLeave={closeSubmenuSoon}
                >
                  <span>Grouping</span>
                  <ChevronRightIcon />
                </button>
              </div>
              {submenuOpen ? (
                <div
                  ref={submenuRef}
                  aria-label="Grouping"
                  className="workspace-menu thread-grouping__submenu"
                  role="menu"
                  style={submenuStyle}
                  onMouseEnter={keepSubmenu}
                  onMouseLeave={closeSubmenuSoon}
                >
                  {(
                    [
                      ["time", "Time"],
                      ["workspace", "Workspace"],
                    ] as const
                  ).map(([value, label]) => (
                    <button
                      key={value}
                      aria-checked={grouping === value}
                      className="workspace-menu__item thread-grouping__option"
                      role="menuitemradio"
                      type="button"
                      onClick={() => {
                        closeMenu();
                        if (value !== grouping) {
                          onChange(value);
                        }
                      }}
                    >
                      <span aria-hidden="true" className="thread-grouping__check">
                        {grouping === value ? <CheckIcon /> : null}
                      </span>
                      {label}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>,
            document.body,
          )
        : null}
    </span>
  );
}

function ArchivedThreadsSection({
  archivedThreads,
  open,
  onToggle,
  selectedWorkspace,
  selectedSession,
  threadMenu,
  onUnarchiveSession,
  onSelectSession,
  onSetSessionPinned,
}: {
  readonly archivedThreads: readonly ThreadListEntry[];
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly selectedWorkspace: WorkspaceRecord | undefined;
  readonly selectedSession: SessionRecord | undefined;
  readonly threadMenu: ThreadMenuState;
  readonly onUnarchiveSession: (target: { workspaceId: string; sessionId: string }) => void;
  readonly onSelectSession: (target: { workspaceId: string; sessionId: string }) => void;
  readonly onSetSessionPinned: (
    target: { workspaceId: string; sessionId: string },
    pinned: boolean,
  ) => void;
}) {
  return (
    <div className="archived-thread-group">
      <button
        aria-expanded={open}
        className="archived-thread-group__toggle"
        type="button"
        onClick={onToggle}
      >
        <span
          aria-hidden="true"
          className={`archived-thread-group__chevron ${open ? "archived-thread-group__chevron--open" : ""}`}
        >
          <ChevronDownIcon />
        </span>
        <span>Archived</span>
        <span className="archived-thread-group__count">{archivedThreads.length}</span>
      </button>
      {open ? (
        <div className="session-list session-list--archived">
          {archivedThreads.map((thread) => {
            const active =
              thread.workspaceId === selectedWorkspace?.id &&
              thread.session.id === selectedSession?.id;
            return (
              <ThreadSessionRow
                key={`${thread.workspaceId}:${thread.session.id}`}
                active={active}
                archived
                thread={thread}
                showContext
                threadMenu={threadMenu}
                onAction={() =>
                  onUnarchiveSession({
                    workspaceId: thread.workspaceId,
                    sessionId: thread.session.id,
                  })
                }
                onSelect={() =>
                  onSelectSession({
                    workspaceId: thread.workspaceId,
                    sessionId: thread.session.id,
                  })
                }
                onTogglePinned={() =>
                  onSetSessionPinned(
                    { workspaceId: thread.workspaceId, sessionId: thread.session.id },
                    !thread.session.pinnedAt,
                  )
                }
              />
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function PinnedThreadsSection({
  pinnedThreads,
  sortableIds,
  sortableIdForThread,
  selectedWorkspace,
  selectedSession,
  threadMenu,
  onArchiveSession,
  onSelectSession,
  onSetSessionPinned,
}: {
  readonly pinnedThreads: readonly ThreadListEntry[];
  readonly sortableIds: readonly string[];
  readonly sortableIdForThread: (thread: ThreadListEntry) => string;
  readonly selectedWorkspace: WorkspaceRecord | undefined;
  readonly selectedSession: SessionRecord | undefined;
  readonly threadMenu: ThreadMenuState;
  readonly onArchiveSession: (target: { workspaceId: string; sessionId: string }) => void;
  readonly onSelectSession: (target: { workspaceId: string; sessionId: string }) => void;
  readonly onSetSessionPinned: (
    target: { workspaceId: string; sessionId: string },
    pinned: boolean,
  ) => void;
}) {
  return (
    <section className="pinned-thread-group" aria-label="Pinned threads">
      <div className="pinned-thread-group__head">
        <PinIcon filled />
        <span>Pinned</span>
      </div>
      <SortableContext items={[...sortableIds]} strategy={verticalListSortingStrategy}>
        <div className="session-list session-list--pinned">
          {pinnedThreads.map((thread) => {
            const active =
              thread.workspaceId === selectedWorkspace?.id &&
              thread.session.id === selectedSession?.id;
            return (
              <SortablePinnedThreadRow
                key={`${thread.workspaceId}:${thread.session.id}`}
                id={sortableIdForThread(thread)}
                active={active}
                thread={thread}
                threadMenu={threadMenu}
                onAction={() =>
                  onArchiveSession({
                    workspaceId: thread.workspaceId,
                    sessionId: thread.session.id,
                  })
                }
                onSelect={() =>
                  onSelectSession({ workspaceId: thread.workspaceId, sessionId: thread.session.id })
                }
                onTogglePinned={() =>
                  onSetSessionPinned(
                    { workspaceId: thread.workspaceId, sessionId: thread.session.id },
                    !thread.session.pinnedAt,
                  )
                }
              />
            );
          })}
        </div>
      </SortableContext>
    </section>
  );
}

/* ── Thread session row ────────────────────────────────── */

function SortablePinnedThreadRow({
  id,
  active,
  thread,
  threadMenu,
  onAction,
  onSelect,
  onTogglePinned,
}: {
  readonly id: string;
  readonly active: boolean;
  readonly thread: ThreadListEntry;
  readonly threadMenu: ThreadMenuState;
  readonly onAction: () => void;
  readonly onSelect: () => void;
  readonly onTogglePinned: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.3 : undefined,
  };
  return (
    <ThreadSessionRow
      ref={setNodeRef}
      style={style}
      active={active}
      thread={thread}
      threadMenu={threadMenu}
      showContext
      dragging={isDragging}
      dragAttributes={attributes}
      dragListeners={listeners}
      onAction={onAction}
      onSelect={onSelect}
      onTogglePinned={onTogglePinned}
    />
  );
}

const THREAD_DND_PREFIX = "thread:";

/** Shows a dragged thread's label just below and right of the pointer, clear of the drop row. */
const besidePointer: Modifier = ({ activatorEvent, draggingNodeRect, transform }) => {
  if (!(activatorEvent instanceof PointerEvent) || !draggingNodeRect) return transform;
  return {
    ...transform,
    x: transform.x + activatorEvent.clientX - draggingNodeRect.left + 12,
    y: transform.y + activatorEvent.clientY - draggingNodeRect.top + 12,
  };
};

function threadDndId(thread: ThreadListEntry): string {
  return `${THREAD_DND_PREFIX}${sessionThreadKey(thread)}`;
}

/** Every thread nested under this one, at any depth: it cannot become their child. */
function descendantKeys(thread: ThreadListEntry): Set<string> {
  const keys = new Set<string>();
  const pending = [...(thread.children ?? [])];
  for (let next = pending.pop(); next; next = pending.pop()) {
    keys.add(sessionThreadKey(next));
    pending.push(...(next.children ?? []));
  }
  return keys;
}

function sessionIndicatorVariant(
  thread: ThreadListEntry,
): "running" | "failed" | "unseen" | "none" {
  if (thread.session.status === "running") {
    return "running";
  }
  if (thread.session.status === "failed") {
    return "failed";
  }
  if (thread.session.hasUnseenUpdate) {
    return "unseen";
  }
  return "none";
}

interface ThreadSessionRowProps {
  readonly active: boolean;
  readonly archived?: boolean;
  readonly showContext?: boolean;
  readonly overlay?: boolean;
  readonly dragging?: boolean;
  /** Another thread is being dragged over this row and would nest under it. */
  readonly dropTarget?: boolean;
  readonly style?: CSSProperties;
  readonly dragAttributes?: DraggableAttributes;
  readonly dragListeners?: DraggableSyntheticListeners;
  readonly thread: ThreadListEntry;
  readonly threadMenu?: ThreadMenuState;
  readonly onAction: () => void;
  readonly onSelect: () => void;
  readonly onTogglePinned: () => void;
}

const ThreadSessionRow = forwardRef<HTMLDivElement, ThreadSessionRowProps>(
  function ThreadSessionRow(
    {
      active,
      archived = false,
      showContext = false,
      overlay = false,
      dragging = false,
      dropTarget = false,
      style,
      dragAttributes,
      dragListeners,
      thread,
      threadMenu,
      onAction,
      onSelect,
      onTogglePinned,
    },
    ref,
  ) {
    const indicatorVariant = sessionIndicatorVariant(thread);
    const tree = useContext(ThreadListContext);
    const threadKey = sessionThreadKey(thread);
    const children = thread.children ?? [];
    const childrenOpen = !tree?.collapsed.has(threadKey);
    const pinned = Boolean(thread.session.pinnedAt);
    const actionContext = showContext && thread.contextLabel ? ` in ${thread.contextLabel}` : "";
    const shortcut = tree?.shortcuts?.get(sessionThreadKey(thread));
    const shortcutBadge = overlay ? undefined : shortcut;
    const menuOpen =
      !overlay &&
      threadMenu?.openMenu?.surface === "sidebar" &&
      threadMenu.openMenu.sessionId === thread.session.id;
    const classes = [
      "session-row",
      children.length > 0 && !overlay ? "session-row--parent" : "",
      active ? "session-row--active" : "",
      pinned ? "session-row--pinned" : "",
      dragging ? "session-row--dragging" : "",
      dropTarget ? "session-row--drop-target" : "",
      overlay ? "session-row--overlay" : "",
      shortcutBadge ? "session-row--shortcut" : "",
    ]
      .filter(Boolean)
      .join(" ");
    return (
      <>
        <div
          ref={ref}
          style={style}
          className={classes}
          data-sidebar-indicator={indicatorVariant}
          data-session-pinned={pinned ? "true" : "false"}
          data-session-id={thread.session.id}
          data-parent-thread={thread.parentKey}
          data-thread-shortcut={shortcutBadge ? String(shortcutBadge.slot) : undefined}
          aria-keyshortcuts={
            shortcutBadge ? `${IS_MAC ? "Meta" : "Control"}+${shortcutBadge.slot}` : undefined
          }
          onClick={() => {
            if (!dragging) onSelect();
          }}
          onContextMenu={(event) => {
            if (!threadMenu || overlay) return;
            event.preventDefault();
            event.stopPropagation();
            threadMenu.openSidebarMenu(thread.session.id);
          }}
        >
          {children.length > 0 && !overlay ? (
            <button
              type="button"
              className="session-row__tree-toggle"
              aria-label={`${childrenOpen ? "Collapse" : "Expand"} children of ${thread.session.title}`}
              aria-expanded={childrenOpen}
              onClick={(event) => {
                event.stopPropagation();
                tree?.toggle(threadKey);
              }}
            >
              {childrenOpen ? <ChevronDownIcon /> : <ChevronRightIcon />}
            </button>
          ) : null}
          <button
            className="session-row__select"
            onClick={(event) => {
              event.stopPropagation();
              onSelect();
            }}
            type="button"
            {...dragAttributes}
            {...dragListeners}
          >
            <span className="session-row__leading" aria-hidden="true">
              {indicatorVariant === "running" ? (
                <span className="session-row__status session-row__status--running" />
              ) : null}
              {indicatorVariant === "failed" ? (
                <span className="session-row__status session-row__status--failed" />
              ) : null}
              {indicatorVariant === "unseen" ? (
                <span className="session-row__status session-row__status--unseen" />
              ) : null}
            </span>
            <span className="session-row__body">
              <span className="session-row__title-line">
                <span className="session-row__title">{thread.session.title}</span>
              </span>
              {showContext && thread.contextLabel ? (
                <span className="session-row__context">{thread.contextLabel}</span>
              ) : null}
            </span>
          </button>
          <span className="session-row__trailing">
            {thread.environment.kind === "worktree" ? (
              <span className="session-row__workspace-icon" aria-hidden="true" title="Worktree">
                <WorktreeIcon />
              </span>
            ) : null}
            {shortcutBadge ? (
              <span className="session-row__shortcut" aria-hidden="true">
                {shortcutBadge.label}
              </span>
            ) : (
              <span className="session-row__time">
                {formatRelativeTime(sessionLastInteractedAt(thread.session))}
              </span>
            )}
            <span className="session-row__action-cluster">
              {!archived ? (
                <button
                  aria-label={`${pinned ? "Unpin" : "Pin"} ${thread.session.title}${actionContext}`}
                  aria-pressed={pinned}
                  className="icon-button session-row__action session-row__pin-action"
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    onTogglePinned();
                  }}
                >
                  <PinIcon filled={pinned} />
                </button>
              ) : null}
              <span className="shortcut-tooltip-wrap session-row__tooltip-wrap">
                <button
                  aria-label={`${archived ? "Restore" : "Archive"} ${thread.session.title}${actionContext}`}
                  className="icon-button session-row__action"
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    onAction();
                  }}
                >
                  {archived ? <RestoreIcon /> : <ArchiveIcon />}
                </button>
                {threadMenu && !overlay && !menuOpen ? (
                  <span className="shortcut-tooltip session-row__tooltip" role="tooltip">
                    <span>{archived ? "Restore thread" : "Archive thread"}</span>
                    {archived ? null : <kbd>{archiveThreadShortcut(threadMenu.platform)}</kbd>}
                  </span>
                ) : null}
              </span>
            </span>
            {threadMenu && menuOpen ? (
              <div className="session-row__menu-wrap" ref={threadMenu.menuWrapRef}>
                <ThreadActionsMenu
                  actions={threadMenu.actionsFor(thread)}
                  className="session-row__menu"
                />
              </div>
            ) : null}
          </span>
        </div>
        {threadMenu?.renameSessionId === thread.session.id ? (
          <form
            className="workspace-rename session-rename"
            ref={threadMenu.renamePanelRef}
            onSubmit={(event) => {
              event.preventDefault();
              threadMenu.submitRename(thread);
            }}
          >
            <input
              aria-label={`Rename thread ${thread.session.title}`}
              className="workspace-rename__input"
              // Mounts when a rename starts, including after the sidebar or a
              // collapsed group opens to reveal the row.
              autoFocus
              onFocus={(event) => event.currentTarget.select()}
              value={threadMenu.renameDraft}
              onChange={(event) => threadMenu.setRenameDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  threadMenu.cancelRename();
                }
              }}
            />
            <div className="workspace-rename__actions">
              <button
                className="workspace-rename__button"
                type="button"
                onClick={threadMenu.cancelRename}
              >
                Cancel
              </button>
              <button
                className="workspace-rename__button workspace-rename__button--primary"
                type="submit"
              >
                Save
              </button>
            </div>
          </form>
        ) : null}
        {tree && !overlay && childrenOpen && children.length > 0 ? (
          <div
            className="session-tree__children"
            data-parent-session-id={thread.session.id}
            role="group"
            aria-label={`Children of ${thread.session.title}`}
          >
            {children.map((child) => (
              <HistoryThreadRow
                key={sessionThreadKey(child)}
                thread={child}
                showContext={showContext}
                selectedWorkspace={tree.props.selectedWorkspace}
                selectedSession={tree.props.selectedSession}
                threadMenu={tree.props.threadMenu}
                onArchiveSession={tree.props.onArchiveSession}
                onSelectSession={tree.props.onSelectSession}
                onSetSessionPinned={tree.props.onSetSessionPinned}
              />
            ))}
          </div>
        ) : null}
      </>
    );
  },
);
