import test from "node:test";
import assert from "node:assert";
import { randomUUID } from "node:crypto";
import { prisma } from "../src/lib/prisma";
import { DeviceStatus, UserStatus } from "../generated/prisma/enums";
import { ingestSingleLocation, ingestBatch, TelemetryError } from "../src/services/telemetry/ingestion_service";
import {
  setMockDutyTime,
  getDutyCurrentTime,
  isWithinDutyWindowIST,
  validateTelemetryDutyWindow,
} from "../src/lib/utils/duty_window";
import { getDashboardOverview } from "../src/services/control-room/dashboard_service";
import { getStaffLocationTrail } from "../src/services/control-room/trail_service";

test("Disha 24/7 Continuous Location Tracking Test Suite", async (t) => {
  let user: any;
  let personnel: any;
  let device: any;

  // Enforce 27-minute threshold for 30-minute interval testing
  process.env.TRAIL_RECORDING_INTERVAL_MS = "1620000";

  await t.test("Setup test fixtures", async () => {
    user = await prisma.user.create({
      data: {
        username: `duty_user_${Date.now()}`,
        passwordHash: "dummyHash",
        role: "FIELD_PERSONNEL",
        status: UserStatus.ACTIVE,
      },
    });

    personnel = await prisma.personnel.create({
      data: {
        userId: user.id,
        personnelCode: `P-DUTY-${Date.now()}`,
        name: "Patrol Officer 24x7",
        active: true,
      },
    });

    device = await prisma.device.create({
      data: {
        personnelId: personnel.id,
        deviceIdentifier: `DEV-DUTY-${Date.now()}`,
        platform: "Android",
        status: DeviceStatus.ACTIVE,
      },
    });
  });

  await t.test("1. 06:59 IST (early morning): location telemetry is accepted in 24x7 tracking mode", async () => {
    // 06:59:00 IST is 01:29:00 UTC
    const t_0659 = new Date("2026-10-21T01:29:00.000Z");
    setMockDutyTime(t_0659);

    assert.strictEqual(isWithinDutyWindowIST(t_0659), true, "06:59 IST must be permitted in 24x7 mode");

    const res = await ingestSingleLocation(personnel.id, {
      clientEventId: randomUUID(),
      latitude: 22.8333,
      longitude: 74.2562,
      accuracy: 8.0,
      recordedAt: t_0659,
      source: "GPS" as any,
      trackingMode: "NORMAL" as any,
    });

    assert.strictEqual(res.status, "accepted");
    assert.ok(res.locationId);

    const count = await prisma.location.count({ where: { personnelId: personnel.id } });
    assert.strictEqual(count, 1, "1 location row persisted at 06:59 IST");

    const dev = await prisma.device.findUnique({ where: { id: device.id } });
    assert.strictEqual(dev?.latestLatitude, 22.8333);
  });

  await t.test("2. 22:30 IST (late night): location telemetry is accepted without duty-hour restrictions", async () => {
    // 22:30:00 IST is 17:00:00 UTC (15.5 hours after Point 1)
    const t_2230 = new Date("2026-10-21T17:00:00.000Z");
    setMockDutyTime(t_2230);

    assert.strictEqual(isWithinDutyWindowIST(t_2230), true, "22:30 IST must be permitted in 24x7 mode");

    const res = await ingestSingleLocation(personnel.id, {
      clientEventId: randomUUID(),
      latitude: 22.8360,
      longitude: 74.2580,
      accuracy: 7.5,
      recordedAt: t_2230,
      source: "GPS" as any,
      trackingMode: "NORMAL" as any,
    });

    assert.strictEqual(res.status, "accepted");
    assert.ok(res.locationId);

    const count = await prisma.location.count({ where: { personnelId: personnel.id } });
    assert.strictEqual(count, 2, "2 location rows persisted");
  });

  await t.test("3. 02:00 IST next day (overnight): telemetry continues 24x7", async () => {
    // 02:00:00 IST is 20:30:00 UTC on 2026-10-21
    const t_0200 = new Date("2026-10-21T20:30:00.000Z");
    setMockDutyTime(t_0200);

    const res = await ingestSingleLocation(personnel.id, {
      clientEventId: randomUUID(),
      latitude: 22.8400,
      longitude: 74.2600,
      accuracy: 9.0,
      recordedAt: t_0200,
      source: "GPS" as any,
      trackingMode: "NORMAL" as any,
    });

    assert.strictEqual(res.status, "accepted");

    const count = await prisma.location.count({ where: { personnelId: personnel.id } });
    assert.strictEqual(count, 3);
  });

  await t.test("4. 30-minute deduplication: rapid updates within 30 min update Live Map without duplicate row", async () => {
    // Attempt 10 minutes after t_0200 (600s < 1620s threshold)
    const t_rapid = new Date("2026-10-21T20:40:00.000Z");
    setMockDutyTime(t_rapid);

    const res = await ingestSingleLocation(personnel.id, {
      clientEventId: randomUUID(),
      latitude: 22.8415,
      longitude: 74.2610,
      accuracy: 8.5,
      recordedAt: t_rapid,
      source: "GPS" as any,
      trackingMode: "NORMAL" as any,
    });

    assert.strictEqual(res.status, "deduplicated");

    // Live Map coordinates on Device table are updated to rapid fix
    const dev = await prisma.device.findUnique({ where: { id: device.id } });
    assert.strictEqual(dev?.latestLatitude, 22.8415);
    assert.strictEqual(dev?.latestLongitude, 74.2610);

    // Database still has 3 historical rows
    const count = await prisma.location.count({ where: { personnelId: personnel.id } });
    assert.strictEqual(count, 3);
  });

  await t.test("5. Future timestamp (> 5 min skew) is rejected with FUTURE_TIMESTAMP", async () => {
    const serverNow = new Date("2026-10-21T21:00:00.000Z");
    setMockDutyTime(serverNow);

    const futureTime = new Date(serverNow.getTime() + 10 * 60 * 1000); // 10 minutes ahead

    await assert.rejects(
      async () => {
        await ingestSingleLocation(personnel.id, {
          clientEventId: randomUUID(),
          latitude: 22.8450,
          longitude: 74.2650,
          accuracy: 5.0,
          recordedAt: futureTime,
          source: "GPS" as any,
          trackingMode: "NORMAL" as any,
        });
      },
      (err: any) => {
        assert.ok(err instanceof TelemetryError);
        assert.strictEqual(err.code, "FUTURE_TIMESTAMP");
        return true;
      }
    );
  });

  await t.test("6. Batch ingestion functions 24x7 across multiple hours", async () => {
    const tBatchBase = new Date("2026-10-22T02:00:00.000Z"); // 07:30 IST Day 2
    setMockDutyTime(tBatchBase);

    const batchRes = await ingestBatch(personnel.id, {
      locations: [
        {
          clientEventId: randomUUID(),
          latitude: 22.8500,
          longitude: 74.2700,
          accuracy: 6.0,
          recordedAt: new Date(tBatchBase.getTime() - 60 * 60 * 1000), // 1 hour ago
          source: "GPS" as any,
        },
        {
          clientEventId: randomUUID(),
          latitude: 22.8510,
          longitude: 74.2710,
          accuracy: 7.0,
          recordedAt: tBatchBase,
          source: "GPS" as any,
        },
      ],
    });

    assert.ok(batchRes.locations.length === 2);
    assert.strictEqual(batchRes.locations[0].status, "accepted");
    assert.strictEqual(batchRes.locations[1].status, "accepted");

    // Device updated to freshest batch point
    const dev = await prisma.device.findUnique({ where: { id: device.id } });
    assert.strictEqual(dev?.latestLatitude, 22.8510);
  });

  await t.test("7. Legacy restricted hours mode: when ENFORCE_RESTRICTED_HOURS=1, off-hour fixes are blocked", async () => {
    try {
      process.env.ENFORCE_RESTRICTED_HOURS = "1";
      const t_night = new Date("2026-10-22T18:00:00.000Z"); // 23:30 IST
      setMockDutyTime(t_night);

      const val = validateTelemetryDutyWindow(t_night, t_night);
      assert.strictEqual(val.permitted, false);
      assert.strictEqual(val.code, "DUTY_WINDOW_CLOSED");
    } finally {
      delete process.env.ENFORCE_RESTRICTED_HOURS;
    }
  });

  await t.test("Cleanup test fixtures and reset mock clock", async () => {
    setMockDutyTime(null);
    delete process.env.TRAIL_RECORDING_INTERVAL_MS;
    await prisma.location.deleteMany({ where: { personnelId: personnel.id } });
    await prisma.sOSEvent.deleteMany({ where: { personnelId: personnel.id } });
    await prisma.dutySession.deleteMany({ where: { personnelId: personnel.id } });
    await prisma.device.deleteMany({ where: { personnelId: personnel.id } });
    await prisma.personnel.delete({ where: { id: personnel.id } });
    await prisma.user.delete({ where: { id: user.id } });
  });
});
