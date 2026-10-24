import test from "node:test";
import assert from "node:assert";
import { randomUUID } from "crypto";
import { prisma } from "../src/lib/prisma";
import { generateDeviceCredential } from "../src/lib/auth/device_auth";
import { startDuty } from "../src/services/duty/duty_service";
import { getDashboardOverview } from "../src/services/control-room/dashboard_service";
import { fetchStaffList } from "../src/services/staff/staff_service";
import { UserStatus, DeviceStatus, UserRole } from "../generated/prisma/enums";
import { POST as heartbeatRoute } from "../src/app/api/telemetry/heartbeat/route";
import { GET as sseRoute } from "../src/app/api/control-room/overview/sse/route";
import { NextRequest } from "next/server";

process.env.DISABLE_DUTY_WINDOW = "1";

test("Field Personnel Heartbeat & Automatic Sync Verification Suite", async (t) => {
  let user: any;
  let personnel: any;
  let device: any;
  let token: string;
  let adminUser: any;
  let adminToken: string;

  await t.test("0. Setup isolated personnel & device fixtures", async () => {
    const { createSession } = await import("../src/lib/auth/session");

    // Admin user for SSE / Live Map queries
    adminUser = await prisma.user.create({
      data: {
        username: `admin_live_${Date.now()}`,
        passwordHash: "dummyHash",
        role: UserRole.SP,
        status: UserStatus.ACTIVE,
        permissions: JSON.stringify(["LIVE_MAP"]),
      },
    });
    const adminSess = await createSession(adminUser.id);
    adminToken = adminSess.token;

    user = await prisma.user.create({
      data: {
        username: `sync_worker_${Date.now()}`,
        passwordHash: "dummyHash",
        role: "FIELD_PERSONNEL",
        status: UserStatus.ACTIVE,
      },
    });
    personnel = await prisma.personnel.create({
      data: {
        userId: user.id,
        personnelCode: `SYNC_${Date.now()}`,
        name: "Test Field Sync Worker",
        active: true,
      },
    });
    device = await prisma.device.create({
      data: {
        personnelId: personnel.id,
        deviceIdentifier: `dev_sync_${Date.now()}`,
        platform: "Android",
        status: DeviceStatus.ACTIVE,
      },
    });
    token = await generateDeviceCredential(device.id);
  });

  await t.test("1. A successful heartbeat marks a connected person online (server-generated timestamp)", async () => {
    // Send heartbeat with client timestamp 10 minutes in past to test server timestamp enforcement
    const clientOldTime = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const req = new Request("http://localhost:3000/api/telemetry/heartbeat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        personnelId: personnel.id,
        batteryLevel: 85,
        networkState: "WIFI",
        recordedAt: clientOldTime,
      }),
    });

    const res = await heartbeatRoute(req);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.status, "accepted");

    // Device lastHeartbeatAt must be fresh server time (now), not clientOldTime
    const updatedDev = await prisma.device.findUnique({ where: { id: device.id } });
    assert.ok(updatedDev?.lastHeartbeatAt);
    const ageDiff = Math.abs(Date.now() - updatedDev.lastHeartbeatAt.getTime());
    assert.ok(ageDiff < 5000, `lastHeartbeatAt (${updatedDev.lastHeartbeatAt.toISOString()}) must be within 5s of server now`);

    const overview = await getDashboardOverview(true);
    const item = overview.find((o) => o.id === personnel.id);
    assert.ok(item);
    assert.strictEqual(item.deviceStatus, "ONLINE");
    assert.strictEqual(item.networkStatus, "ONLINE");
  });

  await t.test("2. Missing heartbeats eventually produce stale/offline status", async () => {
    // Stale test (>90s)
    const twoMinsAgo = new Date(Date.now() - 120 * 1000);
    await prisma.device.update({
      where: { id: device.id },
      data: { lastHeartbeatAt: twoMinsAgo, lastSeenAt: twoMinsAgo },
    });

    const overviewStale = await getDashboardOverview(true);
    const itemStale = overviewStale.find((o) => o.id === personnel.id);
    assert.ok(itemStale);
    assert.strictEqual(itemStale.deviceStatus, "STALE");

    // Offline test (>180s / 3 mins)
    const fourMinsAgo = new Date(Date.now() - 240 * 1000);
    await prisma.device.update({
      where: { id: device.id },
      data: { lastHeartbeatAt: fourMinsAgo, lastSeenAt: fourMinsAgo },
    });

    const overviewOffline = await getDashboardOverview(true);
    const itemOffline = overviewOffline.find((o) => o.id === personnel.id);
    assert.ok(itemOffline);
    assert.strictEqual(itemOffline.deviceStatus, "OFFLINE");
    assert.strictEqual(itemOffline.networkStatus, "OFFLINE");
  });

  await t.test("3. A returning connection automatically restores online status", async () => {
    const req = new Request("http://localhost:3000/api/telemetry/heartbeat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        personnelId: personnel.id,
        batteryLevel: 80,
        networkState: "CELLULAR",
        recordedAt: new Date().toISOString(),
      }),
    });

    const res = await heartbeatRoute(req);
    assert.strictEqual(res.status, 200);

    const overview = await getDashboardOverview(true);
    const item = overview.find((o) => o.id === personnel.id);
    assert.ok(item);
    assert.strictEqual(item.deviceStatus, "ONLINE");
    assert.strictEqual(item.networkStatus, "ONLINE");
  });

  await t.test("4. Duty status remains independent of connectivity status", async () => {
    // Start duty
    await startDuty(personnel.id, device.deviceIdentifier, user.id);

    // Expire heartbeat to simulate network loss while on duty
    const fourMinsAgo = new Date(Date.now() - 240 * 1000);
    await prisma.device.update({
      where: { id: device.id },
      data: { lastHeartbeatAt: fourMinsAgo, lastSeenAt: fourMinsAgo },
    });

    const overview = await getDashboardOverview(true);
    const item = overview.find((o) => o.id === personnel.id);
    assert.ok(item);
    // Duty remains ON DUTY
    assert.strictEqual(item.dutyStatus, "ON DUTY");
    // Connectivity status reflects actual OFFLINE
    assert.strictEqual(item.deviceStatus, "OFFLINE");
    assert.strictEqual(item.networkStatus, "OFFLINE");
  });

  await t.test("5. Repeated heartbeats do not cause excessive database writes (no Heartbeat table bloat)", async () => {
    const initialHeartbeatRows = await prisma.heartbeat.count({ where: { personnelId: personnel.id } });

    // Send 5 rapid heartbeats
    for (let i = 0; i < 5; i++) {
      const req = new Request("http://localhost:3000/api/telemetry/heartbeat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          personnelId: personnel.id,
          batteryLevel: 75 - i,
          networkState: "WIFI",
          recordedAt: new Date().toISOString(),
        }),
      });
      const res = await heartbeatRoute(req);
      assert.strictEqual(res.status, 200);
    }

    const finalHeartbeatRows = await prisma.heartbeat.count({ where: { personnelId: personnel.id } });
    // Zero new rows in Heartbeat table; Device is updated directly in-place
    assert.strictEqual(finalHeartbeatRows, initialHeartbeatRows);
  });

  await t.test("6. Admin SSE streaming endpoint connects and streams live overview", async () => {
    const sseReq = new NextRequest("http://localhost:3000/api/control-room/overview/sse", {
      headers: {
        Accept: "text/event-stream",
        Cookie: `disha_session=${adminToken}`,
      },
    });

    const sseRes = await sseRoute(sseReq);
    assert.strictEqual(sseRes.status, 200);
    assert.ok(sseRes.headers.get("content-type")?.includes("text/event-stream"));

    // Verify stream yields valid data chunk
    const reader = sseRes.body?.getReader();
    assert.ok(reader);
    const { value, done } = await reader.read();
    assert.strictEqual(done, false);
    const text = new TextDecoder().decode(value);
    assert.ok(text.startsWith("data: "));
    const parsedData = JSON.parse(text.replace("data: ", "").trim());
    assert.ok(Array.isArray(parsedData));
    await reader.cancel();
  });

  await t.test("7. Offline batch flush immediately restores device ONLINE status", async () => {
    // Set device to OFFLINE
    const fiveMinsAgo = new Date(Date.now() - 300 * 1000);
    await prisma.device.update({
      where: { id: device.id },
      data: { lastHeartbeatAt: fiveMinsAgo, lastSeenAt: fiveMinsAgo },
    });

    const { ingestBatch } = await import("../src/services/telemetry/ingestion_service");
    await ingestBatch(personnel.id, {
      locations: [
        {
          clientEventId: `test-sync-batch-${Date.now()}`,
          latitude: 22.84,
          longitude: 74.26,
          accuracy: 6.0,
          recordedAt: new Date(),
          source: "GPS",
          batteryLevel: 70,
          networkState: "CELLULAR",
        },
      ],
    });

    const overview = await getDashboardOverview(true);
    const item = overview.find((o) => o.id === personnel.id);
    assert.ok(item);
    assert.strictEqual(item.deviceStatus, "ONLINE");
    assert.strictEqual(item.trackingStatus, "GPS ACTIVE");
  });

  await t.test("8. Cleanup test fixtures", async () => {
    delete process.env.DISABLE_DUTY_WINDOW;
    await prisma.heartbeat.deleteMany({ where: { personnelId: personnel.id } });
    await prisma.location.deleteMany({ where: { personnelId: personnel.id } });
    await prisma.locationEvent.deleteMany({ where: { personnelId: personnel.id } });
    await prisma.dutySession.deleteMany({ where: { personnelId: personnel.id } });
    await prisma.deviceCredential.deleteMany({ where: { deviceId: device.id } });
    await prisma.device.deleteMany({ where: { id: device.id } });
    await prisma.personnel.deleteMany({ where: { id: personnel.id } });
    await prisma.user.deleteMany({ where: { id: { in: [user.id, adminUser.id] } } });
  });
});
