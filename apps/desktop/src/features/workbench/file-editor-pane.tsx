import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { WorkspaceRecord, WorktreeRecord } from "../../../contracts/desktop-state";
import type { PiDesktopApi, WorkspaceFilePreview } from "../../../contracts/ipc";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CopyIcon, WorktreeIcon } from "../../ui/icons";
import { HighlightedLine } from "../../ui/highlighted-line";
import { MAX_HIGHLIGHTED_LINES, extensionToLanguage } from "../../ui/syntax-highlight";
import { imageTypeForPath, type WorkspaceImageResult } from "../../../contracts/workspace-images";
import {
  breadcrumbSegments,
  formatByteSize,
  isMarkdownPath,
  type FileLineMark,
} from "./file-workbench-state";
import { FileImageViewer } from "./file-image-viewer";

interface FileEditorPaneProps {
  readonly api: PiDesktopApi;
  readonly workspace: WorkspaceRecord;
  readonly worktree: WorktreeRecord | undefined;
  /** The one file this tab shows. */
  readonly path: string;
  /** A highlighted range in this file, if a link opened it at a line. */
  readonly line: FileLineMark | null;
  readonly lineNonce: number;
  /** Changes when this file was opened again, which re-reads it. */
  readonly refreshNonce: number;
  /** Shows another file in this tab, such as the next image in the folder. */
  readonly onNavigate: (path: string) => void;
}

const FILE_MARKDOWN_COMPONENTS = {
  code: ({ className, children }: { className?: string; children?: ReactNode }) => {
    const code = String(children).replace(/\n$/, "");
    return <code className={className}>{code}</code>;
  },
  a: ({ href, children }: { href?: string; children?: ReactNode }) => (
    <a href={href} rel="noreferrer" target="_blank">
      {children}
    </a>
  ),
  table: ({ children }: { children?: ReactNode }) => (
    <div className="message__table-scroll">
      <table>{children}</table>
    </div>
  ),
  img: ({ alt }: { alt?: string }) => (
    <span className="file-editor__blocked-image">{alt ? `[image: ${alt}]` : "[image]"}</span>
  ),
};

const FILE_MARKDOWN_PLUGINS = [remarkGfm];

