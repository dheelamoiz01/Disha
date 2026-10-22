import { prisma } from "@/lib/prisma";
import { DutyStatus, DeviceStatus, UserStatus } from "../../../generated/prisma/enums";
import { SingleLocationInput, LocationEventInput, BatchIngestionInput } from "@/domain/telemetry/validation";
import { getActiveDutySession } from "@/services/duty/duty_service";
import { logAudit } from "@/lib/auth/audit";
import {
  getDutyCurrentTime,
  validateTelemetryDutyWindow,
} from "@/lib/utils/duty_window";

export class TelemetryError extends Error {
  constructor(message: string, public code: string) {
    super(message);
    this.name = "TelemetryError";
  }
}

export async function validateDeviceAuthorization(personnelId: string) {
  const personnel = await prisma.personnel.findUnique({
    where: { id: personnelId },
    include: { user: true }
  });

  if (!personnel) {
    throw new TelemetryError("Personnel not found.", "NOT_FOUND");
  }

  if (!personnel.active) {
    throw new TelemetryError("Personnel is inactive.", "PERSONNEL_INACTIVE");
  }

  if (personnel.user.status !== UserStatus.ACTIVE) {
    throw new TelemetryError("User account is not active.", "USER_INACTIVE");
  }

  // Get active device for this personnel
  const device = await prisma.device.findFirst({
    where: { personnelId, status: DeviceStatus.ACTIVE }
  });

  if (!device) {
    throw new TelemetryError("No active device found for this personnel.", "DEVICE_INACTIVE");
  }

  // Optionally get active duty session
  const session = await getActiveDutySession(personnelId);

  return { personnel, device, session };
}

export async function ingestSingleLocation(personnelId: string, input: SingleLocationInput) {
  // 1. 24×7 Location Telemetry Ingestion (Validation for timestamp sanity and future skew)
  const serverNow = getDutyCurrentTime();
  const dutyValidation = validateTelemetryDutyWindow(new Date(input.recordedAt), serverNow);
  if (!dutyValidation.permitted) {
    throw new TelemetryError(dutyValidation.reason!, dutyValidation.code!);
  }

  const { device, session } = await validateDeviceAuthorization(personnelId);

  // Link active duty session if one is currently open (for session-specific analytics)
  const activeDutySession = session;

  const activeSOS = await prisma.sOSEvent.findFirst({
    where: { personnelId, endedAt: null, status: "ACTIVE" }
  });

  const actualTrackingMode = activeSOS ? "SOS" : "NORMAL";

  // Determine if this new fix is fresher and should update the device's latest live position
  const isInputFresh = !device.latestLocationTime ||
    new Date(input.recordedAt).getTime() >= new Date(device.latestLocationTime).getTime();

  // Protect verified building anchor (<= 20m) from coarse (> 20m) cellular jumps within 60s
  const isCoarseDowngrade = input.accuracy > 20 &&
    device.latestAccuracy != null && device.latestAccuracy <= 20 &&
    (Date.now() - (device.latestLocationTime ? new Date(device.latestLocationTime).getTime() : 0)) < 60000 &&
    actualTrackingMode !== "SOS";

  const shouldUpdateDevicePosition = isInputFresh && !isCoarseDowngrade;

  // 30-second historical trail recording interval guard:
  // Persist one historical trail point approximately every 30 seconds (30,000 ms).
  // Avoid creating duplicate historical records from repeated heartbeats or identical updates within the same interval.
  const intervalThresholdMs = process.env.TRAIL_RECORDING_INTERVAL_MS !== undefined
    ? Number(process.env.TRAIL_RECORDING_INTERVAL_MS)
    : 25 * 1000; // 25 seconds default (buffer for 30-second sampling)

  if (actualTrackingMode !== "SOS" && intervalThresholdMs > 0) {
    const lastRecorded = await prisma.location.findFirst({
      where: {
        personnelId,
      },
      orderBy: { recordedAt: "desc" },
      select: { id: true, recordedAt: true },
    });

    if (lastRecorded) {
      const elapsedMs = Math.abs(
        new Date(input.recordedAt).getTime() - new Date(lastRecorded.recordedAt).getTime()
      );
      if (elapsedMs < intervalThresholdMs) {
        // Update device latest position and lastSeenAt without writing a duplicate row to Location table
        const updateData: any = {
          lastSeenAt: serverNow,
          lastHeartbeatAt: serverNow,
          status: "ACTIVE",
          batteryLevel: input.batteryLevel !== undefined ? input.batteryLevel : device.batteryLevel,
          networkState: input.networkState || device.networkState,
        };
        if (shouldUpdateDevicePosition) {
          updateData.latestLatitude = input.latitude;
          updateData.latestLongitude = input.longitude;
          updateData.latestAccuracy = input.accuracy;
          updateData.latestSource = input.source;
          updateData.latestLocationTime = input.recordedAt;
        }

        await prisma.device.update({
          where: { id: device.id },
          data: updateData,
        });

        return {
          status: "deduplicated",
          locationId: lastRecorded.id,
          receivedAt: new Date(),
          message: "Latest position updated; historical trail point preserved on 30-second interval",
        };
      }
    }
  }

  try {
    const location = await prisma.location.create({
      data: {
        clientEventId: input.clientEventId,
        personnelId: personnelId,
        deviceId: device.id,
        dutySessionId: activeDutySession?.id ?? null,
        latitude: input.latitude,
        longitude: input.longitude,
        accuracy: input.accuracy,
        recordedAt: input.recordedAt,
        source: input.source,
        trackingMode: actualTrackingMode,
        batteryLevel: input.batteryLevel ?? null,
        networkState: input.networkState ?? null,
      },
    });

    // Update device latest position and lastSeenAt
    const updateData: any = {
      lastSeenAt: serverNow,
      lastHeartbeatAt: serverNow,
      status: "ACTIVE",
      batteryLevel: input.batteryLevel !== undefined ? input.batteryLevel : device.batteryLevel,
      networkState: input.networkState || device.networkState,
    };
    if (shouldUpdateDevicePosition) {
      updateData.latestLatitude = input.latitude;
      updateData.latestLongitude = input.longitude;
      updateData.latestAccuracy = input.accuracy;
      updateData.latestSource = input.source;
      updateData.latestLocationTime = input.recordedAt;
    }

    await prisma.device.update({
      where: { id: device.id },
      data: updateData,
    });

    return { status: "accepted", locationId: location.id, receivedAt: location.receivedAt };
  } catch (error: unknown) {
    if ((error as any)?.message?.includes("UNIQUE constraint failed") || (error as any)?.code === "P2002") {
      const existing = await prisma.location.findUnique({ where: { clientEventId: input.clientEventId } });
      return { status: "deduplicated", locationId: existing?.id, receivedAt: existing?.receivedAt };
    }
    throw error;
  }
}

