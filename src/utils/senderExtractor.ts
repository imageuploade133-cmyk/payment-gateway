export interface ExtractedSenderInfo {
  senderName: string | null;
  senderBankName: string | null;
  senderAccountNumber: string | null;
  senderBankCode: string | null;
}

/**
  * Safely retrieves property values from an object using a list of candidate keys,
  * using both direct key lookup and case-insensitive/separator-insensitive matching.
  */
function getCaseInsensitiveProp(obj: any, keys: string[]): any {
  if (!obj || typeof obj !== "object") return undefined;

  // 1. Direct exact key match
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== "") {
      return obj[k];
    }
  }

  // 2. Case-insensitive / normalized key match
  const objKeys = Object.keys(obj);
  for (const targetKey of keys) {
    const lowerTarget = targetKey.toLowerCase().replace(/[^a-z0-9]/g, "");
    const foundKey = objKeys.find(
      (k) => k.toLowerCase().replace(/[^a-z0-9]/g, "") === lowerTarget
    );
    if (foundKey && obj[foundKey] !== undefined && obj[foundKey] !== null && obj[foundKey] !== "") {
      return obj[foundKey];
    }
  }

  return undefined;
}

/**
  * Normalizes and extracts real sender/originator details from Flutterwave payment payloads.
  * Checks meta_data, meta, top-level properties, and nested source/entity/sender objects.
  * Explicitly excludes recipient/customer names from acting as sender names.
  */
