/**
 * DISHA 48-Hour Location Data Retention Policy Test Suite
 *
 * Tests the complete retention lifecycle:
 *   1. Physical deletion of GPS pings older than 48 hours
 *   2. Preservation of records within the 48-hour window
 *   3. Preservation of Device latest-position state after ping deletion
 *   4. Preservation of non-location records (User, Personnel, DutySession, etc.)
 *   5. Offline sync upload rejection for records beyond 48 hours
 *   6. Batch delete processing correctness
 *   7. Idempotency — running purge twice produces same result
 *   8. Audit log entries for purge lifecycle
 *   9. Route authentication security:
 *      - Rejection of former default secret ("disha-midnight-cron-secret")
 *      - Rejection when CRON_SECRET is unconfigured
 *      - Acceptance of valid configured secret
 *      - Rejection of invalid secret
 */

import test from "node:test";
import assert from "node:assert";
import { prisma } from "../src/lib/prisma";
import { DeviceStatus, UserStatus } from "../generated/prisma/enums";
import {
  purgeExpiredLocationData,
  MAX_LOCATION_RETENTION_HOURS,
} from "../src/services/retention/purge_service";
import { validateTelemetryDutyWindow } from "../src/lib/utils/duty_window";
import { POST as purgeRoutePost } from "../src/app/api/admin/retention/purge/route";

// ─── Test clock helpers ──────────────────────────────────────────────────────

/** Returns a Date that is exactly `hours` hours ago from now */
function hoursAgo(hours: number): Date {
  return new Date(Date.now() - hours * 60 * 60 * 1000);
}

/** Returns a Date that is exactly `minutes` minutes ago from now */
function minutesAgo(minutes: number): Date {
  return new Date(Date.now() - minutes * 60 * 1000);
}

// ─── Main test suite ─────────────────────────────────────────────────────────

