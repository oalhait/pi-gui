import { createHash } from "node:crypto";
import type { ProviderUsage, ProviderUsageWindow } from "@pi-gui/session-driver";

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

export function parseProviderUsage(
  providerId: string,
  value: unknown,
): Pick<ProviderUsage, "windows" | "plan"> {
  const body = object(value);
  const windows: ProviderUsageWindow[] = [];
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
    for (const [key, label] of [
      ["five_hour", "5-hour"],
      ["seven_day", "Weekly"],
      ["seven_day_opus", "Opus · Weekly"],
      ["seven_day_sonnet", "Sonnet · Weekly"],
      ["seven_day_oauth_apps", "OAuth apps · Weekly"],
      ["seven_day_cowork", "Cowork · Weekly"],
    ]) {
      if (!key || !label) continue;
      const window = object(body[key]);
      const usedPercent = percentage(window.utilization);
      if (usedPercent === undefined) continue;
      const resetsAt = resetTime(window.resets_at);
      windows.push({ label, usedPercent, ...(resetsAt ? { resetsAt } : {}) });
    }
  }
  return { windows, ...(typeof body.plan_type === "string" ? { plan: body.plan_type } : {}) };
}

export class ProviderUsageReader {
  private readonly cache = new Map<
    string,
    { credential: string; expires: number; result: Promise<ProviderUsage> }
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
      const result = this.fetchUsage(providerId, endpoint, auth.auth.apiKey);
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
      return {
        providerId,
        ...usage,
        checkedAt,
        status: usage.windows.length ? "available" : "unavailable",
        ...(!usage.windows.length
          ? { message: "The provider did not report any usage windows." }
          : {}),
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
}
