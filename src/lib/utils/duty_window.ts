/**
 * Asia/Kolkata (IST) Duty Window Utilities
 *
 * Enforces business duty window: 07:00:00.000 AM to 10:00:00.000 PM IST (Asia/Kolkata).
 * Outside 07:00–22:00 IST, location uploads and trail persistence are blocked.
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
  // Asia/Kolkata is UTC +05:30 (330 minutes)
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
 * Checks whether a given timestamp falls strictly within the permitted duty window:
 * 07:00:00.000 AM to 09:59:59.999 PM IST (hour in [7..21]).
 * At 22:00:00 (10:00 PM), returns false.
 * Before 07:00:00 (07:00 AM), returns false.
 */
export function isWithinDutyWindowIST(date: Date): boolean {
  if (process.env.DISABLE_DUTY_WINDOW === "1") return true;
  const parts = getISTTimeParts(date);
  return parts.hour >= 7 && parts.hour < 22;
}

/**
 * Checks if two timestamps fall on the same calendar day in Asia/Kolkata.
 */
export function isSameDayIST(d1: Date, d2: Date): boolean {
  const p1 = getISTTimeParts(d1);
  const p2 = getISTTimeParts(d2);
  return p1.year === p2.year && p1.month === p2.month && p1.day === p2.day;
}

export interface DutyValidationResult {
  permitted: boolean;
  code?: string;
  reason?: string;
}

/**
 * Validates whether location telemetry ingestion is permitted based on:
 * 1. Server-side time in Asia/Kolkata (must be within 07:00 to 22:00 IST).
 * 2. Location recorded timestamp in Asia/Kolkata (must be within 07:00 to 22:00 IST).
 * 3. Future-dating protection: Cannot be more than 2 minutes into the future.
 * 4. Stale/Delayed queue protection: Cannot accept overnight or stale fixes older than 15 minutes.
 */
export function validateTelemetryDutyWindow(
  recordedAt: Date,
  serverNow: Date = getDutyCurrentTime()
): DutyValidationResult {
  // 1. Server time check
  if (!isWithinDutyWindowIST(serverNow)) {
    return {
      permitted: false,
      code: "DUTY_WINDOW_CLOSED",
      reason: "Server duty window closed. Location tracking is permitted only between 07:00 AM and 10:00 PM IST.",
    };
  }

  // 2. Client fix timestamp check
  if (!isWithinDutyWindowIST(recordedAt)) {
    return {
      permitted: false,
      code: "DUTY_WINDOW_CLOSED",
      reason: "Location recorded outside duty window (07:00 AM to 10:00 PM IST). Overnight points are discarded.",
    };
  }

  // 3. Reject future-dated points (> 2 minutes skew)
  const skewMs = recordedAt.getTime() - serverNow.getTime();
  if (skewMs > 2 * 60 * 1000) {
    return {
      permitted: false,
      code: "FUTURE_TIMESTAMP",
      reason: "Location timestamp is in the future compared to server time.",
    };
  }

  // 4. Stale / delayed buffer protection:
  // Points cannot be older than 15 minutes or from a previous day.
  // Prevents queuing overnight data and dumping it at 07:00 AM.
  const ageMs = serverNow.getTime() - recordedAt.getTime();
  const MAX_DELAY_MS = 15 * 60 * 1000; // 15 minutes
  if (ageMs > MAX_DELAY_MS) {
    return {
      permitted: false,
      code: "TIMESTAMP_STALE",
      reason: "Location timestamp is older than 15 minutes. Delayed overnight queuing is not permitted.",
    };
  }

  if (!isSameDayIST(recordedAt, serverNow)) {
    return {
      permitted: false,
      code: "TIMESTAMP_STALE",
      reason: "Location timestamp is from a previous calendar day.",
    };
  }

  return { permitted: true };
}
