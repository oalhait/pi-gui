/**
 * Image files a Files tab shows. Main checks the file's bytes, then hands the window a one-off
 * `pi-gui-image://workspace/<token>` URL bound to that window, workspace and path. The renderer
 * shows it with `<img>`, so an SVG's scripts never run, and never receives the bytes itself.
 */

/** Host on the tool-output image scheme that serves workspace image files. */
export const WORKSPACE_IMAGE_HOST = "workspace";
/** Largest image file the Files tab shows. */
export const MAX_WORKSPACE_IMAGE_BYTES = 32 * 1024 * 1024;
/** Most neighbouring images returned for flipping with the arrow keys. */
export const MAX_WORKSPACE_IMAGE_SIBLINGS = 500;

export type WorkspaceImageMimeType =
  | "image/png"
  | "image/jpeg"
  | "image/gif"
  | "image/webp"
  | "image/svg+xml"
  | "image/bmp"
  | "image/x-icon";

const IMAGE_EXTENSIONS: Readonly<Record<string, WorkspaceImageMimeType>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
};

/** The image type a path's extension names, if the Files tab shows that kind of image. */
export function imageTypeForPath(path: string): WorkspaceImageMimeType | undefined {
  const match = /\.([a-z0-9]+)$/i.exec(path);
  return match ? IMAGE_EXTENSIONS[match[1]!.toLowerCase()] : undefined;
}

/** Short label for an image type, such as "PNG". */
export function imageTypeLabel(mimeType: WorkspaceImageMimeType): string {
  switch (mimeType) {
    case "image/svg+xml":
      return "SVG";
    case "image/x-icon":
      return "ICO";
    default:
      return mimeType.slice("image/".length).toUpperCase();
  }
}

export type WorkspaceImageResult =
  | {
      readonly kind: "image";
      readonly src: string;
      readonly mimeType: WorkspaceImageMimeType;
      readonly sizeBytes: number;
      /** Image files in the same folder, as workspace paths in display order, including this one. */
      readonly siblings: readonly string[];
    }
  | {
      readonly kind: "unsupported";
      /** `too-large` above the size cap; `not-image` when the bytes aren't the named image type. */
      readonly reason: "too-large" | "not-image" | "not-file";
      readonly sizeBytes: number;
    };