test("DISHA 48-Hour Location Data Retention Test Suite", async (t) => {
  let user: any;
  let personnel: any;
  let device: any;

  // We insert locations directly via prisma so we can set arbitrary timestamps
  // without going through the ingestion service's 48h upload guard.
  const testTag = `RET-${Date.now()}`;

  await t.test("0. Setup isolated test fixtures", async () => {
    user = await prisma.user.create({
      data: {
        username: `ret_user_${testTag}`,
        passwordHash: "dummyHash",
        role: "FIELD_PERSONNEL",
        status: UserStatus.ACTIVE,
      },
    });

    personnel = await prisma.personnel.create({
      data: {
        userId: user.id,
        personnelCode: `P-RET-${testTag}`,
        name: "Retention Test Officer",
        active: true,
      },
    });

    device = await prisma.device.create({
      data: {
        personnelId: personnel.id,
        deviceIdentifier: `DEV-RET-${testTag}`,
        platform: "Android",
        status: DeviceStatus.ACTIVE,
        // Latest live position — must survive after historical pings are deleted
        latestLatitude: 22.84000,
        latestLongitude: 74.26000,
        latestAccuracy: 8.0,
        latestSource: "GPS",
        latestLocationTime: minutesAgo(5),
      },
    });

    assert.ok(user.id, "User must be created");
    assert.ok(personnel.id, "Personnel must be created");
    assert.ok(device.id, "Device must be created");
  });

  // ── Test 1: Insert records at various ages ─────────────────────────────────

  let expiredId1: string;
  let expiredId2: string;
  let expiredId3: string;
  let freshId1: string;
  let freshId2: string;
  let boundaryId: string;

  await t.test("1. Insert GPS pings at various timestamps", async () => {
    // 3 expired records: 72h, 60h, 49h ago
    const loc72h = await prisma.location.create({
      data: {
        clientEventId: `${testTag}-expired-72h`,
        personnelId: personnel.id,
        deviceId: device.id,
        latitude: 22.8000,
        longitude: 74.2500,
        accuracy: 10.0,
        recordedAt: hoursAgo(72),
        source: "GPS",
        trackingMode: "NORMAL",
      },
    });
    expiredId1 = loc72h.id;

    const loc60h = await prisma.location.create({
      data: {
        clientEventId: `${testTag}-expired-60h`,
        personnelId: personnel.id,
        deviceId: device.id,
        latitude: 22.8100,
        longitude: 74.2600,
        accuracy: 10.0,
        recordedAt: hoursAgo(60),
        source: "GPS",
        trackingMode: "NORMAL",
      },
    });
    expiredId2 = loc60h.id;

    const loc49h = await prisma.location.create({
      data: {
        clientEventId: `${testTag}-expired-49h`,
        personnelId: personnel.id,
        deviceId: device.id,
        latitude: 22.8200,
        longitude: 74.2700,
        accuracy: 10.0,
        recordedAt: hoursAgo(49),
        source: "GPS",
        trackingMode: "NORMAL",
      },
    });
    expiredId3 = loc49h.id;

    // 2 fresh records: 24h and 1h ago
    const loc24h = await prisma.location.create({
      data: {
        clientEventId: `${testTag}-fresh-24h`,
        personnelId: personnel.id,
        deviceId: device.id,
        latitude: 22.8300,
        longitude: 74.2800,
        accuracy: 8.0,
        recordedAt: hoursAgo(24),
        source: "GPS",
        trackingMode: "NORMAL",
      },
    });
    freshId1 = loc24h.id;

    const loc1h = await prisma.location.create({
      data: {
        clientEventId: `${testTag}-fresh-1h`,
        personnelId: personnel.id,
        deviceId: device.id,
        latitude: 22.8400,
        longitude: 74.2900,
        accuracy: 6.0,
        recordedAt: hoursAgo(1),
        source: "GPS",
        trackingMode: "NORMAL",
      },
    });
    freshId2 = loc1h.id;

    // Boundary: exactly 48h ago
    const loc48h = await prisma.location.create({
      data: {
        clientEventId: `${testTag}-boundary-48h`,
        personnelId: personnel.id,
        deviceId: device.id,
        latitude: 22.8250,
        longitude: 74.2750,
        accuracy: 9.0,
        recordedAt: hoursAgo(48),
        source: "GPS",
        trackingMode: "NORMAL",
      },
    });
    boundaryId = loc48h.id;

    const count = await prisma.location.count({
      where: { clientEventId: { startsWith: testTag } },
    });
    assert.strictEqual(count, 6, "All 6 test location records must exist before purge");
  });

  // ── Test 2: Insert expired LocationEvents and Heartbeats ──────────────────

  let expiredEventId: string;
  let freshEventId: string;
  let expiredHbId: string;
  let freshHbId: string;

  await t.test("2. Insert expired and fresh LocationEvents and Heartbeats", async () => {
    const expiredEvent = await prisma.locationEvent.create({
      data: {
        clientEventId: `${testTag}-evt-expired-60h`,
        eventType: "LOCATION_UNAVAILABLE",
        personnelId: personnel.id,
        deviceId: device.id,
        recordedAt: hoursAgo(60),
      },
    });
    expiredEventId = expiredEvent.id;

    const freshEvent = await prisma.locationEvent.create({
      data: {
        clientEventId: `${testTag}-evt-fresh-2h`,
        eventType: "LOCATION_RECOVERED",
        personnelId: personnel.id,
        deviceId: device.id,
        recordedAt: hoursAgo(2),
      },
    });
    freshEventId = freshEvent.id;

    const expiredHb = await prisma.heartbeat.create({
      data: {
        deviceId: device.id,
        personnelId: personnel.id,
        recordedAt: hoursAgo(55),
        receivedAt: hoursAgo(55),
        batteryLevel: 85.0,
        networkState: "WIFI",
      },
    });
    expiredHbId = expiredHb.id;

    const freshHb = await prisma.heartbeat.create({
      data: {
        deviceId: device.id,
        personnelId: personnel.id,
        recordedAt: minutesAgo(30),
        receivedAt: minutesAgo(30),
        batteryLevel: 72.0,
        networkState: "4G",
      },
    });
    freshHbId = freshHb.id;

    assert.ok(expiredEventId, "Expired LocationEvent must exist");
    assert.ok(freshEventId, "Fresh LocationEvent must exist");
    assert.ok(expiredHbId, "Expired Heartbeat must exist");
    assert.ok(freshHbId, "Fresh Heartbeat must exist");
  });

  // ── Test 3: Run the purge ──────────────────────────────────────────────────

  let purgeResult: any;

  await t.test("3. Execute the 48-hour retention purge job", async () => {
    purgeResult = await purgeExpiredLocationData(48, `TEST-${testTag}`);

    assert.ok(typeof purgeResult.locationsPurged === "number", "locationsPurged must be a number");
    assert.ok(typeof purgeResult.eventsPurged === "number", "eventsPurged must be a number");
    assert.ok(typeof purgeResult.heartbeatsPurged === "number", "heartbeatsPurged must be a number");
    assert.ok(purgeResult.cutoffDate, "cutoffDate must be returned");
    assert.ok(purgeResult.durationMs >= 0, "durationMs must be non-negative");

    assert.ok(
      purgeResult.locationsPurged >= 3,
      `Expected at least 3 expired locations deleted, got ${purgeResult.locationsPurged}`
    );
    assert.ok(
      purgeResult.eventsPurged >= 1,
      `Expected at least 1 expired LocationEvent deleted, got ${purgeResult.eventsPurged}`
    );
    assert.ok(
      purgeResult.heartbeatsPurged >= 1,
      `Expected at least 1 expired Heartbeat deleted, got ${purgeResult.heartbeatsPurged}`
    );
  });

  // ── Test 4: Verify expired records are physically gone ────────────────────

  await t.test(
    "4. Verify: expired GPS pings are physically deleted from the database",
    async () => {
      const loc72h = await prisma.location.findUnique({ where: { id: expiredId1 } });
      assert.strictEqual(
        loc72h,
        null,
        "Location 72h old must be physically deleted (not found in DB)"
      );

      const loc60h = await prisma.location.findUnique({ where: { id: expiredId2 } });
      assert.strictEqual(
        loc60h,
        null,
        "Location 60h old must be physically deleted (not found in DB)"
      );

      const loc49h = await prisma.location.findUnique({ where: { id: expiredId3 } });
      assert.strictEqual(
        loc49h,
        null,
        "Location 49h old must be physically deleted (not found in DB)"
      );

      const expiredEvent = await prisma.locationEvent.findUnique({
        where: { id: expiredEventId },
      });
      assert.strictEqual(
        expiredEvent,
        null,
        "Expired LocationEvent must be physically deleted"
      );

      const expiredHb = await prisma.heartbeat.findUnique({
        where: { id: expiredHbId },
      });
      assert.strictEqual(
        expiredHb,
        null,
        "Expired Heartbeat must be physically deleted"
      );
    }
  );

  // ── Test 5: Verify fresh records remain ───────────────────────────────────

  await t.test(
    "5. Verify: GPS pings within 48 hours remain in the database",
    async () => {
      const loc24h = await prisma.location.findUnique({ where: { id: freshId1 } });
      assert.ok(loc24h !== null, "Location 24h old must still exist after purge");

      const loc1h = await prisma.location.findUnique({ where: { id: freshId2 } });
      assert.ok(loc1h !== null, "Location 1h old must still exist after purge");

      const freshEvent = await prisma.locationEvent.findUnique({
        where: { id: freshEventId },
      });
      assert.ok(freshEvent !== null, "Fresh LocationEvent (2h old) must still exist");

      const freshHb = await prisma.heartbeat.findUnique({ where: { id: freshHbId } });
      assert.ok(freshHb !== null, "Fresh Heartbeat (30min old) must still exist");
    }
  );

  // ── Test 6: Live position state on Device is preserved ────────────────────

  await t.test(
    "6. Verify: Device latest live position is preserved even after historical pings are purged",
    async () => {
      const refreshedDevice = await prisma.device.findUnique({
        where: { id: device.id },
      });

      assert.ok(refreshedDevice !== null, "Device record must still exist");
      assert.ok(
        refreshedDevice!.latestLatitude !== null,
        "Device.latestLatitude must not be nulled by the purge"
      );
      assert.ok(
        refreshedDevice!.latestLongitude !== null,
        "Device.latestLongitude must not be nulled by the purge"
      );
      assert.strictEqual(
        refreshedDevice!.latestLatitude,
        22.84000,
        "Device.latestLatitude value must be unchanged"
      );
      assert.strictEqual(
        refreshedDevice!.latestLongitude,
        74.26000,
        "Device.latestLongitude value must be unchanged"
      );
      assert.strictEqual(
        refreshedDevice!.latestSource,
        "GPS",
        "Device.latestSource must be unchanged"
      );
    }
  );

  // ── Test 7: Non-location records are untouched ────────────────────────────

  await t.test(
    "7. Verify: Worker accounts (User, Personnel) and Device records are not deleted",
    async () => {
      const foundUser = await prisma.user.findUnique({ where: { id: user.id } });
      assert.ok(foundUser !== null, "User account must not be deleted by retention purge");

      const foundPersonnel = await prisma.personnel.findUnique({
        where: { id: personnel.id },
      });
      assert.ok(
        foundPersonnel !== null,
        "Personnel record must not be deleted by retention purge"
      );

      const foundDevice = await prisma.device.findUnique({ where: { id: device.id } });
      assert.ok(foundDevice !== null, "Device record must not be deleted by retention purge");
    }
  );

  // ── Test 8: Idempotency ───────────────────────────────────────────────────

  await t.test(
    "8. Idempotency: running the purge a second time does not delete fresh records",
    async () => {
      const secondResult = await purgeExpiredLocationData(48, `TEST-${testTag}-2nd`);

      const loc24h = await prisma.location.findUnique({ where: { id: freshId1 } });
      assert.ok(loc24h !== null, "24h-old Location must survive second purge run");

      const loc1h = await prisma.location.findUnique({ where: { id: freshId2 } });
      assert.ok(loc1h !== null, "1h-old Location must survive second purge run");
    }
  );

  // ── Test 9: Offline sync upload rejection beyond 48 hours ─────────────────

  await t.test(
    "9. Backend: rejects offline-sync uploads with timestamps older than 48 hours",
    async () => {
      const serverNow = new Date();

      const stale50h = validateTelemetryDutyWindow(hoursAgo(50), serverNow);
      assert.strictEqual(
        stale50h.permitted,
        false,
        "50h-old timestamp must be rejected (TIMESTAMP_STALE)"
      );
      assert.strictEqual(
        stale50h.code,
        "TIMESTAMP_STALE",
        "Rejection code must be TIMESTAMP_STALE"
      );

      const fresh47h = validateTelemetryDutyWindow(hoursAgo(47), serverNow);
      assert.strictEqual(
        fresh47h.permitted,
        true,
        "47h-old timestamp must still be accepted (within 48h window)"
      );
    }
  );

  // ── Test 10: Retention policy constant is 48 hours ────────────────────────

  await t.test(
    "10. Retention policy constant is enforced at exactly 48 hours",
    async () => {
      assert.strictEqual(
        MAX_LOCATION_RETENTION_HOURS,
        48,
        "MAX_LOCATION_RETENTION_HOURS must be exactly 48"
      );
    }
  );

  // ── Test 11: Audit log entries exist for the purge ────────────────────────

  await t.test(
    "11. Audit log: RETENTION_PURGE_STARTED and RETENTION_PURGE_COMPLETED entries exist",
    async () => {
      const auditEntries = await prisma.auditLog.findMany({
        where: {
          actorId: `TEST-${testTag}`,
          action: { in: ["RETENTION_PURGE_STARTED", "RETENTION_PURGE_COMPLETED"] },
        },
        orderBy: { createdAt: "asc" },
      });

      assert.ok(auditEntries.length >= 2, "Expected at least 2 audit entries");
    }
  );

  // ── Test 12: Route authentication security ────────────────────────────────

  await t.test(
    "12. Route Auth: rejects insecure default secret, enforces CRON_SECRET",
    async () => {
      const originalSecret = process.env.CRON_SECRET;

      try {
        // Sub-test A: Unconfigured CRON_SECRET rejects any bearer token
        delete process.env.CRON_SECRET;

        const reqOldDefault = new Request("http://localhost:3000/api/admin/retention/purge", {
          method: "POST",
          headers: {
            Authorization: "Bearer disha-midnight-cron-secret",
          },
        });
        const resOldDefault = await purgeRoutePost(reqOldDefault);
        assert.strictEqual(
          resOldDefault.status,
          401,
          "Former hardcoded default secret must return 401 when CRON_SECRET is unconfigured"
        );

        const reqNoAuth = new Request("http://localhost:3000/api/admin/retention/purge", {
          method: "POST",
        });
        const resNoAuth = await purgeRoutePost(reqNoAuth);
        assert.strictEqual(resNoAuth.status, 401, "Unauthenticated request must return 401");

        // Sub-test B: Configured CRON_SECRET enforces exact match with timingSafeEqual
        const testSecret = "test-secret-value-abcdef1234567890";
        process.env.CRON_SECRET = testSecret;

        // Former default secret must still be rejected
        const reqOldDefaultWithEnv = new Request("http://localhost:3000/api/admin/retention/purge", {
          method: "POST",
          headers: {
            Authorization: "Bearer disha-midnight-cron-secret",
          },
        });
        const resOldDefaultWithEnv = await purgeRoutePost(reqOldDefaultWithEnv);
        assert.strictEqual(
          resOldDefaultWithEnv.status,
          401,
          "Former default secret must return 401 even when CRON_SECRET is configured"
        );

        // Wrong secret must be rejected
        const reqWrong = new Request("http://localhost:3000/api/admin/retention/purge", {
          method: "POST",
          headers: {
            Authorization: "Bearer wrong-token-value",
          },
        });
        const resWrong = await purgeRoutePost(reqWrong);
        assert.strictEqual(resWrong.status, 401, "Mismatched token must return 401");

        // Matching secret must succeed
        const reqValid = new Request("http://localhost:3000/api/admin/retention/purge", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${testSecret}`,
          },
        });
        const resValid = await purgeRoutePost(reqValid);
        assert.strictEqual(resValid.status, 200, "Matching token must return 200");
        const bodyValid = await resValid.json();
        assert.strictEqual(bodyValid.success, true);
      } finally {
        if (originalSecret !== undefined) {
          process.env.CRON_SECRET = originalSecret;
        } else {
          delete process.env.CRON_SECRET;
        }
      }
    }
  );

  // ── Cleanup ──────────────────────────────────────────────────────────────

  await t.test("13. Cleanup: remove all test fixtures", async () => {
    await prisma.location.deleteMany({
      where: { clientEventId: { startsWith: testTag } },
    });

    await prisma.locationEvent.deleteMany({
      where: { clientEventId: { startsWith: testTag } },
    });

    await prisma.heartbeat.deleteMany({
      where: { deviceId: device.id },
    });

    await prisma.device.delete({ where: { id: device.id } }).catch(() => {});
    await prisma.personnel.delete({ where: { id: personnel.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
  });
});
