export interface ProviderUsageWindow {
  readonly label: string;
  readonly usedPercent: number;
  readonly resetsAt?: string;
  /** Provider-reported severity such as "normal" or "warning", when present. */
  readonly severity?: string;
  /** Whether the provider reports this limit as currently applying. */
  readonly active?: boolean;
}

/** Pay-as-you-go credits that cover usage beyond a subscription plan. */
export interface ProviderUsageCredits {
  /** Spent amount in major currency units (dollars, not cents). */
  readonly used: number;
  /** Spending cap in major currency units, when the provider sets one. */
  readonly limit?: number;
  /** ISO 4217 currency code. */
  readonly currency: string;
  readonly fractionDigits: number;
  readonly usedPercent?: number;
  readonly severity?: string;
  readonly limitReached: boolean;
  readonly disclaimer?: string;
}

export interface ProviderUsage {
  readonly providerId: string;
  readonly status: "available" | "unavailable" | "error";
  readonly plan?: string;
  readonly windows: readonly ProviderUsageWindow[];
  readonly credits?: ProviderUsageCredits;
  /**
   * True when, during this app session, credits rose between checks while every
   * plan window stayed at 0%: requests are going to credits, not plan usage.
   */
  readonly billedToCredits?: boolean;
  readonly checkedAt?: string;
  readonly message?: string;
}
