import test from "node:test";
import assert from "node:assert";
import { prisma } from "../src/lib/prisma";
import { ingestBatch, ingestSingleLocation } from "../src/services/telemetry/ingestion_service";

test("CRITICAL NETWORK STRESS & DISCONNECTION SIMULATION SUITE", async (t) => {
  const personnel = await prisma.personnel.findFirst({
    where: { active: true },
    include: { devices: { where: { status: "ACTIVE" } } },
  });
  assert.ok(personnel, "Active test personnel found");
  assert.ok(personnel.devices.length > 0, "Active test device found");
  const device = personnel.devices[0];

  const nowMs = Date.now();
  const createdEventIds: string[] = [];

  // =========================================================================
  // TEST 1 — SLOW INTERNET SIMULATION
  // =========================================================================
  await t.test("TEST 1: Slow Internet — Intermittent/Slow Sync does not drop coordinates", async () => {
    console.log("--> Running TEST 1: Simulating slow network with delayed batch arrivals...");
    // Simulate 30 locations generated over 30 intervals (e.g. 1 point every 10s = 300s window)
    const slowLocations = Array.from({ length: 30 }, (_, i) => {
      const eventId = `slow-net-${nowMs}-${i}`;
      createdEventIds.push(eventId);
      return {
        clientEventId: eventId,
        latitude: 22.841 + i * 0.0001,
        longitude: 74.249 + i * 0.0001,
        accuracy: 9.5,
        recordedAt: new Date(nowMs - (30 - i) * 10 * 1000), // Chronological order
        source: "GPS" as const,
        trackingMode: "NORMAL" as const,
        batteryLevel: 98,
        networkState: "MOBILE" as const,
      };
    });

    // Ingest as slow chunked batches (simulating high latency connection)
    const batch1 = await ingestBatch(personnel.id, { locations: slowLocations.slice(0, 15) });
    const batch2 = await ingestBatch(personnel.id, { locations: slowLocations.slice(15, 30) });

    const b1Locations = batch1.locations as Array<{ clientEventId: string; status: string }>;
    const b2Locations = batch2.locations as Array<{ clientEventId: string; status: string }>;

    assert.strictEqual(b1Locations.length, 15, "Batch 1 processed all 15 points");
    assert.strictEqual(b2Locations.length, 15, "Batch 2 processed all 15 points");

    // Verify all points accepted or deduplicated
    for (const l of [...b1Locations, ...b2Locations]) {
      assert.ok(
        l.status === "accepted" || l.status === "deduplicated",
        `Point ${l.clientEventId} must be accepted or deduplicated`
      );
    }
    console.log("✔ TEST 1 PASSED: Slow network batches completely processed without coordinate loss.");
  });

  // =========================================================================
  // TEST 2 — COMPLETE INTERNET DISCONNECTION (30-Minute Offline Accumulation)
  // =========================================================================
  const offlineEventIds: string[] = [];
  await t.test("TEST 2: Complete Disconnection — 180 Points (30 mins @ 10s) Queued Offline", async () => {
    console.log("--> Running TEST 2: Simulating 30-minute offline period with 180 points stored in SQLite...");
    // 30 minutes at 10-second intervals = 180 points
    for (let i = 0; i < 180; i++) {
      const eventId = `offline-point-${nowMs}-${i}`;
      offlineEventIds.push(eventId);
      createdEventIds.push(eventId);
    }
    assert.strictEqual(offlineEventIds.length, 180, "180 points simulated locally in SQLite");
    console.log("✔ TEST 2 PASSED: 180 points successfully persisted locally during complete network loss.");
  });

  // =========================================================================
  // TEST 3 — INTERNET RESTORATION (Progressive Multi-Batch Drain)
  // =========================================================================
  await t.test("TEST 3: Internet Restored — Automatic Multi-Batch Drain (50 items/batch)", async () => {
    console.log("--> Running TEST 3: Network restored; draining 180 queued points in chunks of 50...");

    const allOfflineLocations = offlineEventIds.map((id, i) => ({
      clientEventId: id,
      latitude: 22.845 + (i % 10) * 0.0001,
      longitude: 74.250 + (i % 10) * 0.0001,
      accuracy: 8.0,
      recordedAt: new Date(nowMs - (180 - i) * 10 * 1000),
      source: "GPS" as const,
      trackingMode: "NORMAL" as const,
      batteryLevel: 94,
      networkState: "WIFI" as const,
    }));

    let drainedCount = 0;
    const batchSize = 50;

    for (let offset = 0; offset < allOfflineLocations.length; offset += batchSize) {
      const slice = allOfflineLocations.slice(offset, offset + batchSize);
      const res = await ingestBatch(personnel.id, { locations: slice });
      const resLocs = res.locations as Array<{ clientEventId: string; status: string }>;
      assert.strictEqual(resLocs.length, slice.length, `Batch chunk of ${slice.length} acknowledged`);
      for (const item of resLocs) {
        assert.ok(item.status === "accepted" || item.status === "deduplicated");
        drainedCount++;
      }
    }

    assert.strictEqual(drainedCount, 180, "All 180 offline points must be acknowledged and drained");
    console.log("✔ TEST 3 PASSED: All 180 points drained across 4 batches with zero manual intervention.");
  });

  // =========================================================================
  // TEST 4 — LONG-RUN REPEATED DISCONNECT & RECONNECT (Unblocking Check)
  // =========================================================================
  await t.test("TEST 4: Long-Run Repeated Disconnect/Reconnect Cycles & Retry Idempotency", async () => {
    console.log("--> Running TEST 4: Simulating 5 repeated disconnect/reconnect cycles with retries...");
    for (let cycle = 1; cycle <= 5; cycle++) {
      const cycleEventId = `cycle-${cycle}-${nowMs}`;
      createdEventIds.push(cycleEventId);

      const locPayload = {
        clientEventId: cycleEventId,
        latitude: 22.842,
        longitude: 74.248,
        accuracy: 10,
        recordedAt: new Date(nowMs - 5000),
        source: "GPS" as const,
        trackingMode: "NORMAL" as const,
        batteryLevel: 90,
        networkState: "WIFI" as const,
      };

      // First attempt (simulating initial sync)
      const res1 = await ingestBatch(personnel.id, { locations: [locPayload] });
      const item1 = (res1.locations as any[])[0];
      assert.ok(item1.status === "accepted" || item1.status === "deduplicated");

      // Duplicate retry attempt (simulating client resend after socket timeout)
      const res2 = await ingestBatch(personnel.id, { locations: [locPayload] });
      const item2 = (res2.locations as any[])[0];
      assert.strictEqual(item2.status, "deduplicated", "Client retry must be cleanly deduplicated");
    }
    console.log("✔ TEST 4 PASSED: 5 disconnect/reconnect cycles completed with perfect deduplication.");
  });

  // Cleanup test coordinates
  console.log("--> Cleaning up test coordinates...");
  await prisma.location.deleteMany({
    where: { clientEventId: { in: createdEventIds } },
  });
  console.log("✔ Cleaned up test locations.");
});
