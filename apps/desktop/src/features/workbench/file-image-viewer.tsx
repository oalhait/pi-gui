import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { imageTypeLabel, type WorkspaceImageMimeType } from "../../../contracts/workspace-images";
import { fileNameFromPath, formatByteSize, siblingPath } from "./file-workbench-state";

interface FileImageViewerProps {
  /** Main's one-off URL for this file; never a file:// or remote address. */
  readonly src: string;
  readonly path: string;
  readonly mimeType: WorkspaceImageMimeType;
  readonly sizeBytes: number;
  /** Image files in the same folder, in display order, including this one. */
  readonly siblings: readonly string[];
  /** Shows another image of the folder in this tab. */
  readonly onNavigate: (path: string) => void;
}

type Zoom = "fit" | "actual";

/** The image a flip moved to, so its viewer takes keyboard focus when it mounts. */
let focusOnMount: string | null = null;

/**
 * One image file, shown through `<img>` so an SVG's scripts never run. It fits the pane by
 * default; 100% shows actual pixels and pans by scrolling or dragging. ←/→ flip through the
 * folder's other images in this tab.
 */
export function FileImageViewer({
  src,
  path,
  mimeType,
  sizeBytes,
  siblings,
  onNavigate,
}: FileImageViewerProps) {
  const [zoom, setZoom] = useState<Zoom>("fit");
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const [shownWidth, setShownWidth] = useState(0);
  const [failed, setFailed] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);

  useEffect(() => {
    if (focusOnMount === path) {
      focusOnMount = null;
      rootRef.current?.focus();
    }
  }, [path]);

  useEffect(() => {
    const image = imageRef.current;
    if (!image) return;
    const observer = new ResizeObserver(() => setShownWidth(image.getBoundingClientRect().width));
    observer.observe(image);
    return () => observer.disconnect();
  }, []);

  const previous = siblingPath(siblings, path, -1);
  const next = siblingPath(siblings, path, 1);
  const navigate = (target: string | undefined) => {
    if (!target) return;
    if (rootRef.current?.contains(document.activeElement)) focusOnMount = target;
    onNavigate(target);
  };
  const scale = natural && natural.width > 0 && shownWidth > 0 ? shownWidth / natural.width : null;
  const canPan = zoom === "actual";
  // A fitted image that isn't scaled down is already at actual size.
  const atActualSize = zoom === "fit" && scale !== null && scale > 0.999;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const action: Record<string, () => void> = {
      ArrowLeft: () => navigate(previous),
      ArrowRight: () => navigate(next),
      "0": () => setZoom("fit"),
      "1": () => setZoom("actual"),
    };
    const run = action[event.key];
    if (!run) return;
    event.preventDefault();
    run();
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    const stage = stageRef.current;
    if (!canPan || !stage || event.button !== 0) return;
    drag.current = {
      x: event.clientX,
      y: event.clientY,
      left: stage.scrollLeft,
      top: stage.scrollTop,
    };
    stage.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const stage = stageRef.current;
    const start = drag.current;
    if (!stage || !start) return;
    stage.scrollLeft = start.left - (event.clientX - start.x);
    stage.scrollTop = start.top - (event.clientY - start.y);
  };
  const endDrag = () => {
    drag.current = null;
  };

  const position = siblings.indexOf(path);
  return (
    <div
      aria-label={`Image ${fileNameFromPath(path)}`}
      className="file-image"
      data-height={natural?.height}
      data-path={path}
      data-state={failed ? "error" : natural ? "loaded" : "loading"}
      data-testid="file-image"
      data-width={natural?.width}
      data-zoom={zoom}
      ref={rootRef}
      role="group"
      tabIndex={0}
      onKeyDown={onKeyDown}
    >
      <div
        className={`file-image__stage file-image__stage--${zoom}`}
        data-testid="file-image-stage"
        ref={stageRef}
        onLostPointerCapture={endDrag}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
      >
        {failed ? (
          <p className="file-image__error" role="status">
            Couldn&apos;t show this image.
          </p>
        ) : null}
        <img
          alt={fileNameFromPath(path)}
          className="file-image__image"
          data-testid="file-image-image"
          draggable={false}
          hidden={failed}
          ref={imageRef}
          src={src}
          style={
            zoom === "actual" && natural
              ? { width: natural.width, height: natural.height }
              : undefined
          }
          onDoubleClick={() => setZoom((current) => (current === "fit" ? "actual" : "fit"))}
          onError={() => setFailed(true)}
          onLoad={(event) => {
            const image = event.currentTarget;
            setFailed(false);
            setNatural({ width: image.naturalWidth, height: image.naturalHeight });
            setShownWidth(image.getBoundingClientRect().width);
          }}
        />
      </div>
      <div className="file-image__footer">
        <span className="file-image__info" data-testid="file-image-info">
          {[
            natural ? `${natural.width} × ${natural.height} px` : null,
            formatByteSize(sizeBytes),
            imageTypeLabel(mimeType),
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
        {siblings.length > 1 && position >= 0 ? (
          <span className="file-image__nav">
            <button
              aria-label="Previous image"
              className="file-image__button"
              disabled={!previous}
              title="Previous image (←)"
              type="button"
              onClick={() => navigate(previous)}
            >
              ‹
            </button>
            <span data-testid="file-image-position">
              {position + 1} / {siblings.length}
            </span>
            <button
              aria-label="Next image"
              className="file-image__button"
              disabled={!next}
              title="Next image (→)"
              type="button"
              onClick={() => navigate(next)}
            >
              ›
            </button>
          </span>
        ) : null}
        <span className="file-image__zoom">
          {scale !== null && !atActualSize ? (
            <span data-testid="file-image-scale">{Math.round(scale * 100)}%</span>
          ) : null}
          <button
            aria-pressed={zoom === "actual"}
            className="file-image__button"
            data-testid="file-image-zoom"
            disabled={atActualSize}
            title={zoom === "fit" ? "Show actual size (1)" : "Fit to pane (0)"}
            type="button"
            onClick={() => setZoom((current) => (current === "fit" ? "actual" : "fit"))}
          >
            {zoom === "fit" ? "100%" : "Fit"}
          </button>
        </span>
      </div>
    </div>
  );
}
