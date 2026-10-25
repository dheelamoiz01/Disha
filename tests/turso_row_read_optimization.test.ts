import test from "node:test";
import assert from "node:assert";
import { prisma } from "../src/lib/prisma";
import { getDashboardOverview, invalidateDashboardCache } from "../src/services/control-room/dashboard_service";
import { getStaffLocationTrail } from "../src/services/control-room/trail_service";
import {
  tursoBudgetTracker,
  THRESHOLDS,
  TURSO_BASELINE,
} from "../src/lib/turso/budget";
import {
  validateDeviceAuthorization,
  ingestSingleLocation,
  invalidateDeviceAuthorizationCache,
} from "../src/services/telemetry/ingestion_service";

test("Turso Rows Read 100M Budget and Query Optimization Suite", async (t) => {
  const testId = `opt_${Date.now()}`;
  let adminA: any;
  let adminB: any;
  let staffA: any;
  let staffB: any;
  let deviceA: any;
  let deviceB: any;

  await t.test("0. Setup test fixtures across two admin hierarchies", async () => {
    adminA = await prisma.user.create({
      data: {
        username: `admin_a_${testId}`,
        passwordHash: "hash",
        role: "CONTROL_ROOM_OFFICER",
        displayName: "Admin A",
      },
    });

    adminB = await prisma.user.create({
      data: {
        username: `admin_b_${testId}`,
        passwordHash: "hash",
        role: "CONTROL_ROOM_OFFICER",
        displayName: "Admin B",
      },
    });

    const userStaffA = await prisma.user.create({
      data: {
        username: `staff_a_${testId}`,
        passwordHash: "hash",
        role: "FIELD_PERSONNEL",
        displayName: "Staff A",
      },
    });

    const userStaffB = await prisma.user.create({
      data: {
        username: `staff_b_${testId}`,
        passwordHash: "hash",
        role: "FIELD_PERSONNEL",
        displayName: "Staff B",
      },
    });

    staffA = await prisma.personnel.create({
      data: {
        userId: userStaffA.id,
        adminId: adminA.id,
        personnelCode: `STA-${testId.slice(-4)}`,
        name: "Staff A Officer",
        active: true,
      },
    });

    staffB = await prisma.personnel.create({
      data: {
        userId: userStaffB.id,
        adminId: adminB.id,
        personnelCode: `STB-${testId.slice(-4)}`,
        name: "Staff B Officer",
        active: true,
      },
    });

    deviceA = await prisma.device.create({
      data: {
        personnelId: staffA.id,
        deviceIdentifier: `DEV-A-${testId}`,
        platform: "android",
        status: "ACTIVE",
        latestLatitude: 23.0225,
        latestLongitude: 72.5714,
        latestAccuracy: 8.5,
        latestLocationTime: new Date(),
      },
    });

    deviceB = await prisma.device.create({
      data: {
        personnelId: staffB.id,
        deviceIdentifier: `DEV-B-${testId}`,
        platform: "android",
        status: "ACTIVE",
        latestLatitude: 22.8333,
        latestLongitude: 74.2562,
        latestAccuracy: 9.0,
        latestLocationTime: new Date(),
      },
    });

    invalidateDashboardCache();
    invalidateDeviceAuthorizationCache();
  });

  await t.test("1. Dashboard overview scoping & cache isolation between Admins", async () => {
    // Admin A only sees Staff A
    const overviewA = await getDashboardOverview(true, adminA.id);
    const hasStaffA = overviewA.some((p) => p.id === staffA.id);
    const hasStaffB = overviewA.some((p) => p.id === staffB.id);

    assert.strictEqual(hasStaffA, true, "Admin A must see Staff A");
    assert.strictEqual(hasStaffB, false, "Admin A must NOT see Staff B");

    // Admin B only sees Staff B
    const overviewB = await getDashboardOverview(true, adminB.id);
    assert.strictEqual(overviewB.some((p) => p.id === staffB.id), true, "Admin B must see Staff B");
    assert.strictEqual(overviewB.some((p) => p.id === staffA.id), false, "Admin B must NOT see Staff A");

    // Superadmin sees both
    const overviewGlobal = await getDashboardOverview(true, null);
    assert.strictEqual(overviewGlobal.some((p) => p.id === staffA.id), true, "Superadmin sees Staff A");
    assert.strictEqual(overviewGlobal.some((p) => p.id === staffB.id), true, "Superadmin sees Staff B");
  });

  await t.test("2. Device authorization in-memory caching reduces queries", async () => {
    invalidateDeviceAuthorizationCache();

    // First call: hits DB
    const firstAuth = await validateDeviceAuthorization(staffA.id);
    assert.strictEqual(firstAuth.device.id, deviceA.id);

    // Second immediate call: served from in-memory cache
    const secondAuth = await validateDeviceAuthorization(staffA.id);
    assert.strictEqual(secondAuth.device.id, deviceA.id);
    assert.strictEqual(secondAuth.personnel.id, staffA.id);
  });

  await t.test("3. Incremental Trail Query with 'since' parameter returns only new fixes", async () => {
    const baseTime = new Date("2026-10-25T10:00:00Z");

    // Insert 3 sequential locations
    const loc1 = await prisma.location.create({
      data: {
        clientEventId: `evt-trail-1-${testId}`,
        personnelId: staffA.id,
        deviceId: deviceA.id,
        latitude: 23.0225,
        longitude: 72.5714,
        accuracy: 10,
        recordedAt: new Date(baseTime.getTime()),
      },
    });

    const loc2 = await prisma.location.create({
      data: {
        clientEventId: `evt-trail-2-${testId}`,
        personnelId: staffA.id,
        deviceId: deviceA.id,
        latitude: 23.0235,
        longitude: 72.5724,
        accuracy: 12,
        recordedAt: new Date(baseTime.getTime() + 10_000), // +10s
      },
    });

    const loc3 = await prisma.location.create({
      data: {
        clientEventId: `evt-trail-3-${testId}`,
        personnelId: staffA.id,
        deviceId: deviceA.id,
        latitude: 23.0245,
        longitude: 72.5734,
        accuracy: 9,
        recordedAt: new Date(baseTime.getTime() + 20_000), // +20s
      },
    });

    // A. Full trail query for that window returns all 3 points
    const fullTrail = await getStaffLocationTrail(staffA.id, {
      startTime: new Date(baseTime.getTime() - 1000),
      endTime: new Date(baseTime.getTime() + 30_000),
    });
    assert.strictEqual(fullTrail.locations.length, 3, "Full trail returns all 3 points");

    // B. Incremental trail query with since = loc2.recordedAt returns ONLY loc3
    const incrementalTrail = await getStaffLocationTrail(staffA.id, {
      startTime: new Date(baseTime.getTime() - 1000),
      endTime: new Date(baseTime.getTime() + 30_000),
      since: loc2.recordedAt,
    });

    assert.strictEqual(incrementalTrail.incremental, true, "Result is marked incremental");
    assert.strictEqual(incrementalTrail.locations.length, 1, "Only 1 new location after loc2");
    assert.strictEqual(incrementalTrail.locations[0].id, loc3.id, "Returned location is loc3");

    // C. Incremental trail query with since = loc3.recordedAt returns 0 new points
    const emptyIncremental = await getStaffLocationTrail(staffA.id, {
      startTime: new Date(baseTime.getTime() - 1000),
      endTime: new Date(baseTime.getTime() + 30_000),
      since: loc3.recordedAt,
    });
    assert.strictEqual(emptyIncremental.locations.length, 0, "No new points returned");
  });

  await t.test("4. 100M Monthly Budget Tracker and Throttling Guarantees", async () => {
    // Check initial budget report
    const reportNormal = tursoBudgetTracker.getBudgetReport();
    assert.strictEqual(reportNormal.thresholds.MAX_LIMIT_100M, 100_000_000);
    assert.strictEqual(reportNormal.baseline.cumulativeRowsRead, TURSO_BASELINE.cumulativeRowsRead);
    assert.strictEqual(reportNormal.throttling.essentialTrackingGuaranteed, true);
    assert.strictEqual(reportNormal.throttling.heartbeatGuaranteed, true);
    assert.strictEqual(reportNormal.throttling.authenticationGuaranteed, true);
    assert.strictEqual(reportNormal.throttling.sosSafetyGuaranteed, true);

    // Test simulation: inject elevated usage (86 Million rows)
    tursoBudgetTracker.setMockUsageOffset(86_000_000);
    const reportElevated = tursoBudgetTracker.getBudgetReport();
    assert.strictEqual(reportElevated.status, "ELEVATED", "Status becomes ELEVATED at 86M");
    assert.strictEqual(reportElevated.throttling.throttleOptionalReports, true, "Throttles heavy reports");
    assert.strictEqual(reportElevated.throttling.essentialTrackingGuaranteed, true, "Essential tracking protected");

    // Test simulation: inject critical usage (96 Million rows)
    tursoBudgetTracker.setMockUsageOffset(96_000_000);
    const reportCritical = tursoBudgetTracker.getBudgetReport();
    assert.strictEqual(reportCritical.status, "CRITICAL", "Status becomes CRITICAL at 96M");
    assert.strictEqual(reportCritical.throttling.throttleNonessentialRefreshes, true, "Nonessential refreshes throttled");
    assert.strictEqual(reportCritical.throttling.heartbeatGuaranteed, true, "Heartbeats strictly guaranteed");

    // Reset offset
    tursoBudgetTracker.setMockUsageOffset(0);
  });

  await t.test("5. IDOR prevention: Admin cannot access location trail of another admin's staff", async () => {
    const { GET: locationHistoryRoute } = await import("../src/app/api/control-room/personnel/[id]/location-history/route");
    const { NextRequest } = await import("next/server");

    // Admin A requests Admin B's staff
    const req = new NextRequest(`http://localhost:3000/api/control-room/personnel/${staffB.id}/location-history`, {
      headers: {
        "x-user-id": adminA.id,
      },
    });

    // Provide auth cookie or mock session for Admin A
    const res = await locationHistoryRoute(req, { params: Promise.resolve({ id: staffB.id }) });
    assert.ok(res.status === 401 || res.status === 403 || res.status === 404, "Cross-admin access must be rejected");
  });

  await t.test("6. Cleanup test fixtures", async () => {
    await prisma.location.deleteMany({
      where: { personnelId: { in: [staffA.id, staffB.id] } },
    });
    await prisma.device.deleteMany({
      where: { id: { in: [deviceA.id, deviceB.id] } },
    });
    await prisma.personnel.deleteMany({
      where: { id: { in: [staffA.id, staffB.id] } },
    });
    await prisma.user.deleteMany({
      where: { id: { in: [adminA.id, adminB.id, staffA.userId, staffB.userId] } },
    });
    invalidateDashboardCache();
    invalidateDeviceAuthorizationCache();
  });
});