export function FileEditorPane({
  api,
  workspace,
  worktree,
  path: activePath,
  line: lineMark,
  lineNonce,
  refreshNonce,
  onNavigate,
}: FileEditorPaneProps) {
  const [preview, setPreview] = useState<WorkspaceFilePreview | null>(null);
  const [image, setImage] = useState<WorkspaceImageResult | null>(null);
  const [viewerError, setViewerError] = useState<string | null>(null);
  const [viewerLoading, setViewerLoading] = useState(false);
  const [missing, setMissing] = useState(false);
  /** Bumped when main reports this file changed on disk. */
  const [diskRevision, setDiskRevision] = useState(0);
  /** The view (path and image/text mode) whose content is on screen, refreshed in place. */
  const shownView = useRef<string | null>(null);
  /** The open (refreshNonce) the content on screen was read for; the agent waits on it. */
  const [settledRefresh, setSettledRefresh] = useState<number | null>(null);
  const [sourceMode, setSourceMode] = useState(() => lineMark !== null);
  const nextSourceKey = `${activePath}:${lineMark ? lineNonce : "none"}`;
  const [sourceKey, setSourceKey] = useState(nextSourceKey);
  if (sourceKey !== nextSourceKey) {
    setSourceKey(nextSourceKey);
    setSourceMode(lineMark !== null);
  }
  const markdown = isMarkdownPath(activePath);
  const imageType = imageTypeForPath(activePath);
  const svg = imageType === "image/svg+xml";
  // An SVG can also be read as source; other images only show as images.
  const showImage = imageType !== undefined && !(svg && sourceMode);
  const worktreeLabel =
    workspace.kind === "worktree"
      ? (worktree?.name ?? workspace.branchName ?? workspace.name)
      : null;

  useEffect(
    () =>
      api.onWorkspaceFileChanged((change) => {
        if (change.workspaceId !== workspace.id || change.path !== activePath) return;
        if (change.kind === "deleted") setMissing(true);
        else setDiskRevision((revision) => revision + 1);
      }),
    [activePath, api, workspace.id],
  );

  useEffect(() => {
    let cancelled = false;
    const view = `${workspace.id}:${activePath}:${showImage ? "image" : "text"}`;
    // A re-read of the content on screen swaps it in place, keeping the scroll position.
    const refresh = shownView.current === view;
    if (!refresh) {
      shownView.current = null;
      setViewerLoading(true);
    }
    const request = showImage
      ? api.openWorkspaceImage(workspace.id, activePath).then((result) => {
          if (!cancelled) {
            setImage(result);
            setPreview(null);
          }
        })
      : api.readWorkspaceFile(workspace.id, activePath).then((result) => {
          if (!cancelled) {
            setPreview(result);
            setImage(null);
          }
        });
    void request
      .then(() => {
        if (!cancelled) {
          shownView.current = view;
          setMissing(false);
          setViewerError(null);
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : String(error);
        shownView.current = null;
        setPreview(null);
        setImage(null);
        if (/\bENOENT\b/.test(message)) {
          setMissing(true);
          setViewerError(null);
        } else {
          setMissing(false);
          setViewerError(message);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setViewerLoading(false);
          setSettledRefresh(refreshNonce);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activePath, api, diskRevision, refreshNonce, showImage, workspace.id]);

  const showSource = (!markdown && !svg) || sourceMode;

  return (
    <section
      aria-label="Open file"
      className="side-panel file-editor"
      data-path={activePath}
      data-refresh={settledRefresh ?? undefined}
      data-state={viewerLoading ? "loading" : missing ? "missing" : viewerError ? "error" : "ready"}
      data-testid="file-editor"
    >
      <div className="file-editor__toolbar">
        {worktreeLabel ? (
          <span className="file-editor__worktree-chip" data-testid="file-editor-worktree-chip">
            <WorktreeIcon />
            <span>{worktreeLabel}</span>
          </span>
        ) : null}
        <nav
          aria-label="File path"
          className="file-editor__breadcrumb"
          data-testid="file-editor-breadcrumb"
          title={activePath}
        >
          {breadcrumbSegments(activePath).map((segment, index, segments) => (
            <span key={`${segment}-${index}`}>
              {index > 0 ? <span className="file-editor__breadcrumb-sep">›</span> : null}
              <span className={index === segments.length - 1 ? "file-editor__breadcrumb-file" : ""}>
                {segment}
              </span>
            </span>
          ))}
        </nav>
        <div className="file-editor__actions">
          {markdown || svg ? (
            <button
              aria-pressed={showSource}
              className={
                showSource
                  ? "file-workbench__mode file-workbench__mode--active"
                  : "file-workbench__mode"
              }
              type="button"
              onClick={() => setSourceMode((current) => !current)}
            >
              View source
            </button>
          ) : null}
          <button
            aria-label="Copy file"
            className="icon-button"
            disabled={!preview || preview.binary || Boolean(viewerError) || missing}
            type="button"
            onClick={() => {
              if (preview && !preview.binary) {
                void navigator.clipboard.writeText(preview.content).catch((error: unknown) => {
                  console.error("[renderer] copy file failed", error);
                });
              }
            }}
          >
            <CopyIcon />
          </button>
          <button
            className="file-workbench__mode"
            type="button"
            onClick={() => {
              void api.revealWorkspaceFile(workspace.id, activePath).catch((error: unknown) => {
                setViewerError(error instanceof Error ? error.message : String(error));
              });
            }}
          >
            Open
          </button>
        </div>
      </div>
      <div className="file-editor__body">
        {renderEditorBody({
          activePath,
          image: showImage ? image : null,
          lineMark: showSource ? lineMark : null,
          markdown,
          missing,
          onNavigate,
          preview,
          showSource,
          viewerError,
          viewerLoading,
        })}
      </div>
    </section>
  );
}

function renderEditorBody({
  activePath,
  image,
  lineMark,
  markdown,
  missing,
  onNavigate,
  preview,
  showSource,
  viewerError,
  viewerLoading,
}: {
  readonly activePath: string;
  readonly image: WorkspaceImageResult | null;
  readonly lineMark: FileLineMark | null;
  readonly markdown: boolean;
  readonly missing: boolean;
  readonly onNavigate: (path: string) => void;
  readonly preview: WorkspaceFilePreview | null;
  readonly showSource: boolean;
  readonly viewerError: string | null;
  readonly viewerLoading: boolean;
}): ReactNode {
  if (viewerLoading) {
    return <div className="diff-panel__empty">Loading file...</div>;
  }
  if (missing) {
    return (
      <div className="diff-panel__empty file-editor__no-preview" data-testid="file-missing">
        <strong>This file no longer exists</strong>
        <span>It was deleted or moved. This tab shows it again if it comes back.</span>
      </div>
    );
  }
  if (viewerError) {
    return <div className="diff-panel__empty">{viewerError}</div>;
  }
  if (image?.kind === "image") {
    return (
      <FileImageViewer
        key={activePath}
        mimeType={image.mimeType}
        path={activePath}
        siblings={image.siblings}
        sizeBytes={image.sizeBytes}
        src={image.src}
        onNavigate={onNavigate}
      />
    );
  }
  if (image) {
    return (
      <CannotPreview
        detail={
          image.reason === "too-large"
            ? `This image is ${formatByteSize(image.sizeBytes)}, larger than the side pane shows.`
            : image.reason === "not-image"
              ? "The file's contents aren't the image type its name says."
              : "This isn't a file."
        }
      />
    );
  }
  if (!preview) {
    return <div className="diff-panel__empty">No preview available.</div>;
  }
  if (preview.binary) {
    return (
      <CannotPreview
        detail={`Not text or a supported image · ${formatByteSize(preview.sizeBytes)}. Use Open to view it in another app.`}
      />
    );
  }
  return (
    <>
      {markdown && !showSource ? (
        <FileMarkdown text={preview.content} />
      ) : (
        <SourceView content={preview.content} lineMark={lineMark} path={activePath} />
      )}
      {preview.truncated ? (
        <div className="file-editor__truncated" role="status">
          Preview truncated
        </div>
      ) : null}
    </>
  );
}

function CannotPreview({ detail }: { readonly detail: string }) {
  return (
    <div className="diff-panel__empty file-editor__no-preview" data-testid="file-no-preview">
      <strong>Can&apos;t preview this file</strong>
      <span>{detail}</span>
    </div>
  );
}

function FileMarkdown({ text }: { readonly text: string }) {
  return (
    <div className="file-editor__markdown message__content" data-testid="file-workbench-preview">
      <ReactMarkdown remarkPlugins={FILE_MARKDOWN_PLUGINS} components={FILE_MARKDOWN_COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

function SourceView({
  path,
  content,
  lineMark,
}: {
  readonly path: string;
  readonly content: string;
  readonly lineMark: FileLineMark | null;
}) {
  const language = extensionToLanguage(path);
  const lines = content.split("\n");
  const highlightActive = language !== undefined && lines.length <= MAX_HIGHLIGHTED_LINES;
  const firstMarkedRef = useRef<HTMLDivElement | null>(null);
  // Scroll to a marked line when it is shown, not again when the file changes on disk.
  useEffect(() => {
    const line = firstMarkedRef.current;
    if (line) {
      scrollIntoContainer(line, ".file-editor__body");
    }
  }, [lineMark, path]);
  return (
    <pre
      className="file-editor__source file-workbench__preview"
      data-testid="file-workbench-preview"
    >
      {lines.map((line, index) => {
        const lineNumber = index + 1;
        const marked =
          lineMark !== null && lineNumber >= lineMark.start && lineNumber <= lineMark.end;
        return (
          <div
            className={marked ? "file-editor__line file-editor__line--marked" : "file-editor__line"}
            data-line={lineNumber}
            data-testid={marked ? "file-line-mark" : undefined}
            key={lineNumber}
            ref={marked && lineNumber === lineMark?.start ? firstMarkedRef : undefined}
          >
            {highlightActive ? <HighlightedLine content={line} language={language} /> : line || " "}
          </div>
        );
      })}
    </pre>
  );
}

function scrollIntoContainer(element: HTMLElement, containerSelector: string): void {
  const container = element.closest(containerSelector);
  if (!(container instanceof HTMLElement)) {
    return;
  }
  const elementRect = element.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  if (elementRect.top >= containerRect.top && elementRect.bottom <= containerRect.bottom) {
    return;
  }
  const top =
    container.scrollTop +
    (elementRect.top - containerRect.top) -
    container.clientHeight / 2 +
    elementRect.height / 2;
  container.scrollTop = Math.max(0, top);
}
