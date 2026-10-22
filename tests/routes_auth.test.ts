import test from "node:test";
import assert from "node:assert";
import { prisma } from "../src/lib/prisma";
import { UserRole, UserStatus, DeviceStatus } from "../generated/prisma/enums";
import { hashPassword } from "../src/lib/auth/password";
import { createSession } from "../src/lib/auth/session";
import { generateDeviceCredential } from "../src/lib/auth/device_auth";

async function cleanOldFixtures(username: string) {
  try {
    const oldUsers = await prisma.user.findMany({ where: { username } });
    for (const u of oldUsers) {
      const p = await prisma.personnel.findUnique({ where: { userId: u.id } });
      if (p) {
        const devs = await prisma.device.findMany({ where: { personnelId: p.id } });
        for (const d of devs) {
          await prisma.deviceCredential.deleteMany({ where: { deviceId: d.id } });
        }
        await prisma.heartbeat.deleteMany({ where: { personnelId: p.id } });
        await prisma.dutySession.deleteMany({ where: { personnelId: p.id } });
        await prisma.location.deleteMany({ where: { personnelId: p.id } });
        await prisma.locationEvent.deleteMany({ where: { personnelId: p.id } });
        await prisma.sOSEvent.deleteMany({ where: { personnelId: p.id } });
        await prisma.alert.deleteMany({ where: { personnelId: p.id } });
        await prisma.device.deleteMany({ where: { personnelId: p.id } });
        await prisma.personnel.delete({ where: { id: p.id } });
      }
      await prisma.session.deleteMany({ where: { userId: u.id } });
      await prisma.user.delete({ where: { id: u.id } });
    }
  } catch (err) {
    // ignore
  }
}

