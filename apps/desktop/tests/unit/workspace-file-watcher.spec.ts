import { watch } from "node:fs";
import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { WorkspaceFileChange } from "../../contracts/ipc";
import {
  WorkspaceFileWatcher,
  type WatchFactory,
} from "../../electron/platform/files/workspace-file-watcher";

async function workspace(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-gui-file-watch-")));
  await mkdir(join(root, "docs"), { recursive: true });
  await writeFile(join(root, "docs", "a.md"), "# A\n");
  await writeFile(join(root, "docs", "b.md"), "# B\n");
  await writeFile(join(root, "top.txt"), "top\n");
  return root;
}

/** Real fs.watch, counting the handles that are open. */
function countingWatch() {
  const open = new Map<string, number>();
  const factory: WatchFactory = (target, listener) => {
    const watcher = watch(target, { persistent: false }, (_event, filename) =>
      listener(typeof filename === "string" ? filename : null),
    );
    watcher.on("error", () => undefined);
    open.set(target, (open.get(target) ?? 0) + 1);
    let closed = false;
    return {
      close() {
        if (closed) return;
        closed = true;
        watcher.close();
        open.set(target, (open.get(target) ?? 1) - 1);
        if (!open.get(target)) open.delete(target);
      },
    };
  };
  return { factory, open };
}

function recorder() {
  const changes: { key: number; change: WorkspaceFileChange }[] = [];
  return {
    changes,
    emit: (key: number, change: WorkspaceFileChange) => changes.push({ key, change }),
    kinds: (path: string) =>
      changes.filter((entry) => entry.change.path === path).map((entry) => entry.change.kind),
  };
}

test("shares one folder watch per folder, dedupes paths and closes every handle", async () => {
  const root = await workspace();
  const { factory, open } = countingWatch();
  const events = recorder();
  const watcher = new WorkspaceFileWatcher(events.emit, factory, 20);

  await watcher.set(1, "ws", root, ["docs/a.md", "docs/b.md", "docs/a.md", "top.txt"]);
  expect(watcher.counts()).toEqual({ files: 3, fileWatchers: 3, folderWatchers: 2 });
  expect(open.get(join(root, "docs"))).toBe(1);

  // Another window on the same folder shares its watch.
  await watcher.set(2, "ws", root, ["docs/a.md"]);
  expect(watcher.counts()).toEqual({ files: 4, fileWatchers: 4, folderWatchers: 2 });
  expect(open.get(join(root, "docs"))).toBe(1);

  // Closing a tab closes its file watch; the folder stays while another tab needs it.
  await watcher.set(1, "ws", root, ["docs/a.md"]);
  expect(watcher.counts()).toEqual({ files: 2, fileWatchers: 2, folderWatchers: 1 });
  expect(open.has(join(root, "top.txt"))).toBe(false);
  expect(open.has(root)).toBe(false);

  // Paths outside the workspace are never watched.
  await watcher.set(2, "ws", root, ["../outside.txt", "docs/a.md"]);
  expect(watcher.counts().files).toBe(2);

  await watcher.set(1, "ws", root, []);
  watcher.dispose(2);
  expect(watcher.counts()).toEqual({ files: 0, fileWatchers: 0, folderWatchers: 0 });
  expect(open.size).toBe(0);
});

test("switching a window to another workspace replaces its watches", async () => {
  const first = await workspace();
  const second = await workspace();
  const { factory, open } = countingWatch();
  const watcher = new WorkspaceFileWatcher(() => undefined, factory, 20);
  await watcher.set(1, "one", first, ["docs/a.md"]);
  await watcher.set(1, "two", second, ["top.txt"]);
  expect(watcher.counts()).toEqual({ files: 1, fileWatchers: 1, folderWatchers: 1 });
  expect([...open.keys()].every((target) => target.startsWith(second))).toBe(true);
  watcher.dispose(1);
  expect(open.size).toBe(0);
});

test("dispose while a set is still in progress leaves nothing watched", async () => {
  const root = await workspace();
  const { factory, open } = countingWatch();
  const watcher = new WorkspaceFileWatcher(() => undefined, factory, 20);
  const pending = watcher.set(1, "ws", root, ["docs/a.md", "top.txt"]);
  watcher.dispose(1);
  await pending;
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(watcher.counts()).toEqual({ files: 0, fileWatchers: 0, folderWatchers: 0 });
  expect(open.size).toBe(0);
});

test("reports direct writes, atomic replaces, deletes and a file that comes back", async () => {
  const root = await workspace();
  const events = recorder();
  const watcher = new WorkspaceFileWatcher(events.emit, undefined, 30);
  const file = join(root, "docs", "a.md");
  await watcher.set(7, "ws", root, ["docs/a.md"]);
  // One write can report more than once (truncate, then data); each step must end in its kind.
  const step = async (action: () => Promise<unknown>, kind: "changed" | "deleted") => {
    const before = events.kinds("docs/a.md").length;
    await action();
    await expect
      .poll(
        () => {
          const kinds = events.kinds("docs/a.md");
          return kinds.length > before ? kinds.at(-1) : undefined;
        },
        { timeout: 5_000 },
      )
      .toBe(kind);
  };

  await step(() => writeFile(file, "# A, edited in place\n"), "changed");
  // Write-to-temp then rename, as editors and agent tools do.
  await step(async () => {
    await writeFile(join(root, "docs", ".a.md.tmp"), "# A, replaced atomically\n");
    await rename(join(root, "docs", ".a.md.tmp"), file);
  }, "changed");
  // The replaced file (a new inode) is still followed.
  await step(() => writeFile(file, "# A, edited after the replace\n"), "changed");
  await step(() => rm(file), "deleted");
  await step(() => writeFile(file, "# A is back\n"), "changed");
  // Its whole folder disappears and comes back.
  await step(() => rm(join(root, "docs"), { recursive: true }), "deleted");
  await step(async () => {
    await mkdir(join(root, "docs"));
    await writeFile(file, "# A in a new folder\n");
  }, "changed");

  expect(
    events.changes.every((entry) => entry.key === 7 && entry.change.workspaceId === "ws"),
  ).toBe(true);
  // Other files in the folder don't report for this tab.
  await writeFile(join(root, "docs", "b.md"), "# B, edited\n");
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(events.changes.some((entry) => entry.change.path === "docs/b.md")).toBe(false);
  watcher.dispose(7);
  expect(watcher.counts()).toEqual({ files: 0, fileWatchers: 0, folderWatchers: 0 });
});
