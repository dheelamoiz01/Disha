import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/auth/audit";
import { getRollingRetentionCutoffIST, getDutyCurrentTime } from "@/lib/utils/duty_window";

/**
 * DISHA Rolling 2-Business-Day Location Data Retention Service
 *
 * Policy:
 *   Always retain location history for:
 *     - The current business day (Asia/Kolkata).
 *     - The immediately preceding business day (Asia/Kolkata).
 *
 *   When a new business day starts in Asia/Kolkata, the complete historical GPS trail
 *   belonging to any earlier business day is permanently and physically deleted
 *   from the database using SQL DELETE.
 *
 * Example:
 *   - Day 1: Keep Day 1.
 *   - Day 2: Keep Day 1 and Day 2.
 *   - Day 3: Delete all Day 1 historical trail records; keep Day 2 and Day 3.
 *   - Day 4: Delete all Day 2 historical trail records; keep Day 3 and Day 4.
 *
 * Tables pruned:
 *   - Location         (GPS pings — primary retention target)
 *   - LocationEvent    (connectivity events tied to specific timestamps)
 *   - Heartbeat        (device heartbeat/status pings)
 *
 * Tables NEVER touched by this job:
 *   - Device.latestLatitude, latestLongitude, latestAccuracy, latestLocationTime (live map state)
 *   - User, Personnel  (worker accounts and profiles)
 *   - DutySession      (attendance / work sessions)
 *   - SOSEvent, Alert  (safety events — legal hold policy applies)
 *   - AuditLog         (immutable audit trail)
 *   - Session, DeviceCredential (auth records)
 *   - AppRelease       (OTA release metadata)
 */

export const RETENTION_POLICY = "rolling_2_business_days_ist";
export const RETENTION_BUSINESS_DAYS = 2;
export const MAX_LOCATION_RETENTION_HOURS = 48; // Kept for backward compatibility

/** Batch size for safe incremental deletes — avoids holding large table locks */
const PURGE_BATCH_SIZE = 500;

/** Concurrency mutex to prevent overlapping purge runs */
let isPurgeRunning = false;

export interface PurgeResult {
  locationsPurged: number;
  eventsPurged: number;
  heartbeatsPurged: number;
  cutoffDate: string;
  durationMs: number;
  policy: string;
  skipped?: boolean;
}

/**
 * Calculates the authoritative cutoff timestamp for rolling 2-day retention.
 * Any record recorded before this cutoff belongs to a business day older
 * than the preceding business day and must be deleted.
 */
export function getRetentionCutoffDate(
  referenceTime: Date = getDutyCurrentTime(),
  businessDaysToKeep: number = RETENTION_BUSINESS_DAYS
): Date {
  return getRollingRetentionCutoffIST(referenceTime, businessDaysToKeep);
}

/**
 * Permanently deletes GPS location pings, LocationEvents, and Heartbeats
 * older than the rolling 2-business-day window in Asia/Kolkata.
 *
 * The cutoff timestamp is derived from the server clock:
 *   cutoff = Start of preceding business day in Asia/Kolkata (00:00:00.000 IST).
 *
 * Records with recordedAt < cutoff are physically DELETEd from the database.
 * Processing occurs in safe batches of 500 to prevent blocking live writes.
 *
 * @param daysOrHours   - Business days to retain (default 2), or hours (e.g. 48)
 * @param actorId       - Identifier for audit log (user ID or "SYSTEM_CRON")
 * @param referenceTime - Optional reference time (defaults to server clock / mock clock)
 */
