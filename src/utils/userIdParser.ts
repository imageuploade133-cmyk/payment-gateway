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
  const ref = (txRef || "").trim();
  if (ref) {
    if (ref.startsWith("tx-FUNDING-")) return ref;
    if (ref.startsWith("tx-")) return `tx-FUNDING-${ref.substring(3)}`;
    return `tx-FUNDING-${ref}`;
  }
  const id = (flwId || "").trim();
  if (id) {
    if (id.startsWith("tx-FUNDING-")) return id;
    return `tx-FUNDING-${id}`;
  }
  return "tx-FUNDING-UNKNOWN";
}
