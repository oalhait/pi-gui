import { nativeImage, type BrowserWindow, type NativeImage } from "electron";
import type { SessionRef } from "@pi-gui/session-driver";
import type { WorkbenchCaptureTarget } from "../../contracts/workbench-agent";
import type { BrowserOwner } from "./browser-owner";

/** Longest edge sent to the model. Larger captures are downscaled, never cropped. */
export const MAX_CAPTURE_EDGE = 1600;
const MAX_PNG_BYTES = 1_000_000;

export interface WorkbenchCaptureImage {
  readonly data: string;
  readonly mimeType: "image/png" | "image/jpeg";
  readonly width: number;
  readonly height: number;
}
export interface WorkbenchCaptureResult {
  /** JSON-safe description returned to the model and kept in tool details. */
  readonly summary: Record<string, unknown>;
  readonly image?: WorkbenchCaptureImage;
}
export type WorkbenchCapturer = (
  window: BrowserWindow,
  target: SessionRef,
  capture: WorkbenchCaptureTarget,
) => Promise<WorkbenchCaptureResult>;

export function captureSize(
  width: number,
  height: number,
  limit = MAX_CAPTURE_EDGE,
): { width: number; height: number } {
  const scale = Math.min(1, limit / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** Encodes in memory only: captures are never written to disk or logged. */
export function encodeCaptureImage(image: NativeImage): WorkbenchCaptureImage | undefined {
  if (image.isEmpty()) return undefined;
  // Use the densest representation (2x on Retina) so text stays legible after downscaling.
  const scaleFactor = Math.max(1, ...image.getScaleFactors());
  const pixels = image.getSize(scaleFactor);
  if (pixels.width <= 0 || pixels.height <= 0) return undefined;
  const source = nativeImage.createFromBitmap(image.toBitmap({ scaleFactor }), pixels);
  const size = captureSize(pixels.width, pixels.height);
  const output =
    size.width === pixels.width && size.height === pixels.height
      ? source
      : source.resize({ ...size, quality: "best" });
  const png = output.toPNG();
  const [bytes, mimeType] =
    png.length <= MAX_PNG_BYTES
      ? ([png, "image/png"] as const)
      : ([output.toJPEG(85), "image/jpeg"] as const);
  const actual = output.getSize();
  return {
    data: bytes.toString("base64"),
    mimeType,
    width: actual.width,
    height: actual.height,
  };
}

export function createWorkbenchCapturer(browser: () => BrowserOwner): WorkbenchCapturer {
  return async (window, target, capture) => {
    if (capture.kind === "browser") {
      const page = await browser().capturePage(window, target, capture.pageId);
      const image = page.image ? encodeCaptureImage(page.image) : undefined;
      const notes: string[] = [];
      if (page.unavailable) notes.push(page.unavailable);
      else if (!image) notes.push("The page has not rendered any content yet.");
      if (!capture.selected)
        notes.push(
          "The user is not looking at this page right now: another tab is selected or the side pane is hidden.",
        );
      else if (!page.shown && !page.unavailable)
        notes.push(
          "The page is covered by a pi-gui dialog, menu or overlay, so the user may not see it right now.",
        );
      return {
        summary: {
          tab_id: capture.tabId,
          kind: "browser",
          url: page.url,
          title: page.title,
          loading: page.loading,
          ...(page.error ? { error: page.error } : {}),
          viewport: page.viewport,
          visible_to_user: capture.selected && page.shown,
          image: image ? { width: image.width, height: image.height } : null,
          ...(notes.length ? { note: notes.join(" ") } : {}),
        },
        ...(image ? { image } : {}),
      };
    }
    let image: WorkbenchCaptureImage | undefined;
    let note = capture.unavailable;
    if (capture.rect && !note) {
      const zoom = window.webContents.getZoomFactor();
      const content = window.getContentBounds();
      const x = Math.max(0, Math.round(capture.rect.x * zoom));
      const y = Math.max(0, Math.round(capture.rect.y * zoom));
      const rect = {
        x,
        y,
        width: Math.min(Math.round(capture.rect.width * zoom), content.width - x),
        height: Math.min(Math.round(capture.rect.height * zoom), content.height - y),
      };
      if (rect.width > 0 && rect.height > 0)
        image = encodeCaptureImage(
          await window.webContents.capturePage(rect, { stayHidden: true }),
        );
      if (!image) note = "The side pane has not rendered any content yet.";
    }
    return {
      summary: {
        tab_id: capture.tabId,
        kind: capture.tool,
        title: capture.title,
        description: capture.description,
        image: image ? { width: image.width, height: image.height } : null,
        ...(note ? { note } : {}),
      },
      ...(image ? { image } : {}),
    };
  };
}
