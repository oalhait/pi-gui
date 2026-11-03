import type { BrowserTabState } from "../../../contracts/browser";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import {
  formatShortcut,
  getSidePanelTabShortcutLabel,
  SIDE_PANEL_TAB_SHORTCUT_SLOT_COUNT,
  type TerminalSessionSnapshot,
} from "../../../contracts/ipc";
import { toolRefId, type TaskWorkbenchTemplate, type ToolRef } from "../../../contracts/workbench";
import type { DesktopExtensionViewInfo } from "../../../contracts/extension-views";
import { CloseIcon, ExtensionIcon, FileIcon, PlusIcon, SidePanelIcon } from "../../ui/icons";
import { BUILTIN_TOOL_ENTRIES, BUILTIN_TOOLS } from "./builtin-tools";
import { fileNameFromPath, fileTabLabels } from "./file-workbench-state";
import { WorkbenchResizeHandle } from "./workbench-resize-handle";
import { activeWorkbenchTool, workbenchCloseNeighbor } from "./workbench-state";

interface WorkbenchProps {
  readonly view: TaskWorkbenchTemplate;
  readonly browserTabs?: readonly BrowserTabState[];
  readonly terminalSessions?: readonly TerminalSessionSnapshot[];
  readonly platform: NodeJS.Platform;
  /** Whether the side panel tab modifier is held, so tabs show their numbers. */
  readonly tabHintsVisible: boolean;
  readonly onResize: (width: number) => void;
  readonly onTogglePanel: () => void;
  readonly onOpenTool: (tool: ToolRef) => void;
  /** Opens another tab of this kind: a new browser page or terminal, or focuses a singleton. */
  readonly onNewTab: (tool: ToolRef) => void;
  readonly onActivateTool: (toolId: string) => void;
  readonly onCloseTool: (toolId: string) => void;
  readonly children?: ReactNode;
  readonly error?: string;
  readonly loading?: boolean;
  readonly onRetryRestore?: () => void;
  readonly extensionViews?: readonly DesktopExtensionViewInfo[];
  readonly extensionViewsLoading?: boolean;
  readonly extensionViewsError?: string;
  readonly onReloadExtensionViews?: () => void;
}

export function workbenchToolLabel(tool: ToolRef): string {
  if (tool.kind === "extension") return tool.viewId;
  if (tool.kind === "file") return fileNameFromPath(tool.path);
  return BUILTIN_TOOLS[tool.kind].label;
}

function ToolIcon({ tool }: { readonly tool: ToolRef }) {
  if (tool.kind === "extension") return <ExtensionIcon />;
  if (tool.kind === "file") return <FileIcon />;
  const { Icon } = BUILTIN_TOOLS[tool.kind];
  return <Icon />;
}

