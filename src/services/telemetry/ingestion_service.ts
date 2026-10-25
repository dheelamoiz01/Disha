import { prisma } from "@/lib/prisma";
import { DutyStatus, DeviceStatus, UserStatus } from "../../../generated/prisma/enums";
import { SingleLocationInput, LocationEventInput, BatchIngestionInput } from "@/domain/telemetry/validation";
import { getActiveDutySession } from "@/services/duty/duty_service";
import { logAudit } from "@/lib/auth/audit";
import {
  getDutyCurrentTime,
  validateTelemetryDutyWindow,
} from "@/lib/utils/duty_window";
import { invalidateDashboardCache } from "@/services/control-room/dashboard_service";
import { tursoBudgetTracker } from "@/lib/turso/budget";

export class TelemetryError extends Error {
  constructor(message: string, public code: string) {
    super(message);
    this.name = "TelemetryError";
  }
}

// In-memory cache for device authorization
interface CachedDeviceAuth {
  personnel: any;
  device: any;
  session: any;
  cachedAt: number;
}
const deviceAuthCache = new Map<string, CachedDeviceAuth>();
const DEVICE_AUTH_CACHE_TTL_MS = 45_000; // 45 seconds

export function invalidateDeviceAuthorizationCache(personnelId?: string) {
  if (personnelId) {
    deviceAuthCache.delete(personnelId);
  } else {
    deviceAuthCache.clear();
  }
}

// In-memory cache for active SOS
interface CachedSOS {
  activeSOS: any;
  cachedAt: number;
}
const activeSOSCache = new Map<string, CachedSOS>();
const SOS_CACHE_TTL_MS = 30_000; // 30 seconds

export function invalidateActiveSOSCache(personnelId?: string) {
  if (personnelId) {
    activeSOSCache.delete(personnelId);
  } else {
    activeSOSCache.clear();
  }
}

// In-memory tracker for last recorded location per personnel (eliminates Location.findFirst on every ping)
const lastRecordedLocationMap = new Map<string, { id: string; recordedAtMs: number }>();

export function clearLastRecordedLocationMap(personnelId?: string) {
  if (personnelId) {
    lastRecordedLocationMap.delete(personnelId);
  } else {
    lastRecordedLocationMap.clear();
  }
}

