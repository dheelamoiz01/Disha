/**
 * Asia/Kolkata (IST) 24×7 Location Tracking & Duty Window Utilities
 *
 * GPS tracking is eligible to run 24 hours a day, 7 days a week, including
 * nights, weekends, holidays, and outside work sessions.
 * Location telemetry is accepted at any time without work-hour restrictions.
 */

import { TelemetryError } from "@/services/telemetry/ingestion_service";

// Controllable clock for deterministic automated testing
let mockDutyTime: Date | null = null;

export function setMockDutyTime(date: Date | null) {
  mockDutyTime = date;
}

export function getDutyCurrentTime(): Date {
  return mockDutyTime ? new Date(mockDutyTime.getTime()) : new Date();
}

export interface ISTTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
}

/**
 * Extracts date and time components strictly in Asia/Kolkata timezone (UTC +05:30).
 */
export function getISTTimeParts(date: Date): ISTTimeParts {
  const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
  const istDate = new Date(date.getTime() + IST_OFFSET_MS);

  return {
    year: istDate.getUTCFullYear(),
    month: istDate.getUTCMonth() + 1,
    day: istDate.getUTCDate(),
    hour: istDate.getUTCHours(),
    minute: istDate.getUTCMinutes(),
    second: istDate.getUTCSeconds(),
    millisecond: istDate.getUTCMilliseconds(),
  };
}

/**
 * Checks if a timestamp falls within the authorised tracking schedule.
 * In 24×7 mode (default), returns true around the clock every day.
 * Only restricts to 07:00–19:00 IST if ENFORCE_RESTRICTED_HOURS=1 is explicitly set.
 */
export function isWithinDutyWindowIST(date: Date): boolean {
  if (process.env.ENFORCE_RESTRICTED_HOURS === "1") {
    const parts = getISTTimeParts(date);
    if (parts.hour < 7) return false;
    if (parts.hour > 19) return false;
    if (parts.hour === 19 && (parts.minute > 0 || parts.second > 0)) return false;
    return true;
  }
  return true;
}

/**
 * Checks if two timestamps fall on the same calendar day in Asia/Kolkata.
 */
export function isSameDayIST(d1: Date, d2: Date): boolean {
  const p1 = getISTTimeParts(d1);
  const p2 = getISTTimeParts(d2);
  return p1.year === p2.year && p1.month === p2.month && p1.day === p2.day;
}

/**
 * Calculates the UTC Date corresponding to the start (00:00:00.000 IST) of the
 * oldest retained business day under the rolling 2-day policy.
 *
 * In IST (UTC+05:30):
 * - Current business day = Day N
 * - Immediately preceding business day = Day N - 1
 * - Cutoff timestamp = Start of Day N - 1 in IST (00:00:00.000 IST)
 *
 * Records recorded strictly before this cutoff belong to Day N - 2 or earlier
 * and must be physically deleted.
 *
 * @param now Reference timestamp (defaults to server current time)
 * @param businessDaysToKeep Number of business days to retain (default 2: today + yesterday)
 */
export function getRollingRetentionCutoffIST(
  now: Date = getDutyCurrentTime(),
  businessDaysToKeep: number = 2
): Date {
  const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
  const istDate = new Date(now.getTime() + IST_OFFSET_MS);

  const year = istDate.getUTCFullYear();
  const month = istDate.getUTCMonth();
  const day = istDate.getUTCDate();

  // For 2 business days: keep today (0) and preceding day (-1).
  // Cutoff is the start of the preceding day (day - 1) at 00:00:00.000 IST.
  const offsetDays = Math.max(1, businessDaysToKeep) - 1;
  const cutoffUtcMs = Date.UTC(year, month, day - offsetDays, 0, 0, 0, 0) - IST_OFFSET_MS;
  return new Date(cutoffUtcMs);
}

export interface DutyValidationResult {
  permitted: boolean;
  code?: string;
  reason?: string;
}

/**
 * Validates whether location telemetry ingestion is permitted:
 * 1. 24×7 Tracking: Telemetry is accepted around the clock without work-hour restrictions.
 * 2. Future-dating protection: Cannot be more than 5 minutes into the future (clock drift protection).
 * 3. Stale buffer protection: Rejects telemetry older than rolling 2-business-day IST cutoff.
 */
export function validateTelemetryDutyWindow(
  recordedAt: Date,
  serverNow: Date = getDutyCurrentTime()
): DutyValidationResult {
  // 24×7 tracking is default across all environments.
  // Legacy restricted hours check only fires if explicitly requested via ENFORCE_RESTRICTED_HOURS=1
  if (process.env.ENFORCE_RESTRICTED_HOURS === "1") {
    if (!isWithinDutyWindowIST(serverNow)) {
      return {
        permitted: false,
        code: "DUTY_WINDOW_CLOSED",
        reason: "Server tracking window closed (07:00 AM to 07:00 PM IST authorised window).",
      };
    }
    if (!isWithinDutyWindowIST(recordedAt)) {
      return {
        permitted: false,
        code: "DUTY_WINDOW_CLOSED",
        reason: "Location recorded outside authorised tracking window (07:00 AM to 07:00 PM IST).",
      };
    }
  }

  // 1. Reject future-dated points (> 5 minutes skew tolerance)
  const skewMs = recordedAt.getTime() - serverNow.getTime();
  const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000; // 5 minutes
  if (skewMs > MAX_FUTURE_SKEW_MS) {
    return {
      permitted: false,
      code: "FUTURE_TIMESTAMP",
      reason: "Location timestamp is in the future compared to server time.",
    };
  }

  // 2. Reject stale records beyond rolling 2-day retention window.
  //    This matches the database retention policy exactly: records older than the preceding
  //    IST business day are physically deleted by the purge job, so accepting uploads
  //    beyond this window would insert records that are immediately eligible for
  //    deletion and could not appear in historical trail queries.
  //    This also prevents offline-queued pings from resurrecting deleted trails.
  const retentionCutoff = getRollingRetentionCutoffIST(serverNow, 2);
  if (recordedAt.getTime() < retentionCutoff.getTime()) {
    return {
      permitted: false,
      code: "TIMESTAMP_STALE",
      reason: "Location timestamp is older than the rolling 2-business-day retention window (earlier than preceding IST business day).",
    };
  }

  return { permitted: true };
}