export async function purgeExpiredLocationData(
  daysOrHours: number = RETENTION_BUSINESS_DAYS,
  actorId: string = "SYSTEM_CRON",
  referenceTime?: Date
): Promise<PurgeResult> {
  const startedAt = Date.now();

  // Normalize days vs hours input
  let effectiveDays = RETENTION_BUSINESS_DAYS;
  if (typeof daysOrHours === "number") {
    if (daysOrHours > 7) {
      // Input in hours (e.g. 48 -> 2 days)
      effectiveDays = Math.max(1, Math.round(daysOrHours / 24));
    } else {
      effectiveDays = Math.max(1, daysOrHours);
    }
  }
  // Policy strictly enforces retaining at most 2 business days
  effectiveDays = Math.min(effectiveDays, RETENTION_BUSINESS_DAYS);

  const baseTime = referenceTime ?? getDutyCurrentTime();
  const cutoffDate = getRollingRetentionCutoffIST(baseTime, effectiveDays);

  // Concurrency guard: prevent overlapping purge jobs
  if (isPurgeRunning) {
    console.warn("[RetentionPurge] Concurrency lock active: another purge is already running. Skipping.");
    return {
      locationsPurged: 0,
      eventsPurged: 0,
      heartbeatsPurged: 0,
      cutoffDate: cutoffDate.toISOString(),
      durationMs: Date.now() - startedAt,
      policy: RETENTION_POLICY,
      skipped: true,
    };
  }

  isPurgeRunning = true;

  console.log(
    `[RetentionPurge] Starting rolling 2-business-day purge (IST). Cutoff: ${cutoffDate.toISOString()} ` +
    `(Start of preceding IST business day: 00:00:00 IST). Deleting Location, LocationEvent, and Heartbeat.`
  );

  await logAudit({
    actorId,
    action: "RETENTION_PURGE_STARTED",
    metadata: {
      cutoffDate: cutoffDate.toISOString(),
      policy: RETENTION_POLICY,
      businessDays: effectiveDays,
      referenceTime: baseTime.toISOString(),
    },
  });

  let locationsPurged = 0;
  let eventsPurged = 0;
  let heartbeatsPurged = 0;

  try {
    // ── Phase 1: Delete expired Location records (GPS pings) ─────────────────
    // Uses the [personnelId, recordedAt] index via a two-step findMany+deleteMany
    // pattern, which is compatible with Turso/libSQL over HTTP.
    {
      let batchCount = 0;
      while (true) {
        const batch = await prisma.location.findMany({
          where: { recordedAt: { lt: cutoffDate } },
          select: { id: true },
          take: PURGE_BATCH_SIZE,
        });
        if (batch.length === 0) break;

        const ids = batch.map((r) => r.id);
        const deleted = await prisma.location.deleteMany({
          where: { id: { in: ids } },
        });
        locationsPurged += deleted.count;
        batchCount++;

        if (batch.length < PURGE_BATCH_SIZE) break; // Last partial batch
      }
      console.log(
        `[RetentionPurge] Location: deleted ${locationsPurged} records in ${batchCount} batch(es).`
      );
    }

    // ── Phase 2: Delete expired LocationEvent records ────────────────────────
    {
      let batchCount = 0;
      while (true) {
        const batch = await prisma.locationEvent.findMany({
          where: { recordedAt: { lt: cutoffDate } },
          select: { id: true },
          take: PURGE_BATCH_SIZE,
        });
        if (batch.length === 0) break;

        const ids = batch.map((r) => r.id);
        const deleted = await prisma.locationEvent.deleteMany({
          where: { id: { in: ids } },
        });
        eventsPurged += deleted.count;
        batchCount++;

        if (batch.length < PURGE_BATCH_SIZE) break;
      }
      console.log(
        `[RetentionPurge] LocationEvent: deleted ${eventsPurged} records in ${batchCount} batch(es).`
      );
    }

    // ── Phase 3: Delete expired Heartbeat records ─────────────────────────────
    {
      let batchCount = 0;
      while (true) {
        const batch = await prisma.heartbeat.findMany({
          where: { recordedAt: { lt: cutoffDate } },
          select: { id: true },
          take: PURGE_BATCH_SIZE,
        });
        if (batch.length === 0) break;

        const ids = batch.map((r) => r.id);
        const deleted = await prisma.heartbeat.deleteMany({
          where: { id: { in: ids } },
        });
        heartbeatsPurged += deleted.count;
        batchCount++;

        if (batch.length < PURGE_BATCH_SIZE) break;
      }
      console.log(
        `[RetentionPurge] Heartbeat: deleted ${heartbeatsPurged} records in ${batchCount} batch(es).`
      );
    }

    const durationMs = Date.now() - startedAt;

    console.log(
      `[RetentionPurge] Completed in ${durationMs}ms. ` +
      `Purged: ${locationsPurged} locations, ${eventsPurged} events, ${heartbeatsPurged} heartbeats.`
    );

    await logAudit({
      actorId,
      action: "RETENTION_PURGE_COMPLETED",
      metadata: {
        locationsPurged,
        eventsPurged,
        heartbeatsPurged,
        cutoffDate: cutoffDate.toISOString(),
        policy: RETENTION_POLICY,
        businessDays: effectiveDays,
        durationMs,
      },
    });

    return {
      locationsPurged,
      eventsPurged,
      heartbeatsPurged,
      cutoffDate: cutoffDate.toISOString(),
      durationMs,
      policy: RETENTION_POLICY,
    };
  } catch (error: unknown) {
    const durationMs = Date.now() - startedAt;
    const errorMsg = (error as any)?.message ?? "Unknown error";

    console.error(`[RetentionPurge] FAILED after ${durationMs}ms:`, errorMsg);

    await logAudit({
      actorId,
      action: "RETENTION_PURGE_FAILED",
      metadata: {
        error: errorMsg,
        cutoffDate: cutoffDate.toISOString(),
        policy: RETENTION_POLICY,
        businessDays: effectiveDays,
        partialLocationsPurged: locationsPurged,
        partialEventsPurged: eventsPurged,
        partialHeartbeatsPurged: heartbeatsPurged,
        durationMs,
      },
    });

    throw error;
  } finally {
    isPurgeRunning = false;
  }
}

/**
 * Kept for backward compatibility with existing callers.
 */
export async function purgeOldTelemetry(
  daysToKeep: number = 2,
  actorId?: string
): Promise<{ locationsPurged: number; eventsPurged: number; heartbeatsPurged: number }> {
  const result = await purgeExpiredLocationData(daysToKeep, actorId ?? "SYSTEM_CRON");
  return {
    locationsPurged: result.locationsPurged,
    eventsPurged: result.eventsPurged,
    heartbeatsPurged: result.heartbeatsPurged,
  };
}
