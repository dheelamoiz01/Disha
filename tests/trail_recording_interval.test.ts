import test from "node:test";
import assert from "node:assert";
import { randomUUID } from "node:crypto";
import { prisma } from "../src/lib/prisma";
import { startDuty, endDuty } from "../src/services/duty/duty_service";
import { DeviceStatus, UserStatus } from "../generated/prisma/enums";
import { ingestSingleLocation } from "../src/services/telemetry/ingestion_service";
import { getStaffLocationTrail } from "../src/services/control-room/trail_service";
import { getDashboardOverview } from "../src/services/control-room/dashboard_service";
import { setMockDutyTime } from "../src/lib/utils/duty_window";

test("30-Minute Location Trail Recording Interval Lifecycle", async (t) => {
  let user: any;
  let personnel: any;
  let device: any;

  // Enforce 27-minute (1,620,000 ms) threshold for 30-minute sampling
  process.env.TRAIL_RECORDING_INTERVAL_MS = "1620000";

  const BASE_TIME = new Date("2026-10-20T04:00:00.000Z"); // 09:30 IST
  setMockDutyTime(BASE_TIME);

  await t.test("Setup fixtures", async () => {
    user = await prisma.user.create({
      data: {
        username: `interval_user_${Date.now()}`,
        passwordHash: "hash",
        role: "FIELD_PERSONNEL",
        status: UserStatus.ACTIVE,
      },
    });

    personnel = await prisma.personnel.create({
      data: {
        userId: user.id,
        name: "Patrol Officer 30Min",
        personnelCode: `PC-30M-${Date.now()}`,
        designation: "Head Constable",
        unit: "Dahod Patrol",
        active: true,
      },
    });

    device = await prisma.device.create({
      data: {
        personnelId: personnel.id,
        deviceIdentifier: `DEV-30M-${Date.now()}`,
        platform: "Android",
        status: DeviceStatus.ACTIVE,
      },
    });
  });

  await t.test("Start duty session", async () => {
    const session = await startDuty(personnel.id, device.deviceIdentifier, user.id);
    assert.ok(session);
    assert.strictEqual(session.personnelId, personnel.id);
  });

  await t.test("1. Initial fix (t = 0m) is persisted immediately as anchor point", async () => {
    const t0 = new Date(BASE_TIME.getTime());
    setMockDutyTime(t0);
    const res = await ingestSingleLocation(personnel.id, {
      clientEventId: randomUUID(),
      latitude: 22.8333,
      longitude: 74.2562,
      accuracy: 8.0, // Optimal <= 10m
      recordedAt: t0,
      source: "GPS" as any,
      trackingMode: "NORMAL" as any,
      batteryLevel: 95.0,
      networkState: "4G",
    });

    assert.strictEqual(res.status, "accepted");
    assert.ok(res.locationId);

    const count = await prisma.location.count({ where: { personnelId: personnel.id } });
    assert.strictEqual(count, 1);
  });

  await t.test("2. Rapid live map updates within interval (t = 5m and t = 15m) are deduplicated, not persisted in historical table", async () => {
    // Attempt at t = +5 minutes (300s < 1620s)
    const t5 = new Date(BASE_TIME.getTime() + 5 * 60 * 1000);
    setMockDutyTime(t5);
    const res1 = await ingestSingleLocation(personnel.id, {
      clientEventId: randomUUID(),
      latitude: 22.8340,
      longitude: 74.2565,
      accuracy: 9.5,
      recordedAt: t5,
      source: "GPS" as any,
      trackingMode: "NORMAL" as any,
      batteryLevel: 94.0,
    });
    assert.strictEqual(res1.status, "deduplicated");

    // Attempt at t = +15 minutes (900s < 1620s)
    const t15 = new Date(BASE_TIME.getTime() + 15 * 60 * 1000);
    setMockDutyTime(t15);
    const res2 = await ingestSingleLocation(personnel.id, {
      clientEventId: randomUUID(),
      latitude: 22.8345,
      longitude: 74.2570,
      accuracy: 10.0,
      recordedAt: t15,
      source: "GPS" as any,
      trackingMode: "NORMAL" as any,
      batteryLevel: 93.0,
    });
    assert.strictEqual(res2.status, "deduplicated");

    // Live Device position was updated for Live Map!
    const dev = await prisma.device.findUnique({ where: { id: device.id } });
    assert.strictEqual(dev?.latestLatitude, 22.8345);
    assert.strictEqual(dev?.latestLongitude, 74.2570);

    // Database still has only 1 historical record!
    const count = await prisma.location.count({ where: { personnelId: personnel.id } });
    assert.strictEqual(count, 1);
  });

  await t.test("3. Scheduled fix at t = 30m (1800s >= 1620s) is accepted and persisted as Point 2", async () => {
    const t30 = new Date(BASE_TIME.getTime() + 30 * 60 * 1000); // 30 minutes later
    setMockDutyTime(t30);
    const res = await ingestSingleLocation(personnel.id, {
      clientEventId: randomUUID(),
      latitude: 22.8360,
      longitude: 74.2580,
      accuracy: 12.0, // Verified <= 20m
      recordedAt: t30,
      source: "GPS" as any,
      trackingMode: "NORMAL" as any,
      batteryLevel: 92.0,
    });

    assert.strictEqual(res.status, "accepted");
    assert.ok(res.locationId);

    const count = await prisma.location.count({ where: { personnelId: personnel.id } });
    assert.strictEqual(count, 2);
  });

  await t.test("4. Temporary signal loss (no fix at t=60m); next valid fix at t=90m records honest gap", async () => {
    // 60 minutes elapsed since Point 2 (t30)
    const t90 = new Date(BASE_TIME.getTime() + 90 * 60 * 1000);
    setMockDutyTime(t90);
    const res = await ingestSingleLocation(personnel.id, {
      clientEventId: randomUUID(),
      latitude: 22.8400,
      longitude: 74.2620,
      accuracy: 14.5, // Verified <= 20m
      recordedAt: t90,
      source: "GPS" as any,
      trackingMode: "NORMAL" as any,
      batteryLevel: 88.0,
    });

    assert.strictEqual(res.status, "accepted");

    const count = await prisma.location.count({ where: { personnelId: personnel.id } });
    assert.strictEqual(count, 3);
  });

  await t.test("5. Emergency SOS bypasses 30-minute interval gate and persists immediately", async () => {
    // Trigger SOS
    await prisma.sOSEvent.create({
      data: {
        clientEventId: randomUUID(),
        personnelId: personnel.id,
        deviceId: device.id,
        status: "ACTIVE",
        startedAt: new Date(BASE_TIME.getTime() + 90 * 60 * 1000 + 30 * 1000),
      },
    });

    // 30 seconds after t90 (inside the 30-minute window)
    const t90_30s = new Date(BASE_TIME.getTime() + 90 * 60 * 1000 + 30 * 1000);
    setMockDutyTime(t90_30s);
    const res = await ingestSingleLocation(personnel.id, {
      clientEventId: randomUUID(),
      latitude: 22.8405,
      longitude: 74.2625,
      accuracy: 7.0,
      recordedAt: t90_30s,
      source: "GPS" as any,
      trackingMode: "SOS" as any,
    });

    assert.strictEqual(res.status, "accepted");
    const count = await prisma.location.count({ where: { personnelId: personnel.id } });
    assert.strictEqual(count, 4);

    // Resolve SOS
    await prisma.sOSEvent.updateMany({
      where: { personnelId: personnel.id, status: "ACTIVE" },
      data: { status: "RESOLVED", endedAt: new Date() },
    });
  });

  await t.test("6. End duty session - off-duty location tracking continues 24x7", async () => {
    await endDuty(personnel.id, user.id);

    // Next 30-minute fix at t=125m while off duty
    const t125 = new Date(BASE_TIME.getTime() + 125 * 60 * 1000);
    setMockDutyTime(t125);
    const res = await ingestSingleLocation(personnel.id, {
      clientEventId: randomUUID(),
      latitude: 22.8450,
      longitude: 74.2650,
      accuracy: 6.5,
      recordedAt: t125,
      source: "GPS" as any,
      trackingMode: "NORMAL" as any,
      batteryLevel: 80.0,
    });

    assert.strictEqual(res.status, "accepted");
    const count = await prisma.location.count({ where: { personnelId: personnel.id } });
    assert.strictEqual(count, 5);
  });

  await t.test("7. Verify Trail analysis service reflects 30-minute sampling and 60-min gap", async () => {
    const trail = await getStaffLocationTrail(personnel.id, {
      dateStr: "2026-10-20",
    });

    assert.strictEqual(trail.personnel.id, personnel.id);
    assert.strictEqual(trail.locations.length, 5);

    // Point 1 (t=0m) to Point 2 (t=30m) time diff should be ~30 minutes
    const p0Time = new Date(trail.locations[0].recordedAt).getTime();
    const p1Time = new Date(trail.locations[1].recordedAt).getTime();
    const diffMin = (p1Time - p0Time) / 60000;
    assert.strictEqual(diffMin, 30);

    // Point 2 (t=30m) to Point 3 (t=90m) time diff is 60 minutes -> flagged as a tracking gap (> 35 min)!
    assert.strictEqual(trail.summary.gapCount, 1);
    assert.strictEqual(trail.summary.longestGapMinutes, 60);
    assert.strictEqual(trail.trackingGaps.length, 1);
    assert.strictEqual(trail.trackingGaps[0].durationMinutes, 60);

    // Accuracy ratings verified
    assert.strictEqual(trail.summary.totalPoints, 5);
    assert.strictEqual(trail.summary.verifiedPointsCount, 5); // 8m, 12m, 14.5m, 7m, 6.5m (all <= 20m)
  });

  await t.test("Cleanup test fixtures", async () => {
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
