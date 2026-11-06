import { useTranslation } from "../../i18n";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ProviderUsage,
  ProviderUsageCredits,
  ProviderUsageWindow,
} from "@pi-gui/session-driver";
import type { RuntimeProviderRecord } from "@pi-gui/session-driver/runtime-types";

const dateLabel = (value: string, locale: string) =>
  new Date(value).toLocaleString(locale, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

type Translate = ReturnType<typeof useTranslation>["t"];

const elevated = (severity: string | undefined) =>
  severity !== undefined && severity.toLowerCase() !== "normal";

function severityLabel(t: Translate, severity: string) {
  switch (severity.toLowerCase()) {
    case "normal":
      return t("settings.usage.severity.normal");
    case "warning":
      return t("settings.usage.severity.warning");
    case "critical":
      return t("settings.usage.severity.critical");
    default:
      return severity;
  }
}

function windowDetails(t: Translate, window: ProviderUsageWindow, locale: string) {
  const parts: string[] = [];
  if (window.active !== undefined)
    parts.push(window.active ? t("settings.usage.active") : t("settings.usage.inactive"));
  if (window.severity)
    parts.push(t("settings.usage.severity", { severity: severityLabel(t, window.severity) }));
  if (window.resetsAt)
    parts.push(t("settings.usage.resets", { time: dateLabel(window.resetsAt, locale) }));
  return parts.join(" · ");
}

/** Renders "text [label](https://…)" with the link as a real anchor; other text stays plain. */
function Disclaimer({ text }: { readonly text: string }) {
  const match = /\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/.exec(text);
  if (!match) return <>{text}</>;
  return (
    <>
      {text.slice(0, match.index)}
      <a href={match[2]} rel="noreferrer" target="_blank">
        {match[1]}
      </a>
      {text.slice(match.index + match[0].length)}
    </>
  );
}

function CreditsSummary({
  credits,
  billedToCredits,
  providerName,
}: {
  readonly credits: ProviderUsageCredits;
  readonly billedToCredits: boolean;
  readonly providerName: string;
}) {
  const { t, locale } = useTranslation();
  const money = new Intl.NumberFormat(locale, {
    style: "currency",
    currency: credits.currency,
    minimumFractionDigits: credits.fractionDigits,
    maximumFractionDigits: credits.fractionDigits,
  });
  const warning = credits.limitReached || elevated(credits.severity);
  const used = money.format(credits.used);
  const percent = credits.usedPercent === undefined ? undefined : Math.round(credits.usedPercent);
  return (
    <div
      className={`provider-usage__window${warning ? " provider-usage__window--warning" : ""}`}
      data-testid="provider-usage-credits"
    >
      <div className="provider-usage__line">
        <span>{t("settings.usage.credits")}</span>
        <span>
          {credits.limit === undefined
            ? t("settings.usage.creditsSpent", { used })
            : percent === undefined
              ? t("settings.usage.creditsAmount", { used, limit: money.format(credits.limit) })
              : t("settings.usage.creditsAmountPercent", {
                  used,
                  limit: money.format(credits.limit),
                  percent,
                })}
        </span>
      </div>
      {credits.usedPercent !== undefined ? (
        <progress
          max={100}
          value={Math.min(100, credits.usedPercent)}
          aria-label={t("settings.usage.progress", {
            provider: providerName,
            window: t("settings.usage.credits"),
          })}
        />
      ) : null}
      {credits.limitReached ? (
        <div className="provider-usage__note provider-usage__note--warning" role="status">
          {t("settings.usage.creditsLimitReached")}
        </div>
      ) : credits.severity && elevated(credits.severity) ? (
        <div className="provider-usage__note provider-usage__note--warning">
          {t("settings.usage.severity", { severity: severityLabel(t, credits.severity) })}
        </div>
      ) : null}
      {billedToCredits ? (
        <div className="provider-usage__note provider-usage__note--warning">
          {t("settings.usage.billedToCredits")}
        </div>
      ) : null}
      {credits.disclaimer ? (
        <div className="provider-usage__note">
          <Disclaimer text={credits.disclaimer} />
        </div>
      ) : null}
    </div>
  );
}

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
                  <div
                    className={`provider-usage__window${
                      elevated(window.severity) ? " provider-usage__window--warning" : ""
                    }`}
                    key={window.label + index}
                  >
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
                    {windowDetails(t, window, locale) ? (
                      <div className="provider-usage__note">{windowDetails(t, window, locale)}</div>
                    ) : null}
                  </div>
                ))
              ) : (
                <p className="provider-usage__note">
                  {current?.message ??
                    (pending ? t("settings.usage.pending") : t("settings.usage.unavailable"))}
                </p>
              )}
              {current?.status === "available" && current.credits ? (
                <CreditsSummary
                  credits={current.credits}
                  billedToCredits={current.billedToCredits === true}
                  providerName={provider.name}
                />
              ) : null}
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
