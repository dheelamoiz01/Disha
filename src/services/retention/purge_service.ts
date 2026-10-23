import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/auth/audit";

/**
 * DISHA 48-Hour Location Data Retention Service
 *
 * Policy: Every GPS location ping (Location record), associated LocationEvents,
 * and Heartbeat records are physically and permanently deleted from the database
 * once they become older than 48 hours.
 *
 * This uses actual SQL DELETE operations. There is NO soft deletion, archiving,
 * or hiding of records. Once committed, expired records cease to exist in the database.
 *
 * Tables pruned:
 *   - Location         (GPS pings — primary retention target)
 *   - LocationEvent    (connectivity events tied to specific timestamps)
 *   - Heartbeat        (device heartbeat/status pings)
 *
 * Tables NEVER touched by this job:
 *   - User, Personnel, Device  (worker accounts and latest live position)
 *   - DutySession              (attendance / work sessions)
 *   - SOSEvent, Alert          (safety events — separate legal hold policy applies)
 *   - AuditLog                 (immutable audit trail)
 *   - Session, DeviceCredential (auth records)
 *   - AppRelease               (OTA release metadata)
 */

/** Strict maximum — cannot exceed this retention window regardless of env config */
export const MAX_LOCATION_RETENTION_HOURS = 48;

/** Batch size for safe incremental deletes — avoids holding large table locks */
const PURGE_BATCH_SIZE = 500;

export interface PurgeResult {
  locationsPurged: number;
  eventsPurged: number;
  heartbeatsPurged: number;
  cutoffDate: string;
  durationMs: number;
}

/**
 * Permanently deletes GPS location pings, LocationEvents, and Heartbeats
 * older than the retention window (default 48 hours, maximum 48 hours).
 *
 * The cutoff timestamp is always derived from the authoritative server clock:
 *   cutoff = now() - retentionHours
 *
 * Records with recordedAt < cutoff are physically DELETEd from the database.
 * Processing occurs in batches of 500 to prevent blocking live writes.
 *
 * @param retentionHours - Number of hours to retain (max 48, default 48)
 * @param actorId        - Identifier for audit log (user ID or "SYSTEM_CRON")
 */
export async function purgeExpiredLocationData(
  retentionHours: number = MAX_LOCATION_RETENTION_HOURS,
  actorId: string = "SYSTEM_CRON"
): Promise<PurgeResult> {
  const startedAt = Date.now();

  // Strictly enforce the 48-hour ceiling — never allow config to exceed it
  const effectiveHours = Math.min(
    Math.max(1, retentionHours),
    MAX_LOCATION_RETENTION_HOURS
  );

  // Cutoff = authoritative server UTC time minus retention window
  const cutoffDate = new Date(Date.now() - effectiveHours * 60 * 60 * 1000);

  console.log(
    `[RetentionPurge] Starting 48-hour purge. Cutoff: ${cutoffDate.toISOString()} (server UTC). ` +
    `Deleting Location, LocationEvent, and Heartbeat records older than ${effectiveHours}h.`
  );

  await logAudit({
    actorId,
    action: "RETENTION_PURGE_STARTED",
    metadata: {
      cutoffDate: cutoffDate.toISOString(),
      retentionHours: effectiveHours,
      policy: "48h_hard_delete",
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
        retentionHours: effectiveHours,
        durationMs,
      },
    });

    return {
      locationsPurged,
      eventsPurged,
      heartbeatsPurged,
      cutoffDate: cutoffDate.toISOString(),
      durationMs,
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
        retentionHours: effectiveHours,
        partialLocationsPurged: locationsPurged,
        partialEventsPurged: eventsPurged,
        partialHeartbeatsPurged: heartbeatsPurged,
        durationMs,
      },
    });

    throw error;
  }
}

/**
 * @deprecated Use purgeExpiredLocationData() instead.
 * Kept for backward compatibility with the existing purge route.
 * The daysToKeep parameter is clamped to a maximum of 2 days (48 hours).
 */
export async function purgeOldTelemetry(
  daysToKeep: number = 2,
  actorId?: string
): Promise<{ locationsPurged: number; eventsPurged: number; heartbeatsPurged: number }> {
  // Convert days to hours, capped at 48h
  const requestedHours = Math.min(daysToKeep * 24, MAX_LOCATION_RETENTION_HOURS);
  const result = await purgeExpiredLocationData(requestedHours, actorId ?? "SYSTEM_CRON");
  return {
    locationsPurged: result.locationsPurged,
    eventsPurged: result.eventsPurged,
    heartbeatsPurged: result.heartbeatsPurged,
  };
}
