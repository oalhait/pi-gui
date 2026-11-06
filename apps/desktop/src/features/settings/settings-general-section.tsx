import { useEffect, useState } from "react";
import type { RuntimeSnapshot } from "@pi-gui/session-driver/runtime-types";
import type { ModelSettingsScopeMode } from "../../../contracts/desktop-state";
import { useTranslation } from "../../i18n";
import { useThinkingDisplay } from "../conversation/thinking-display";
import { SettingsSegmented, SettingsSelect, SettingsSwitch } from "./settings-controls";
import { SettingsGroup, SettingsRow } from "./settings-utils";

/** Seconds offered for the stall detector; 0 turns it off. */
const MODEL_STALL_CHOICES = [0, 60, 120, 180, 300];

interface SettingsGeneralSectionProps {
  readonly runtime?: RuntimeSnapshot;
  readonly modelSettingsScopeMode: ModelSettingsScopeMode;
  readonly integratedTerminalShell: string;
  readonly modelStallTimeoutSeconds: number;
  readonly onSetModelStallTimeout: (seconds: number) => void;
  readonly onSetModelSettingsScopeMode: (mode: ModelSettingsScopeMode) => void;
  readonly onSetIntegratedTerminalShell: (shellPath: string) => void;
  readonly onToggleSkillCommands: (enabled: boolean) => void;
}

export function SettingsGeneralSection({
  runtime,
  modelSettingsScopeMode,
  integratedTerminalShell,
  modelStallTimeoutSeconds,
  onSetModelStallTimeout,
  onSetModelSettingsScopeMode,
  onSetIntegratedTerminalShell,
  onToggleSkillCommands,
}: SettingsGeneralSectionProps) {
  const { t } = useTranslation();
  const [terminalShellDraft, setTerminalShellDraft] = useState(integratedTerminalShell);
  const [thinkingDisplay, setThinkingDisplay] = useThinkingDisplay();

  useEffect(() => {
    setTerminalShellDraft(integratedTerminalShell);
  }, [integratedTerminalShell]);

  const commitTerminalShellDraft = () => {
    if (terminalShellDraft !== integratedTerminalShell) {
      onSetIntegratedTerminalShell(terminalShellDraft);
    }
  };

  return (
    <>
      <SettingsGroup title={t("settings.general.groupAgent")}>
        <SettingsRow
          title={t("settings.general.modelScope.title")}
          description={t("settings.general.modelScope.description")}
        >
          <SettingsSegmented
            label={t("settings.general.modelScope.label")}
            options={[
              { value: "app-global", label: t("settings.general.modelScope.appGlobal") },
              { value: "per-repo", label: t("settings.general.modelScope.perRepo") },
            ]}
            value={modelSettingsScopeMode}
            onChange={onSetModelSettingsScopeMode}
          />
        </SettingsRow>
        <SettingsRow
          title={t("settings.general.skillCommands.title")}
          description={t("settings.general.skillCommands.description")}
        >
          <SettingsSwitch
            checked={runtime?.settings.enableSkillCommands ?? true}
            label={t("settings.general.skillCommands.label")}
            onChange={onToggleSkillCommands}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title={t("settings.general.groupConversation")}>
        <SettingsRow
          title={t("settings.general.thinking.title")}
          description={t("settings.general.thinking.description")}
        >
          <SettingsSegmented
            label={t("settings.general.thinking.label")}
            options={[
              { value: "expanded", label: t("settings.general.thinking.expanded") },
              { value: "collapsed", label: t("settings.general.thinking.collapsed") },
              { value: "hidden", label: t("settings.general.thinking.hidden") },
            ]}
            value={thinkingDisplay}
            onChange={setThinkingDisplay}
          />
        </SettingsRow>
        <SettingsRow
          title={t("settings.general.modelStall.title")}
          description={t("settings.general.modelStall.description")}
        >
          <SettingsSelect
            label={t("settings.general.modelStall.label")}
            options={[...new Set([...MODEL_STALL_CHOICES, modelStallTimeoutSeconds])]
              .sort((a, b) => a - b)
              .map((seconds) => ({
                value: String(seconds),
                label:
                  seconds === 0
                    ? t("settings.general.modelStall.off")
                    : seconds % 60 === 0
                      ? t("settings.general.modelStall.minutes", { minutes: seconds / 60 })
                      : t("settings.general.modelStall.seconds", { seconds }),
              }))}
            value={String(modelStallTimeoutSeconds)}
            onChange={(value) => onSetModelStallTimeout(Number(value))}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title={t("settings.general.groupTerminal")}>
        <SettingsRow
          title={t("settings.general.shell.title")}
          description={t("settings.general.shell.description")}
        >
          <input
            aria-label={t("settings.general.shell.label")}
            className="settings-text-input"
            placeholder="/bin/zsh"
            spellCheck={false}
            type="text"
            value={terminalShellDraft}
            onBlur={commitTerminalShellDraft}
            onChange={(event) => setTerminalShellDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.currentTarget.blur();
              }
            }}
          />
        </SettingsRow>
      </SettingsGroup>
    </>
  );
}
