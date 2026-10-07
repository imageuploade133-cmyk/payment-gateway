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

export function isValidFlwId(flwId?: string | null): boolean {
  if (!flwId) return false;
  const clean = String(flwId).trim();
  if (!clean) return false;
  const lower = clean.toLowerCase();
  if (lower === "n/a" || lower === "undefined" || lower === "null" || lower === "0" || lower === "unknown") {
    return false;
  }
  return true;
}

export function resolveFundingLedgerDocId(txRef?: string | null, flwId?: string | null): string {
  const cleanFlwId = (flwId || "").trim();
  if (isValidFlwId(cleanFlwId)) {
    if (cleanFlwId.startsWith("tx-FUNDING-flw-")) return cleanFlwId;
    if (cleanFlwId.startsWith("tx-FUNDING-")) return `tx-FUNDING-flw-${cleanFlwId.replace("tx-FUNDING-", "")}`;
    return `tx-FUNDING-flw-${cleanFlwId}`;
  }

  const ref = (txRef || "").trim();
  if (ref && !ref.startsWith("user-wallet-")) {
    if (ref.startsWith("tx-FUNDING-")) return ref;
    if (ref.startsWith("tx-")) return `tx-FUNDING-${ref.substring(3)}`;
    return `tx-FUNDING-${ref}`;
  }

  return "tx-FUNDING-UNKNOWN";
}