export async function validateDeviceAuthorization(personnelId: string) {
  const isTest =
    process.env.NODE_ENV === "test" ||
    process.env.DISABLE_CACHE === "1" ||
    process.argv.some((a) => a.includes("test"));

  const now = Date.now();
  if (!isTest) {
    const cached = deviceAuthCache.get(personnelId);
    if (cached && now - cached.cachedAt < DEVICE_AUTH_CACHE_TTL_MS) {
      return { personnel: cached.personnel, device: cached.device, session: cached.session };
    }
  }

  tursoBudgetTracker.recordQuery("telemetry_ingestion", 3);
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

  if (!isTest) {
    deviceAuthCache.set(personnelId, {
      personnel,
      device,
      session,
      cachedAt: now,
    });
  }

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

  const isTest =
    process.env.NODE_ENV === "test" ||
    process.env.DISABLE_CACHE === "1" ||
    process.argv.some((a) => a.includes("test"));

  const nowMs = Date.now();
  let activeSOS: any = null;
  if (!isTest) {
    const cachedSOS = activeSOSCache.get(personnelId);
    if (cachedSOS && nowMs - cachedSOS.cachedAt < SOS_CACHE_TTL_MS) {
      activeSOS = cachedSOS.activeSOS;
    }
  }

  if (activeSOS === null) {
    tursoBudgetTracker.recordQuery("telemetry_ingestion", 1);
    activeSOS = await prisma.sOSEvent.findFirst({
      where: { personnelId, endedAt: null, status: "ACTIVE" }
    });
    if (!isTest) {
      activeSOSCache.set(personnelId, { activeSOS, cachedAt: nowMs });
    }
  }

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

  console.log(
    `[Telemetry Ingestion] Device ${device.deviceIdentifier} (Personnel ${personnelId}): Lat=${input.latitude.toFixed(5)}, Lon=${input.longitude.toFixed(5)}, Acc=±${input.accuracy.toFixed(1)}m, Source=${input.source}, UpdateLive=${shouldUpdateDevicePosition}`
  );

  // 10-second historical trail recording interval guard:
  // Persist one historical trail point approximately every 10 seconds (10,000 ms).
  // Avoid creating duplicate historical records from repeated heartbeats or identical updates within the same interval.
  const intervalThresholdMs = process.env.TRAIL_RECORDING_INTERVAL_MS !== undefined
    ? Number(process.env.TRAIL_RECORDING_INTERVAL_MS)
    : 8 * 1000; // 8 seconds default (buffer for 10-second sampling)

  if (actualTrackingMode !== "SOS" && intervalThresholdMs > 0) {
    let lastRecorded = lastRecordedLocationMap.get(personnelId);
    if (!lastRecorded && device.latestLocationTime) {
      lastRecorded = {
        id: `prev-${device.id}`,
        recordedAtMs: new Date(device.latestLocationTime).getTime(),
      };
      lastRecordedLocationMap.set(personnelId, lastRecorded);
    }

    if (!lastRecorded) {
      tursoBudgetTracker.recordQuery("telemetry_ingestion", 1);
      const lastInDb = await prisma.location.findFirst({
        where: {
          personnelId,
        },
        orderBy: { recordedAt: "desc" },
        select: { id: true, recordedAt: true },
      });
      if (lastInDb) {
        lastRecorded = {
          id: lastInDb.id,
          recordedAtMs: new Date(lastInDb.recordedAt).getTime(),
        };
        lastRecordedLocationMap.set(personnelId, lastRecorded);
      }
    }

    if (lastRecorded) {
      const pointTimeMs = new Date(input.recordedAt).getTime();
      const elapsedMs = Math.abs(pointTimeMs - lastRecorded.recordedAtMs);
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

        // Update cached device in memory
        const cachedAuth = deviceAuthCache.get(personnelId);
        if (cachedAuth && cachedAuth.device) {
          Object.assign(cachedAuth.device, updateData);
        }

        return {
          status: "deduplicated",
          locationId: lastRecorded.id,
          receivedAt: new Date(),
          message: "Latest position updated; historical trail point preserved on 10-second interval",
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

    // Update in-memory last recorded tracker
    lastRecordedLocationMap.set(personnelId, {
      id: location.id,
      recordedAtMs: new Date(input.recordedAt).getTime(),
    });

    // Always touch device's lastSeenAt and latest position if fresh
    const deviceUpdateData: any = {
      lastSeenAt: serverNow,
      lastHeartbeatAt: serverNow,
      status: "ACTIVE",
      batteryLevel: input.batteryLevel !== undefined ? input.batteryLevel : device.batteryLevel,
      networkState: input.networkState || device.networkState,
    };
    if (shouldUpdateDevicePosition) {
      deviceUpdateData.latestLatitude = input.latitude;
      deviceUpdateData.latestLongitude = input.longitude;
      deviceUpdateData.latestAccuracy = input.accuracy;
      deviceUpdateData.latestSource = input.source;
      deviceUpdateData.latestLocationTime = input.recordedAt;
    }

    await prisma.device.update({
      where: { id: device.id },
      data: deviceUpdateData,
    });

    // Update cached device in memory
    const cachedAuth = deviceAuthCache.get(personnelId);
    if (cachedAuth && cachedAuth.device) {
      Object.assign(cachedAuth.device, deviceUpdateData);
    }

    return { status: "accepted", locationId: location.id, receivedAt: location.receivedAt };
  } catch (error: unknown) {
    if ((error as any)?.message?.includes("UNIQUE constraint failed") || (error as any)?.code === "P2002") {
      tursoBudgetTracker.recordQuery("telemetry_ingestion", 1);
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

    // Crucial: Invalidate overview cache on genuine state-changing event
    invalidateDashboardCache();

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
      tursoBudgetTracker.recordQuery("telemetry_ingestion", 1);
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

  const isTest =
    process.env.NODE_ENV === "test" ||
    process.env.DISABLE_CACHE === "1" ||
    process.argv.some((a) => a.includes("test"));

  const nowMs = Date.now();
  let activeSOS: any = null;
  if (!isTest) {
    const cachedSOS = activeSOSCache.get(personnelId);
    if (cachedSOS && nowMs - cachedSOS.cachedAt < SOS_CACHE_TTL_MS) {
      activeSOS = cachedSOS.activeSOS;
    }
  }

  if (activeSOS === null) {
    tursoBudgetTracker.recordQuery("telemetry_ingestion", 1);
    activeSOS = await prisma.sOSEvent.findFirst({
      where: { personnelId, endedAt: null, status: "ACTIVE" }
    });
    if (!isTest) {
      activeSOSCache.set(personnelId, { activeSOS, cachedAt: nowMs });
    }
  }

  const actualTrackingMode = activeSOS ? "SOS" : "NORMAL";

  const results = {
    locations: [] as unknown as Record<string, unknown>[],
    events: [] as unknown as Record<string, unknown>[]
  };

  if (input.locations && input.locations.length > 0) {
    const intervalThresholdMs = process.env.TRAIL_RECORDING_INTERVAL_MS !== undefined
      ? Number(process.env.TRAIL_RECORDING_INTERVAL_MS)
      : 8 * 1000; // 8 seconds default (buffer for 10-second sampling)

    let lastAcceptedTimeMs: number | null = null;
    if (actualTrackingMode !== "SOS" && intervalThresholdMs > 0) {
      const inMemory = lastRecordedLocationMap.get(personnelId);
      if (inMemory) {
        lastAcceptedTimeMs = inMemory.recordedAtMs;
      } else if (device.latestLocationTime) {
        lastAcceptedTimeMs = new Date(device.latestLocationTime).getTime();
        lastRecordedLocationMap.set(personnelId, {
          id: `prev-${device.id}`,
          recordedAtMs: lastAcceptedTimeMs,
        });
      } else {
        tursoBudgetTracker.recordQuery("telemetry_ingestion", 1);
        const lastInDb = await prisma.location.findFirst({
          where: { personnelId },
          orderBy: { recordedAt: "desc" },
          select: { recordedAt: true },
        });
        if (lastInDb) {
          lastAcceptedTimeMs = new Date(lastInDb.recordedAt).getTime();
          lastRecordedLocationMap.set(personnelId, {
            id: `prev-${device.id}`,
            recordedAtMs: lastAcceptedTimeMs,
          });
        }
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
            message: "Location within 10-second trail interval deduplicated",
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
        lastRecordedLocationMap.set(personnelId, {
          id: location.id,
          recordedAtMs: lastAcceptedTimeMs,
        });
        results.locations.push({ clientEventId: loc.clientEventId, status: "accepted", locationId: location.id, receivedAt: location.receivedAt });
      } catch (err: unknown) {
        if ((err as any)?.message?.includes("UNIQUE constraint failed") || (err as any)?.code === "P2002") {
          tursoBudgetTracker.recordQuery("telemetry_ingestion", 1);
          const existing = await prisma.location.findUnique({ where: { clientEventId: loc.clientEventId } });
          results.locations.push({ clientEventId: loc.clientEventId, status: "deduplicated", locationId: existing?.id, receivedAt: existing?.receivedAt });
        } else {
          results.locations.push({ clientEventId: loc.clientEventId, status: "error", error: (err as any)?.message });
        }
      }
    }

    // Update device position and always touch lastSeenAt/lastHeartbeatAt/status: ACTIVE
    // so incoming batch immediately marks device ONLINE
    const deviceBatchUpdate: any = {
      lastSeenAt: serverNow,
      lastHeartbeatAt: serverNow,
      status: "ACTIVE",
    };

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
        console.log(
          `[Batch Ingestion] Device ${device.deviceIdentifier}: Updating latest position -> Lat=${latestBatchLoc.latitude.toFixed(5)}, Lon=${latestBatchLoc.longitude.toFixed(5)}, Acc=±${latestBatchLoc.accuracy.toFixed(1)}m, Source=${latestBatchLoc.source}`
        );
        deviceBatchUpdate.latestLatitude = latestBatchLoc.latitude;
        deviceBatchUpdate.latestLongitude = latestBatchLoc.longitude;
        deviceBatchUpdate.latestAccuracy = latestBatchLoc.accuracy;
        deviceBatchUpdate.latestLocationTime = new Date(latestBatchLoc.recordedAt);
        deviceBatchUpdate.latestSource = latestBatchLoc.source;
      }
    }

    await prisma.device.update({
      where: { id: device.id },
      data: deviceBatchUpdate,
    });

    // Update cached device in memory
    const cachedAuth = deviceAuthCache.get(personnelId);
    if (cachedAuth && cachedAuth.device) {
      Object.assign(cachedAuth.device, deviceBatchUpdate);
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
