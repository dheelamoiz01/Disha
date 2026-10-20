import test from "node:test";
import assert from "node:assert";
import { randomUUID } from "crypto";
import { prisma } from "../src/lib/prisma";
import { generateDeviceCredential } from "../src/lib/auth/device_auth";
import { createSession } from "../src/lib/auth/session";
import { startDuty } from "../src/services/duty/duty_service";
import { getDashboardOverview } from "../src/services/control-room/dashboard_service";
import { fetchStaffList } from "../src/services/staff/staff_service";
import { UserStatus, DeviceStatus } from "../generated/prisma/enums";

process.env.DISABLE_DUTY_WINDOW = "1";

test("Automatic Worker Inactivity and Sign-Out Lifecycle", async (t) => {
  let userA: any;
  let personnelA: any;
  let deviceA: any;
  let tokenA: string;
  let sessionA: any;

  let userB: any;
  let personnelB: any;
  let deviceB: any;
  let tokenB: string;

  await t.test("Setup test fixtures", async () => {
    // Worker A
    userA = await prisma.user.create({
      data: {
        username: `worker_a_${Date.now()}`,
        passwordHash: "hashA",
        role: "FIELD_PERSONNEL",
        status: UserStatus.ACTIVE,
      },
    });
    personnelA = await prisma.personnel.create({
      data: {
        userId: userA.id,
        personnelCode: `P_A_${Date.now()}`,
        name: "Worker Alpha",
        active: true,
      },
    });
    deviceA = await prisma.device.create({
      data: {
        personnelId: personnelA.id,
        deviceIdentifier: `dev_alpha_${Date.now()}`,
        platform: "Android",
        status: DeviceStatus.ACTIVE,
      },
    });
    tokenA = await generateDeviceCredential(deviceA.id);
    const sessionRes = await createSession(userA.id, "TestAgent", "127.0.0.1");
    sessionA = sessionRes.session;

    // Worker B (for security isolation test)
    userB = await prisma.user.create({
      data: {
        username: `worker_b_${Date.now()}`,
        passwordHash: "hashB",
        role: "FIELD_PERSONNEL",
        status: UserStatus.ACTIVE,
      },
    });
    personnelB = await prisma.personnel.create({
      data: {
        userId: userB.id,
        personnelCode: `P_B_${Date.now()}`,
        name: "Worker Beta",
        active: true,
      },
    });
    deviceB = await prisma.device.create({
      data: {
        personnelId: personnelB.id,
        deviceIdentifier: `dev_beta_${Date.now()}`,
        platform: "Android",
        status: DeviceStatus.ACTIVE,
      },
    });
    tokenB = await generateDeviceCredential(deviceB.id);
  });

  await t.test("Initial state: with no heartbeats, device status is OFFLINE", async () => {
    const overview = await getDashboardOverview();
    const item = overview.find((o) => o.id === personnelA.id);
    assert.ok(item);
    assert.strictEqual(item.deviceStatus, "OFFLINE");
    assert.strictEqual(item.networkStatus, "OFFLINE");
    assert.strictEqual(item.dutyStatus, "OFF DUTY");
  });

  await t.test("Incoming fresh heartbeat marks device ONLINE automatically", async () => {
    // Record fresh heartbeat (now)
    await prisma.heartbeat.create({
      data: {
        deviceId: deviceA.id,
        personnelId: personnelA.id,
        batteryLevel: 94.0,
        networkState: "WIFI",
        recordedAt: new Date(),
      },
    });
    await prisma.device.update({
      where: { id: deviceA.id },
      data: { status: "ACTIVE", lastSeenAt: new Date() },
    });

    const overview = await getDashboardOverview();
    const item = overview.find((o) => o.id === personnelA.id);
    assert.ok(item);
    assert.strictEqual(item.deviceStatus, "ONLINE");
    assert.strictEqual(item.networkStatus, "ONLINE");

    const staff = await fetchStaffList();
    const staffItem = staff.find((s) => s.id === personnelA.id);
    assert.ok(staffItem);
    assert.strictEqual(staffItem.connectionStatus, "ONLINE");
  });

  await t.test("Heartbeat timeout (>2 mins) marks device connection OFFLINE server-side", async () => {
    // Backdate all heartbeats for worker A to 3 minutes ago
    const threeMinsAgo = new Date(Date.now() - 3 * 60 * 1000);
    await prisma.heartbeat.updateMany({
      where: { personnelId: personnelA.id },
      data: { recordedAt: threeMinsAgo },
    });
    await prisma.device.update({
      where: { id: deviceA.id },
      data: { lastSeenAt: threeMinsAgo },
    });

    const overview = await getDashboardOverview();
    const item = overview.find((o) => o.id === personnelA.id);
    assert.ok(item);
    assert.strictEqual(item.deviceStatus, "OFFLINE");
    assert.strictEqual(item.networkStatus, "OFFLINE");

    const staff = await fetchStaffList();
    const staffItem = staff.find((s) => s.id === personnelA.id);
    assert.ok(staffItem);
    assert.strictEqual(staffItem.connectionStatus, "OFFLINE");
  });

  await t.test("Separation of Duty Status from Connection Status", async () => {
    // Worker starts duty
    await startDuty(personnelA.id, deviceA.deviceIdentifier, userA.id);

    // Ingest a fresh location telemetry fix
    await prisma.location.create({
      data: {
        clientEventId: randomUUID(),
        deviceId: deviceA.id,
        personnelId: personnelA.id,
        latitude: 19.076,
        longitude: 72.8777,
        accuracy: 8.5,
        recordedAt: new Date(),
      },
    });

    // Heartbeat remains expired (>2 mins ago, so device connection is OFFLINE)
    const overview = await getDashboardOverview();
    const item = overview.find((o) => o.id === personnelA.id);
    assert.ok(item);

    // CRITICAL: Duty status is preserved as ON DUTY
    assert.strictEqual(item.dutyStatus, "ON DUTY");
    // While device connectivity is truthfully OFFLINE
    assert.strictEqual(item.deviceStatus, "OFFLINE");
    assert.strictEqual(item.networkStatus, "OFFLINE");
    // And location is marked STALE because device connectivity is OFFLINE even if the fix timestamp was recent
    assert.strictEqual(item.locationStatus, "STALE");
  });

  await t.test("Reconnection recovery: new heartbeat automatically restores ONLINE status", async () => {
    // New fresh heartbeat arrives
    await prisma.heartbeat.create({
      data: {
        deviceId: deviceA.id,
        personnelId: personnelA.id,
        batteryLevel: 88.0,
        networkState: "CELLULAR",
        recordedAt: new Date(),
      },
    });
    await prisma.device.update({
      where: { id: deviceA.id },
      data: { status: "ACTIVE", lastSeenAt: new Date() },
    });

    const overview = await getDashboardOverview();
    const item = overview.find((o) => o.id === personnelA.id);
    assert.ok(item);
    assert.strictEqual(item.deviceStatus, "ONLINE");
    assert.strictEqual(item.networkStatus, "ONLINE");
    assert.strictEqual(item.dutyStatus, "ON DUTY");
  });

  await t.test("Security: worker B cannot sign out worker A's device", async () => {
    const { POST: signoutHandler } = await import("../src/app/api/device/signout/route");
    const req = new Request("http://localhost:3000/api/device/signout", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenB}`,
      },
      body: JSON.stringify({
        personnelId: personnelA.id, // Worker B trying to sign out Worker A
        deviceIdentifier: deviceA.deviceIdentifier,
      }),
    });

    const res = await signoutHandler(req);
    assert.strictEqual(res.status, 403);
  });

  await t.test("Explicit worker sign-out revokes session & credentials and sets connection INACTIVE", async () => {
    const { POST: signoutHandler } = await import("../src/app/api/device/signout/route");
    const req = new Request("http://localhost:3000/api/device/signout", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({
        personnelId: personnelA.id,
        deviceIdentifier: deviceA.deviceIdentifier,
      }),
    });

    const res = await signoutHandler(req);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.status, "INACTIVE");

    // 1. Check credential is deactivated
    const cred = await prisma.deviceCredential.findFirst({
      where: { deviceId: deviceA.id, isActive: true },
    });
    assert.strictEqual(cred, null); // All credentials inactive

    // 2. Check user session is revoked
    const sess = await prisma.session.findUnique({
      where: { id: sessionA.id },
    });
    assert.ok(sess!.revokedAt !== null);

    // 3. Check device status in DB is INACTIVE
    const dev = await prisma.device.findUnique({
      where: { id: deviceA.id },
    });
    assert.strictEqual(dev!.status, "INACTIVE");

    // 4. Check dashboard overview immediately reflects OFFLINE without page reload
    const overview = await getDashboardOverview();
    const item = overview.find((o) => o.id === personnelA.id);
    assert.ok(item);
    assert.strictEqual(item.deviceStatus, "OFFLINE");
    assert.strictEqual(item.networkStatus, "OFFLINE");
  });

  await t.test("Cleanup test fixtures", async () => {
    delete process.env.DISABLE_DUTY_WINDOW;
    await prisma.heartbeat.deleteMany({ where: { personnelId: { in: [personnelA.id, personnelB.id] } } });
    await prisma.location.deleteMany({ where: { personnelId: { in: [personnelA.id, personnelB.id] } } });
    await prisma.locationEvent.deleteMany({ where: { personnelId: { in: [personnelA.id, personnelB.id] } } });
    await prisma.dutySession.deleteMany({ where: { personnelId: { in: [personnelA.id, personnelB.id] } } });
    await prisma.deviceCredential.deleteMany({ where: { deviceId: { in: [deviceA.id, deviceB.id] } } });
    await prisma.device.deleteMany({ where: { id: { in: [deviceA.id, deviceB.id] } } });
    await prisma.session.deleteMany({ where: { userId: { in: [userA.id, userB.id] } } });
    await prisma.personnel.deleteMany({ where: { id: { in: [personnelA.id, personnelB.id] } } });
    await prisma.user.deleteMany({ where: { id: { in: [userA.id, userB.id] } } });
  });
});