export function Workbench({
  view,
  browserTabs,
  terminalSessions,
  platform,
  tabHintsVisible,
  onResize,
  onTogglePanel,
  onOpenTool,
  onNewTab,
  onActivateTool,
  onCloseTool,
  children,
  error,
  loading = false,
  onRetryRestore,
  extensionViews = [],
  extensionViewsLoading = false,
  extensionViewsError = "",
  onReloadExtensionViews,
}: WorkbenchProps) {
  const panelId = useId();
  const addRef = useRef<HTMLButtonElement | null>(null);
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const tabsRef = useRef<HTMLDivElement | null>(null);
  const activeTool = activeWorkbenchTool(view);
  const fileLabels = useMemo(
    () => fileTabLabels(view.tools.flatMap((tool) => (tool.kind === "file" ? [tool.path] : []))),
    [view.tools],
  );
  const tabLabel = (tool: ToolRef): string => {
    switch (tool.kind) {
      case "extension":
        return (
          extensionViews.find(
            (entry) => entry.extensionId === tool.extensionId && entry.id === tool.viewId,
          )?.title ?? workbenchToolLabel(tool)
        );
      case "browser":
        return browserTabs?.find((tab) => tab.id === tool.pageId)?.title ?? "Browser";
      case "file":
        return fileLabels.get(tool.path) ?? workbenchToolLabel(tool);
      case "terminal":
        // The shell's title, or its numbered default ("Terminal 2") until it sets one.
        return terminalSessions?.find((entry) => entry.id === tool.sessionId)?.title || "Terminal";
      default:
        return workbenchToolLabel(tool);
    }
  };
  const activeExtension =
    activeTool?.kind === "extension"
      ? extensionViews.find(
          (entry) => entry.extensionId === activeTool.extensionId && entry.id === activeTool.viewId,
        )
      : undefined;
  useEffect(() => {
    if (view.visibility === "visible" && view.selection.kind === "tool") {
      tabRefs.current
        .get(view.selection.toolId)
        ?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }, [view.selection, view.visibility]);

  const tabId = (toolId: string) => `${panelId}-${encodeURIComponent(toolId)}`;

  const closeAndFocus = (toolId: string) => {
    const nextId = workbenchCloseNeighbor(view, toolId);
    onCloseTool(toolId);
    window.requestAnimationFrame(() => {
      if (nextId) tabRefs.current.get(nextId)?.focus();
      else addRef.current?.focus();
    });
  };

  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, toolId: string) => {
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      closeAndFocus(toolId);
      return;
    }
    const index = view.tools.findIndex((tool) => toolRefId(tool) === toolId);
    const nextIndex =
      event.key === "ArrowRight"
        ? (index + 1) % view.tools.length
        : event.key === "ArrowLeft"
          ? (index - 1 + view.tools.length) % view.tools.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? view.tools.length - 1
              : undefined;
    if (nextIndex === undefined) return;
    event.preventDefault();
    const nextTool = view.tools[nextIndex];
    if (!nextTool) return;
    const nextId = toolRefId(nextTool);
    onActivateTool(nextId);
    tabRefs.current.get(nextId)?.focus();
  };

  if (view.visibility === "hidden") return null;

  return (
    <aside
      aria-label="Side workspace"
      className="workbench side-panel"
      data-testid="workbench"
      id="task-workbench"
    >
      <WorkbenchResizeHandle onResize={onResize} />
      <div className="workbench__tabbar">
        <div
          aria-label="Workspace tools"
          className="workbench__tabs"
          onWheel={(event) => {
            // A vertical wheel scrolls an overflowing tab row sideways.
            const row = tabsRef.current;
            if (row && Math.abs(event.deltaY) > Math.abs(event.deltaX))
              row.scrollLeft += event.deltaY;
          }}
          ref={tabsRef}
          role="tablist"
        >
          {view.tools.map((tool, index) => {
            const toolId = toolRefId(tool);
            const label = tabLabel(tool);
            const status =
              tool.kind === "terminal"
                ? terminalSessions?.find((entry) => entry.id === tool.sessionId)?.status
                : undefined;
            const tooltip = tool.kind === "file" ? tool.path : label;
            const selected = view.selection.kind === "tool" && view.selection.toolId === toolId;
            const slot = index < SIDE_PANEL_TAB_SHORTCUT_SLOT_COUNT ? index + 1 : undefined;
            const shortcut = slot ? getSidePanelTabShortcutLabel(platform, slot) : undefined;
            return (
              <div className="workbench__tab-wrapper" key={toolId} role="presentation">
                <button
                  aria-controls={panelId}
                  aria-keyshortcuts={
                    slot ? `${platform === "darwin" ? "Control" : "Alt"}+${slot}` : undefined
                  }
                  aria-label={label}
                  aria-selected={selected}
                  className={`workbench__tab${selected ? " workbench__tab--active" : ""}`}
                  data-tab-shortcut={tabHintsVisible && slot ? String(slot) : undefined}
                  data-testid={`workbench-tab-${toolId}`}
                  disabled={loading}
                  id={tabId(toolId)}
                  onClick={() => onActivateTool(toolId)}
                  onKeyDown={(event) => onTabKeyDown(event, toolId)}
                  ref={(button) => {
                    if (button) tabRefs.current.set(toolId, button);
                    else tabRefs.current.delete(toolId);
                  }}
                  role="tab"
                  tabIndex={selected || (view.selection.kind === "chooser" && index === 0) ? 0 : -1}
                  title={shortcut ? `${tooltip} (${shortcut})` : tooltip}
                  type="button"
                >
                  {tabHintsVisible && shortcut ? (
                    <span className="workbench__tab-shortcut" aria-hidden="true">
                      {shortcut}
                    </span>
                  ) : (
                    <ToolIcon tool={tool} />
                  )}
                  <span>{label}</span>
                  {status && status !== "running" ? (
                    <span
                      aria-label={status === "error" ? "failed" : "exited"}
                      className={`workbench__terminal-status workbench__terminal-status--${status}`}
                    />
                  ) : null}
                </button>
                <button
                  aria-label={`Close ${label} tab`}
                  className="workbench__tab-close icon-button"
                  disabled={loading}
                  onClick={() => closeAndFocus(toolId)}
                  tabIndex={-1}
                  title={`Close ${label} tab`}
                  type="button"
                >
                  <CloseIcon />
                </button>
              </div>
            );
          })}
        </div>
        <NewTabMenu
          addRef={addRef}
          disabled={loading}
          extensions={extensionViews}
          onNewTab={onNewTab}
          platform={platform}
        />
        <button
          aria-label="Toggle side panel"
          aria-pressed="true"
          aria-controls="task-workbench"
          data-testid="toggle-side-panel"
          className="workbench__add icon-button"
          onClick={onTogglePanel}
          title="Hide side panel"
          type="button"
        >
          <SidePanelIcon />
        </button>
      </div>
      {error ? (
        <div className="workbench__error" role="status">
          <p>{error}</p>
          {loading && onRetryRestore ? (
            <button className="button" onClick={onRetryRestore} type="button">
              Retry restoring tabs
            </button>
          ) : null}
        </div>
      ) : null}
      <div
        aria-labelledby={activeTool ? tabId(toolRefId(activeTool)) : undefined}
        className="workbench__content"
        id={panelId}
        role={activeTool ? "tabpanel" : undefined}
      >
        {loading ? (
          <p className="workbench__loading" role="status">
            {error
              ? "Saved tabs are unavailable until restoration succeeds."
              : "Restoring tool tabs…"}
          </p>
        ) : view.selection.kind === "chooser" ? (
          <div className="workbench__chooser" data-testid="workbench-chooser">
            <h2>Open a tool</h2>
            <p>Keep the tools you need alongside your conversation.</p>
            {BUILTIN_TOOL_ENTRIES.map(({ kind, label, description, Icon, shortcutKey }) => (
              <button
                aria-keyshortcuts={
                  shortcutKey
                    ? `${platform === "darwin" ? "Meta" : "Control"}+${shortcutKey}`
                    : undefined
                }
                aria-label={label}
                className="workbench__choice"
                key={kind}
                onClick={() => onNewTab({ kind })}
                type="button"
              >
                <span className="workbench__choice-icon">
                  <Icon />
                </span>
                <span className="workbench__choice-copy">
                  <strong>{label}</strong>
                  <span>{description}</span>
                </span>
                {shortcutKey ? (
                  <kbd className="workbench__choice-shortcut">
                    {formatShortcut(platform, shortcutKey)}
                  </kbd>
                ) : null}
              </button>
            ))}
            <h3 className="workbench__extension-heading">Extension views</h3>
            {extensionViewsLoading ? <p role="status">Loading extension views…</p> : null}
            {extensionViewsError ? (
              <div role="status">
                <p>{extensionViewsError}</p>
                {onReloadExtensionViews ? (
                  <button className="button" type="button" onClick={onReloadExtensionViews}>
                    Refresh views
                  </button>
                ) : null}
              </div>
            ) : null}
            {extensionViews.map((extension) => (
              <button
                aria-label={extension.title}
                className="workbench__choice"
                key={toolRefId({
                  kind: "extension",
                  extensionId: extension.extensionId,
                  viewId: extension.id,
                })}
                onClick={() =>
                  onOpenTool({
                    kind: "extension",
                    extensionId: extension.extensionId,
                    viewId: extension.id,
                  })
                }
                type="button"
              >
                <span className="workbench__choice-icon">
                  <ExtensionIcon />
                </span>
                <span className="workbench__choice-copy">
                  <strong>{extension.title}</strong>
                  {extension.state === "error" ? (
                    <span>{extension.error ?? "View unavailable"}</span>
                  ) : null}
                </span>
              </button>
            ))}
            {!extensionViewsLoading && !extensionViewsError && extensionViews.length === 0 ? (
              <p>Installed extensions can provide additional views here.</p>
            ) : null}
          </div>
        ) : activeTool?.kind === "extension" && activeExtension?.state !== "ready" ? (
          <div className="workbench__unavailable" role="status">
            <ExtensionIcon />
            <h2>
              {extensionViewsLoading
                ? "Finding this extension view…"
                : "This extension view is unavailable"}
            </h2>
            <p>
              {activeExtension?.error ||
                extensionViewsError ||
                "Your saved tab is retained. Extension commands can still be used when installed."}
            </p>
            {!extensionViewsLoading && onReloadExtensionViews ? (
              <button className="button" type="button" onClick={onReloadExtensionViews}>
                Refresh views
              </button>
            ) : null}
            <button
              className="button"
              onClick={() => closeAndFocus(toolRefId(activeTool))}
              type="button"
            >
              Close tab
            </button>
          </div>
        ) : (
          children
        )}
      </div>
    </aside>
  );
}

