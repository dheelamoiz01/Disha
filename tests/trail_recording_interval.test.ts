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

test("1-Minute Location Trail Recording Interval Lifecycle", async (t) => {
  let user: any;
  let personnel: any;
  let device: any;

  // Enforce 50-second (50,000 ms) threshold for 1-minute sampling
  process.env.TRAIL_RECORDING_INTERVAL_MS = "50000";

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
        name: "Patrol Officer 1Min",
        personnelCode: `PC-1M-${Date.now()}`,
        designation: "Head Constable",
        unit: "Dahod Patrol",
        active: true,
      },
    });

    device = await prisma.device.create({
      data: {
        personnelId: personnel.id,
        deviceIdentifier: `DEV-1M-${Date.now()}`,
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

  await t.test("1. Initial fix (t = 0s) is persisted immediately as anchor point", async () => {
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

  await t.test("2. Rapid live map updates within interval (t = 10s and t = 25s) are deduplicated, not persisted in historical table", async () => {
    // Attempt at t = +10s (10s < 50s)
    const t10 = new Date(BASE_TIME.getTime() + 10 * 1000);
    setMockDutyTime(t10);
    const res1 = await ingestSingleLocation(personnel.id, {
      clientEventId: randomUUID(),
      latitude: 22.8340,
      longitude: 74.2565,
      accuracy: 9.5,
      recordedAt: t10,
      source: "GPS" as any,
      trackingMode: "NORMAL" as any,
      batteryLevel: 94.0,
    });
    assert.strictEqual(res1.status, "deduplicated");

    // Attempt at t = +25s (25s < 50s)
    const t25 = new Date(BASE_TIME.getTime() + 25 * 1000);
    setMockDutyTime(t25);
    const res2 = await ingestSingleLocation(personnel.id, {
      clientEventId: randomUUID(),
      latitude: 22.8345,
      longitude: 74.2570,
      accuracy: 10.0,
      recordedAt: t25,
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

  await t.test("3. Scheduled fix at t = 60s (60s >= 50s) is accepted and persisted as Point 2", async () => {
    const t60 = new Date(BASE_TIME.getTime() + 60 * 1000); // 1 minute later
    setMockDutyTime(t60);
    const res = await ingestSingleLocation(personnel.id, {
      clientEventId: randomUUID(),
      latitude: 22.8360,
      longitude: 74.2580,
      accuracy: 12.0, // Verified <= 20m
      recordedAt: t60,
      source: "GPS" as any,
      trackingMode: "NORMAL" as any,
      batteryLevel: 92.0,
    });

    assert.strictEqual(res.status, "accepted");
    assert.ok(res.locationId);

    const count = await prisma.location.count({ where: { personnelId: personnel.id } });
    assert.strictEqual(count, 2);
  });

  await t.test("4. Temporary signal loss (no fix at t=120s); next valid fix at t=240s records honest gap", async () => {
    // 3 minutes (180s) elapsed since Point 2 (t60) -> exceeds 3-minute gap threshold
    const t240 = new Date(BASE_TIME.getTime() + 240 * 1000);
    setMockDutyTime(t240);
    const res = await ingestSingleLocation(personnel.id, {
      clientEventId: randomUUID(),
      latitude: 22.8400,
      longitude: 74.2620,
      accuracy: 14.5, // Verified <= 20m
      recordedAt: t240,
      source: "GPS" as any,
      trackingMode: "NORMAL" as any,
      batteryLevel: 88.0,
    });

    assert.strictEqual(res.status, "accepted");

    const count = await prisma.location.count({ where: { personnelId: personnel.id } });
    assert.strictEqual(count, 3);
  });

  await t.test("5. Emergency SOS bypasses 1-minute interval gate and persists immediately", async () => {
    // Trigger SOS
    await prisma.sOSEvent.create({
      data: {
        clientEventId: randomUUID(),
        personnelId: personnel.id,
        deviceId: device.id,
        status: "ACTIVE",
        startedAt: new Date(BASE_TIME.getTime() + 245 * 1000),
      },
    });

    // 5 seconds after t240 (inside the 1-minute window)
    const t245 = new Date(BASE_TIME.getTime() + 245 * 1000);
    setMockDutyTime(t245);
    const res = await ingestSingleLocation(personnel.id, {
      clientEventId: randomUUID(),
      latitude: 22.8405,
      longitude: 74.2625,
      accuracy: 7.0,
      recordedAt: t245,
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

    // Next 1-minute fix at t=310s (65s after t245) while off duty
    const t310 = new Date(BASE_TIME.getTime() + 310 * 1000);
    setMockDutyTime(t310);
    const res = await ingestSingleLocation(personnel.id, {
      clientEventId: randomUUID(),
      latitude: 22.8450,
      longitude: 74.2650,
      accuracy: 6.5,
      recordedAt: t310,
      source: "GPS" as any,
      trackingMode: "NORMAL" as any,
      batteryLevel: 80.0,
    });

    assert.strictEqual(res.status, "accepted");
    const count = await prisma.location.count({ where: { personnelId: personnel.id } });
    assert.strictEqual(count, 5);
  });

  await t.test("7. Verify Trail analysis service reflects 1-minute sampling and 3-min gap", async () => {
    const trail = await getStaffLocationTrail(personnel.id, {
      dateStr: "2026-10-20",
    });

    assert.strictEqual(trail.personnel.id, personnel.id);
    assert.strictEqual(trail.locations.length, 5);

    // Point 1 (t=0s) to Point 2 (t=60s) time diff should be 1 minute
    const p0Time = new Date(trail.locations[0].recordedAt).getTime();
    const p1Time = new Date(trail.locations[1].recordedAt).getTime();
    const diffMin = (p1Time - p0Time) / 60000;
    assert.strictEqual(diffMin, 1);

    // Point 2 (t=60s) to Point 3 (t=240s) time diff is 3 minutes -> flagged as a tracking gap (>= 3 min)!
    assert.strictEqual(trail.summary.gapCount, 1);
    assert.strictEqual(trail.summary.longestGapMinutes, 3);
    assert.strictEqual(trail.trackingGaps.length, 1);
    assert.strictEqual(trail.trackingGaps[0].durationMinutes, 3);

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
