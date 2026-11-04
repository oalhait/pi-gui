import type { FileLineMark } from "../../../contracts/workbench";

export type { FileLineMark };

export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(path);
}

export function breadcrumbSegments(path: string): readonly string[] {
  return path.split("/").filter(Boolean);
}

export function fileNameFromPath(path: string): string {
  const segments = breadcrumbSegments(path);
  return segments[segments.length - 1] ?? path;
}

export function ancestorDirectoryPaths(filePath: string): readonly string[] {
  const parts = breadcrumbSegments(filePath);
  if (parts.length < 2) {
    return [];
  }
  const directories: string[] = [];
  let current = "";
  for (const part of parts.slice(0, -1)) {
    current = current ? `${current}/${part}` : part;
    directories.push(current);
  }
  return directories;
}

/**
 * Tab labels for open files: the basename, plus enough of the parent folder to tell apart files
 * that share a basename.
 */
export function fileTabLabels(paths: readonly string[]): ReadonlyMap<string, string> {
  const counts = new Map<string, number>();
  for (const path of paths) {
    const name = fileNameFromPath(path);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return new Map(
    paths.map((path) => {
      const name = fileNameFromPath(path);
      if ((counts.get(name) ?? 0) < 2) return [path, name];
      const parent = breadcrumbSegments(path).slice(0, -1).at(-1);
      return [path, parent ? `${name} · ${parent}` : name];
    }),
  );
}

/** A file size for display, such as "512 B", "14.2 KB" or "3.1 MB". */
export function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** The neighbouring path `step` places along, or undefined at either end of the list. */
export function siblingPath(
  siblings: readonly string[],
  path: string,
  step: -1 | 1,
): string | undefined {
  const index = siblings.indexOf(path);
  return index < 0 ? undefined : siblings[index + step];
}
