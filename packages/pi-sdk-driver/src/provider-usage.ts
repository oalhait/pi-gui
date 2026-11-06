import { createHash } from "node:crypto";
import type {
  ProviderUsage,
  ProviderUsageCredits,
  ProviderUsageWindow,
} from "@pi-gui/session-driver";

const endpoints: Readonly<Record<string, string>> = {
  "openai-codex": "https://chatgpt.com/backend-api/wham/usage",
  anthropic: "https://api.anthropic.com/api/oauth/usage",
};

interface UsageRuntime {
  isUsingOAuth(provider: string): boolean;
  getRegisteredProviderConfig(provider: string): unknown;
  getRegisteredNativeProvider?(provider: string): unknown;
  getAuth(provider: string): Promise<{ auth: { apiKey?: string } } | undefined>;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function percentage(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function resetTime(value: unknown): string | undefined {
  const milliseconds =
    typeof value === "number" ? value * 1000 : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(milliseconds) && milliseconds > 0 && milliseconds <= 8640000000000000
    ? new Date(milliseconds).toISOString()
    : undefined;
}

function windowLabel(seconds: number): string {
  if (seconds === 604800) return "Weekly";
  return seconds % 3600 === 0 ? `${seconds / 3600}-hour` : `${Math.round(seconds / 60)}-minute`;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function digits(value: unknown): number | undefined {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 6
    ? (value as number)
    : undefined;
}

function currencyCode(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Z]{3}$/.test(value) ? value : undefined;
}

function capitalize(value: string): string {
  const words = value.replace(/_/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const limitGroupLabels: Readonly<Record<string, string>> = {
  session: "Session",
  weekly: "Weekly",
  weekly_all: "Weekly",
  weekly_scoped: "Weekly",
};

/** Reads Claude's `limits` array: one entry per plan limit, with optional model scope. */
function anthropicLimits(value: unknown): ProviderUsageWindow[] {
  if (!Array.isArray(value)) return [];
  const windows: ProviderUsageWindow[] = [];
  for (const item of value) {
    const limit = object(item);
    const usedPercent = percentage(limit.percent);
    const kind = text(limit.kind);
    const group = text(limit.group);
    if (usedPercent === undefined || (!kind && !group)) continue;
    const base =
      (kind && limitGroupLabels[kind]) ??
      (group && limitGroupLabels[group]) ??
      capitalize(group ?? kind ?? "");
    const scope = object(limit.scope);
    const scopeName = text(object(scope.model).display_name) ?? text(scope.surface);
    const resetsAt = resetTime(limit.resets_at);
    const severity = text(limit.severity);
    windows.push({
      label: scopeName ? `${base} · ${scopeName}` : base,
      usedPercent,
      ...(resetsAt ? { resetsAt } : {}),
      ...(severity ? { severity } : {}),
      ...(typeof limit.is_active === "boolean" ? { active: limit.is_active } : {}),
    });
  }
  return windows;
}

function anthropicLegacyWindows(body: Record<string, unknown>): ProviderUsageWindow[] {
  const windows: ProviderUsageWindow[] = [];
  for (const [key, label] of [
    ["five_hour", "5-hour"],
    ["seven_day", "Weekly"],
    ["seven_day_opus", "Opus · Weekly"],
    ["seven_day_sonnet", "Sonnet · Weekly"],
    ["seven_day_oauth_apps", "OAuth apps · Weekly"],
    ["seven_day_cowork", "Cowork · Weekly"],
  ] as const) {
    const window = object(body[key]);
    const usedPercent = percentage(window.utilization);
    if (usedPercent === undefined) continue;
    const resetsAt = resetTime(window.resets_at);
    windows.push({ label, usedPercent, ...(resetsAt ? { resetsAt } : {}) });
  }
  return windows;
}

/**
 * Reads usage credits (extra usage billed beyond the plan). Prefers the newer
 * `spend` money objects and falls back to `extra_usage`, whose amounts are minor units.
 */
function anthropicCredits(body: Record<string, unknown>): ProviderUsageCredits | undefined {
  const spend = object(body.spend);
  const extra = object(body.extra_usage);
  if (spend.enabled === false || extra.is_enabled === false) return undefined;
  const spendUsed = object(spend.used);
  const spendLimit = object(spend.limit);
  let used: number | undefined;
  let limit: number | undefined;
  let currency: string | undefined;
  let fractionDigits: number | undefined;
  const usedMinor = finite(spendUsed.amount_minor);
  const usedExponent = digits(spendUsed.exponent);
  if (usedMinor !== undefined && usedExponent !== undefined) {
    used = usedMinor / 10 ** usedExponent;
    fractionDigits = usedExponent;
    currency = currencyCode(spendUsed.currency);
    const limitMinor = finite(spendLimit.amount_minor);
    const limitExponent = digits(spendLimit.exponent) ?? usedExponent;
    if (limitMinor !== undefined) limit = limitMinor / 10 ** limitExponent;
  } else {
    const extraUsed = finite(extra.used_credits);
    const places = digits(extra.decimal_places);
    if (extraUsed === undefined || places === undefined) return undefined;
    used = extraUsed / 10 ** places;
    fractionDigits = places;
    const extraLimit = finite(extra.monthly_limit);
    if (extraLimit !== undefined) limit = extraLimit / 10 ** places;
  }
  currency ??= currencyCode(spendLimit.currency) ?? currencyCode(extra.currency);
  if (!currency || used < 0) return undefined;
  const usedPercent =
    percentage(spend.percent) ??
    percentage(extra.utilization) ??
    (limit ? (used / limit) * 100 : undefined);
  const severity = text(spend.severity);
  const disclaimer = text(spend.disclaimer);
  return {
    used,
    ...(limit !== undefined && limit >= 0 ? { limit } : {}),
    currency,
    fractionDigits,
    ...(usedPercent !== undefined ? { usedPercent } : {}),
    ...(severity ? { severity } : {}),
    limitReached: extra.spend_limit_reached === true,
    ...(disclaimer ? { disclaimer } : {}),
  };
}

export function parseProviderUsage(
  providerId: string,
  value: unknown,
): Pick<ProviderUsage, "windows" | "plan" | "credits"> {
  const body = object(value);
  const windows: ProviderUsageWindow[] = [];
  let credits: ProviderUsageCredits | undefined;
  if (providerId === "openai-codex") {
    const add = (rate: unknown, prefix = "") => {
      const limits = object(rate);
      for (const slot of ["primary_window", "secondary_window"]) {
        const window = object(limits[slot]);
        const usedPercent = percentage(window.used_percent);
        const seconds = window.limit_window_seconds;
        if (
          usedPercent === undefined ||
          typeof seconds !== "number" ||
          !Number.isFinite(seconds) ||
          seconds <= 0
        )
          continue;
        const resetsAt = resetTime(window.reset_at);
        windows.push({
          label: prefix + windowLabel(seconds),
          usedPercent,
          ...(resetsAt ? { resetsAt } : {}),
        });
      }
    };
    add(body.rate_limit);
    add(body.code_review_rate_limit, "Code review · ");
    if (Array.isArray(body.additional_rate_limits))
      for (const item of body.additional_rate_limits) {
        const rate = object(item);
        if (typeof rate.limit_name === "string") add(rate.rate_limit, `${rate.limit_name} · `);
      }
  } else if (providerId === "anthropic") {
    windows.push(...anthropicLimits(body.limits));
    if (!windows.length) windows.push(...anthropicLegacyWindows(body));
    credits = anthropicCredits(body);
  }
  return {
    windows,
    ...(typeof body.plan_type === "string" ? { plan: body.plan_type } : {}),
    ...(credits ? { credits } : {}),
  };
}

export class ProviderUsageReader {
  private readonly cache = new Map<
    string,
    { credential: string; expires: number; result: Promise<ProviderUsage> }
  >();
  /** Credits seen at the previous check, to tell whether this app's requests use them. */
  private readonly creditHistory = new Map<
    string,
    { credential: string; used: number; billedToCredits: boolean }
  >();
  constructor(
    private readonly request: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async read(runtime: UsageRuntime, providerId: string): Promise<ProviderUsage> {
    const unavailable: ProviderUsage = {
      providerId,
      status: "unavailable",
      windows: [],
      message:
        "This connection does not report account usage limits. Check your provider’s billing dashboard.",
    };
    const endpoint = endpoints[providerId];
    if (
      !endpoint ||
      !runtime.isUsingOAuth(providerId) ||
      runtime.getRegisteredProviderConfig(providerId) ||
      runtime.getRegisteredNativeProvider?.(providerId)
    )
      return unavailable;
    try {
      const auth = await runtime.getAuth(providerId);
      if (!auth?.auth.apiKey)
        return { ...unavailable, message: "Sign in again to read usage limits." };
      const credential = createHash("sha256").update(auth.auth.apiKey).digest("hex");
      const cached = this.cache.get(providerId);
      if (cached && cached.credential === credential && cached.expires > this.now())
        return cached.result;
      const result = this.fetchUsage(providerId, endpoint, auth.auth.apiKey, credential);
      this.cache.set(providerId, { credential, expires: this.now() + 60000, result });
      return result;
    } catch {
      return {
        providerId,
        status: "error",
        windows: [],
        message: "Could not read usage limits. Try refreshing or signing in again.",
      };
    }
  }

  private async fetchUsage(
    providerId: string,
    endpoint: string,
    token: string,
    credential: string,
  ): Promise<ProviderUsage> {
    const checkedAt = new Date(this.now()).toISOString();
    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      };
      if (providerId === "anthropic") headers["anthropic-beta"] = "oauth-2025-04-20";
      const response = await this.request(endpoint, {
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(12000),
      });
      if (!response.ok)
        return {
          providerId,
          status: "error",
          windows: [],
          checkedAt,
          message:
            response.status === 429
              ? "Usage checks are rate limited. Wait a minute before refreshing."
              : response.status === 401 || response.status === 403
                ? "Your provider did not authorize this usage check. Try signing in again."
                : "The provider’s usage service is temporarily unavailable.",
        };
      const usage = parseProviderUsage(providerId, (await response.json()) as unknown);
      const reported = usage.windows.length > 0 || usage.credits !== undefined;
      const billedToCredits = this.trackCredits(providerId, credential, usage);
      return {
        providerId,
        ...usage,
        ...(billedToCredits ? { billedToCredits } : {}),
        checkedAt,
        status: reported ? "available" : "unavailable",
        ...(!reported ? { message: "The provider did not report any usage windows." } : {}),
      };
    } catch {
      return {
        providerId,
        status: "error",
        windows: [],
        checkedAt,
        message: "Could not reach the provider’s usage service. Try again shortly.",
      };
    }
  }

  /**
   * Credits rising between checks while every plan window reads 0% means requests
   * are billed to credits instead of plan usage. Once seen, it stays true for the
   * session until plan usage moves, credits stop, or the account changes.
   */
  private trackCredits(
    providerId: string,
    credential: string,
    usage: Pick<ProviderUsage, "windows" | "credits">,
  ): boolean {
    const previous = this.creditHistory.get(providerId);
    if (!usage.credits) {
      this.creditHistory.delete(providerId);
      return false;
    }
    const planIdle = usage.windows.every((window) => window.usedPercent === 0);
    const sameAccount = previous?.credential === credential;
    const rose = sameAccount && usage.credits.used > previous.used;
    const billedToCredits = planIdle && (rose || (sameAccount && previous.billedToCredits));
    this.creditHistory.set(providerId, {
      credential,
      used: usage.credits.used,
      billedToCredits,
    });
    return billedToCredits;
  }
}
