export type CanonicalLedgerStatus = "PENDING" | "SUCCESS" | "FAILED" | "CANCELED" | "EXPIRED" | "REVERSED";

export function mapProviderStatus(rawStatus: string | undefined | null): CanonicalLedgerStatus {
  if (!rawStatus) return "FAILED";
  const s = String(rawStatus).trim().toUpperCase();

  if (s === "SUCCESS" || s === "SUCCESSFUL" || s === "COMPLETED" || s === "PAID") {
    return "SUCCESS";
  }
  if (s === "PENDING" || s === "PROCESSING" || s === "NEW" || s === "ONGOING") {
    return "PENDING";
  }
  if (s === "CANCELED" || s === "CANCELLED" || s === "ABANDONED" || s === "USER_CANCELLED") {
    return "CANCELED";
  }
  if (s === "EXPIRED" || s === "TIMEOUT") {
    return "EXPIRED";
  }
  if (s === "REVERSED" || s === "REFUNDED") {
    return "REVERSED";
  }
  return "FAILED";
}
