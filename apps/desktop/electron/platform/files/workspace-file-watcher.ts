import { watch, type FSWatcher } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import type { WorkspaceFileChange } from "../../../contracts/ipc";
import { MAX_WORKBENCH_FILE_TABS } from "../../../contracts/workbench";
import { resolveWorkspacePath } from "./workspace-paths";

/** Watches only a single file or folder entry, never a tree. */
export type WatchFactory = (
  target: string,
  listener: (filename: string | null) => void,
) => { close(): void };

const nativeWatch: WatchFactory = (target, listener) => {
  const watcher: FSWatcher = watch(target, { persistent: false }, (_event, filename) =>
    listener(typeof filename === "string" ? filename : null),
  );
  // A watched entry that disappears can error on some platforms; the folder watch covers it.
  watcher.on("error", () => watcher.close());
  return watcher;
};

function logFailure(error: unknown): void {
  console.error("[main] watchWorkspaceFiles failed", error);
}

interface WatchedFile {
  readonly owner: Subscription;
  readonly path: string;
  readonly absolute: string;
  /** `missing`, or the identity and timestamps the last check saw. */
  signature: string;
  file?: { readonly signature: string; readonly handle: { close(): void } };
  folder?: string;
  timer?: ReturnType<typeof setTimeout>;
  closed: boolean;
}

interface Subscription {
  readonly key: number;
  readonly workspaceId: string;
  readonly root: string;
  readonly files: Map<string, WatchedFile>;
}

interface SharedFolder {
  readonly handle: { close(): void };
  readonly files: Set<WatchedFile>;
}

async function signatureOf(absolute: string): Promise<string> {
  try {
    const stats = await stat(absolute);
    return stats.isFile()
      ? `${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`
      : `other:${stats.ino}`;
  } catch {
    return "missing";
  }
}