interface NewTabMenuProps {
  readonly addRef: RefObject<HTMLButtonElement | null>;
  readonly disabled: boolean;
  readonly extensions: readonly DesktopExtensionViewInfo[];
  readonly onNewTab: (tool: ToolRef) => void;
  readonly platform: NodeJS.Platform;
}

/** The tab row's + menu: each choice opens one more top-level tab, or focuses a singleton. */
function NewTabMenu({ addRef, disabled, extensions, onNewTab, platform }: NewTabMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const menuId = useId();
  useEffect(() => {
    if (!open) return;
    rootRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside, true);
    return () => document.removeEventListener("pointerdown", closeOutside, true);
  }, [open]);
  const choose = (tool: ToolRef) => {
    setOpen(false);
    onNewTab(tool);
  };
  const items: {
    readonly key: string;
    readonly label: string;
    readonly icon: ReactNode;
    readonly tool: ToolRef;
    readonly shortcutKey?: string;
  }[] = [
    ...BUILTIN_TOOL_ENTRIES.map(({ kind, Icon, shortcutKey }) => ({
      key: kind,
      label:
        kind === "browser"
          ? "New browser page"
          : kind === "terminal"
            ? "New terminal"
            : BUILTIN_TOOLS[kind].label,
      icon: <Icon />,
      tool: { kind } as ToolRef,
      // The Terminal chord focuses the most recent terminal; it does not add one.
      shortcutKey: kind === "terminal" ? undefined : shortcutKey,
    })),
    ...extensions.map((extension) => {
      const tool: ToolRef = {
        kind: "extension",
        extensionId: extension.extensionId,
        viewId: extension.id,
      };
      return { key: toolRefId(tool), label: extension.title, icon: <ExtensionIcon />, tool };
    }),
  ];
  return (
    <div
      className="workbench__new-tab"
      onBlur={(event) => {
        if (!rootRef.current?.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (!open) return;
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          addRef.current?.focus();
          return;
        }
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        event.preventDefault();
        const entries = [
          ...(rootRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []),
        ];
        const index = entries.indexOf(document.activeElement as HTMLButtonElement);
        const next =
          event.key === "ArrowDown"
            ? (index + 1) % entries.length
            : (index - 1 + entries.length) % entries.length;
        entries[next]?.focus();
      }}
      ref={rootRef}
    >
      <button
        aria-controls={open ? menuId : undefined}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-keyshortcuts={`${platform === "darwin" ? "Meta" : "Control"}+T`}
        aria-label="Add tab"
        className="workbench__add icon-button"
        data-testid="workbench-add-tab"
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
        ref={addRef}
        title={`Add tab (${formatShortcut(platform, "T")})`}
        type="button"
      >
        <PlusIcon />
      </button>
      {open ? (
        <div
          aria-label="Add tab"
          className="workspace-menu workbench__new-tab-menu"
          data-testid="workbench-new-tab-menu"
          id={menuId}
          role="menu"
        >
          {items.map((item) => (
            <button
              className="workspace-menu__item review-menu__item workbench__new-tab-item"
              key={item.key}
              onClick={() => choose(item.tool)}
              role="menuitem"
              tabIndex={-1}
              type="button"
            >
              {item.icon}
              <span>{item.label}</span>
              {item.shortcutKey ? (
                <kbd className="workspace-menu__shortcut">
                  {formatShortcut(platform, item.shortcutKey)}
                </kbd>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
