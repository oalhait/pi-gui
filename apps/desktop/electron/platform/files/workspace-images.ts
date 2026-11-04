import { randomBytes } from "node:crypto";
import { open, readdir } from "node:fs/promises";
import path from "node:path";
import {
  MAX_WORKSPACE_IMAGE_BYTES,
  MAX_WORKSPACE_IMAGE_SIBLINGS,
  WORKSPACE_IMAGE_HOST,
  imageTypeForPath,
  type WorkspaceImageMimeType,
  type WorkspaceImageResult,
} from "../../../contracts/workspace-images";
import { TOOL_IMAGE_SCHEME } from "../../../contracts/tool-output-images";
import { resolveExistingWorkspacePath, resolveWorkspacePath } from "./workspace-paths";

const SNIFF_BYTES = 4096;
const MAX_TOKENS = 256;

/**
 * The image type a file's leading bytes show. Raster formats are recognised by their signature;
 * SVG must be text whose first element (after any XML declaration, comments or doctype) is `<svg`.
 */
export function sniffImageType(bytes: Uint8Array): WorkspaceImageMimeType | undefined {
  const starts = (...signature: number[]) =>
    signature.every((byte, index) => bytes[index] === byte);
  const ascii = (offset: number, text: string) =>
    [...text].every((char, index) => bytes[offset + index] === char.charCodeAt(0));
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (ascii(0, "GIF87a") || ascii(0, "GIF89a")) return "image/gif";
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp";
  if (ascii(0, "BM") && bytes.length >= 26) return "image/bmp";
  if (starts(0x00, 0x00, 0x01, 0x00) && bytes.length >= 6 && (bytes[4]! > 0 || bytes[5]! > 0))
    return "image/x-icon";
  if (bytes.includes(0)) return undefined;
  const text = new TextDecoder("utf-8", { fatal: false })
    .decode(bytes)
    .replace(/^\uFEFF/, "")
    .replace(
      /^(\s*(<\?xml[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>[]*(\[[\s\S]*?\])?\s*>))*\s*/i,
      "",
    );
  return /^<svg[\s>/]/i.test(text) ? "image/svg+xml" : undefined;
}

/** Whether the bytes are the image the path's extension names. Raster types may disagree. */
function acceptedType(
  named: WorkspaceImageMimeType,
  sniffed: WorkspaceImageMimeType | undefined,
): WorkspaceImageMimeType | undefined {
  if (!sniffed) return undefined;
  // SVG is text: only show it when both the name and the bytes say SVG.
  if ((named === "image/svg+xml") !== (sniffed === "image/svg+xml")) return undefined;
  return sniffed;
}

interface CheckedImage {
  readonly realPath: string;
  readonly mimeType: WorkspaceImageMimeType;
  readonly sizeBytes: number;
}

async function checkImage(
  workspacePath: string,
  filePath: string,
): Promise<CheckedImage | Extract<WorkspaceImageResult, { kind: "unsupported" }>> {
  const named = imageTypeForPath(filePath);
  const realPath = await resolveExistingWorkspacePath(workspacePath, filePath);
  const handle = await open(realPath, "r");
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) return { kind: "unsupported", reason: "not-file", sizeBytes: stats.size };
    if (stats.size > MAX_WORKSPACE_IMAGE_BYTES)
      return { kind: "unsupported", reason: "too-large", sizeBytes: stats.size };
    const head = Buffer.alloc(Math.min(stats.size, SNIFF_BYTES));
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    const mimeType = named && acceptedType(named, sniffImageType(head.subarray(0, bytesRead)));
    if (!mimeType) return { kind: "unsupported", reason: "not-image", sizeBytes: stats.size };
    return { realPath, mimeType, sizeBytes: stats.size };
  } finally {
    await handle.close();
  }
}

/** Image files beside `filePath`, as workspace paths, at most `limit` around it. */
export async function siblingImagePaths(
  workspacePath: string,
  filePath: string,
  limit = MAX_WORKSPACE_IMAGE_SIBLINGS,
): Promise<string[]> {
  const normalized = filePath.split(path.sep).join("/");
  const slash = normalized.lastIndexOf("/");
  const folder = slash < 0 ? "" : normalized.slice(0, slash);
  let names: string[];
  try {
    const entries = await readdir(resolveWorkspacePath(workspacePath, folder || "."), {
      withFileTypes: true,
    });
    names = entries
      .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && imageTypeForPath(entry.name))
      .map((entry) => entry.name);
  } catch {
    names = [];
  }
  const paths = names
    .map((name) => (folder ? `${folder}/${name}` : name))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
  if (!paths.includes(normalized)) return [normalized];
  if (paths.length <= limit) return paths;
  const index = paths.indexOf(normalized);
  const start = Math.max(0, Math.min(index - Math.floor(limit / 2), paths.length - limit));
  return paths.slice(start, start + limit);
}

interface ImageGrant {
  readonly windowId: number;
  readonly workspacePath: string;
  readonly filePath: string;
  readonly mimeType: WorkspaceImageMimeType;
}

/**
 * Serves workspace image files to the window that asked for them. Each open returns a fresh,
 * unguessable URL; a request re-resolves the path inside the workspace, re-checks the size cap and
 * bytes, and serves the file only as the image type it was granted as.
 */
export class WorkspaceImageServer {
  private readonly grants = new Map<string, ImageGrant>();

  async open(
    windowId: number,
    workspacePath: string,
    filePath: string,
  ): Promise<WorkspaceImageResult> {
    const checked = await checkImage(workspacePath, filePath);
    if ("kind" in checked) return checked;
    const token = randomBytes(24).toString("base64url");
    this.grants.set(token, { windowId, workspacePath, filePath, mimeType: checked.mimeType });
    while (this.grants.size > MAX_TOKENS) {
      const oldest = this.grants.keys().next().value;
      if (oldest === undefined) break;
      this.grants.delete(oldest);
    }
    return {
      kind: "image",
      src: `${TOOL_IMAGE_SCHEME}://${WORKSPACE_IMAGE_HOST}/${token}`,
      mimeType: checked.mimeType,
      sizeBytes: checked.sizeBytes,
      siblings: await siblingImagePaths(workspacePath, filePath),
    };
  }

  /** Forgets every URL handed to a window, such as when it closes. */
  revokeWindow(windowId: number): void {
    for (const [token, grant] of this.grants) {
      if (grant.windowId === windowId) this.grants.delete(token);
    }
  }

  async response(requestUrl: string): Promise<Response> {
    const url = new URL(requestUrl);
    const grant =
      url.host === WORKSPACE_IMAGE_HOST ? this.grants.get(url.pathname.slice(1)) : undefined;
    if (!grant) return new Response("Not found", { status: 404 });
    try {
      const checked = await checkImage(grant.workspacePath, grant.filePath);
      if ("kind" in checked || checked.mimeType !== grant.mimeType)
        return new Response("Not found", { status: 404 });
      const handle = await open(checked.realPath, "r");
      let bytes: Buffer;
      try {
        const size = Math.min((await handle.stat()).size, MAX_WORKSPACE_IMAGE_BYTES);
        bytes = Buffer.alloc(size);
        const { bytesRead } = await handle.read(bytes, 0, size, 0);
        bytes = bytes.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
      return new Response(new Uint8Array(bytes), {
        headers: {
          "content-type": grant.mimeType,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          // Shown only through <img>, where scripts never run; this also covers a direct load.
          "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        },
      });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  }
}
