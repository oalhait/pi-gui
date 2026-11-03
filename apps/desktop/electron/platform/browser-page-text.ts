/**
 * Bounded text view of a browser page for agents. The script runs in an isolated world of the
 * page's own contents: it shares the DOM but none of the page's JavaScript, and it has no access
 * to pi-gui. Main re-validates and re-bounds everything it returns.
 */
export const PAGE_TEXT_WORLD_ID = 4242;
export const PAGE_TEXT_LIMITS = {
  text: 12_000,
  html: 60_000,
  headings: 50,
  links: 100,
  fields: 50,
  item: 300,
  href: 2_000,
} as const;

export function pageTextScript(includeHtml: boolean): string {
  const limits = JSON.stringify(PAGE_TEXT_LIMITS);
  return `(() => {
  const L = ${limits};
  const clip = (value, limit) => String(value || "").replace(/\\s+/g, " ").trim().slice(0, limit);
  const shown = (element) => {
    if (!element.getClientRects().length) return false;
    const style = getComputedStyle(element);
    return style.visibility !== "hidden" && style.display !== "none";
  };
  const all = (selector) => Array.from(document.querySelectorAll(selector)).filter(shown);
  const label = (element) =>
    clip(
      element.getAttribute("aria-label") ||
        (element.labels && element.labels[0] && element.labels[0].innerText) ||
        element.getAttribute("placeholder") ||
        element.getAttribute("title") ||
        "",
      L.item,
    );
  const text = document.body ? document.body.innerText : "";
  const html = ${includeHtml ? "document.documentElement ? document.documentElement.outerHTML : ''" : "''"};
  return {
    text: text.slice(0, L.text + 1),
    headings: all("h1,h2,h3,h4,h5,h6").slice(0, L.headings).map((heading) => ({
      level: Number(heading.tagName.slice(1)),
      text: clip(heading.innerText, L.item),
    })),
    links: all("a[href]").slice(0, L.links).map((link) => ({
      text: clip(link.innerText || link.getAttribute("aria-label") || link.getAttribute("title"), L.item),
      href: String(link.href).slice(0, L.href),
    })),
    fields: all("input,textarea,select,button")
      .filter((field) => field.type !== "hidden")
      .slice(0, L.fields)
      .map((field) => {
        const tag = field.tagName.toLowerCase();
        const type =
          tag === "input" || tag === "button" ? String(field.type || "text") : tag;
        const secret =
          type === "password" ||
          type === "file" ||
          /^(cc-|one-time-code|current-password|new-password)/.test(field.autocomplete || "");
        const value =
          secret
            ? undefined
            : tag === "select"
              ? Array.from(field.selectedOptions).map((option) => option.text).join(", ")
              : tag === "button" || type === "submit" || type === "button"
                ? field.innerText || field.value
                : type === "checkbox" || type === "radio"
                  ? undefined
                  : field.value;
        return {
          tag,
          type,
          name: clip(field.name || field.id, L.item),
          label: label(field),
          value: value === undefined ? undefined : clip(value, L.item),
          checked: type === "checkbox" || type === "radio" ? Boolean(field.checked) : undefined,
          disabled: Boolean(field.disabled),
        };
      }),
    html: html.slice(0, L.html + 1),
    scroll: {
      y: Math.round(window.scrollY),
      height: Math.round(document.documentElement ? document.documentElement.scrollHeight : 0),
      viewport: Math.round(window.innerHeight),
    },
  };
})()`;
}

export interface PageText {
  readonly text: string;
  readonly text_truncated: boolean;
  readonly headings: readonly { readonly level: number; readonly text: string }[];
  readonly links: readonly { readonly text: string; readonly href: string }[];
  readonly fields: readonly Record<string, string | boolean>[];
  readonly html?: string;
  readonly html_truncated?: boolean;
  readonly scroll?: { readonly y: number; readonly height: number; readonly viewport: number };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function list(value: unknown, limit: number): Record<string, unknown>[] {
  return Array.isArray(value) ? value.slice(0, limit).map(record) : [];
}
function text(value: unknown, limit: number): string {
  return typeof value === "string" ? value.replace(/\0/g, "").slice(0, limit) : "";
}
function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

/** Rebuilds the page's answer with known fields and hard caps; the page controls its contents. */
export function normalizePageText(value: unknown, includeHtml: boolean): PageText {
  const input = record(value);
  const raw = text(input.text, PAGE_TEXT_LIMITS.text + 1);
  const html = text(input.html, PAGE_TEXT_LIMITS.html + 1);
  const scroll = record(input.scroll);
  const L = PAGE_TEXT_LIMITS;
  return {
    text: raw.slice(0, L.text),
    text_truncated: raw.length > L.text,
    headings: list(input.headings, L.headings).map((heading) => ({
      level: Math.min(6, Math.max(1, count(heading.level))),
      text: text(heading.text, L.item),
    })),
    links: list(input.links, L.links).map((link) => ({
      text: text(link.text, L.item),
      href: text(link.href, L.href),
    })),
    fields: list(input.fields, L.fields).map((field) => {
      const entry: Record<string, string | boolean> = {
        tag: text(field.tag, 20),
        type: text(field.type, 40),
      };
      for (const key of ["name", "label", "value"])
        if (typeof field[key] === "string" && field[key]) entry[key] = text(field[key], L.item);
      if (typeof field.checked === "boolean") entry.checked = field.checked;
      if (field.disabled === true) entry.disabled = true;
      return entry;
    }),
    ...(includeHtml ? { html: html.slice(0, L.html), html_truncated: html.length > L.html } : {}),
    scroll: { y: count(scroll.y), height: count(scroll.height), viewport: count(scroll.viewport) },
  };
}
