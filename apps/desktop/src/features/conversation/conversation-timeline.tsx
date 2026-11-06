import type { SessionTranscriptMessage } from "@pi-gui/session-driver";
import {
  memo,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import type {
  DisplayTimelineItem,
  TimelineTranscriptItem,
} from "../../../contracts/timeline-types";
import type { ScheduledTaskOrigin } from "../../../contracts/scheduled-tasks";
import type { ExtensionToolLabels } from "../../../contracts/tool-labels";
import { ExtensionToolLabelsContext } from "../extensions/extension-tool-labels";
import type { TimelineViewport } from "./hooks/use-timeline-viewport";
import type { AnnotationMarker, OpenAnnotation } from "./annotations/annotation-markers";
import { useAnnotationSelection } from "./annotations/annotation-selection";
import type { TranscriptAnnotations } from "./annotations/use-transcript-annotations";
import { ThreadSearchBar } from "./thread-search";
import type { RunExtensionAction } from "./extension-card";
import { TimelineItem } from "./timeline-item";
import { sameRowContent, type TimelineRow } from "./timeline-layout";
import { useThinkingDisplay, type ThinkingDisplay } from "./thinking-display";
import type { OpenTurnChange } from "./turn-changes-card";
import type { WorkspaceFileLine } from "./workspace-file-line";
import { SparkIcon } from "../../ui/icons";

interface ThreadSearchModel {
  readonly isOpen: boolean;
  readonly query: string;
  readonly matchCount: number;
  readonly activeIndex: number;
  readonly inputRef: RefObject<HTMLInputElement | null>;
  readonly search: (query: string) => void;
  readonly goToMatch: (direction: 1 | -1) => void;
  readonly close: () => void;
}
interface ConversationTimelineProps {
  readonly transcript: readonly TimelineTranscriptItem[];
  /** A run with nothing in the transcript yet still shows its Working line, not the empty state. */
  readonly running: boolean;
  readonly isTranscriptLoading: boolean;
  readonly transcriptFailed?: { readonly retrying: boolean } | null;
  readonly onRetryTranscript?: () => void;
  readonly viewport: TimelineViewport;
  readonly threadSearch: ThreadSearchModel;
  readonly onViewFileInDiff?: (path: string) => void;
  readonly onOpenTurnChange?: OpenTurnChange;
  readonly onEditFromMessage?: (message: SessionTranscriptMessage) => void;
  readonly onForkFromMessage?: (messageIndex: number, preview?: string) => void;
  readonly onOpenWorkspaceFileLine?: (target: WorkspaceFileLine) => void;
  readonly onExtensionAction?: RunExtensionAction;
  readonly extensionToolLabels: ExtensionToolLabels;
  readonly scheduledOrigins?: ReadonlyMap<string, ScheduledTaskOrigin>;
  readonly workspacePath?: string;
  readonly annotations?: TranscriptAnnotations;
  readonly platform: NodeJS.Platform;
  /** Stops the run; Cancel on a lost-connection line uses it. */
  readonly onStopRun?: () => void;
}
const NO_MARKERS: readonly AnnotationMarker[] = [];
export function ConversationTimeline({
  transcript,
  running,
  isTranscriptLoading,
  transcriptFailed = null,
  onRetryTranscript,
  viewport,
  threadSearch,
  onViewFileInDiff,
  onOpenTurnChange,
  onForkFromMessage,
  onEditFromMessage,
  onOpenWorkspaceFileLine,
  onExtensionAction,
  extensionToolLabels,
  scheduledOrigins,
  workspacePath,
  annotations,
  platform,
  onStopRun,
}: ConversationTimelineProps) {
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const annotationSelection = useAnnotationSelection({
    paneRef: surfaceRef,
    annotations,
    platform,
  });
  const annotationList = annotations?.list;
  // Keyed by every id an annotation knows its message by: a row keeps its live id after it
  // is saved, and a reload shows it by its saved id.
  const markersByMessage = useMemo(() => {
    const markers = new Map<string, AnnotationMarker[]>();
    annotationList?.forEach(({ id, messageIds, start, end, anchorText }, index) => {
      const entry = { id, number: index + 1, start, end, anchorText };
      for (const messageId of messageIds) {
        markers.set(messageId, [...(markers.get(messageId) ?? []), entry]);
      }
    });
    return markers;
  }, [annotationList]);
  const [expandedToolCallIds, setExpandedToolCallIds] = useState<Set<string>>(() => new Set());
  const toggleToolCall = useCallback(
    (id: string) =>
      setExpandedToolCallIds((current) => {
        const next = new Set(current);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    [],
  );
  useLayoutEffect(() => {
    const available = new Set(
      transcript.filter((item) => item.kind === "tool").map((item) => item.callId),
    );
    setExpandedToolCallIds((current) => {
      if ([...current].every((id) => available.has(id))) return current;
      return new Set([...current].filter((id) => available.has(id)));
    });
  }, [transcript]);
  // A row the user opened or closed keeps that; others follow the Show thinking setting, and
  // a block still streaming shows its newest lines.
  const [thinkingDisplay] = useThinkingDisplay();
  const [thinkingOverrides, setThinkingOverrides] = useState<ReadonlyMap<string, boolean>>(
    () => new Map(),
  );
  const toggleThinking = useCallback(
    (id: string, expanded: boolean) =>
      setThinkingOverrides((current) => new Map(current).set(id, expanded)),
    [],
  );
  useLayoutEffect(() => {
    setThinkingOverrides((current) => {
      if (current.size === 0) return current;
      const available = new Set(transcript.map((item) => item.id));
      if ([...current.keys()].every((id) => available.has(id))) return current;
      return new Map([...current].filter(([id]) => available.has(id)));
    });
  }, [transcript]);
  const renderedMessageIndexById = useMemo(() => {
    const indices = new Map<string, number>();
    let index = 0;
    for (const item of transcript) if (item.kind === "message") indices.set(item.id, index++);
    return indices;
  }, [transcript]);
  return (
    <ExtensionToolLabelsContext.Provider value={extensionToolLabels}>
      <div className="timeline-surface" ref={surfaceRef}>
        <div className="timeline-column">
          {threadSearch.isOpen ? (
            <ThreadSearchBar
              query={threadSearch.query}
              matchCount={threadSearch.matchCount}
              activeIndex={threadSearch.activeIndex}
              inputRef={threadSearch.inputRef}
              onSearch={threadSearch.search}
              onNext={() => threadSearch.goToMatch(1)}
              onPrev={() => threadSearch.goToMatch(-1)}
              onClose={threadSearch.close}
            />
          ) : null}
          <div
            className="timeline-pane timeline-pane--thread"
            data-testid="timeline-pane"
            ref={viewport.attachPane}
            tabIndex={0}
          >
            {transcriptFailed ? (
              <div className="timeline" data-testid="transcript">
                <TranscriptHydrateError
                  retrying={transcriptFailed.retrying}
                  onRetry={onRetryTranscript}
                />
              </div>
            ) : isTranscriptLoading ? (
              <div className="timeline" data-testid="transcript">
                <TranscriptSkeleton />
              </div>
            ) : transcript.length === 0 && !running ? (
              <div className="timeline" data-testid="transcript">
                <TranscriptEmptyState />
              </div>
            ) : (
              <div
                className="timeline timeline--virtualized"
                data-testid="transcript"
                style={{ height: viewport.totalHeight }}
              >
                {viewport.visibleRows.map(({ item, top, height }, index, rows) => (
                  <MeasuredTimelineItem
                    key={item.id}
                    item={item}
                    offset={top - rowBottom(rows[index - 1])}
                    height={height}
                    className="timeline__virtual-row"
                    onHeightChange={viewport.measureRow}
                    generation={viewport.layoutGeneration}
                    expandedToolCallIds={expandedToolCallIds}
                    onToggleToolCall={toggleToolCall}
                    thinkingExpanded={thinkingExpanded(item, thinkingOverrides, thinkingDisplay)}
                    onToggleThinking={toggleThinking}
                    onViewFileInDiff={onViewFileInDiff}
                    onOpenTurnChange={onOpenTurnChange}
                    sourceMessageIndex={renderedMessageIndexById.get(item.id)}
                    onForkFromMessage={onForkFromMessage}
                    onEditFromMessage={onEditFromMessage}
                    onOpenWorkspaceFileLine={onOpenWorkspaceFileLine}
                    onExtensionAction={onExtensionAction}
                    workspacePath={workspacePath}
                    annotationMarkers={
                      markersByMessage.get(item.id) ??
                      (item.kind === "message" && item.sourceMessageId
                        ? markersByMessage.get(item.sourceMessageId)
                        : undefined) ??
                      NO_MARKERS
                    }
                    onOpenAnnotation={annotationSelection.openAnnotation}
                    onStopRun={onStopRun}
                    scheduledOrigin={
                      item.kind === "message" ? scheduledOrigins?.get(item.id) : undefined
                    }
                  />
                ))}
              </div>
            )}
            {!transcriptFailed && viewport.showJumpToLatest ? (
              <button
                className="timeline-jump"
                data-testid="timeline-jump"
                type="button"
                onClick={viewport.jumpToLatest}
              >
                New activity below
              </button>
            ) : null}
          </div>
        </div>
        {annotationSelection.layer}
      </div>
    </ExtensionToolLabelsContext.Provider>
  );
}

function TranscriptSkeleton() {
  return (
    <div className="transcript-skeleton" data-testid="transcript-skeleton" aria-hidden="true">
      <div className="transcript-skeleton__row transcript-skeleton__row--user">
        <span className="skeleton-line" style={{ width: "42%" }} />
      </div>
      <div className="transcript-skeleton__row">
        <span className="skeleton-line" style={{ width: "88%" }} />
        <span className="skeleton-line" style={{ width: "94%" }} />
        <span className="skeleton-line" style={{ width: "66%" }} />
      </div>
      <div className="transcript-skeleton__row transcript-skeleton__row--tool">
        <span className="skeleton-line skeleton-line--tool" style={{ width: "38%" }} />
      </div>
      <div className="transcript-skeleton__row">
        <span className="skeleton-line" style={{ width: "80%" }} />
        <span className="skeleton-line" style={{ width: "72%" }} />
      </div>
      <span className="sr-only">Loading transcript…</span>
    </div>
  );
}

function TranscriptHydrateError({
  retrying,
  onRetry,
}: {
  readonly retrying: boolean;
  readonly onRetry?: () => void;
}) {
  return (
    <div className="transcript-hydrate-error" data-testid="transcript-hydrate-error">
      <h2>Couldn't load this thread</h2>
      <p>The selected conversation couldn't be restored. Retry to try again.</p>
      <div className="transcript-hydrate-error__actions">
        <button
          className="button button--primary"
          data-testid="hydrate-retry"
          type="button"
          disabled={retrying || !onRetry}
          onClick={onRetry}
        >
          {retrying ? "Retrying…" : "Retry"}
        </button>
      </div>
    </div>
  );
}

function TranscriptEmptyState() {
  return (
    <div className="transcript-empty" data-testid="transcript-empty">
      <span className="transcript-empty__glyph" aria-hidden="true">
        <SparkIcon />
      </span>
      <p className="transcript-empty__title">Start the conversation</p>
      <p className="transcript-empty__hint">Send a prompt below to begin this session.</p>
    </div>
  );
}

function thinkingExpanded(
  item: DisplayTimelineItem,
  overrides: ReadonlyMap<string, boolean>,
  display: ThinkingDisplay,
): boolean {
  if (item.kind !== "thinking") return false;
  return overrides.get(item.id) ?? (item.streaming === true || display === "expanded");
}

interface MeasuredTimelineItemProps {
  readonly item: DisplayTimelineItem;
  readonly className?: string;
  /** Space above the row: its layout top less the previous row's bottom. */
  readonly offset: number;
  readonly height: number;
  readonly onHeightChange: (id: string, height: number, generation: number) => void;
  readonly generation: number;
  readonly expandedToolCallIds: ReadonlySet<string>;
  readonly onToggleToolCall: (callId: string) => void;
  readonly thinkingExpanded: boolean;
  readonly onToggleThinking: (id: string, expanded: boolean) => void;
  readonly onViewFileInDiff?: (path: string) => void;
  readonly onOpenTurnChange?: OpenTurnChange;
  readonly sourceMessageIndex?: number;
  readonly onEditFromMessage?: (message: SessionTranscriptMessage) => void;
  readonly onForkFromMessage?: (messageIndex: number, preview?: string) => void;
  readonly onOpenWorkspaceFileLine?: (target: WorkspaceFileLine) => void;
  readonly onExtensionAction?: RunExtensionAction;
  readonly scheduledOrigin?: ScheduledTaskOrigin;
  readonly workspacePath?: string;
  readonly annotationMarkers: readonly AnnotationMarker[];
  readonly onOpenAnnotation: OpenAnnotation;
  readonly onStopRun?: (() => void) | undefined;
}

function MeasuredTimelineItemBase({
  item,
  className,
  offset,
  height,
  onHeightChange,
  generation,
  expandedToolCallIds,
  onToggleToolCall,
  thinkingExpanded,
  onToggleThinking,
  onViewFileInDiff,
  onOpenTurnChange,
  sourceMessageIndex,
  onForkFromMessage,
  onEditFromMessage,
  onOpenWorkspaceFileLine,
  onExtensionAction,
  scheduledOrigin,
  workspacePath,
  annotationMarkers,
  onOpenAnnotation,
  onStopRun,
}: MeasuredTimelineItemProps) {
  const rowRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const element = rowRef.current;
    if (!element) {
      return undefined;
    }

    const measure = () => {
      onHeightChange(item.id, element.getBoundingClientRect().height, generation);
    };

    measure();
    const resizeObserver = new ResizeObserver(() => {
      measure();
    });
    resizeObserver.observe(element);

    return () => {
      resizeObserver.disconnect();
    };
  }, [item, onHeightChange, generation]);

  // The row keeps its laid-out height in normal flow (see timeline.css); the content inside
  // is what gets measured, and may outgrow the row until its new height is laid out.
  return (
    <div
      className={className}
      data-message-id={item.id}
      data-source-message-id={item.kind === "message" ? item.sourceMessageId : undefined}
      style={{ marginTop: offset, height }}
    >
      <div className="timeline__virtual-row-content" ref={rowRef}>
        <TimelineItem
          item={item}
          expandedToolCallIds={expandedToolCallIds}
          onToggleToolCall={onToggleToolCall}
          thinkingExpanded={thinkingExpanded}
          onToggleThinking={onToggleThinking}
          onViewFileInDiff={onViewFileInDiff}
          onOpenTurnChange={onOpenTurnChange}
          sourceMessageIndex={sourceMessageIndex}
          onForkFromMessage={onForkFromMessage}
          onEditFromMessage={onEditFromMessage}
          onOpenWorkspaceFileLine={onOpenWorkspaceFileLine}
          onExtensionAction={onExtensionAction}
          scheduledOrigin={scheduledOrigin}
          workspacePath={workspacePath}
          annotationMarkers={annotationMarkers}
          onOpenAnnotation={onOpenAnnotation}
          onStopRun={onStopRun}
        />
      </div>
    </div>
  );
}

// The transcript array is rebuilt with fresh item objects on every session
// update, so reference equality on `item` would re-render all rows each
// streaming tick — on long threads (virtualization off) that means re-running
// every row several times per second, which saturates the renderer. Compare
// items structurally by the fields that actually affect their rendering.
function isSameDisplayItem(a: DisplayTimelineItem, b: DisplayTimelineItem): boolean {
  if (a === b) {
    return true;
  }
  if (a.kind !== b.kind || a.id !== b.id) {
    return false;
  }
  if (a.kind === "message" && b.kind === "message") {
    return (
      a.role === b.role &&
      a.text === b.text &&
      a.attachments === b.attachments &&
      a.sourceMessageId === b.sourceMessageId
    );
  }
  if (a.kind === "tool" && b.kind === "tool") {
    // input/output are rebuilt objects on every transcript update, so identity
    // comparison would re-render every tool row per streaming tick. All visible
    // transitions (result arrival, failure) flip status and/or the derived
    // label/detail/metadata strings, so compare those instead.
    return (
      a.status === b.status &&
      a.toolName === b.toolName &&
      a.label === b.label &&
      a.detail === b.detail &&
      a.metadata === b.metadata
    );
  }
  if (a.kind === "thinking" && b.kind === "thinking") {
    return sameRowContent(a, b);
  }
  if (a.kind === "activity" && b.kind === "activity") {
    return (
      a.label === b.label && a.detail === b.detail && a.metadata === b.metadata && a.tone === b.tone
    );
  }
  if (a.kind === "summary" && b.kind === "summary") {
    return a.label === b.label && a.metadata === b.metadata && a.presentation === b.presentation;
  }
  if (a.kind === "turn-marker" && b.kind === "turn-marker") {
    return a.durationMs === b.durationMs;
  }
  if (a.kind === "working" && b.kind === "working") {
    // The line ticks its own elapsed time, so only a new run start, wait or retry redraws it.
    return (
      a.startedAt === b.startedAt &&
      a.connectionRetry?.attempt === b.connectionRetry?.attempt &&
      a.connectionRetry?.retryAt === b.connectionRetry?.retryAt &&
      a.modelWait?.since === b.modelWait?.since &&
      a.modelWait?.retry?.attempt === b.modelWait?.retry?.attempt &&
      a.modelWait?.retry?.retryAt === b.modelWait?.retry?.retryAt &&
      a.modelWait?.request?.phase === b.modelWait?.request?.phase &&
      a.modelWait?.request?.pings === b.modelWait?.request?.pings &&
      a.modelWait?.request?.stallAt === b.modelWait?.request?.stallAt &&
      a.largeContext?.tokens === b.largeContext?.tokens &&
      a.largeContext?.cacheExpired === b.largeContext?.cacheExpired
    );
  }
  if (a.kind === "turn-changes" && b.kind === "turn-changes") {
    // A card's id is its checkpoint, and a captured turn's files never change.
    return true;
  }
  if ((a.kind === "card" || a.kind === "custom") && a.kind === b.kind) {
    return sameRowContent(a, b);
  }
  return false;
}

function rowBottom(row: TimelineRow | undefined): number {
  return row ? row.top + row.height : 0;
}

function areMeasuredTimelineItemPropsEqual(
  prev: MeasuredTimelineItemProps,
  next: MeasuredTimelineItemProps,
): boolean {
  return (
    isSameDisplayItem(prev.item, next.item) &&
    prev.className === next.className &&
    prev.offset === next.offset &&
    prev.height === next.height &&
    prev.generation === next.generation &&
    prev.onHeightChange === next.onHeightChange &&
    prev.expandedToolCallIds === next.expandedToolCallIds &&
    prev.onToggleToolCall === next.onToggleToolCall &&
    prev.thinkingExpanded === next.thinkingExpanded &&
    prev.onToggleThinking === next.onToggleThinking &&
    prev.onViewFileInDiff === next.onViewFileInDiff &&
    prev.onOpenTurnChange === next.onOpenTurnChange &&
    prev.sourceMessageIndex === next.sourceMessageIndex &&
    prev.onForkFromMessage === next.onForkFromMessage &&
    prev.onEditFromMessage === next.onEditFromMessage &&
    prev.onOpenWorkspaceFileLine === next.onOpenWorkspaceFileLine &&
    prev.onExtensionAction === next.onExtensionAction &&
    prev.workspacePath === next.workspacePath &&
    prev.annotationMarkers === next.annotationMarkers &&
    prev.onOpenAnnotation === next.onOpenAnnotation &&
    prev.onStopRun === next.onStopRun &&
    prev.scheduledOrigin?.taskId === next.scheduledOrigin?.taskId
  );
}

const MeasuredTimelineItem = memo(MeasuredTimelineItemBase, areMeasuredTimelineItemPropsEqual);
