import type { EntryKind } from "./types";

export const MAX_AMOUNT_MINOR = 9_000_000_000_000_000;

export class AmountError extends Error {
  constructor(
    message: string,
    public readonly code: "required" | "invalid" | "zero" | "too-large",
  ) {
    super(message);
    this.name = "AmountError";
  }
}

function parseDecimal(input: string, allowSign: boolean): number {
  const normalized = input.trim();
  if (!normalized) {
    throw new AmountError("请输入金额", "required");
  }

  const pattern = allowSign ? /^[+-]?\d+(?:\.\d{1,2})?$/ : /^\d+(?:\.\d{1,2})?$/;
  if (!pattern.test(normalized)) {
    throw new AmountError("金额必须是最多两位小数的数字", "invalid");
  }

  const negative = normalized.startsWith("-");
  const unsigned = normalized.replace(/^[+-]/, "");
  const [whole, fraction = ""] = unsigned.split(".");
  const minor = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  const signedMinor = negative ? -minor : minor;

  if (!Number.isSafeInteger(signedMinor) || Math.abs(signedMinor) > MAX_AMOUNT_MINOR) {
    throw new AmountError("金额超出可记录范围", "too-large");
  }

  return signedMinor;
}

export function parseUnsignedAmountToMinor(input: string): number {
  const minor = parseDecimal(input, false);
  if (minor === 0) {
    throw new AmountError("金额必须大于 0", "zero");
  }
  return minor;
}

export function parseSignedAmountToMinor(input: string): number {
  return parseDecimal(input, true);
}

export function kindToSignedMinor(kind: EntryKind, absoluteMinor: number): number {
  if (
    !Number.isSafeInteger(absoluteMinor) ||
    absoluteMinor <= 0 ||
    absoluteMinor > MAX_AMOUNT_MINOR
  ) {
    throw new AmountError("金额必须是大于 0 的整数分", "invalid");
  }
  return kind === "expense" ? -absoluteMinor : absoluteMinor;
}

export function kindFromSignedMinor(amountMinor: number): EntryKind {
  if (!Number.isSafeInteger(amountMinor) || amountMinor === 0) {
    throw new AmountError("账目金额必须是非零整数分", "invalid");
  }
  return amountMinor < 0 ? "expense" : "income";
}

export function amountMinorToInput(amountMinor: number): string {
  if (!Number.isSafeInteger(amountMinor)) {
    throw new AmountError("金额必须是整数分", "invalid");
  }
  const absolute = Math.abs(amountMinor);
  return `${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`;
}

const cnyFormatter = new Intl.NumberFormat("zh-CN", {
  style: "currency",
  currency: "CNY",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const cnyWholeFormatter = new Intl.NumberFormat("zh-CN", {
  maximumFractionDigits: 0,
});

export function formatCny(amountMinor: number | bigint): string {
  if (typeof amountMinor === "bigint") {
    const negative = amountMinor < 0n;
    const absolute = negative ? -amountMinor : amountMinor;
    const whole = cnyWholeFormatter.format(absolute / 100n);
    const fraction = String(absolute % 100n).padStart(2, "0");
    return `${negative ? "-" : ""}¥${whole}.${fraction}`;
  }
  if (!Number.isSafeInteger(amountMinor)) {
    throw new AmountError("金额必须是整数分", "invalid");
  }
  return cnyFormatter.format(amountMinor / 100);
}
