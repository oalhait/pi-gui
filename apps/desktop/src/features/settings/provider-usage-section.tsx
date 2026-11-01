import { useTranslation } from "../../i18n";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ProviderUsage } from "@pi-gui/session-driver";
import type { RuntimeProviderRecord } from "@pi-gui/session-driver/runtime-types";

const dateLabel = (value: string, locale: string) =>
  new Date(value).toLocaleString(locale, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

export function ProviderUsageSection({
  workspaceId,
  providers,
}: {
  readonly workspaceId: string;
  readonly providers: readonly RuntimeProviderRecord[];
}) {
  const { t, locale } = useTranslation();
  const [usage, setUsage] = useState<readonly ProviderUsage[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const request = useRef(0);
  const refresh = useCallback(async () => {
    const id = ++request.current;
    setPending(true);
    setError(false);
    try {
      const api = window.piApp;
      if (!api) throw new Error("Desktop connection unavailable");
      const result = await api.getProviderUsage(workspaceId);
      if (id === request.current) setUsage(result);
    } catch {
      if (id === request.current) setError(true);
    } finally {
      if (id === request.current) setPending(false);
    }
  }, [workspaceId]);
  useEffect(() => {
    refresh().catch(() => setError(true));
    return () => {
      request.current++;
    };
  }, [refresh]);

  return (
    <section className="settings-section provider-usage" data-testid="provider-usage">
      <div className="settings-section__header">
        <h3 className="settings-section__title">{t("settings.usage.title")}</h3>
        <button
          className="button"
          type="button"
          disabled={pending}
          onClick={() => {
            refresh().catch(() => setError(true));
          }}
        >
          {pending ? t("settings.usage.checking") : t("settings.usage.refresh")}
        </button>
      </div>
      <p className="settings-section__description">{t("settings.usage.description")}</p>
      {error ? <p role="alert">{t("settings.usage.error")}</p> : null}
      <div className="settings-group" aria-busy={pending}>
        {providers.map((provider) => {
          const current = usage.find((item) => item.providerId === provider.id);
          return (
            <div className="provider-usage__account" key={provider.id}>
              <div className="provider-usage__heading">
                <strong>{provider.name}</strong>
                {current?.plan ? (
                  <span className="provider-usage__plan">{current.plan}</span>
                ) : null}
              </div>
              {current?.status === "available" ? (
                current.windows.map((window, index) => (
                  <div className="provider-usage__window" key={window.label + index}>
                    <div className="provider-usage__line">
                      <span>{window.label}</span>
                      <span>
                        {t("settings.usage.fraction", {
                          used: Math.round(window.usedPercent),
                          remaining: Math.max(0, Math.round(100 - window.usedPercent)),
                        })}
                      </span>
                    </div>
                    <progress
                      max={100}
                      value={Math.min(100, window.usedPercent)}
                      aria-label={t("settings.usage.progress", {
                        provider: provider.name,
                        window: window.label,
                      })}
                    />
                    {window.resetsAt ? (
                      <div className="provider-usage__note">
                        {t("settings.usage.resets", { time: dateLabel(window.resetsAt, locale) })}
                      </div>
                    ) : null}
                  </div>
                ))
              ) : (
                <p className="provider-usage__note">
                  {current?.message ??
                    (pending ? t("settings.usage.pending") : t("settings.usage.unavailable"))}
                </p>
              )}
              {current?.checkedAt ? (
                <div className="provider-usage__note">
                  {t("settings.usage.checked", { time: dateLabel(current.checkedAt, locale) })}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
