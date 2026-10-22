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

  // Enforce 50-second threshold for 1-minute interval testing
  process.env.TRAIL_RECORDING_INTERVAL_MS = "50000";

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

  await t.test("4. 1-minute deduplication: rapid updates within 1 min update Live Map without duplicate row", async () => {
    // Attempt 15 seconds after 02:00 (15s < 50s threshold)
    const t_base = new Date("2026-10-21T20:30:00.000Z");
    const t_rapid = new Date(t_base.getTime() + 15 * 1000);
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

  await t.test("8. Tracking across 02:00, 06:00, 19:00, 23:00, and midnight in Asia/Kolkata without stop or reset", async () => {
    // 02:00 IST (20:30 UTC previous day)
    const t0200 = new Date("2026-10-23T20:30:00.000Z");
    setMockDutyTime(t0200);
    const r0200 = await ingestSingleLocation(personnel.id, {
      clientEventId: randomUUID(),
      latitude: 22.8520,
      longitude: 74.2720,
      accuracy: 6.0,
      recordedAt: t0200,
      source: "GPS" as any,
    });
    assert.strictEqual(r0200.status, "accepted");

    // 06:00 IST (00:30 UTC)
    const t0600 = new Date("2026-10-24T00:30:00.000Z");
    setMockDutyTime(t0600);
    const r0600 = await ingestSingleLocation(personnel.id, {
      clientEventId: randomUUID(),
      latitude: 22.8530,
      longitude: 74.2730,
      accuracy: 5.5,
      recordedAt: t0600,
      source: "GPS" as any,
    });
    assert.strictEqual(r0600.status, "accepted");

    // 19:00 IST (13:30 UTC)
    const t1900 = new Date("2026-10-24T13:30:00.000Z");
    setMockDutyTime(t1900);
    const r1900 = await ingestSingleLocation(personnel.id, {
      clientEventId: randomUUID(),
      latitude: 22.8540,
      longitude: 74.2740,
      accuracy: 7.0,
      recordedAt: t1900,
      source: "GPS" as any,
    });
    assert.strictEqual(r1900.status, "accepted");

    // 23:00 IST (17:30 UTC)
    const t2300 = new Date("2026-10-24T17:30:00.000Z");
    setMockDutyTime(t2300);
    const r2300 = await ingestSingleLocation(personnel.id, {
      clientEventId: randomUUID(),
      latitude: 22.8550,
      longitude: 74.2750,
      accuracy: 6.5,
      recordedAt: t2300,
      source: "GPS" as any,
    });
    assert.strictEqual(r2300.status, "accepted");

    // Pre-midnight: 23:59:00 IST (18:29:00 UTC)
    const tPreMidnight = new Date("2026-10-24T18:29:00.000Z");
    setMockDutyTime(tPreMidnight);
    const rPre = await ingestSingleLocation(personnel.id, {
      clientEventId: randomUUID(),
      latitude: 22.8560,
      longitude: 74.2760,
      accuracy: 5.0,
      recordedAt: tPreMidnight,
      source: "GPS" as any,
    });
    assert.strictEqual(rPre.status, "accepted");

    // Post-midnight: 00:00:10 IST (18:30:10 UTC next day, 70s later)
    const tPostMidnight = new Date("2026-10-24T18:30:10.000Z");
    setMockDutyTime(tPostMidnight);
    const rPost = await ingestSingleLocation(personnel.id, {
      clientEventId: randomUUID(),
      latitude: 22.8565,
      longitude: 74.2765,
      accuracy: 5.5,
      recordedAt: tPostMidnight,
      source: "GPS" as any,
    });
    assert.strictEqual(rPost.status, "accepted");

    // Overview across midnight: worker remains active, fresh and ONLINE without reset
    const overview = await getDashboardOverview();
    const workerOverview = overview.find((p) => p.id === personnel.id);
    assert.ok(workerOverview);
    assert.strictEqual(workerOverview.deviceStatus, "ONLINE");
    assert.strictEqual(workerOverview.trackingStatus, "GPS ACTIVE");
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