export function extractSenderInfo(data: any): ExtractedSenderInfo {
  if (!data || typeof data !== "object") {
    return {
      senderName: null,
      senderBankName: null,
      senderAccountNumber: null,
      senderBankCode: null,
    };
  }

  const metaData = data.meta_data || data.metadata || {};
  const meta = data.meta || {};
  const source = data.source || {};
  const entity = data.entity || {};
  const sender = data.sender || {};

  const senderNameKeys = [
    "originatorname",
    "originator_name",
    "originatorName",
    "originatoraccountname",
    "originator_account_name",
    "sender_name",
    "senderName",
    "sender_account_name",
    "senderAccountName",
  ];

  const bankNameKeys = [
    "originatorbankname",
    "originator_bank_name",
    "originator_bank",
    "originatorbank",
    "sender_bank_name",
    "sender_bank",
    "senderBankName",
    "senderBank",
    "bankname",
  ];

  const accountNumberKeys = [
    "originatoraccountnumber",
    "originator_account_number",
    "originator_account",
    "originatoraccount",
    "sender_account_number",
    "sender_account",
    "senderAccountNumber",
    "senderAccount",
  ];

  const bankCodeKeys = [
    "bankcode",
    "bank_code",
    "originatorbankcode",
    "originator_bank_code",
    "sender_bank_code",
    "senderBankCode",
  ];

  // If meta or metaData is an array of key-value objects, convert to map first
  const extractFromMetaArray = (metaArray: any[], keys: string[]) => {
    if (!Array.isArray(metaArray)) return undefined;
    for (const item of metaArray) {
      if (!item || typeof item !== "object") continue;
      const k = item.metaname || item.meta_name || item.name || item.key || item.Metaname || item.MetaName;
      const v = item.metavalue || item.meta_value || item.value || item.val || item.Metavalue || item.MetaValue;
      if (k && v !== undefined && v !== null && v !== "") {
        const normalizedKey = String(k).toLowerCase().replace(/[^a-z0-9]/g, "");
        for (const targetKey of keys) {
          if (normalizedKey === targetKey.toLowerCase().replace(/[^a-z0-9]/g, "")) {
            return v;
          }
        }
      }
    }
    return undefined;
  };

  // 1. Check meta_data / metadata
  let rawSenderName = Array.isArray(metaData) ? extractFromMetaArray(metaData, senderNameKeys) : getCaseInsensitiveProp(metaData, senderNameKeys);
  let rawBankName = Array.isArray(metaData) ? extractFromMetaArray(metaData, bankNameKeys) : getCaseInsensitiveProp(metaData, bankNameKeys);
  let rawAccountNumber = Array.isArray(metaData) ? extractFromMetaArray(metaData, accountNumberKeys) : getCaseInsensitiveProp(metaData, accountNumberKeys);
  let rawBankCode = Array.isArray(metaData) ? extractFromMetaArray(metaData, bankCodeKeys) : getCaseInsensitiveProp(metaData, bankCodeKeys);

  // 2. Check meta
  if (!rawSenderName) rawSenderName = Array.isArray(meta) ? extractFromMetaArray(meta, senderNameKeys) : getCaseInsensitiveProp(meta, senderNameKeys);
  if (!rawBankName) rawBankName = Array.isArray(meta) ? extractFromMetaArray(meta, bankNameKeys) : getCaseInsensitiveProp(meta, bankNameKeys);
  if (!rawAccountNumber) rawAccountNumber = Array.isArray(meta) ? extractFromMetaArray(meta, accountNumberKeys) : getCaseInsensitiveProp(meta, accountNumberKeys);
  if (!rawBankCode) rawBankCode = Array.isArray(meta) ? extractFromMetaArray(meta, bankCodeKeys) : getCaseInsensitiveProp(meta, bankCodeKeys);

  // 3. Check top-level data
  if (!rawSenderName) rawSenderName = getCaseInsensitiveProp(data, senderNameKeys);
  if (!rawBankName) rawBankName = getCaseInsensitiveProp(data, bankNameKeys);
  if (!rawAccountNumber) rawAccountNumber = getCaseInsensitiveProp(data, accountNumberKeys);
  if (!rawBankCode) rawBankCode = getCaseInsensitiveProp(data, bankCodeKeys);

  // 4. Check nested source / entity / sender objects
  if (!rawSenderName) rawSenderName = getCaseInsensitiveProp(source, senderNameKeys) || getCaseInsensitiveProp(entity, senderNameKeys) || getCaseInsensitiveProp(sender, senderNameKeys);
  if (!rawBankName) rawBankName = getCaseInsensitiveProp(source, bankNameKeys) || getCaseInsensitiveProp(entity, bankNameKeys) || getCaseInsensitiveProp(sender, bankNameKeys);
  if (!rawAccountNumber) rawAccountNumber = getCaseInsensitiveProp(source, accountNumberKeys) || getCaseInsensitiveProp(entity, accountNumberKeys) || getCaseInsensitiveProp(sender, accountNumberKeys);
  if (!rawBankCode) rawBankCode = getCaseInsensitiveProp(source, bankCodeKeys) || getCaseInsensitiveProp(entity, bankCodeKeys) || getCaseInsensitiveProp(sender, bankCodeKeys);

  const isInvalidSentinel = (val: string) => {
    const lower = val.toLowerCase().trim();
    return lower === "" || lower === "n/a" || lower === "null" || lower === "undefined" || lower === "none";
  };

  // Clean and sanitize string values
  let senderName: string | null = null;
  if (rawSenderName && typeof rawSenderName === "string") {
    const trimmed = rawSenderName.trim();
    if (!isInvalidSentinel(trimmed)) {
      senderName = trimmed;
    }
  } else if (rawSenderName && typeof rawSenderName === "object" && rawSenderName.name) {
    const trimmed = String(rawSenderName.name).trim();
    if (!isInvalidSentinel(trimmed)) {
      senderName = trimmed;
    }
  }

  let senderBankName: string | null = null;
  if (rawBankName && typeof rawBankName === "string") {
    const trimmed = rawBankName.trim();
    if (!isInvalidSentinel(trimmed)) {
      senderBankName = trimmed;
    }
  }

  let senderAccountNumber: string | null = null;
  if (rawAccountNumber !== undefined && rawAccountNumber !== null) {
    const str = String(rawAccountNumber).trim();
    if (!isInvalidSentinel(str)) {
      senderAccountNumber = str;
    }
  }

  let senderBankCode: string | null = null;
  if (rawBankCode !== undefined && rawBankCode !== null) {
    const str = String(rawBankCode).trim();
    if (!isInvalidSentinel(str)) {
      senderBankCode = str;
    }
  }

  return {
    senderName,
    senderBankName,
    senderAccountNumber,
    senderBankCode,
  };
}
