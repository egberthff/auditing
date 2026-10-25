// Amounts are integers in the currency's minor unit (cents for USD, yen for JPY).

const digitsCache = new Map();

export function currencyDigits(currency) {
  if (!digitsCache.has(currency)) {
    let digits = 2;
    try { digits = new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits; } catch { /* unknown code */ }
    digitsCache.set(currency, digits);
  }
  return digitsCache.get(currency);
}

export function isValidCurrency(code) {
  if (!/^[A-Z]{3}$/.test(code)) return false;
  try { new Intl.NumberFormat("en", { style: "currency", currency: code }); return true; } catch { return false; }
}

// Turn a typed number into plain "1234.56" form, accepting both "1,234.56" and "1.234,56",
// and a decimal comma ("10,50" = 10.50). Returns null when the grouping is ambiguous or
// malformed, so a typo is refused instead of being read as a much larger amount.
function normalizeNumber(text) {
  const s = text.replace(/[\s  ']/g, "");
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  if (lastComma === -1) {
    return s;
  }
  if (lastComma > lastDot) {
    const head = s.slice(0, lastComma);
    const tail = s.slice(lastComma + 1);
    // "1,234" or "12,345,678": commas used for thousands only
    if (lastDot === -1 && /^\d{1,3}(,\d{3})+$/.test(s)) return s.replace(/,/g, "");
    // Otherwise the comma is the decimal mark; dots before it may group thousands ("1.234,56")
    if (!/^\d*$/.test(tail) || !(/^\d*$/.test(head) || /^\d{1,3}(\.\d{3})+$/.test(head))) return null;
    return `${head.replace(/\./g, "")}.${tail}`;
  }
  // The dot is the decimal mark; commas before it must group thousands ("1,234.56")
  const head = s.slice(0, lastDot);
  if (!/^\d{1,3}(,\d{3})+$/.test(head)) return null;
  return head.replace(/,/g, "") + s.slice(lastDot);
}

// Parse what a person typed into minor units without floating point.
// Returns NaN for negatives, too many decimals, or values beyond exact integer range.
export function parseAmount(input, currency) {
  const digits = currencyDigits(currency);
  const s = normalizeNumber(String(input ?? "").trim());
  if (s === null) return NaN;
  const m = new RegExp(`^(?=\\d|\\.\\d)(\\d*)(?:\\.(\\d{0,${digits}}))?$`).exec(s);
  if (!m) return NaN;
  const minor = Number(m[1] || "0") * 10 ** digits + Number((m[2] || "").padEnd(digits, "0") || "0");
  return Number.isSafeInteger(minor) ? minor : NaN;
}

export function formatMoney(minor, currency) {
  if (typeof minor !== "number" || !Number.isFinite(minor)) minor = 0;
  const digits = currencyDigits(currency);
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency, minimumFractionDigits: digits, maximumFractionDigits: digits })
      .format(minor / 10 ** digits);
  } catch {
    return (minor / 10 ** digits).toFixed(digits);
  }
}

// Plain number for prefilling an <input> (no grouping, no symbol).
export function toInputValue(minor, currency) {
  const digits = currencyDigits(currency);
  return (minor / 10 ** digits).toFixed(digits);
}

export function inputStep(currency) {
  const digits = currencyDigits(currency);
  return digits === 0 ? "1" : `0.${"0".repeat(digits - 1)}1`;
}
