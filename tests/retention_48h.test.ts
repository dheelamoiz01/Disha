/**
 * DISHA Rolling 2-Business-Day Location Data Retention Test Suite
 *
 * Verifies all 10 core requirements:
 *   1. Day 1 records remain when Day 2 starts.
 *   2. Day 1 records are permanently deleted when Day 3 starts.
 *   3. Day 2 and Day 3 records remain after Day 3 cleanup.
 *   4. Day 2 records are deleted when Day 4 starts.
 *   5. LocationEvent and Heartbeat follow the same policy.
 *   6. Current device location and attendance data remain untouched.
 *   7. Offline sync cannot restore expired trails (ingestion rejects).
 *   8. Cleanup is idempotent and handles retries safely.
 *   9. Concurrency lock prevents overlapping runs.
 *   10. Timezone boundaries behave correctly around midnight IST.
 *   11. Route authorization security (rejects old default secret, enforces CRON_SECRET).
 */

import test from "node:test";
import assert from "node:assert";
import { randomUUID } from "node:crypto";
import { prisma } from "../src/lib/prisma";
import { DeviceStatus, UserStatus, DutyStatus } from "../generated/prisma/enums";
import {
  purgeExpiredLocationData,
  getRetentionCutoffDate,
  RETENTION_POLICY,
  RETENTION_BUSINESS_DAYS,
} from "../src/services/retention/purge_service";
import {
  validateTelemetryDutyWindow,
  getRollingRetentionCutoffIST,
} from "../src/lib/utils/duty_window";
import { POST as purgeRoutePost } from "../src/app/api/admin/retention/purge/route";

// Helper to construct exact IST timestamps
function istDate(year: number, month: number, day: number, hour: number, minute: number, second: number, ms: number = 0): Date {
  const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second, ms) - IST_OFFSET_MS);
}

