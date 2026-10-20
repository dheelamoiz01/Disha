import test from "node:test";
import assert from "node:assert";
import { randomUUID } from "crypto";
import { prisma } from "../src/lib/prisma";
import { startDuty, endDuty } from "../src/services/duty/duty_service";
import { DeviceStatus, UserStatus } from "../generated/prisma/enums";
import { 
  ingestSingleLocation, 
  ingestLocationEvent, 
  ingestBatch, 
  validateDeviceAuthorization 
} from "../src/services/telemetry/ingestion_service";
import { singleLocationSchema } from "../src/domain/telemetry/validation";

// Disable interval suppression in this unit test file to allow sub-millisecond API mechanics verification
process.env.TRAIL_RECORDING_INTERVAL_MS = "0";
process.env.DISABLE_DUTY_WINDOW = "1";

test("Telemetry Ingestion and Events - Decoupled 24/7", async (t) => {
  let userA: any;
  let personnelA: any;
  let deviceA: any;
  let deviceRevoked: any;
  
  await t.test("Setup fixtures", async () => {
    userA = await prisma.user.create({ data: { username: "telemetryUser", passwordHash: "x", role: "FIELD_PERSONNEL", status: UserStatus.ACTIVE } });
    personnelA = await prisma.personnel.create({ data: { userId: userA.id, personnelCode: "T-1", name: "T1", active: true } });
    deviceA = await prisma.device.create({ data: { personnelId: personnelA.id, deviceIdentifier: "T-DEV-1", platform: "Android", status: DeviceStatus.ACTIVE } });
    deviceRevoked = await prisma.device.create({ data: { personnelId: personnelA.id, deviceIdentifier: "T-DEV-R", platform: "Android", status: DeviceStatus.REVOKED } });
  });

  await t.test("Telemetry while OFF DUTY succeeds (dutySessionId is null)", async () => {
    const auth = await validateDeviceAuthorization(personnelA.id);
    assert.ok(auth.device);
    assert.strictEqual(auth.session, null); // No active duty

    const cid = randomUUID();
    const res = await ingestSingleLocation(personnelA.id, {
      clientEventId: cid,
      latitude: 23.0,
      longitude: 72.0,
      accuracy: 10,
      recordedAt: new Date(),
      source: "GPS" as any as unknown as Record<string, unknown>,
      trackingMode: "NORMAL" as any as unknown as Record<string, unknown>,
    });
    assert.strictEqual(res.status, "accepted");
    const loc = await prisma.location.findUnique({ where: { clientEventId: cid } });
    assert.strictEqual(loc!.dutySessionId, null);
  });

  await t.test("Start duty successfully", async () => {
    await startDuty(personnelA.id, deviceA.deviceIdentifier, userA.id);
  });

  await t.test("Telemetry during duty succeeds (dutySessionId is populated)", async () => {
    const cid = randomUUID();
    const res = await ingestSingleLocation(personnelA.id, {
      clientEventId: cid,
      latitude: 23.0,
      longitude: 72.0,
      accuracy: 10,
      recordedAt: new Date(),
      source: "GPS" as any as unknown as Record<string, unknown>,
      trackingMode: "NORMAL" as any as unknown as Record<string, unknown>,
    });
    assert.strictEqual(res.status, "accepted");
    const loc = await prisma.location.findUnique({ where: { clientEventId: cid } });
    assert.ok(loc!.dutySessionId !== null);
  });

  await t.test("Idempotency: Same clientEventId is deduplicated", async () => {
    const cid = randomUUID();
    const payload = {
      clientEventId: cid,
      latitude: 23.0,
      longitude: 72.0,
      accuracy: 10,
      recordedAt: new Date(),
      source: "GPS" as any as unknown as Record<string, unknown>,
      trackingMode: "NORMAL" as any as unknown as Record<string, unknown>,
    };
    const res1 = await ingestSingleLocation(personnelA.id, payload);
    const res2 = await ingestSingleLocation(personnelA.id, payload);

    assert.strictEqual(res1.status, "accepted");
    assert.strictEqual(res2.status, "deduplicated");
    assert.strictEqual(res1.locationId, res2.locationId);
  });

  await t.test("Event ingestion (LOCATION_UNAVAILABLE)", async () => {
    const res = await ingestLocationEvent(personnelA.id, {
      clientEventId: randomUUID(),
      eventType: "LOCATION_UNAVAILABLE",
      recordedAt: new Date(),
    });
    assert.strictEqual(res.status, "accepted");
  });

  await t.test("Batch ingestion handles partial successes and deduplication", async () => {
    const cid1 = randomUUID();
    const cid2 = randomUUID();
    // Simulate batch
    const batch = {
      locations: [
        { clientEventId: cid1, latitude: 10, longitude: 20, accuracy: 5, recordedAt: new Date(), source: "GPS" as any as unknown as Record<string, unknown>, trackingMode: "NORMAL" as any as unknown as Record<string, unknown> },
        { clientEventId: cid2, latitude: 10, longitude: 20, accuracy: 5, recordedAt: new Date(), source: "GPS" as any as unknown as Record<string, unknown>, trackingMode: "NORMAL" as any as unknown as Record<string, unknown> }, 
      ],
      events: [
        { clientEventId: randomUUID(), eventType: "NETWORK_LOST" as unknown as Record<string, unknown>, recordedAt: new Date(), metadata: {} }
      ]
    };

    const res = await ingestBatch(personnelA.id, batch);
    assert.strictEqual(res.locations.length, 2);
    assert.strictEqual(res.events.length, 1);
    assert.strictEqual(res.locations[0].status, "accepted");
    
    // Duplicate test
    const res2 = await ingestBatch(personnelA.id, { locations: [{ clientEventId: cid1, latitude: 10, longitude: 20, accuracy: 5, recordedAt: new Date(), source: "GPS" as any as unknown as Record<string, unknown>, trackingMode: "NORMAL" as any as unknown as Record<string, unknown> }] });
    assert.strictEqual(res2.locations[0].status, "deduplicated");
  });

  await t.test("End duty successfully", async () => {
    await endDuty(personnelA.id, userA.id);
  });

  await t.test("Telemetry continues to be accepted after duty ends", async () => {
    const cid = randomUUID();
    const res = await ingestSingleLocation(personnelA.id, { 
      clientEventId: cid, latitude: 0, longitude: 0, accuracy: 10, recordedAt: new Date(), source: "GPS" as any as unknown as Record<string, unknown>, trackingMode: "NORMAL" as any as unknown as Record<string, unknown> 
    });
    assert.strictEqual(res.status, "accepted");
    const loc = await prisma.location.findUnique({ where: { clientEventId: cid } });
    assert.strictEqual(loc!.dutySessionId, null);
  });

  await t.test("Telemetry fails if device is revoked", async () => {
    // Revoke device A
    await prisma.device.update({ where: { id: deviceA.id }, data: { status: DeviceStatus.REVOKED } });
    await assert.rejects(
      ingestSingleLocation(personnelA.id, { clientEventId: randomUUID(), latitude: 0, longitude: 0, accuracy: 10, recordedAt: new Date(), source: "GPS" as any as unknown as Record<string, unknown>, trackingMode: "NORMAL" as any as unknown as Record<string, unknown> }),
      (err: unknown) => err.code === "DEVICE_INACTIVE"
    );
  });

  await t.test("Payload validation: normalize FUSED, CELLULAR, and enforce accuracy", async () => {
    // Fused source normalized to GPS
    const payloadFused = singleLocationSchema.parse({
      clientEventId: randomUUID(),
      latitude: 22.83,
      longitude: 74.25,
      accuracy: 8.5, // <= 10m target met
      recordedAt: new Date().toISOString(),
      source: "FUSED",
    });
    assert.strictEqual(payloadFused.source, "GPS");
    assert.strictEqual(payloadFused.accuracy, 8.5);

    // Cellular source normalized to NETWORK
    const payloadCellular = singleLocationSchema.parse({
      clientEventId: randomUUID(),
      latitude: 22.83,
      longitude: 74.25,
      accuracy: 120.0, // Coarse fix
      recordedAt: new Date().toISOString(),
      source: "CELLULAR",
    });
    assert.strictEqual(payloadCellular.source, "NETWORK");
    assert.strictEqual(payloadCellular.accuracy, 120.0);

    // Out-of-bounds coordinates rejected
    assert.throws(() => {
      singleLocationSchema.parse({
        clientEventId: randomUUID(),
        latitude: 95.0, // Invalid latitude
        longitude: 74.25,
        accuracy: 10,
        recordedAt: new Date().toISOString(),
      });
    });

    // Stale timestamps older than 7 days rejected
    assert.throws(() => {
      const eightDaysAgo = new Date(Date.now() - 1000 * 60 * 60 * 24 * 8);
      singleLocationSchema.parse({
        clientEventId: randomUUID(),
        latitude: 22.83,
        longitude: 74.25,
        accuracy: 10,
        recordedAt: eightDaysAgo.toISOString(),
      });
    });
  });

  await t.test("Cleanup", async () => {
    await prisma.location.deleteMany({ where: { personnelId: personnelA.id } });
    await prisma.locationEvent.deleteMany({ where: { personnelId: personnelA.id } });
    await prisma.dutySession.deleteMany({ where: { personnelId: personnelA.id } });
    await prisma.device.deleteMany({ where: { personnelId: personnelA.id } });
    await prisma.personnel.deleteMany({ where: { id: personnelA.id } });
    await prisma.user.deleteMany({ where: { id: userA.id } });
  });
});
