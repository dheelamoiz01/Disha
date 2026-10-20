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

test("Disha 24/7 Location Enabled, Duty-Hours-Only Server Tracking Test Suite", async (t) => {
  let user: any;
  let personnel: any;
  let device: any;

  // Use 4.5-minute threshold for 5-minute trail testing
  process.env.TRAIL_RECORDING_INTERVAL_MS = "270000";

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

  await t.test("1. 06:59 IST: no location upload or trail persistence (blocked)", async () => {
    // 06:59:00 IST is 01:29:00 UTC
    const t_0659 = new Date("2026-10-21T01:29:00.000Z");
    setMockDutyTime(t_0659);

    assert.strictEqual(isWithinDutyWindowIST(t_0659), false, "06:59 IST must be outside duty window");

    // Attempting to ingest location at 06:59 IST must throw TelemetryError with code DUTY_WINDOW_CLOSED
    await assert.rejects(
      async () => {
        await ingestSingleLocation(personnel.id, {
          clientEventId: randomUUID(),
          latitude: 22.8333,
          longitude: 74.2562,
          accuracy: 8.0,
          recordedAt: t_0659,
          source: "GPS" as any,
          trackingMode: "NORMAL" as any,
        });
      },
      (err: any) => {
        assert.ok(err instanceof TelemetryError);
        assert.strictEqual(err.code, "DUTY_WINDOW_CLOSED");
        return true;
      }
    );

    // Confirm 0 location rows were persisted in the database
    const count = await prisma.location.count({ where: { personnelId: personnel.id } });
    assert.strictEqual(count, 0, "No location rows must be written at 06:59 IST");

    // Confirm Device latest position was not overwritten
    const dev = await prisma.device.findUnique({ where: { id: device.id } });
    assert.strictEqual(dev?.latestLatitude, null, "Device latest position must remain null");
  });

  await t.test("2. 07:00 IST: automatic duty-window activation", async () => {
    // 07:00:00 IST is 01:30:00 UTC
    const t_0700 = new Date("2026-10-21T01:30:00.000Z");
    setMockDutyTime(t_0700);

    assert.strictEqual(isWithinDutyWindowIST(t_0700), true, "07:00 IST must activate duty window");

    // Ingest initial duty fix
    const res = await ingestSingleLocation(personnel.id, {
      clientEventId: randomUUID(),
      latitude: 22.8333,
      longitude: 74.2562,
      accuracy: 8.0,
      recordedAt: t_0700,
      source: "GPS" as any,
      trackingMode: "NORMAL" as any,
      batteryLevel: 98.0,
      networkState: "4G",
    });

    assert.strictEqual(res.status, "accepted");
    assert.ok(res.locationId);

    // Verify exactly 1 historical point in DB
    const count = await prisma.location.count({ where: { personnelId: personnel.id } });
    assert.strictEqual(count, 1);

    // Verify automatic duty session was created for today
    const activeSession = await prisma.dutySession.findFirst({
      where: { personnelId: personnel.id, endedAt: null },
    });
    assert.ok(activeSession, "Automatic duty session should be created at 07:00 IST");
    assert.strictEqual(activeSession?.status, "DUTY_STARTED");

    // Verify Dashboard overview reflects ON DUTY & TRACKING ACTIVE
    const overview = await getDashboardOverview(true);
    const p = overview.find((item) => item.id === personnel.id);
    assert.ok(p);
    assert.strictEqual(p.dutyStatus, "ON DUTY");
    assert.strictEqual(p.locationStatus, "TRACKING ACTIVE");
  });

  await t.test("3. 07:05 IST: a valid trail point may be saved if sampling gate permits (5-min interval)", async () => {
    // 07:05:00 IST is 01:35:00 UTC (300 seconds after t_0700)
    const t_0705 = new Date("2026-10-21T01:35:00.000Z");
    setMockDutyTime(t_0705);

    // First rapid ping at 07:02 (120s < 270s) should be deduplicated
    const t_0702 = new Date("2026-10-21T01:32:00.000Z");
    const resDedup = await ingestSingleLocation(personnel.id, {
      clientEventId: randomUUID(),
      latitude: 22.8340,
      longitude: 74.2565,
      accuracy: 9.0,
      recordedAt: t_0702,
      source: "GPS" as any,
      trackingMode: "NORMAL" as any,
    });
    assert.strictEqual(resDedup.status, "deduplicated");

    // Scheduled fix at 07:05 (300s >= 270s) should be accepted as Point 2
    const resPoint2 = await ingestSingleLocation(personnel.id, {
      clientEventId: randomUUID(),
      latitude: 22.8350,
      longitude: 74.2570,
      accuracy: 9.5,
      recordedAt: t_0705,
      source: "GPS" as any,
      trackingMode: "NORMAL" as any,
    });
    assert.strictEqual(resPoint2.status, "accepted");

    const count = await prisma.location.count({ where: { personnelId: personnel.id } });
    assert.strictEqual(count, 2, "Point 2 persisted after 5-min gate");
  });

  await t.test("4. 21:59 IST: eligible location uploads and trail recording continue", async () => {
    // 21:59:00 IST is 16:29:00 UTC
    const t_2159 = new Date("2026-10-21T16:29:00.000Z");
    setMockDutyTime(t_2159);

    assert.strictEqual(isWithinDutyWindowIST(t_2159), true, "21:59 IST is within duty window");

    const res = await ingestSingleLocation(personnel.id, {
      clientEventId: randomUUID(),
      latitude: 22.8450,
      longitude: 74.2650,
      accuracy: 10.0,
      recordedAt: t_2159,
      source: "GPS" as any,
      trackingMode: "NORMAL" as any,
    });

    assert.strictEqual(res.status, "accepted");
    const count = await prisma.location.count({ where: { personnelId: personnel.id } });
    assert.strictEqual(count, 3, "Point 3 persisted at 21:59 IST");
  });

  await t.test("5. 22:00 IST: uploads and trail persistence are blocked", async () => {
    // 22:00:00 IST is 16:30:00 UTC
    const t_2200 = new Date("2026-10-21T16:30:00.000Z");
    setMockDutyTime(t_2200);

    assert.strictEqual(isWithinDutyWindowIST(t_2200), false, "22:00 IST must close duty window");

    // Ingestion at 22:00 must fail
    await assert.rejects(
      async () => {
        await ingestSingleLocation(personnel.id, {
          clientEventId: randomUUID(),
          latitude: 22.8455,
          longitude: 74.2655,
          accuracy: 11.0,
          recordedAt: t_2200,
          source: "GPS" as any,
          trackingMode: "NORMAL" as any,
        });
      },
      (err: any) => {
        assert.ok(err instanceof TelemetryError);
        assert.strictEqual(err.code, "DUTY_WINDOW_CLOSED");
        return true;
      }
    );

    // Database count remains at 3
    const count = await prisma.location.count({ where: { personnelId: personnel.id } });
    assert.strictEqual(count, 3, "No location rows written at 22:00 IST");
  });

  await t.test("6. 22:30 IST: no overnight coordinates are uploaded or stored; dashboard marks STALE", async () => {
    // 22:30:00 IST is 17:00:00 UTC
    const t_2230 = new Date("2026-10-21T17:00:00.000Z");
    setMockDutyTime(t_2230);

    assert.strictEqual(isWithinDutyWindowIST(t_2230), false, "22:30 IST must be outside duty window");

    await assert.rejects(
      async () => {
        await ingestSingleLocation(personnel.id, {
          clientEventId: randomUUID(),
          latitude: 22.8460,
          longitude: 74.2660,
          accuracy: 12.0,
          recordedAt: t_2230,
          source: "GPS" as any,
          trackingMode: "NORMAL" as any,
        });
      },
      (err: any) => {
        assert.strictEqual(err.code, "DUTY_WINDOW_CLOSED");
        return true;
      }
    );

    // Check dashboard outside duty window
    const overview = await getDashboardOverview(true);
    const p = overview.find((item) => item.id === personnel.id);
    assert.ok(p);
    assert.strictEqual(p.dutyStatus, "OFF DUTY", "Off-duty overnight status displayed");
    assert.strictEqual(p.locationStatus, "STALE", "Location status must be STALE outside duty hours");
    assert.ok(p.location, "Last permitted location marker remains available");
    assert.strictEqual(p.location?.latitude, 22.8450, "Marker preserves 21:59 position");
  });

  await t.test("7. 06:59 next day: still blocked", async () => {
    // 06:59:00 IST next day (2026-10-22T01:29:00.000Z)
    const t_next0659 = new Date("2026-10-22T01:29:00.000Z");
    setMockDutyTime(t_next0659);

    assert.strictEqual(isWithinDutyWindowIST(t_next0659), false, "06:59 next day is still blocked");

    await assert.rejects(
      async () => {
        await ingestSingleLocation(personnel.id, {
          clientEventId: randomUUID(),
          latitude: 22.8500,
          longitude: 74.2700,
          accuracy: 10.0,
          recordedAt: t_next0659,
          source: "GPS" as any,
          trackingMode: "NORMAL" as any,
        });
      },
      (err: any) => {
        assert.strictEqual(err.code, "DUTY_WINDOW_CLOSED");
        return true;
      }
    );

    const count = await prisma.location.count({ where: { personnelId: personnel.id } });
    assert.strictEqual(count, 3, "No overnight locations stored");
  });

  await t.test("8. 07:00 next day: tracking resumes automatically without manual toggle", async () => {
    // 07:00:00 IST next day (2026-10-22T01:30:00.000Z)
    const t_next0700 = new Date("2026-10-22T01:30:00.000Z");
    setMockDutyTime(t_next0700);

    assert.strictEqual(isWithinDutyWindowIST(t_next0700), true, "07:00 next day resumes duty window");

    const res = await ingestSingleLocation(personnel.id, {
      clientEventId: randomUUID(),
      latitude: 22.8510,
      longitude: 74.2710,
      accuracy: 7.5,
      recordedAt: t_next0700,
      source: "GPS" as any,
      trackingMode: "NORMAL" as any,
    });

    assert.strictEqual(res.status, "accepted");
    assert.ok(res.locationId);

    const count = await prisma.location.count({ where: { personnelId: personnel.id } });
    assert.strictEqual(count, 4, "Day 2 anchor point accepted automatically");

    // Previous day session should be cleanly ended, and today's session created
    const activeSessions = await prisma.dutySession.findMany({
      where: { personnelId: personnel.id, endedAt: null },
    });
    assert.strictEqual(activeSessions.length, 1, "Exactly 1 active session for today");
    assert.strictEqual(
      activeSessions[0].startedAt.toISOString(),
      t_next0700.toISOString()
    );
  });

  await t.test("9. Requests with stale, delayed, queued, or manipulated timestamps cannot bypass backend enforcement", async () => {
    // Current time: 07:15 IST (2026-10-22T01:45:00.000Z)
    const t_now = new Date("2026-10-22T01:45:00.000Z");
    setMockDutyTime(t_now);

    // Scenario A: Client sends overnight fix recorded at 03:00 AM (hour 3 outside duty window)
    const overnightFixTime = new Date("2026-10-21T21:30:00.000Z"); // 03:00 IST
    await assert.rejects(
      async () => {
        await ingestSingleLocation(personnel.id, {
          clientEventId: randomUUID(),
          latitude: 22.8550,
          longitude: 74.2750,
          accuracy: 5.0,
          recordedAt: overnightFixTime,
          source: "GPS" as any,
          trackingMode: "NORMAL" as any,
        });
      },
      (err: any) => {
        assert.ok(err.code === "DUTY_WINDOW_CLOSED" || err.code === "TIMESTAMP_STALE");
        return true;
      }
    );

    // Scenario B: Client attempts to send fix from yesterday at 21:50 IST (older than 15 mins)
    const yesterdayFixTime = new Date("2026-10-21T16:20:00.000Z"); // yesterday 21:50 IST
    await assert.rejects(
      async () => {
        await ingestSingleLocation(personnel.id, {
          clientEventId: randomUUID(),
          latitude: 22.8550,
          longitude: 74.2750,
          accuracy: 5.0,
          recordedAt: yesterdayFixTime,
          source: "GPS" as any,
          trackingMode: "NORMAL" as any,
        });
      },
      (err: any) => {
        assert.strictEqual(err.code, "TIMESTAMP_STALE");
        return true;
      }
    );

    // Scenario C: Batch ingestion with queued points containing an overnight fix
    const batchResult = await ingestBatch(personnel.id, {
      locations: [
        {
          clientEventId: randomUUID(),
          latitude: 22.8520,
          longitude: 74.2720,
          accuracy: 8.0,
          recordedAt: "2026-10-21T22:30:00.000Z", // 04:00 AM overnight
          source: "GPS",
          trackingMode: "NORMAL",
        },
      ],
    });

    assert.strictEqual(batchResult.locations.length, 1);
    assert.strictEqual((batchResult.locations[0] as any).status, "rejected");
  });

  await t.test("10. Existing Trail History analysis works correctly with duty-window segmented sessions", async () => {
    // Day 1: 2026-10-21 (contains points 1, 2, 3)
    const trailDay1 = await getStaffLocationTrail(personnel.id, { dateStr: "2026-10-21" });
    assert.strictEqual(trailDay1.locations.length, 3, "Day 1 trail has exactly 3 points");
    assert.strictEqual(trailDay1.summary.totalPoints, 3);

    // Day 2: 2026-10-22 (contains point 4)
    const trailDay2 = await getStaffLocationTrail(personnel.id, { dateStr: "2026-10-22" });
    assert.strictEqual(trailDay2.locations.length, 1, "Day 2 trail has exactly 1 point");
    assert.strictEqual(trailDay2.summary.totalPoints, 1);
  });

  await t.test("Cleanup test fixtures and reset mock clock", async () => {
    setMockDutyTime(null);
    await prisma.location.deleteMany({ where: { personnelId: personnel.id } });
    await prisma.dutySession.deleteMany({ where: { personnelId: personnel.id } });
    await prisma.device.deleteMany({ where: { personnelId: personnel.id } });
    await prisma.personnel.delete({ where: { id: personnel.id } });
    await prisma.user.delete({ where: { id: user.id } });
  });
});
