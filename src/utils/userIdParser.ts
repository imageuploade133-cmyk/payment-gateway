export function parseUserIdFromTxRef(txRef?: string | null): string | null {
  if (!txRef) return null;
  const ref = String(txRef).trim();

  if (ref.startsWith("user-wallet-")) {
    const uid = ref.substring("user-wallet-".length).trim();
    return uid.length > 0 ? uid : null;
  }

  if (ref.startsWith("flw-tx-")) {
    // Format: flw-tx-<uid>-<timestamp_or_suffix>
    const str = ref.substring("flw-tx-".length);
    const lastHyphen = str.lastIndexOf("-");
    if (lastHyphen > 0) {
      const uid = str.substring(0, lastHyphen).trim();
      return uid.length > 0 ? uid : null;
    }
  }

  return null;
}

export function resolveFundingLedgerDocId(txRef?: string | null, flwId?: string | null): string {
  const cleanFlwId = (flwId || "").trim();
  // Requirement 2: The real Flutterwave provider transaction ID (flwId) MUST be the canonical funding idempotency identity!
  if (cleanFlwId && cleanFlwId !== "N/A" && cleanFlwId !== "undefined" && cleanFlwId !== "null") {
    if (cleanFlwId.startsWith("tx-FUNDING-flw-")) return cleanFlwId;
    if (cleanFlwId.startsWith("tx-FUNDING-")) return `tx-FUNDING-flw-${cleanFlwId.replace("tx-FUNDING-", "")}`;
    return `tx-FUNDING-flw-${cleanFlwId}`;
  }

  const ref = (txRef || "").trim();
  if (ref) {
    if (ref.startsWith("tx-FUNDING-")) return ref;
    if (ref.startsWith("tx-")) return `tx-FUNDING-${ref.substring(3)}`;
    return `tx-FUNDING-${ref}`;
  }

  return "tx-FUNDING-UNKNOWN";
}
