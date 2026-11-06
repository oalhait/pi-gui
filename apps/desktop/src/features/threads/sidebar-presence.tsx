import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

/** The properties `styles/sidebar.css` transitions: docked sidebar and narrow-window drawer. */
const SLIDE_PROPERTIES = new Set(["margin-left", "transform"]);
/** Settles the slide this long after its CSS duration if `transitionend` never arrives. */
const SETTLE_GRACE_MS = 150;

type SidebarPresenceState = "open" | "opening" | "closing" | "closed";

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** The longest transition the sidebar's styles currently declare, in milliseconds. */
function slideDurationMs(sidebar: Element | null | undefined): number {
  if (!sidebar) return 0;
  return Math.max(
    0,
    ...getComputedStyle(sidebar)
      .transitionDuration.split(",")
      .map((value) => parseFloat(value) * (value.trim().endsWith("ms") ? 1 : 1000))
      .filter(Number.isFinite),
  );
}

/**
 * Keeps the primary sidebar mounted while it slides closed, then unmounts it, and slides it in
 * when it opens. Transitions rather than keyframes, so reversing mid-slide starts from where the
 * sidebar is. The wrapper is `display: contents`, so `.sidebar` stays a grid item of `.shell`;
 * the shell styles each phase through `[data-state]`. While closing the sidebar is inert and
 * hidden from assistive technology, so focus and keyboard behave as if it were already gone.
 */
export function SidebarPresence({
  collapsed,
  children,
}: {
  readonly collapsed: boolean;
  readonly children: ReactNode;
}) {
  const [state, setState] = useState<SidebarPresenceState>(collapsed ? "closed" : "open");
  const shownCollapsed = useRef(collapsed);
  const wrapper = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (shownCollapsed.current === collapsed) return;
    shownCollapsed.current = collapsed;
    if (prefersReducedMotion()) {
      setState(collapsed ? "closed" : "open");
      return;
    }
    setState((current) => {
      if (collapsed) return current === "closed" ? "closed" : "closing";
      return current === "open" ? "open" : "opening";
    });
  }, [collapsed]);

  useEffect(() => {
    if (state !== "closing" && state !== "opening") return;
    // Transitionend is not guaranteed (hidden window, interrupted paint), so settle regardless.
    const timer = window.setTimeout(
      () => setState(state === "closing" ? "closed" : "open"),
      slideDurationMs(wrapper.current?.querySelector(":scope > .sidebar")) + SETTLE_GRACE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [state]);

  if (state === "closed") return null;
  const closing = state === "closing";
  return (
    <div
      aria-hidden={closing || undefined}
      className="sidebar-presence"
      data-state={state}
      inert={closing}
      ref={wrapper}
      onTransitionEnd={(event) => {
        if (!SLIDE_PROPERTIES.has(event.propertyName)) return;
        if (!(event.target as Element).classList.contains("sidebar")) return;
        setState((current) =>
          current === "closing" ? "closed" : current === "opening" ? "open" : current,
        );
      }}
    >
      {children}
    </div>
  );
}
