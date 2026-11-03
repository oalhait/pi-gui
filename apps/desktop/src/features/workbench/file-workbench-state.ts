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