export async function ingestLocationEvent(personnelId: string, input: LocationEventInput) {
  const { device, session } = await validateDeviceAuthorization(personnelId);

  try {
    const event = await prisma.locationEvent.create({
      data: {
        clientEventId: input.clientEventId,
        eventType: input.eventType,
        personnelId: personnelId,
        deviceId: device.id,
        dutySessionId: session?.id ?? null,
        recordedAt: input.recordedAt,
        metadata: input.metadata ? JSON.stringify(input.metadata) : null,
      },
    });

    if (input.eventType === "LOCATION_UNAVAILABLE" || input.eventType === "LOCATION_RECOVERED") {
       await logAudit({
         action: input.eventType as "LOCATION_UNAVAILABLE" | "LOCATION_RECOVERED",
         targetType: "LocationEvent",
         targetId: event.id,
         metadata: { clientEventId: input.clientEventId }
       });
    }

    return { status: "accepted", eventId: event.id, receivedAt: event.receivedAt };
  } catch (error: unknown) {
    if ((error as any)?.message?.includes("UNIQUE constraint failed") || (error as any)?.code === "P2002") {
      const existing = await prisma.locationEvent.findUnique({ where: { clientEventId: input.clientEventId } });
      return { status: "deduplicated", eventId: existing?.id, receivedAt: existing?.receivedAt };
    }
    throw error;
  }
}

