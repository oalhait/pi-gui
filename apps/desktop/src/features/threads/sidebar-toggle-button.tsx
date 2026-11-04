import { useEffect, useState, type Ref } from "react";
import { SidebarToggleIcon } from "../../ui/icons";

/** The toggle and the sidebar presence it drives are used together by the app shell. */
export { SidebarPresence } from "./sidebar-presence";

interface SidebarToggleButtonProps {
  readonly collapsed: boolean;
  readonly shortcutLabel: string;
  readonly onToggle: () => void;
  readonly ref?: Ref<HTMLButtonElement>;
}

/** macOS hides the traffic lights in native full screen, so the toggle moves into their space. */
function useTrafficLightsHidden(): boolean {
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    const api = window.piApp;
    if (api?.platform !== "darwin") return;
    return api.onFullScreenChanged(setHidden);
  }, []);
  return hidden;
}

export function SidebarToggleButton({
  collapsed,
  shortcutLabel,
  onToggle,
  ref,
}: SidebarToggleButtonProps) {
  const trafficLightsHidden = useTrafficLightsHidden();
  return (
    <div
      className={`shortcut-tooltip-wrap sidebar-toggle${
        trafficLightsHidden ? " sidebar-toggle--no-traffic-lights" : ""
      }`}
    >
      <button
        aria-label="Toggle sidebar"
        aria-pressed={!collapsed}
        className="icon-button sidebar-toggle__button"
        data-testid="sidebar-toggle"
        ref={ref}
        type="button"
        onClick={onToggle}
      >
        <SidebarToggleIcon />
      </button>
      <span className="shortcut-tooltip sidebar-toggle__tooltip" role="tooltip">
        <span>Toggle sidebar</span>
        <kbd>{shortcutLabel}</kbd>
      </span>
    </div>
  );
}