async function isFolder(absolute: string): Promise<boolean> {
  try {
    return (await stat(absolute)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Watches the files a window shows in tabs, so each tab can re-read its file when it changes on
 * disk. Each file has its own watch plus a shared watch on its folder, which sees atomic
 * temp-file-and-rename writes and a file that reappears. A file whose folder is gone waits on its
 * nearest existing folder inside the workspace. Changes are debounced and compared against the
 * file's identity, size and timestamps, so a read or a duplicate event never reports a change.
 */
export class WorkspaceFileWatcher {
  private readonly subscriptions = new Map<number, Subscription>();
  private readonly folders = new Map<string, SharedFolder>();
  private readonly queues = new Map<number, Promise<void>>();

  constructor(
    private readonly emit: (key: number, change: WorkspaceFileChange) => void,
    private readonly watchEntry: WatchFactory = nativeWatch,
    private readonly debounceMs = 150,
  ) {}

  /** Replaces the set of files `key` (a window) watches. An empty list stops watching. */
  set(
    key: number,
    workspaceId: string,
    workspacePath: string,
    paths: readonly string[],
  ): Promise<void> {
    return this.enqueue(key, () => this.apply(key, workspaceId, workspacePath, paths));
  }

  /** Stops watching for `key` now and after any change to its set still in progress. */
  dispose(key: number): void {
    this.release(key);
    if (this.queues.has(key)) this.enqueue(key, () => this.release(key)).catch(logFailure);
  }

  /** Runs `task` after this key's earlier changes; it never rejects. */
  private enqueue(key: number, task: () => void | Promise<void>): Promise<void> {
    const next: Promise<void> = (this.queues.get(key) ?? Promise.resolve())
      .then(task)
      .catch(logFailure)
      .then(() => {
        if (this.queues.get(key) === next) this.queues.delete(key);
      });
    this.queues.set(key, next);
    return next;
  }

  private release(key: number): void {
    const subscription = this.subscriptions.get(key);
    if (!subscription) return;
    this.subscriptions.delete(key);
    for (const file of subscription.files.values()) this.unwatch(file);
  }

  /** Watch handles currently open, for tests. */
  counts(): { files: number; fileWatchers: number; folderWatchers: number } {
    let files = 0;
    let fileWatchers = 0;
    for (const subscription of this.subscriptions.values()) {
      files += subscription.files.size;
      for (const file of subscription.files.values()) if (file.file) fileWatchers += 1;
    }
    return { files, fileWatchers, folderWatchers: this.folders.size };
  }

  private async apply(
    key: number,
    workspaceId: string,
    workspacePath: string,
    paths: readonly string[],
  ): Promise<void> {
    const root = path.resolve(workspacePath);
    let subscription = this.subscriptions.get(key);
    if (subscription && (subscription.workspaceId !== workspaceId || subscription.root !== root)) {
      this.release(key);
      subscription = undefined;
    }
    const wanted = new Map<string, string>();
    for (const filePath of paths.slice(0, MAX_WORKBENCH_FILE_TABS)) {
      try {
        wanted.set(filePath, resolveWorkspacePath(root, filePath));
      } catch {
        // Outside the workspace: never watched.
      }
    }
    if (!subscription) {
      if (!wanted.size) return;
      subscription = { key, workspaceId, root, files: new Map() };
      this.subscriptions.set(key, subscription);
    }
    for (const [filePath, file] of subscription.files) {
      if (!wanted.has(filePath)) {
        subscription.files.delete(filePath);
        this.unwatch(file);
      }
    }
    const added: WatchedFile[] = [];
    for (const [filePath, absolute] of wanted) {
      if (subscription.files.has(filePath)) continue;
      const file: WatchedFile = {
        owner: subscription,
        path: filePath,
        absolute,
        signature: "missing",
        closed: false,
      };
      subscription.files.set(filePath, file);
      added.push(file);
    }
    if (!subscription.files.size) this.subscriptions.delete(key);
    await Promise.all(
      added.map(async (file) => {
        file.signature = await signatureOf(file.absolute);
        if (!file.closed) await this.arm(file);
      }),
    );
  }

  private unwatch(file: WatchedFile): void {
    file.closed = true;
    if (file.timer) clearTimeout(file.timer);
    file.file?.handle.close();
    file.file = undefined;
    this.leaveFolder(file);
  }

  private leaveFolder(file: WatchedFile): void {
    const folder = file.folder;
    if (!folder) return;
    file.folder = undefined;
    const shared = this.folders.get(folder);
    if (!shared) return;
    shared.files.delete(file);
    if (!shared.files.size) {
      shared.handle.close();
      this.folders.delete(folder);
    }
  }

  /**
   * Watches the file itself while it exists, and its nearest existing folder. Returns true when
   * that folder moved, since a change made before the new folder watch started went unseen.
   */
  private async arm(file: WatchedFile): Promise<boolean> {
    if (file.signature === "missing") {
      file.file?.handle.close();
      file.file = undefined;
    } else if (file.file?.signature !== file.signature.split(":")[0]) {
      // A rename-replace gives the path a new inode; the old watch would follow the old file.
      file.file?.handle.close();
      file.file = undefined;
      try {
        file.file = {
          signature: file.signature.split(":")[0]!,
          handle: this.watchEntry(file.absolute, () => this.schedule(file)),
        };
      } catch {
        // The folder watch still sees the file.
      }
    }
    let folder = path.dirname(file.absolute);
    while (
      folder !== file.owner.root &&
      folder.startsWith(file.owner.root) &&
      !(await isFolder(folder))
    )
      folder = path.dirname(folder);
    if (file.closed || file.folder === folder) return false;
    this.leaveFolder(file);
    let shared = this.folders.get(folder);
    if (!shared) {
      const files = new Set<WatchedFile>();
      let handle: { close(): void };
      try {
        handle = this.watchEntry(folder, (filename) => {
          for (const entry of files) {
            const direct = path.dirname(entry.absolute) === folder;
            // A missing parent folder: any change here may be that folder coming back.
            if (!direct || filename === null || filename === path.basename(entry.absolute))
              this.schedule(entry);
          }
        });
      } catch {
        return false;
      }
      shared = { handle, files };
      this.folders.set(folder, shared);
    }
    shared.files.add(file);
    file.folder = folder;
    return true;
  }

  private schedule(file: WatchedFile): void {
    if (file.closed) return;
    if (file.timer) clearTimeout(file.timer);
    file.timer = setTimeout(() => {
      file.timer = undefined;
      this.check(file).catch(logFailure);
    }, this.debounceMs);
  }

  private async check(file: WatchedFile): Promise<void> {
    const signature = await signatureOf(file.absolute);
    if (file.closed) return;
    const previous = file.signature;
    file.signature = signature;
    if (await this.arm(file)) this.schedule(file);
    if (file.closed || signature === previous) return;
    this.emit(file.owner.key, {
      workspaceId: file.owner.workspaceId,
      path: file.path,
      kind: signature === "missing" ? "deleted" : "changed",
    });
  }
}
