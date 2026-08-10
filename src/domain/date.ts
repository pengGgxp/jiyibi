export interface StableLocalDateTime {
  occurredAt: string;
  localDateKey: string;
  localMonthKey: string;
  timezoneOffsetMinutes: number;
}

const LOCAL_DATE_TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

export class DateTimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DateTimeError";
  }
}

export function parseLocalDateTime(input: string): StableLocalDateTime {
  const match = LOCAL_DATE_TIME_PATTERN.exec(input.trim());
  if (!match) {
    throw new DateTimeError("请选择有效的日期和时间");
  }

  const [, yearText, monthText, dayText, hourText, minuteText, secondText = "00"] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const date = new Date(year, month - 1, day, hour, minute, second, 0);

  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day ||
    date.getHours() !== hour ||
    date.getMinutes() !== minute ||
    date.getSeconds() !== second
  ) {
    throw new DateTimeError("日期或时间不存在");
  }

  const localDateKey = `${yearText}-${monthText}-${dayText}`;
  return {
    occurredAt: date.toISOString(),
    localDateKey,
    localMonthKey: `${yearText}-${monthText}`,
    timezoneOffsetMinutes: date.getTimezoneOffset(),
  };
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function assertPaydayDay(paydayDay: number): void {
  if (!Number.isInteger(paydayDay) || paydayDay < 1 || paydayDay > 31) {
    throw new RangeError("发薪日必须是 1 到 31 日");
  }
}

function paydayInMonth(year: number, monthIndex: number, paydayDay: number): Date {
  const lastDay = new Date(year, monthIndex + 1, 0).getDate();
  return new Date(year, monthIndex, Math.min(paydayDay, lastDay));
}

function calendarDayNumber(date: Date): number {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000;
}

export interface PayCycleRange {
  cycleStartDateKey: string;
  cycleEndDateKey: string;
  nextPaydayDateKey: string;
  daysUntilPayday: number;
}

export function resolvePayCycleRange(
  paydayDay: number,
  now = new Date(),
): PayCycleRange {
  assertPaydayDay(paydayDay);
  if (!Number.isFinite(now.getTime())) throw new RangeError("工资周期日期无效");

  const currentPayday = paydayInMonth(now.getFullYear(), now.getMonth(), paydayDay);
  const startsThisMonth = calendarDayNumber(now) >= calendarDayNumber(currentPayday);
  const cycleStart = startsThisMonth
    ? currentPayday
    : paydayInMonth(now.getFullYear(), now.getMonth() - 1, paydayDay);
  const nextPayday = startsThisMonth
    ? paydayInMonth(now.getFullYear(), now.getMonth() + 1, paydayDay)
    : currentPayday;
  const cycleEnd = new Date(
    nextPayday.getFullYear(),
    nextPayday.getMonth(),
    nextPayday.getDate() - 1,
  );

  return {
    cycleStartDateKey: localDateKey(cycleStart),
    cycleEndDateKey: localDateKey(cycleEnd),
    nextPaydayDateKey: localDateKey(nextPayday),
    daysUntilPayday: calendarDayNumber(nextPayday) - calendarDayNumber(now),
  };
}

export function currentLocalDateTimeInput(now = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

export function entryToLocalDateTimeInput(occurredAt: string, timezoneOffsetMinutes: number): string {
  const instant = new Date(occurredAt);
  if (!Number.isFinite(instant.getTime()) || !Number.isInteger(timezoneOffsetMinutes)) {
    throw new DateTimeError("账目时间无效");
  }
  const localWallTime = new Date(instant.getTime() - timezoneOffsetMinutes * 60_000);
  return `${localWallTime.getUTCFullYear()}-${pad(localWallTime.getUTCMonth() + 1)}-${pad(localWallTime.getUTCDate())}T${pad(localWallTime.getUTCHours())}:${pad(localWallTime.getUTCMinutes())}`;
}

export function currentLocalMonthKey(now = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
}

export function currentLocalDateKey(now = new Date()): string {
  return localDateKey(now);
}
