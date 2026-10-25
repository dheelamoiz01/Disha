import test from "node:test";
import assert from "node:assert";
import { randomUUID } from "crypto";
import { prisma } from "../src/lib/prisma";
import { createSession } from "../src/lib/auth/session";
import { UserStatus, UserRole, DeviceStatus, LocationSource } from "../generated/prisma/enums";
import { GET as staffGetRoute, POST as staffPostRoute } from "../src/app/api/staff/route";
import { PATCH as staffPatchRoute, DELETE as staffDeleteRoute } from "../src/app/api/staff/[id]/route";
import { POST as resetPasswordRoute } from "../src/app/api/staff/[id]/reset-password/route";
import { GET as trailPersonnelRoute } from "../src/app/api/control-room/trail/personnel/route";
import { GET as trailLocationHistoryRoute } from "../src/app/api/control-room/personnel/[id]/location-history/route";
import { GET as overviewRoute } from "../src/app/api/control-room/overview/route";
import { GET as sseRoute } from "../src/app/api/control-room/overview/sse/route";
import { POST as alertAckRoute } from "../src/app/api/alerts/[id]/ack/route";
import { NextRequest } from "next/server";

test("DISHA Hierarchical Admin Access Control Test Suite", async (t) => {
  const ts = Date.now();
  let superAdminUser: any;
  let superAdminToken: string;

  let adminAUser: any;
  let adminAToken: string;

  let adminBUser: any;
  let adminBToken: string;

  let staffA1: any;
  let staffA1User: any;
  let staffA1Device: any;

  let staffB1: any;
  let staffB1User: any;
  let staffB1Device: any;

  let unassignedStaff: any;
  let unassignedStaffUser: any;

  let alertB1: any;

  await t.test("0. Setup isolated test fixtures across multiple admins", async () => {
    // 1. Superadmin (SP)
    superAdminUser = await prisma.user.create({
      data: {
        username: `superadmin_test_${ts}`,
        passwordHash: "dummyHash",
        role: UserRole.SP,
        status: UserStatus.ACTIVE,
        permissions: JSON.stringify(["STAFF_MANAGEMENT", "LIVE_MAP"]),
      },
    });
    const sSess = await createSession(superAdminUser.id);
    superAdminToken = sSess.token;

    // 2. Admin A (CONTROL_ROOM_OFFICER)
    adminAUser = await prisma.user.create({
      data: {
        username: `admin_a_test_${ts}`,
        passwordHash: "dummyHash",
        role: UserRole.CONTROL_ROOM_OFFICER,
        status: UserStatus.ACTIVE,
        permissions: JSON.stringify(["STAFF_MANAGEMENT", "LIVE_MAP"]),
      },
    });
    const aSess = await createSession(adminAUser.id);
    adminAToken = aSess.token;

    // 3. Admin B (CONTROL_ROOM_OFFICER)
    adminBUser = await prisma.user.create({
      data: {
        username: `admin_b_test_${ts}`,
        passwordHash: "dummyHash",
        role: UserRole.CONTROL_ROOM_OFFICER,
        status: UserStatus.ACTIVE,
        permissions: JSON.stringify(["STAFF_MANAGEMENT", "LIVE_MAP"]),
      },
    });
    const bSess = await createSession(adminBUser.id);
    adminBToken = bSess.token;

    // 4. Staff A1 (owned by Admin A)
    staffA1User = await prisma.user.create({
      data: {
        username: `staff_a1_${ts}`,
        passwordHash: "dummyHash",
        role: UserRole.FIELD_PERSONNEL,
        status: UserStatus.ACTIVE,
      },
    });
    staffA1 = await prisma.personnel.create({
      data: {
        userId: staffA1User.id,
        adminId: adminAUser.id,
        personnelCode: `CODE_A1_${ts}`,
        name: `Officer A1 (${ts})`,
        active: true,
      },
    });
    staffA1Device = await prisma.device.create({
      data: {
        personnelId: staffA1.id,
        deviceIdentifier: `dev_a1_${ts}`,
        platform: "android",
        status: DeviceStatus.ACTIVE,
        latestLatitude: 22.84,
        latestLongitude: 74.26,
        latestAccuracy: 8.0,
        latestLocationTime: new Date(),
        lastSeenAt: new Date(),
        lastHeartbeatAt: new Date(),
      },
    });

    // 5. Staff B1 (owned by Admin B)
    staffB1User = await prisma.user.create({
      data: {
        username: `staff_b1_${ts}`,
        passwordHash: "dummyHash",
        role: UserRole.FIELD_PERSONNEL,
        status: UserStatus.ACTIVE,
      },
    });
    staffB1 = await prisma.personnel.create({
      data: {
        userId: staffB1User.id,
        adminId: adminBUser.id,
        personnelCode: `CODE_B1_${ts}`,
        name: `Officer B1 (${ts})`,
        active: true,
      },
    });
    staffB1Device = await prisma.device.create({
      data: {
        personnelId: staffB1.id,
        deviceIdentifier: `dev_b1_${ts}`,
        platform: "android",
        status: DeviceStatus.ACTIVE,
        latestLatitude: 23.10,
        latestLongitude: 75.10,
        latestAccuracy: 6.0,
        latestLocationTime: new Date(),
        lastSeenAt: new Date(),
        lastHeartbeatAt: new Date(),
      },
    });

    // Create location record for Staff B1
    await prisma.location.create({
      data: {
        clientEventId: `loc_b1_${ts}`,
        personnelId: staffB1.id,
        deviceId: staffB1Device.id,
        latitude: 23.10,
        longitude: 75.10,
        accuracy: 6.0,
        source: LocationSource.GPS,
        recordedAt: new Date(),
      },
    });

    // Create Alert for Staff B1
    alertB1 = await prisma.alert.create({
      data: {
        personnelId: staffB1.id,
        type: "SOS",
        message: "Test SOS alert for Staff B1",
        status: "ACTIVE",
      },
    });

    // 6. Unassigned Staff (legacy / Superadmin created without adminId)
    unassignedStaffUser = await prisma.user.create({
      data: {
        username: `staff_unassigned_${ts}`,
        passwordHash: "dummyHash",
        role: UserRole.FIELD_PERSONNEL,
        status: UserStatus.ACTIVE,
      },
    });
    unassignedStaff = await prisma.personnel.create({
      data: {
        userId: unassignedStaffUser.id,
        adminId: null, // intentionally null
        personnelCode: `CODE_UN_${ts}`,
        name: `Officer Unassigned (${ts})`,
        active: true,
      },
    });
  });

  await t.test("1. Superadmin can see staff belonging to multiple Admins", async () => {
    const req = new NextRequest("http://localhost:3000/api/staff", {
      headers: { cookie: `disha_session=${superAdminToken}` },
    });
    const res = await staffGetRoute(req);
    assert.strictEqual(res.status, 200);
    const json = await res.json();
    const ids = json.staff.map((s: any) => s.id);
    assert.ok(ids.includes(staffA1.id), "Superadmin must see Staff A1");
    assert.ok(ids.includes(staffB1.id), "Superadmin must see Staff B1");
    assert.ok(ids.includes(unassignedStaff.id), "Superadmin must see unassigned staff");
  });

  await t.test("2. Admin A sees their own staff and activities", async () => {
    const req = new NextRequest("http://localhost:3000/api/staff", {
      headers: { cookie: `disha_session=${adminAToken}` },
    });
    const res = await staffGetRoute(req);
    assert.strictEqual(res.status, 200);
    const json = await res.json();
    const ids = json.staff.map((s: any) => s.id);
    assert.ok(ids.includes(staffA1.id), "Admin A must see their own Staff A1");
  });

  await t.test("3. Admin A cannot see Admin B's staff, activities, live locations or trails", async () => {
    // 3a. Staff List
    const reqStaff = new NextRequest("http://localhost:3000/api/staff", {
      headers: { cookie: `disha_session=${adminAToken}` },
    });
    const resStaff = await staffGetRoute(reqStaff);
    const jsonStaff = await resStaff.json();
    const ids = jsonStaff.staff.map((s: any) => s.id);
    assert.strictEqual(ids.includes(staffB1.id), false, "Admin A must NOT see Admin B's staff in /api/staff");

    // 3b. Trail Selector List
    const reqTrailList = new NextRequest("http://localhost:3000/api/control-room/trail/personnel", {
      headers: { cookie: `disha_session=${adminAToken}` },
    });
    const resTrailList = await trailPersonnelRoute(reqTrailList);
    const jsonTrailList = await resTrailList.json();
    const trailIds = jsonTrailList.personnel.map((p: any) => p.id);
    assert.ok(trailIds.includes(staffA1.id), "Admin A must see Staff A1 in Trail selector");
    assert.strictEqual(trailIds.includes(staffB1.id), false, "Admin A must NOT see Staff B1 in Trail selector");

    // 3c. Control Room Overview & Live Map (Polling)
    const reqOverview = new NextRequest("http://localhost:3000/api/control-room/overview", {
      headers: { cookie: `disha_session=${adminAToken}` },
    });
    const resOverview = await overviewRoute(reqOverview);
    const jsonOverview = await resOverview.json();
    const overviewIds = jsonOverview.map((item: any) => item.id);
    assert.ok(overviewIds.includes(staffA1.id), "Admin A overview must include Staff A1");
    assert.strictEqual(overviewIds.includes(staffB1.id), false, "Admin A overview must NOT include Staff B1");
  });

  await t.test("4. Manipulating URL parameters or personnel IDs cannot bypass restrictions (IDOR prevention)", async () => {
    // Admin A maliciously requests Admin B's staff location history by direct ID
    const reqHistory = new NextRequest(
      `http://localhost:3000/api/control-room/personnel/${staffB1.id}/location-history`,
      { headers: { cookie: `disha_session=${adminAToken}` } }
    );
    const resHistory = await trailLocationHistoryRoute(reqHistory, {
      params: Promise.resolve({ id: staffB1.id }),
    });
    assert.strictEqual(resHistory.status, 404, "Attempting to access Admin B's staff trail must return 404 access denied");

    // Admin A maliciously attempts to PATCH Admin B's staff details
    const reqPatch = new NextRequest(`http://localhost:3000/api/staff/${staffB1.id}`, {
      method: "PATCH",
      headers: { cookie: `disha_session=${adminAToken}` },
      body: JSON.stringify({ name: "Hacked by Admin A" }),
    });
    const resPatch = await staffPatchRoute(reqPatch, {
      params: Promise.resolve({ id: staffB1.id }),
    });
    assert.strictEqual(resPatch.status, 404, "Attempting to patch Admin B's staff must return 404 access denied");

    // Admin A maliciously attempts to reset password of Admin B's staff
    const reqReset = new NextRequest(`http://localhost:3000/api/staff/${staffB1.id}/reset-password`, {
      method: "POST",
      headers: { cookie: `disha_session=${adminAToken}` },
      body: JSON.stringify({ newPassword: "maliciousPassword123" }),
    });
    const resReset = await resetPasswordRoute(reqReset, {
      params: Promise.resolve({ id: staffB1.id }),
    });
    assert.strictEqual(resReset.status, 404, "Attempting to reset Admin B's staff password must return 404 access denied");

    // Admin A maliciously attempts to delete Admin B's staff
    const reqDelete = new NextRequest(`http://localhost:3000/api/staff/${staffB1.id}`, {
      method: "DELETE",
      headers: { cookie: `disha_session=${adminAToken}` },
    });
    const resDelete = await staffDeleteRoute(reqDelete, {
      params: Promise.resolve({ id: staffB1.id }),
    });
    assert.strictEqual(resDelete.status, 404, "Attempting to delete Admin B's staff must return 404 access denied");
  });

  await t.test("5. SSE streaming and real-time fallbacks respect ownership rules", async () => {
    // Admin A connects to SSE stream
    const reqSse = new NextRequest("http://localhost:3000/api/control-room/overview/sse", {
      headers: { cookie: `disha_session=${adminAToken}` },
    });
    const resSse = await sseRoute(reqSse);
    assert.strictEqual(resSse.status, 200);
    assert.strictEqual(resSse.headers.get("content-type"), "text/event-stream; charset=utf-8");

    // Read initial streamed chunk
    const reader = resSse.body?.getReader();
    assert.ok(reader, "SSE stream reader must exist");
    const { value } = await reader.read();
    reader.cancel();

    const text = new TextDecoder().decode(value);
    assert.ok(text.startsWith("data: "), "Stream chunk must be formatted as data: ");
    const parsedData = JSON.parse(text.replace("data: ", "").trim());
    const streamedIds = parsedData.map((item: any) => item.id);

    assert.ok(streamedIds.includes(staffA1.id), "Admin A SSE stream must include Staff A1");
    assert.strictEqual(streamedIds.includes(staffB1.id), false, "Admin A SSE stream must NOT include Staff B1");
  });

  let createdNewStaffId: string | null = null;
  const newStaffUsername = `new_staff_${ts}`;

  await t.test("6. New staff automatically inherit the correct owning Admin relationship", async () => {
    const reqCreate = new NextRequest("http://localhost:3000/api/staff", {
      method: "POST",
      headers: { cookie: `disha_session=${adminAToken}` },
      body: JSON.stringify({
        name: `New Officer Created by A (${ts})`,
        username: newStaffUsername,
        password: "strongPassword123#",
        personnelCode: `NEW_A_${ts}`,
      }),
    });
    const resCreate = await staffPostRoute(reqCreate);
    assert.strictEqual(resCreate.status, 200);
    const jsonCreate = await resCreate.json();
    assert.strictEqual(jsonCreate.success, true);
    assert.strictEqual(jsonCreate.staff.adminId, adminAUser.id, "Newly created staff must persist adminId = creating admin");
    createdNewStaffId = jsonCreate.staff.id;

    // Verify persisted in database
    const dbRecord = await prisma.personnel.findUnique({
      where: { id: jsonCreate.staff.id },
      select: { adminId: true },
    });
    assert.strictEqual(dbRecord?.adminId, adminAUser.id, "Database record must store adminId");
  });

  await t.test("7. Existing staff with missing ownership are handled safely", async () => {
    // Admin A should NOT see unassigned staff
    const reqStaffA = new NextRequest("http://localhost:3000/api/staff", {
      headers: { cookie: `disha_session=${adminAToken}` },
    });
    const resStaffA = await staffGetRoute(reqStaffA);
    const jsonA = await resStaffA.json();
    const idsA = jsonA.staff.map((s: any) => s.id);
    assert.strictEqual(idsA.includes(unassignedStaff.id), false, "Unassigned staff must NOT leak to Admin A");

    // Admin B should NOT see unassigned staff
    const reqStaffB = new NextRequest("http://localhost:3000/api/staff", {
      headers: { cookie: `disha_session=${adminBToken}` },
    });
    const resStaffB = await staffGetRoute(reqStaffB);
    const jsonB = await resStaffB.json();
    const idsB = jsonB.staff.map((s: any) => s.id);
    assert.strictEqual(idsB.includes(unassignedStaff.id), false, "Unassigned staff must NOT leak to Admin B");

    // Superadmin CAN see unassigned staff
    const reqSuper = new NextRequest("http://localhost:3000/api/staff", {
      headers: { cookie: `disha_session=${superAdminToken}` },
    });
    const resSuper = await staffGetRoute(reqSuper);
    const jsonSuper = await resSuper.json();
    const idsSuper = jsonSuper.staff.map((s: any) => s.id);
    assert.ok(idsSuper.includes(unassignedStaff.id), "Superadmin must see unassigned staff");
  });

  await t.test("8. Full Screen Trail Map still works with authorised data", async () => {
    // Admin A requests location history for their own staff A1
    const reqHistory = new NextRequest(
      `http://localhost:3000/api/control-room/personnel/${staffA1.id}/location-history`,
      { headers: { cookie: `disha_session=${adminAToken}` } }
    );
    const resHistory = await trailLocationHistoryRoute(reqHistory, {
      params: Promise.resolve({ id: staffA1.id }),
    });
    assert.strictEqual(resHistory.status, 200, "Authorised location history request must return 200");
    const jsonHistory = await resHistory.json();
    assert.strictEqual(jsonHistory.personnel.id, staffA1.id);
    assert.ok(Array.isArray(jsonHistory.locations));
    assert.ok(jsonHistory.summary !== undefined);
  });

  await t.test("9. Unauthenticated users cannot access protected data", async () => {
    // No auth cookie
    const reqStaff = new NextRequest("http://localhost:3000/api/staff");
    const resStaff = await staffGetRoute(reqStaff);
    assert.strictEqual(resStaff.status, 401, "Unauthenticated /api/staff must return 401");

    const reqOverview = new NextRequest("http://localhost:3000/api/control-room/overview");
    const resOverview = await overviewRoute(reqOverview);
    assert.strictEqual(resOverview.status, 401, "Unauthenticated /api/control-room/overview must return 401");

    const reqSse = new NextRequest("http://localhost:3000/api/control-room/overview/sse");
    const resSse = await sseRoute(reqSse);
    assert.strictEqual(resSse.status, 401, "Unauthenticated SSE stream must return 401");

    const reqTrail = new NextRequest("http://localhost:3000/api/control-room/trail/personnel");
    const resTrail = await trailPersonnelRoute(reqTrail);
    assert.strictEqual(resTrail.status, 401, "Unauthenticated trail personnel must return 401");
  });

  await t.test("10. Cleanup isolated test fixtures", async () => {
    // Delete created test users and linked records safely
    const testUsernames = [
      superAdminUser.username,
      adminAUser.username,
      adminBUser.username,
      staffA1User.username,
      staffB1User.username,
      unassignedStaffUser.username,
      newStaffUsername,
    ];

    await prisma.alert.deleteMany({
      where: { id: alertB1.id },
    });

    const allPersonnelIds = [staffA1.id, staffB1.id, unassignedStaff.id];
    if (createdNewStaffId) allPersonnelIds.push(createdNewStaffId);

    await prisma.location.deleteMany({
      where: { personnelId: { in: allPersonnelIds } },
    });

    await prisma.device.deleteMany({
      where: { personnelId: { in: allPersonnelIds } },
    });

    await prisma.personnel.deleteMany({
      where: { id: { in: allPersonnelIds } },
    });

    await prisma.session.deleteMany({
      where: {
        userId: {
          in: [
            superAdminUser.id,
            adminAUser.id,
            adminBUser.id,
            staffA1User.id,
            staffB1User.id,
            unassignedStaffUser.id,
          ],
        },
      },
    });

    await prisma.user.deleteMany({
      where: {
        username: {
          in: testUsernames,
        },
      },
    });
  });
});