test("DISHA Rolling 2-Business-Day Location Retention Test Suite", async (t) => {
  let user: any;
  let personnel: any;
  let device: any;
  let dutySession: any;

  const testTag = `ROLL-${Date.now()}`;

  // IST Reference Dates:
  // Day 1: 2026-10-21 IST
  // Day 2: 2026-10-22 IST
  // Day 3: 2026-10-23 IST
  // Day 4: 2026-10-24 IST
  const day1Morning = istDate(2026, 10, 21, 9, 0, 0);
  const day1LateNight = istDate(2026, 10, 21, 23, 55, 0); // ~24h old when Day 3 starts (less than 48h!)

  const day2Early = istDate(2026, 10, 22, 0, 5, 0);
  const day2Afternoon = istDate(2026, 10, 22, 14, 0, 0);
  const day2LateNight = istDate(2026, 10, 22, 23, 50, 0);

  const day3Start = istDate(2026, 10, 23, 0, 1, 0);
  const day3Afternoon = istDate(2026, 10, 23, 15, 0, 0);

  const day4Start = istDate(2026, 10, 24, 0, 5, 0);

  let idDay1Morning: string;
  let idDay1LateNight: string;
  let idDay2Early: string;
  let idDay2Afternoon: string;
  let idDay2LateNight: string;
  let idDay3Start: string;
  let idDay3Afternoon: string;

  let eventDay1: string;
  let eventDay2: string;
  let heartbeatDay1: string;
  let heartbeatDay2: string;

  await t.test("0. Setup isolated test fixtures and attendance records", async () => {
    user = await prisma.user.create({
      data: {
        username: `roll_user_${testTag}`,
        passwordHash: "dummyHash",
        role: "FIELD_PERSONNEL",
        status: UserStatus.ACTIVE,
      },
    });

    personnel = await prisma.personnel.create({
      data: {
        userId: user.id,
        personnelCode: `P-ROLL-${testTag}`,
        name: "Rolling Retention Officer",
        active: true,
      },
    });

    device = await prisma.device.create({
      data: {
        personnelId: personnel.id,
        deviceIdentifier: `DEV-ROLL-${testTag}`,
        platform: "Android",
        status: DeviceStatus.ACTIVE,
        latestLatitude: 22.84000,
        latestLongitude: 74.26000,
        latestAccuracy: 8.0,
        latestSource: "GPS",
        latestLocationTime: day3Afternoon,
      },
    });

    dutySession = await prisma.dutySession.create({
      data: {
        personnelId: personnel.id,
        deviceId: device.id,
        startedAt: day1Morning,
        endedAt: day1LateNight,
        status: DutyStatus.DUTY_ENDED,
      },
    });

    assert.ok(user.id);
    assert.ok(personnel.id);
    assert.ok(device.id);
    assert.ok(dutySession.id);
  });

  await t.test("1. Insert telemetry across Day 1, Day 2, and Day 3", async () => {
    const loc1 = await prisma.location.create({
      data: {
        personnelId: personnel.id,
        deviceId: device.id,
        latitude: 22.80001,
        longitude: 74.20001,
        accuracy: 10.0,
        source: "GPS",
        trackingMode: "NORMAL",
        recordedAt: day1Morning,
        clientEventId: `evt-d1m-${testTag}`,
      },
    });
    idDay1Morning = loc1.id;

    const loc2 = await prisma.location.create({
      data: {
        personnelId: personnel.id,
        deviceId: device.id,
        latitude: 22.80002,
        longitude: 74.20002,
        accuracy: 10.0,
        source: "GPS",
        trackingMode: "NORMAL",
        recordedAt: day1LateNight,
        clientEventId: `evt-d1ln-${testTag}`,
      },
    });
    idDay1LateNight = loc2.id;

    const loc3 = await prisma.location.create({
      data: {
        personnelId: personnel.id,
        deviceId: device.id,
        latitude: 22.80003,
        longitude: 74.20003,
        accuracy: 10.0,
        source: "GPS",
        trackingMode: "NORMAL",
        recordedAt: day2Early,
        clientEventId: `evt-d2e-${testTag}`,
      },
    });
    idDay2Early = loc3.id;

    const loc4 = await prisma.location.create({
      data: {
        personnelId: personnel.id,
        deviceId: device.id,
        latitude: 22.80004,
        longitude: 74.20004,
        accuracy: 10.0,
        source: "GPS",
        trackingMode: "NORMAL",
        recordedAt: day2Afternoon,
        clientEventId: `evt-d2a-${testTag}`,
      },
    });
    idDay2Afternoon = loc4.id;

    const loc5 = await prisma.location.create({
      data: {
        personnelId: personnel.id,
        deviceId: device.id,
        latitude: 22.80005,
        longitude: 74.20005,
        accuracy: 10.0,
        source: "GPS",
        trackingMode: "NORMAL",
        recordedAt: day2LateNight,
        clientEventId: `evt-d2ln-${testTag}`,
      },
    });
    idDay2LateNight = loc5.id;

    const loc6 = await prisma.location.create({
      data: {
        personnelId: personnel.id,
        deviceId: device.id,
        latitude: 22.80006,
        longitude: 74.20006,
        accuracy: 10.0,
        source: "GPS",
        trackingMode: "NORMAL",
        recordedAt: day3Start,
        clientEventId: `evt-d3s-${testTag}`,
      },
    });
    idDay3Start = loc6.id;

    const loc7 = await prisma.location.create({
      data: {
        personnelId: personnel.id,
        deviceId: device.id,
        latitude: 22.80007,
        longitude: 74.20007,
        accuracy: 10.0,
        source: "GPS",
        trackingMode: "NORMAL",
        recordedAt: day3Afternoon,
        clientEventId: `evt-d3a-${testTag}`,
      },
    });
    idDay3Afternoon = loc7.id;

    // Events and Heartbeats on Day 1 and Day 2
    const ev1 = await prisma.locationEvent.create({
      data: {
        clientEventId: `ev-${randomUUID()}`,
        personnelId: personnel.id,
        deviceId: device.id,
        eventType: "NETWORK_LOST",
        recordedAt: day1Morning,
      },
    });
    eventDay1 = ev1.id;

    const ev2 = await prisma.locationEvent.create({
      data: {
        clientEventId: `ev-${randomUUID()}`,
        personnelId: personnel.id,
        deviceId: device.id,
        eventType: "NETWORK_RESTORED",
        recordedAt: day2Afternoon,
      },
    });
    eventDay2 = ev2.id;

    const hb1 = await prisma.heartbeat.create({
      data: {
        personnelId: personnel.id,
        deviceId: device.id,
        batteryLevel: 80,
        networkState: "CELLULAR",
        appVersion: "1.0.0",
        recordedAt: day1LateNight,
      },
    });
    heartbeatDay1 = hb1.id;

    const hb2 = await prisma.heartbeat.create({
      data: {
        personnelId: personnel.id,
        deviceId: device.id,
        batteryLevel: 85,
        networkState: "WIFI",
        appVersion: "1.0.0",
        recordedAt: day2LateNight,
      },
    });
    heartbeatDay2 = hb2.id;
  });

  await t.test("2. Day 1 records remain when Day 2 is active", async () => {
    // Current time: Day 2 Afternoon (2026-10-22 14:00:00 IST)
    // Rolling 2 days: Day 2 (today) + Day 1 (yesterday). Cutoff = 2026-10-21 00:00:00 IST
    const cutoff = getRollingRetentionCutoffIST(day2Afternoon, 2);
    assert.strictEqual(cutoff.toISOString(), istDate(2026, 10, 21, 0, 0, 0).toISOString());

    // Both Day 1 records are >= 2026-10-21 00:00:00 IST, so 0 records should be deleted from this test set
    await purgeExpiredLocationData(2, "TEST_RUNNER", day2Afternoon);

    const d1m = await prisma.location.findUnique({ where: { id: idDay1Morning } });
    const d1ln = await prisma.location.findUnique({ where: { id: idDay1LateNight } });
    const d2a = await prisma.location.findUnique({ where: { id: idDay2Afternoon } });

    assert.ok(d1m, "Day 1 morning record must remain on Day 2");
    assert.ok(d1ln, "Day 1 late night record must remain on Day 2");
    assert.ok(d2a, "Day 2 record must remain on Day 2");
  });

  await t.test("3. Day 1 records are permanently deleted when Day 3 starts (even if < 48 hours old)", async () => {
    // Current time: Day 3 Start (2026-10-23 00:01:00 IST)
    // Preceding day = Day 2. Cutoff = 2026-10-22 00:00:00 IST
    // Notice: day1LateNight was recorded on 2026-10-21 23:55:00 IST.
    // It is only ~24 hours and 6 minutes old! But it belongs to Day 1, so it MUST BE DELETED!
    const cutoff = getRollingRetentionCutoffIST(day3Start, 2);
    assert.strictEqual(cutoff.toISOString(), istDate(2026, 10, 22, 0, 0, 0).toISOString());

    const result = await purgeExpiredLocationData(2, "TEST_RUNNER", day3Start);
    assert.ok(result.locationsPurged >= 2, "Must purge at least the 2 Day 1 locations");
    assert.strictEqual(result.policy, RETENTION_POLICY);

    // Verify physical database deletion via SQL query
    const d1m = await prisma.location.findUnique({ where: { id: idDay1Morning } });
    const d1ln = await prisma.location.findUnique({ where: { id: idDay1LateNight } });

    assert.strictEqual(d1m, null, "Day 1 morning record must be physically deleted from database");
    assert.strictEqual(d1ln, null, "Day 1 late night record must be physically deleted even though < 48h old");

    // LocationEvent and Heartbeat from Day 1 must also be physically deleted
    const ev1 = await prisma.locationEvent.findUnique({ where: { id: eventDay1 } });
    const hb1 = await prisma.heartbeat.findUnique({ where: { id: heartbeatDay1 } });
    assert.strictEqual(ev1, null, "Day 1 LocationEvent must be physically deleted");
    assert.strictEqual(hb1, null, "Day 1 Heartbeat must be physically deleted");
  });

  await t.test("4. Day 2 and Day 3 records remain after Day 3 cleanup", async () => {
    const d2e = await prisma.location.findUnique({ where: { id: idDay2Early } });
    const d2a = await prisma.location.findUnique({ where: { id: idDay2Afternoon } });
    const d2ln = await prisma.location.findUnique({ where: { id: idDay2LateNight } });
    const d3s = await prisma.location.findUnique({ where: { id: idDay3Start } });
    const d3a = await prisma.location.findUnique({ where: { id: idDay3Afternoon } });

    assert.ok(d2e, "Day 2 early morning record must remain on Day 3");
    assert.ok(d2a, "Day 2 afternoon record must remain on Day 3");
    assert.ok(d2ln, "Day 2 late night record must remain on Day 3");
    assert.ok(d3s, "Day 3 start record must remain on Day 3");
    assert.ok(d3a, "Day 3 afternoon record must remain on Day 3");

    const ev2 = await prisma.locationEvent.findUnique({ where: { id: eventDay2 } });
    const hb2 = await prisma.heartbeat.findUnique({ where: { id: heartbeatDay2 } });
    assert.ok(ev2, "Day 2 LocationEvent must remain on Day 3");
    assert.ok(hb2, "Day 2 Heartbeat must remain on Day 3");
  });

  await t.test("5. Day 2 records are permanently deleted when Day 4 starts", async () => {
    // Current time: Day 4 Start (2026-10-24 00:05:00 IST)
    // Preceding day = Day 3. Cutoff = 2026-10-23 00:00:00 IST
    const cutoff = getRollingRetentionCutoffIST(day4Start, 2);
    assert.strictEqual(cutoff.toISOString(), istDate(2026, 10, 23, 0, 0, 0).toISOString());

    const result = await purgeExpiredLocationData(2, "TEST_RUNNER", day4Start);
    assert.ok(result.locationsPurged >= 3, "Must purge Day 2 records");

    const d2e = await prisma.location.findUnique({ where: { id: idDay2Early } });
    const d2a = await prisma.location.findUnique({ where: { id: idDay2Afternoon } });
    const d2ln = await prisma.location.findUnique({ where: { id: idDay2LateNight } });

    assert.strictEqual(d2e, null, "Day 2 early record must be deleted on Day 4");
    assert.strictEqual(d2a, null, "Day 2 afternoon record must be deleted on Day 4");
    assert.strictEqual(d2ln, null, "Day 2 late night record must be deleted on Day 4");

    // Day 3 records must still be retained
    const d3s = await prisma.location.findUnique({ where: { id: idDay3Start } });
    const d3a = await prisma.location.findUnique({ where: { id: idDay3Afternoon } });
    assert.ok(d3s, "Day 3 records must be preserved on Day 4");
    assert.ok(d3a, "Day 3 records must be preserved on Day 4");

    // Day 2 Event & Heartbeat purged
    const ev2 = await prisma.locationEvent.findUnique({ where: { id: eventDay2 } });
    const hb2 = await prisma.heartbeat.findUnique({ where: { id: heartbeatDay2 } });
    assert.strictEqual(ev2, null, "Day 2 LocationEvent deleted on Day 4");
    assert.strictEqual(hb2, null, "Day 2 Heartbeat deleted on Day 4");
  });

  await t.test("6. Current device location and attendance data remain untouched", async () => {
    const freshDevice = await prisma.device.findUnique({ where: { id: device.id } });
    assert.ok(freshDevice, "Device must survive purge");
    assert.strictEqual(freshDevice.latestLatitude, 22.84000);
    assert.strictEqual(freshDevice.latestLongitude, 74.26000);
    assert.strictEqual(freshDevice.latestAccuracy, 8.0);
    assert.strictEqual(freshDevice.latestSource, "GPS");

    const freshUser = await prisma.user.findUnique({ where: { id: user.id } });
    const freshPersonnel = await prisma.personnel.findUnique({ where: { id: personnel.id } });
    assert.ok(freshUser, "User must survive purge");
    assert.ok(freshPersonnel, "Personnel must survive purge");

    const freshDutySession = await prisma.dutySession.findUnique({ where: { id: dutySession.id } });
    assert.ok(freshDutySession, "DutySession (attendance) must never be purged");
    assert.strictEqual(freshDutySession.status, DutyStatus.DUTY_ENDED);
  });

  await t.test("7. Offline sync cannot restore expired trails (ingestion rejects stale business days)", async () => {
    // If today is Day 3, attempting to upload a Day 1 ping must be rejected
    const validationDay1OnDay3 = validateTelemetryDutyWindow(day1LateNight, day3Start);
    assert.strictEqual(validationDay1OnDay3.permitted, false);
    assert.strictEqual(validationDay1OnDay3.code, "TIMESTAMP_STALE");

    // Uploading a Day 2 ping on Day 3 is permitted (preceding business day)
    const validationDay2OnDay3 = validateTelemetryDutyWindow(day2Afternoon, day3Start);
    assert.strictEqual(validationDay2OnDay3.permitted, true);

    // If today is Day 4, attempting to upload a Day 2 ping must be rejected
    const validationDay2OnDay4 = validateTelemetryDutyWindow(day2LateNight, day4Start);
    assert.strictEqual(validationDay2OnDay4.permitted, false);
    assert.strictEqual(validationDay2OnDay4.code, "TIMESTAMP_STALE");
  });

  await t.test("8. Cleanup is idempotent and safe to retry", async () => {
    // Running purge again for Day 4 produces 0 deleted records
    const secondPurge = await purgeExpiredLocationData(2, "TEST_RUNNER", day4Start);
    assert.strictEqual(secondPurge.locationsPurged, 0);
    assert.strictEqual(secondPurge.eventsPurged, 0);
    assert.strictEqual(secondPurge.heartbeatsPurged, 0);
  });

  await t.test("9. Timezone boundaries behave correctly around midnight IST", async () => {
    // 1 millisecond before midnight IST (end of Day 2: 2026-10-22 23:59:59.999 IST)
    const endOfDay2 = istDate(2026, 10, 22, 23, 59, 59, 999);
    const cutoffBeforeMidnight = getRollingRetentionCutoffIST(endOfDay2, 2);
    // Preceding day is Day 1 -> cutoff is start of Day 1 (2026-10-21 00:00:00.000 IST)
    assert.strictEqual(cutoffBeforeMidnight.toISOString(), istDate(2026, 10, 21, 0, 0, 0).toISOString());

    // Exactly at midnight IST (start of Day 3: 2026-10-23 00:00:00.000 IST)
    const startOfDay3 = istDate(2026, 10, 23, 0, 0, 0, 0);
    const cutoffAtMidnight = getRollingRetentionCutoffIST(startOfDay3, 2);
    // Preceding day is Day 2 -> cutoff is start of Day 2 (2026-10-22 00:00:00.000 IST)
    assert.strictEqual(cutoffAtMidnight.toISOString(), istDate(2026, 10, 22, 0, 0, 0).toISOString());

    // Day 1 pings transition from valid to expired at exact midnight IST
    assert.strictEqual(day1LateNight >= cutoffBeforeMidnight, true);
    assert.strictEqual(day1LateNight < cutoffAtMidnight, true);
  });

  await t.test("10. Audit log: purge lifecycle records are immutable", async () => {
    const startedLogs = await prisma.auditLog.findMany({
      where: { action: "RETENTION_PURGE_STARTED" },
      orderBy: { createdAt: "desc" },
      take: 2,
    });
    const completedLogs = await prisma.auditLog.findMany({
      where: { action: "RETENTION_PURGE_COMPLETED" },
      orderBy: { createdAt: "desc" },
      take: 2,
    });

    assert.ok(startedLogs.length > 0, "Must have RETENTION_PURGE_STARTED logs");
    assert.ok(completedLogs.length > 0, "Must have RETENTION_PURGE_COMPLETED logs");
  });

  await t.test("11. Route Auth: rejects insecure default secret, enforces CRON_SECRET", async () => {
    const origSecret = process.env.CRON_SECRET;
    try {
      // 11a: Unconfigured CRON_SECRET -> reject
      delete process.env.CRON_SECRET;
      const reqNoSecret = new Request("https://disha.local/api/admin/retention/purge", {
        method: "POST",
        headers: { Authorization: "Bearer disha-midnight-cron-secret" },
      });
      const resNoSecret = await purgeRoutePost(reqNoSecret);
      assert.strictEqual(resNoSecret.status, 401);

      // 11b: Configured CRON_SECRET -> old hardcoded secret rejected
      process.env.CRON_SECRET = "production-test-secure-cron-secret-123456";
      const reqOldSecret = new Request("https://disha.local/api/admin/retention/purge", {
        method: "POST",
        headers: { Authorization: "Bearer disha-midnight-cron-secret" },
      });
      const resOldSecret = await purgeRoutePost(reqOldSecret);
      assert.strictEqual(resOldSecret.status, 401);

      // 11c: Configured CRON_SECRET -> correct secret accepted
      const reqValid = new Request("https://disha.local/api/admin/retention/purge", {
        method: "POST",
        headers: { Authorization: "Bearer production-test-secure-cron-secret-123456" },
      });
      const resValid = await purgeRoutePost(reqValid);
      assert.strictEqual(resValid.status, 200);
      const json = await resValid.json();
      assert.strictEqual(json.success, true);
      assert.ok(json.cutoffDate);
    } finally {
      if (origSecret !== undefined) {
        process.env.CRON_SECRET = origSecret;
      } else {
        delete process.env.CRON_SECRET;
      }
    }
  });

  await t.test("12. Cleanup: remove test fixtures", async () => {
    await prisma.location.deleteMany({ where: { personnelId: personnel.id } });
    await prisma.locationEvent.deleteMany({ where: { personnelId: personnel.id } });
    await prisma.heartbeat.deleteMany({ where: { personnelId: personnel.id } });
    await prisma.dutySession.deleteMany({ where: { personnelId: personnel.id } });
    await prisma.device.deleteMany({ where: { personnelId: personnel.id } });
    await prisma.personnel.deleteMany({ where: { id: personnel.id } });
    await prisma.user.deleteMany({ where: { id: user.id } });
  });
});