export async function ingestBatch(personnelId: string, input: BatchIngestionInput) {
  // Validate authorization and active device once for the entire batch
  const { device, session } = await validateDeviceAuthorization(personnelId);
  const serverNow = getDutyCurrentTime();

  // Link active duty session if one is currently open (for session-specific analytics)
  const activeDutySession = session;

  const activeSOS = await prisma.sOSEvent.findFirst({
    where: { personnelId, endedAt: null, status: "ACTIVE" }
  });
  const actualTrackingMode = activeSOS ? "SOS" : "NORMAL";

  const results = {
    locations: [] as unknown as Record<string, unknown>[],
    events: [] as unknown as Record<string, unknown>[]
  };

  if (input.locations && input.locations.length > 0) {
    const intervalThresholdMs = process.env.TRAIL_RECORDING_INTERVAL_MS !== undefined
      ? Number(process.env.TRAIL_RECORDING_INTERVAL_MS)
      : 25 * 1000; // 25 seconds default (buffer for 30-second sampling)

    let lastAcceptedTimeMs: number | null = null;
    if (actualTrackingMode !== "SOS" && intervalThresholdMs > 0) {
      const lastInDb = await prisma.location.findFirst({
        where: { personnelId },
        orderBy: { recordedAt: "desc" },
        select: { recordedAt: true },
      });
      if (lastInDb) {
        lastAcceptedTimeMs = new Date(lastInDb.recordedAt).getTime();
      }
    }

    for (const loc of input.locations) {
      // Telemetry validation
      const dutyValidation = validateTelemetryDutyWindow(new Date(loc.recordedAt), serverNow);
      if (!dutyValidation.permitted) {
        results.locations.push({
          clientEventId: loc.clientEventId,
          status: "rejected",
          code: dutyValidation.code,
          message: dutyValidation.reason,
        });
        continue;
      }

      if (actualTrackingMode !== "SOS" && intervalThresholdMs > 0 && lastAcceptedTimeMs != null) {
        const pointTimeMs = new Date(loc.recordedAt).getTime();
        const diffMs = Math.abs(pointTimeMs - lastAcceptedTimeMs);
        if (diffMs < intervalThresholdMs) {
          results.locations.push({
            clientEventId: loc.clientEventId,
            status: "deduplicated",
            message: "Location within 30-second trail interval deduplicated",
          });
          continue;
        }
      }

      try {
        const location = await prisma.location.create({
          data: {
            clientEventId: loc.clientEventId,
            personnelId: personnelId,
            deviceId: device.id,
            dutySessionId: activeDutySession?.id ?? null,
            latitude: loc.latitude,
            longitude: loc.longitude,
            accuracy: loc.accuracy,
            recordedAt: loc.recordedAt,
            source: loc.source,
            trackingMode: actualTrackingMode,
            batteryLevel: loc.batteryLevel ?? null,
            networkState: loc.networkState ?? null,
          },
        });
        lastAcceptedTimeMs = new Date(loc.recordedAt).getTime();
        results.locations.push({ clientEventId: loc.clientEventId, status: "accepted", locationId: location.id, receivedAt: location.receivedAt });
      } catch (err: unknown) {
        if ((err as any)?.message?.includes("UNIQUE constraint failed") || (err as any)?.code === "P2002") {
          const existing = await prisma.location.findUnique({ where: { clientEventId: loc.clientEventId } });
          results.locations.push({ clientEventId: loc.clientEventId, status: "deduplicated", locationId: existing?.id, receivedAt: existing?.receivedAt });
        } else {
          results.locations.push({ clientEventId: loc.clientEventId, status: "error", error: (err as any)?.message });
        }
      }
    }

    // Update device position to newest valid location in batch so Live Map reflects freshest position
    const validLocs = input.locations.filter((l) =>
      results.locations.some(
        (r) => r.clientEventId === l.clientEventId && (r.status === "accepted" || r.status === "deduplicated")
      )
    );
    if (validLocs.length > 0) {
      const latestBatchLoc = validLocs.reduce(
        (latest, curr) => (new Date(curr.recordedAt) > new Date(latest.recordedAt) ? curr : latest),
        validLocs[0]
      );
      const isNewer = !device.latestLocationTime || new Date(latestBatchLoc.recordedAt) >= new Date(device.latestLocationTime);
      if (isNewer) {
        await prisma.device.update({
          where: { id: device.id },
          data: {
            latestLatitude: latestBatchLoc.latitude,
            latestLongitude: latestBatchLoc.longitude,
            latestAccuracy: latestBatchLoc.accuracy,
            latestLocationTime: new Date(latestBatchLoc.recordedAt),
            latestSource: latestBatchLoc.source,
            lastHeartbeatAt: serverNow,
          },
        });
      }
    }
  }

  if (input.events && input.events.length > 0) {
    for (const ev of input.events) {
      try {
        const res = await ingestLocationEvent(personnelId, ev);
        results.events.push({ clientEventId: ev.clientEventId, ...res });
      } catch (err: unknown) {
         results.events.push({ clientEventId: ev.clientEventId, status: "error", error: (err as any)?.message });
      }
    }
  }

  return results;
}
