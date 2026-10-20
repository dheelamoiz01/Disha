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

test("5-Minute Location Trail Recording Interval Lifecycle", async (t) => {
  let user: any;
  let personnel: any;
  let device: any;

  // Enforce 4.5-minute (270s) interval threshold for 5-minute sampling
  process.env.TRAIL_RECORDING_INTERVAL_MS = "270000";

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
        name: "Patrol Officer 5Min",
        personnelCode: `PC-5M-${Date.now()}`,
        designation: "Head Constable",
        unit: "Dahod Patrol",
        active: true,
      },
    });

    device = await prisma.device.create({
      data: {
        personnelId: personnel.id,
        deviceIdentifier: `DEV-5M-${Date.now()}`,
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

  await t.test("1. Initial duty fix (t = 0m) is persisted immediately as anchor point", async () => {
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

  await t.test("2. Rapid updates within interval (t = 1m and t = 3m) are deduplicated, not persisted", async () => {
    // Attempt at t = +1 minute (60s < 270s)
    const t1 = new Date(BASE_TIME.getTime() + 60 * 1000);
    setMockDutyTime(t1);
    const res1 = await ingestSingleLocation(personnel.id, {
      clientEventId: randomUUID(),
      latitude: 22.8340,
      longitude: 74.2565,
      accuracy: 9.5,
      recordedAt: t1,
      source: "GPS" as any,
      trackingMode: "NORMAL" as any,
      batteryLevel: 94.0,
    });
    assert.strictEqual(res1.status, "deduplicated");

    // Attempt at t = +3 minutes (180s < 270s)
    const t3 = new Date(BASE_TIME.getTime() + 180 * 1000);
    setMockDutyTime(t3);
    const res2 = await ingestSingleLocation(personnel.id, {
      clientEventId: randomUUID(),
      latitude: 22.8345,
      longitude: 74.2570,
      accuracy: 10.0,
      recordedAt: t3,
      source: "GPS" as any,
      trackingMode: "NORMAL" as any,
      batteryLevel: 93.0,
    });
    assert.strictEqual(res2.status, "deduplicated");

    // Database still has only 1 historical record!
    const count = await prisma.location.count({ where: { personnelId: personnel.id } });
    assert.strictEqual(count, 1);
  });

  await t.test("3. Scheduled fix at t = 5m (300s >= 270s) is accepted and persisted as Point 2", async () => {
    const t5 = new Date(BASE_TIME.getTime() + 300 * 1000); // exactly 5 minutes later
    setMockDutyTime(t5);
    const res = await ingestSingleLocation(personnel.id, {
      clientEventId: randomUUID(),
      latitude: 22.8360,
      longitude: 74.2580,
      accuracy: 12.0, // Verified <= 20m
      recordedAt: t5,
      source: "GPS" as any,
      trackingMode: "NORMAL" as any,
      batteryLevel: 92.0,
    });

    assert.strictEqual(res.status, "accepted");
    assert.ok(res.locationId);

    const count = await prisma.location.count({ where: { personnelId: personnel.id } });
    assert.strictEqual(count, 2);
  });

  await t.test("4. Temporary signal loss (no fix at t=10m); next valid fix at t=15m records honest gap", async () => {
    // 10 minutes elapsed since Point 2 (t5)
    const t15 = new Date(BASE_TIME.getTime() + 15 * 60 * 1000);
    setMockDutyTime(t15);
    const res = await ingestSingleLocation(personnel.id, {
      clientEventId: randomUUID(),
      latitude: 22.8400,
      longitude: 74.2620,
      accuracy: 14.5, // Verified <= 20m
      recordedAt: t15,
      source: "GPS" as any,
      trackingMode: "NORMAL" as any,
      batteryLevel: 88.0,
    });

    assert.strictEqual(res.status, "accepted");

    const count = await prisma.location.count({ where: { personnelId: personnel.id } });
    assert.strictEqual(count, 3);
  });

  await t.test("5. Emergency SOS bypasses interval gate and persists immediately", async () => {
    // Trigger SOS
    await prisma.sOSEvent.create({
      data: {
        clientEventId: randomUUID(),
        personnelId: personnel.id,
        deviceId: device.id,
        status: "ACTIVE",
        startedAt: new Date(BASE_TIME.getTime() + 15 * 60 * 1000 + 30 * 1000),
      },
    });

    // 30 seconds after t15 (inside the 5-minute window)
    const t15_30s = new Date(BASE_TIME.getTime() + 15 * 60 * 1000 + 30 * 1000);
    setMockDutyTime(t15_30s);
    const res = await ingestSingleLocation(personnel.id, {
      clientEventId: randomUUID(),
      latitude: 22.8405,
      longitude: 74.2625,
      accuracy: 7.0,
      recordedAt: t15_30s,
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

  await t.test("6. Verify Trail analysis service reflects 5-minute sampling and gap", async () => {
    const trail = await getStaffLocationTrail(personnel.id, {
      dateStr: "2026-10-20",
    });

    assert.strictEqual(trail.personnel.id, personnel.id);
    assert.strictEqual(trail.locations.length, 4);

    // Point 1 (t=0m) to Point 2 (t=5m) time diff should be ~300s (5 minutes)
    const p0Time = new Date(trail.locations[0].recordedAt).getTime();
    const p1Time = new Date(trail.locations[1].recordedAt).getTime();
    const diffMin = (p1Time - p0Time) / 60000;
    assert.strictEqual(diffMin, 5);

    // Point 2 (t=5m) to Point 3 (t=15m) time diff should be 10 minutes -> flagged as a gap!
    assert.strictEqual(trail.summary.gapCount, 1);
    assert.strictEqual(trail.summary.longestGapMinutes, 10);
    assert.strictEqual(trail.trackingGaps.length, 1);
    assert.strictEqual(trail.trackingGaps[0].durationMinutes, 10);

    // Accuracy ratings verified
    assert.strictEqual(trail.summary.totalPoints, 4);
    assert.strictEqual(trail.summary.verifiedPointsCount, 4); // 8m, 12m, 14.5m, 7m (all <= 20m)
  });

  await t.test("7. End duty session", async () => {
    await endDuty(personnel.id, user.id);
  });

  await t.test("Cleanup test fixtures", async () => {
    setMockDutyTime(null);
    await prisma.location.deleteMany({ where: { personnelId: personnel.id } });
    await prisma.sOSEvent.deleteMany({ where: { personnelId: personnel.id } });
    await prisma.dutySession.deleteMany({ where: { personnelId: personnel.id } });
    await prisma.device.deleteMany({ where: { personnelId: personnel.id } });
    await prisma.personnel.delete({ where: { id: personnel.id } });
    await prisma.user.delete({ where: { id: user.id } });
  });
});