test("API Route Handlers: Authentication and Authorization Verification", async (t) => {
  const TEST_USER = "route_test_officer";
  let userField: any;
  let personnelField: any;
  let deviceField: any;
  let sessionField: any;
  let sessionToken: string;
  let deviceToken: string;

  await t.test("Setup fixtures", async () => {
    await cleanOldFixtures(TEST_USER);

    const passwordHash = await hashPassword("ValidPassword123!");
    userField = await prisma.user.create({
      data: {
        username: TEST_USER,
        passwordHash,
        role: UserRole.FIELD_PERSONNEL,
        status: UserStatus.ACTIVE,
      },
    });

    personnelField = await prisma.personnel.create({
      data: {
        userId: userField.id,
        personnelCode: "RT-101",
        name: "Route Test Officer",
        active: true,
      },
    });

    deviceField = await prisma.device.create({
      data: {
        personnelId: personnelField.id,
        deviceIdentifier: "DEV-RT-101",
        platform: "Android",
        status: DeviceStatus.ACTIVE,
      },
    });

    // Create session
    const sess = await createSession(userField.id, "TestAgent", "127.0.0.1");
    sessionField = sess.session;
    sessionToken = sess.token;

    // Create device token
    deviceToken = await generateDeviceCredential(deviceField.id);
  });

  await t.test("POST /api/device/enroll: Case-insensitive login (lower, upper, mixed case with whitespace)", async () => {
    const { POST: enrollHandler } = await import("../src/app/api/device/enroll/route");

    // 1. Lowercase match
    const lowerReq = new Request("http://localhost/api/device/enroll", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "route_test_officer",
        password: "ValidPassword123!",
        deviceIdentifier: "DEV-RT-101",
      }),
    });
    const lowerRes = await enrollHandler(lowerReq);
    assert.strictEqual(lowerRes.status, 200);
    const lowerBody = await lowerRes.json();
    assert.ok(lowerBody.token);
    assert.strictEqual(lowerBody.personnel.id, personnelField.id);

    // 2. Uppercase match
    const upperReq = new Request("http://localhost/api/device/enroll", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "ROUTE_TEST_OFFICER",
        password: "ValidPassword123!",
        deviceIdentifier: "DEV-RT-101",
      }),
    });
    const upperRes = await enrollHandler(upperReq);
    assert.strictEqual(upperRes.status, 200);
    const upperBody = await upperRes.json();
    assert.ok(upperBody.token);
    assert.strictEqual(upperBody.personnel.id, personnelField.id);

    // 3. Mixed case with whitespace
    const mixedReq = new Request("http://localhost/api/device/enroll", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "  Route_Test_Officer  ",
        password: "ValidPassword123!",
        deviceIdentifier: "DEV-RT-101",
      }),
    });
    const mixedRes = await enrollHandler(mixedReq);
    assert.strictEqual(mixedRes.status, 200);
    const mixedBody = await mixedRes.json();
    assert.ok(mixedBody.token);
    assert.strictEqual(mixedBody.personnel.id, personnelField.id);

    // Update deviceToken to latest generated token from enroll
    deviceToken = mixedBody.token;

    // 4. Invalid password rejected
    const badPassReq = new Request("http://localhost/api/device/enroll", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "Route_Test_Officer",
        password: "WrongPassword!",
        deviceIdentifier: "DEV-RT-101",
      }),
    });
    const badPassRes = await enrollHandler(badPassReq);
    assert.strictEqual(badPassRes.status, 401);
  });

  await t.test("POST /api/duty/start handler: Bearer token auth, validation and ownership check", async () => {
    const { POST: startDutyHandler } = await import("../src/app/api/duty/start/route");

    // 1. Invalid Bearer token is rejected with 401
    const invalidTokenReq = new Request("http://localhost/api/duty/start", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer invalid_bearer_token_123",
      },
      body: JSON.stringify({
        personnelId: personnelField.id,
        deviceIdentifier: deviceField.deviceIdentifier,
      }),
    });
    const invalidTokenRes = await startDutyHandler(invalidTokenReq);
    assert.strictEqual(invalidTokenRes.status, 401);

    // 2. Mismatched personnelId is rejected with 403 Forbidden
    const mismatchPersonnelReq = new Request("http://localhost/api/duty/start", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${deviceToken}`,
      },
      body: JSON.stringify({
        personnelId: "cuid_attacker_spoof_id",
        deviceIdentifier: deviceField.deviceIdentifier,
      }),
    });
    const mismatchPersonnelRes = await startDutyHandler(mismatchPersonnelReq);
    assert.strictEqual(mismatchPersonnelRes.status, 403);

    // 3. Mismatched deviceIdentifier is rejected with 403 Forbidden
    const mismatchDeviceReq = new Request("http://localhost/api/duty/start", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${deviceToken}`,
      },
      body: JSON.stringify({
        personnelId: personnelField.id,
        deviceIdentifier: "DEV-DIFFERENT-999",
      }),
    });
    const mismatchDeviceRes = await startDutyHandler(mismatchDeviceReq);
    assert.strictEqual(mismatchDeviceRes.status, 403);

    // 4. Valid Bearer token with matching personnel and device succeeds
    const validReq = new Request("http://localhost/api/duty/start", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${deviceToken}`,
      },
      body: JSON.stringify({
        personnelId: personnelField.id,
        deviceIdentifier: deviceField.deviceIdentifier,
      }),
    });
    const validRes = await startDutyHandler(validReq);
    assert.strictEqual(validRes.status, 200);
    const validBody = await validRes.json();
    assert.strictEqual(validBody.success, true);
    assert.strictEqual(validBody.session.status, "DUTY_STARTED");
  });

  await t.test("POST /api/duty/end handler: Bearer token auth and ownership check", async () => {
    const { POST: endDutyHandler } = await import("../src/app/api/duty/end/route");

    // 1. Mismatched personnelId is rejected with 403 Forbidden
    const mismatchReq = new Request("http://localhost/api/duty/end", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${deviceToken}`,
      },
      body: JSON.stringify({
        personnelId: "cuid_wrong_personnel_id",
      }),
    });
    const mismatchRes = await endDutyHandler(mismatchReq);
    assert.strictEqual(mismatchRes.status, 403);

    // 2. Valid Bearer token successfully ends duty
    const validReq = new Request("http://localhost/api/duty/end", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${deviceToken}`,
      },
      body: JSON.stringify({
        personnelId: personnelField.id,
      }),
    });
    const validRes = await endDutyHandler(validReq);
    assert.strictEqual(validRes.status, 200);
    const validBody = await validRes.json();
    assert.strictEqual(validBody.success, true);
    assert.strictEqual(validBody.session.status, "DUTY_ENDED");
  });

  await t.test("POST /api/duty/start and /end: Fallback to cookie-based session auth", async () => {
    const { POST: startDutyHandler } = await import("../src/app/api/duty/start/route");
    const { POST: endDutyHandler } = await import("../src/app/api/duty/end/route");

    // 1. Start duty with session cookie
    const cookieStartReq = new Request("http://localhost/api/duty/start", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Cookie": `disha_session=${sessionToken}`,
      },
      body: JSON.stringify({
        personnelId: personnelField.id,
        deviceIdentifier: deviceField.deviceIdentifier,
      }),
    });
    const startRes = await startDutyHandler(cookieStartReq);
    assert.strictEqual(startRes.status, 200);
    const startBody = await startRes.json();
    assert.strictEqual(startBody.success, true);
    assert.strictEqual(startBody.session.status, "DUTY_STARTED");

    // 2. End duty with session cookie
    const cookieEndReq = new Request("http://localhost/api/duty/end", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Cookie": `disha_session=${sessionToken}`,
      },
      body: JSON.stringify({
        personnelId: personnelField.id,
      }),
    });
    const endRes = await endDutyHandler(cookieEndReq);
    assert.strictEqual(endRes.status, 200);
    const endBody = await endRes.json();
    assert.strictEqual(endBody.success, true);
    assert.strictEqual(endBody.session.status, "DUTY_ENDED");
  });

  await t.test("POST /api/telemetry/heartbeat verifies device Bearer token and rejects invalid token", async () => {
    const { POST: heartbeatHandler } = await import("../src/app/api/telemetry/heartbeat/route");

    // 1. Valid device Bearer token
    const validReq = new Request("http://localhost/api/telemetry/heartbeat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${deviceToken}`,
      },
      body: JSON.stringify({
        personnelId: personnelField.id,
        batteryLevel: 95,
        networkState: "WIFI",
        recordedAt: new Date().toISOString(),
      }),
    });

    const validRes = await heartbeatHandler(validReq);
    assert.strictEqual(validRes.status, 200);
    const validBody = await validRes.json();
    assert.strictEqual(validBody.status, "accepted");

    // 2. Invalid device Bearer token is rejected with 401
    const invalidReq = new Request("http://localhost/api/telemetry/heartbeat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer invalid_token_12345",
      },
      body: JSON.stringify({
        personnelId: personnelField.id,
        batteryLevel: 95,
        networkState: "WIFI",
        recordedAt: new Date().toISOString(),
      }),
    });

    const invalidRes = await heartbeatHandler(invalidReq);
    assert.strictEqual(invalidRes.status, 401);
  });

  await t.test("POST /api/telemetry/batch accepts device Bearer token and processes batched points", async () => {
    const { POST: batchHandler } = await import("../src/app/api/telemetry/batch/route");

    const batchReq = new Request("http://localhost/api/telemetry/batch", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${deviceToken}`,
      },
      body: JSON.stringify({
        locations: [
          {
            clientEventId: "batch-test-evt-1",
            latitude: 22.8333,
            longitude: 74.2562,
            accuracy: 8.5,
            recordedAt: new Date(Date.now() - 35 * 60 * 1000).toISOString(),
            source: "GPS",
            trackingMode: "NORMAL",
            batteryLevel: 90,
            networkState: "CELLULAR",
          },
          {
            clientEventId: "batch-test-evt-2",
            latitude: 22.8340,
            longitude: 74.2570,
            accuracy: 6.0,
            recordedAt: new Date().toISOString(),
            source: "GPS",
            trackingMode: "NORMAL",
            batteryLevel: 89,
            networkState: "CELLULAR",
          },
        ],
      }),
    });

    const batchRes = await batchHandler(batchReq);
    assert.strictEqual(batchRes.status, 200);
    const body = await batchRes.json();
    assert.ok(Array.isArray(body.locations));
    assert.strictEqual(body.locations.length, 2);
    assert.strictEqual(body.locations[0].status, "accepted");
    assert.strictEqual(body.locations[1].status, "accepted");
  });

  await t.test("Cleanup test fixtures", async () => {
    await cleanOldFixtures(TEST_USER);
  });
});
