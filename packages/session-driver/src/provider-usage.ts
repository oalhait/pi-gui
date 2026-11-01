export interface ProviderUsageWindow {
  readonly label: string;
  readonly usedPercent: number;
  readonly resetsAt?: string;
}

export interface ProviderUsage {
  readonly providerId: string;
  readonly status: "available" | "unavailable" | "error";
  readonly plan?: string;
  readonly windows: readonly ProviderUsageWindow[];
  readonly checkedAt?: string;
  readonly message?: string;
}
