import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { validateDeviceAuthorization } from "@/services/telemetry/ingestion_service";

const heartbeatSchema = z.object({
  personnelId: z.string(),
  batteryLevel: z.number().nullable().optional(),
  networkState: z.string().nullable().optional(),
  appVersion: z.string().nullable().optional(),
  healthState: z.string().nullable().optional(),
  locationEnabled: z.boolean().nullable().optional(),
  permissionState: z.string().nullable().optional(),
  isTrackingRunning: z.boolean().nullable().optional(),
  gpsAvailable: z.boolean().nullable().optional(),
  lastGpsFixTime: z
    .union([z.string().transform((str) => new Date(str)), z.date()])
    .nullable()
    .optional(),
  recordedAt: z.union([z.string().transform((str) => new Date(str)), z.date()]),
});

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const parsed = heartbeatSchema.parse(body);

    let device: any;
    const authHeader = req.headers.get("authorization");
    if (authHeader && authHeader.startsWith("Bearer ")) {
      const token = authHeader.substring(7);
      const { verifyDeviceToken } = await import("@/lib/auth/device_auth");
      const verifiedDevice = await verifyDeviceToken(token);
      if (!verifiedDevice) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
      if (verifiedDevice.personnelId !== parsed.personnelId) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
      device = verifiedDevice;
    } else {
      const auth = await validateDeviceAuthorization(parsed.personnelId);
      device = auth.device;
    }

    // Prepare updated device fields
    const updateData: any = {
      lastSeenAt: new Date(),
      lastHeartbeatAt: parsed.recordedAt,
      batteryLevel: parsed.batteryLevel !== undefined ? parsed.batteryLevel : device.batteryLevel,
      networkState: parsed.networkState || device.networkState,
      appVersion: parsed.appVersion || device.appVersion,
      status: "ACTIVE",
    };

    if (parsed.locationEnabled !== undefined) {
      updateData.locationEnabled = parsed.locationEnabled;
    }
    if (parsed.permissionState !== undefined) {
      updateData.permissionState = parsed.permissionState;
    }
    if (parsed.isTrackingRunning !== undefined) {
      updateData.isTrackingRunning = parsed.isTrackingRunning;
    }
    if (parsed.gpsAvailable !== undefined) {
      updateData.gpsAvailable = parsed.gpsAvailable;
    }
    if (parsed.lastGpsFixTime !== undefined) {
      updateData.lastGpsFixTime = parsed.lastGpsFixTime;
    }

    // Efficient heartbeat update:
    // Update Device directly in a single write without inserting an ephemeral historical row into Heartbeat.
    await prisma.device.update({
      where: { id: device.id },
      data: updateData,
    });

    // Detect state changes and log critical events (only on state transition to prevent DB bloat)
    if (parsed.locationEnabled === false && device.locationEnabled !== false) {
      try {
        await prisma.locationEvent.create({
          data: {
            clientEventId: `evt-loc-off-${device.id}-${Date.now()}`,
            eventType: "LOCATION_UNAVAILABLE",
            personnelId: parsed.personnelId,
            deviceId: device.id,
            recordedAt: parsed.recordedAt,
            metadata: JSON.stringify({ reason: "SYSTEM_LOCATION_DISABLED" }),
          },
        });
      } catch {
        // Suppress transient duplicate event collision
      }
    } else if (parsed.locationEnabled === true && device.locationEnabled === false) {
      try {
        await prisma.locationEvent.create({
          data: {
            clientEventId: `evt-loc-on-${device.id}-${Date.now()}`,
            eventType: "LOCATION_RECOVERED",
            personnelId: parsed.personnelId,
            deviceId: device.id,
            recordedAt: parsed.recordedAt,
            metadata: JSON.stringify({ reason: "SYSTEM_LOCATION_ENABLED" }),
          },
        });
      } catch {
        // Suppress transient duplicate event collision
      }
    }

    return NextResponse.json({
      status: "accepted",
      heartbeatId: `hb-${device.id}`,
      deviceId: device.id,
    });
  } catch (error: any) {
    if (error.name === "ZodError") {
      return NextResponse.json({ error: "Validation failed", details: error.issues || error.errors }, { status: 400 });
    }
    if (error.code === "DEVICE_INACTIVE" || error.code === "PERSONNEL_INACTIVE") {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    console.error("Heartbeat error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
