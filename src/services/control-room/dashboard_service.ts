import { tursoBudgetTracker } from "@/lib/turso/budget";
import { prisma } from "@/lib/prisma";
import {
  getHeartbeatTimeoutMs,
  getHeartbeatStaleMs,
  getLocationStaleMs,
} from "@/lib/config/inactivity";
import {
  getDutyCurrentTime,
  isWithinDutyWindowIST,
  isSameDayIST,
} from "@/lib/utils/duty_window";

// Short-lived in-memory cache partitioned by scope to prevent cross-admin data leakage
const cachedOverviewMap = new Map<string, { data: any[]; timestamp: number }>();
const inFlightOverviewMap = new Map<string, Promise<any[]>>();
const CACHE_TTL_MS = 6000; // 6 seconds (aligns with 10s SSE / polling while sharing data across tabs)

// In-memory cache for recent location events (rare events, 30s TTL)
let cachedRecentEvents: { data: any[]; timestamp: number } | null = null;
const EVENTS_CACHE_TTL_MS = 30_000;

export function invalidateDashboardCache(scopedAdminId?: string) {
  cachedRecentEvents = null;
  if (scopedAdminId) {
    cachedOverviewMap.delete(scopedAdminId);
    cachedOverviewMap.delete("GLOBAL");
  } else {
    cachedOverviewMap.clear();
  }
}

export async function getDashboardOverview(forceFresh: boolean = false, scopedAdminId?: string | null) {
  const scopeKey = scopedAdminId || "GLOBAL";
  const dutyNow = getDutyCurrentTime();
  const now = dutyNow.getTime();
  const isDutyHours = isWithinDutyWindowIST(dutyNow);
  const isTest =
    process.env.NODE_ENV === "test" ||
    process.env.DISABLE_CACHE === "1" ||
    process.argv.some((a) => a.includes("test"));

  const cached = cachedOverviewMap.get(scopeKey);
  if (!isTest && !forceFresh && cached && now - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }

  // Single-Flight: Coalesce concurrent calls for the same scope into one query
  if (!isTest && !forceFresh && inFlightOverviewMap.has(scopeKey)) {
    return await inFlightOverviewMap.get(scopeKey)!;
  }

  const LOC_STALE_THRESHOLD_MS = getLocationStaleMs(); // 7 mins default (5-min interval + 2-min buffer)
  const HB_TIMEOUT_MS = getHeartbeatTimeoutMs(); // 2 mins default
  const HB_STALE_THRESHOLD_MS = getHeartbeatStaleMs(); // 75 secs default

  tursoBudgetTracker.recordQuery("dashboard_overview", 15);
  // Single efficient query using indexed filters and selecting ONLY necessary columns, scoped to owning admin
  const personnelList = await prisma.personnel.findMany({
    where: {
      active: true,
      ...(scopedAdminId ? { adminId: scopedAdminId } : {}),
    },
    select: {
      id: true,
      name: true,
      personnelCode: true,
      designation: true,
      unit: true,
      devices: {
        orderBy: { registeredAt: "desc" },
        take: 1,
        select: {
          id: true,
          deviceIdentifier: true,
          status: true,
          lastSeenAt: true,
          lastHeartbeatAt: true,
          batteryLevel: true,
          networkState: true,
          latestLatitude: true,
          latestLongitude: true,
          latestAccuracy: true,
          latestSource: true,
          latestLocationTime: true,
          locationEnabled: true,
          permissionState: true,
          isTrackingRunning: true,
          gpsAvailable: true,
          lastGpsFixTime: true,
        },
      },
      dutySessions: {
        where: { endedAt: null },
        take: 1,
        select: { id: true, status: true, startedAt: true },
      },
      sosEvents: {
        where: { status: "ACTIVE" },
        take: 1,
        select: {
          id: true,
          alerts: {
            where: { status: { not: "RESOLVED" } },
            take: 1,
            select: { id: true },
          },
        },
      },
    },
  });

  // Check if any active device is missing latest fields (e.g. legacy test records)
  const legacyLocIds = personnelList
    .filter((p) => p.devices[0] && p.devices[0].latestLatitude == null)
    .map((p) => p.id);

  let legacyLocMap = new Map<string, any>();
  if (legacyLocIds.length > 0) {
    const rawLegacy = await prisma.location.findMany({
      where: { personnelId: { in: legacyLocIds } },
      orderBy: { recordedAt: "desc" },
      take: legacyLocIds.length * 2,
    });
    for (const l of rawLegacy) {
      if (!legacyLocMap.has(l.personnelId)) {
        legacyLocMap.set(l.personnelId, l);
      }
    }
  }

  // Also check if any recent location event exists (e.g. LOCATION_UNAVAILABLE)
  const activePersonnelIds = personnelList.map((p) => p.id);
  let recentEvents: any[] = [];
  if (!isTest && cachedRecentEvents && now - cachedRecentEvents.timestamp < EVENTS_CACHE_TTL_MS) {
    recentEvents = cachedRecentEvents.data;
  } else {
    tursoBudgetTracker.recordQuery("dashboard_overview", 5);
    recentEvents = await prisma.locationEvent.findMany({
      where: {
        personnelId: { in: activePersonnelIds },
        recordedAt: { gte: new Date(now - 15 * 60 * 1000) }, // last 15 mins only
      },
      orderBy: { recordedAt: "desc" },
      take: 50,
    });
    if (!isTest) {
      cachedRecentEvents = { data: recentEvents, timestamp: now };
    }
  }

  const evMap = new Map<string, any>();
  for (const ev of recentEvents) {
    if (!evMap.has(ev.personnelId)) {
      evMap.set(ev.personnelId, ev);
    }
  }

  const result = personnelList.map((p) => {
    const primaryDevice = p.devices[0] || null;
    const activeDuty = p.dutySessions[0] || null;
    const activeSOS = p.sosEvents[0] || null;
    const ev = evMap.get(p.id);

    const isDeviceSignedOut = !primaryDevice || primaryDevice.status === "INACTIVE";

    // Latest location: prioritize single latest-position record on Device, fallback to legacy
    let loc: any = null;
    if (primaryDevice && primaryDevice.latestLatitude != null) {
      loc = {
        latitude: primaryDevice.latestLatitude,
        longitude: primaryDevice.latestLongitude,
        accuracy: primaryDevice.latestAccuracy,
        source: primaryDevice.latestSource || "GPS",
        recordedAt: primaryDevice.latestLocationTime || primaryDevice.lastSeenAt,
        batteryLevel: primaryDevice.batteryLevel,
      };
    } else {
      loc = legacyLocMap.get(p.id) || null;
    }

    const locTime = loc?.recordedAt ? new Date(loc.recordedAt).getTime() : 0;
    const evTime = ev ? new Date(ev.recordedAt).getTime() : 0;

    // Latest heartbeat: from Device record
    const hbRecordedAt = primaryDevice?.lastHeartbeatAt || primaryDevice?.lastSeenAt || null;
    const hbTime = hbRecordedAt ? new Date(hbRecordedAt).getTime() : 0;

    // Device & Network Connection Status
    let deviceStatus = "ONLINE";
    let networkStatus = "ONLINE";
    let lastHeartbeat: Date | null = null;

    if (isDeviceSignedOut) {
      deviceStatus = "OFFLINE";
      networkStatus = "OFFLINE";
    } else if (hbRecordedAt) {
      lastHeartbeat = new Date(hbRecordedAt);
      const hbDiff = now - hbTime;
      if (hbDiff > HB_TIMEOUT_MS) {
        deviceStatus = "OFFLINE";
        networkStatus = "OFFLINE";
      } else if (hbDiff > HB_STALE_THRESHOLD_MS) {
        deviceStatus = "STALE";
        networkStatus = primaryDevice.networkState === "OFFLINE" ? "OFFLINE" : "ONLINE";
      } else {
        deviceStatus = "ONLINE";
        networkStatus = primaryDevice.networkState === "OFFLINE" ? "OFFLINE" : "ONLINE";
      }
    } else {
      deviceStatus = "OFFLINE";
      networkStatus = "OFFLINE";
    }

    // Explicit network lost or signout events still trump normal status if recent
    if (
      ev &&
      (ev.eventType === "NETWORK_LOST" || ev.eventType === "LOCATION_UNAVAILABLE") &&
      evTime > hbTime
    ) {
      networkStatus = "OFFLINE";
      deviceStatus = "OFFLINE";
    }

    // Last Contact Timestamp: reflects latest valid interaction
    let lastSeen: Date | null = null;
    const latestActiveTime = Math.max(locTime, evTime, hbTime);
    if (latestActiveTime > 0) {
      lastSeen = new Date(latestActiveTime);
    }

    // Detailed Tracking Status hierarchy:
    // - "GPS ACTIVE": Recent valid GPS fix
    // - "NETWORK LOCATION": Recent valid network fix
    // - "LOCATION OFF": Android reports system Location disabled
    // - "PERMISSION DENIED": Required location permission missing
    // - "GPS UNAVAILABLE": Location enabled but no valid GPS fix available
    // - "INTERNET DISCONNECTED": Device reported network loss
    // - "TRACKING INTERRUPTED": Tracking service stopped or device signed out
    // - "STALE / OFFLINE": No recent heartbeat; device unreachable
    // - "OUTSIDE DUTY HOURS": Outside 07:00–22:00 IST

    let trackingStatus = "STALE / OFFLINE";
    let statusReason = "No telemetry received";
    let confirmedByDevice = false;

    if (!isDutyHours) {
      trackingStatus = "OUTSIDE DUTY HOURS";
      statusReason = "Outside permitted duty window (07:00 AM – 07:00 PM IST)";
    } else if (isDeviceSignedOut) {
      trackingStatus = "TRACKING INTERRUPTED";
      statusReason = "Device is signed out or inactive";
      confirmedByDevice = true;
    } else if (deviceStatus === "OFFLINE") {
      if (primaryDevice?.networkState === "OFFLINE") {
        trackingStatus = "INTERNET DISCONNECTED";
        statusReason = "Device reported network disconnected";
        confirmedByDevice = true;
      } else {
        trackingStatus = "STALE / OFFLINE";
        statusReason = `No heartbeat received within ${Math.round(HB_TIMEOUT_MS / 60000)} minutes`;
        confirmedByDevice = false;
      }
    } else {
      // Device is ONLINE, check confirmed device-reported telemetry
      confirmedByDevice = true;
      if (primaryDevice?.locationEnabled === false) {
        trackingStatus = "LOCATION OFF";
        statusReason = "Device location is disabled in Android Settings";
      } else if (primaryDevice?.permissionState === "DENIED") {
        trackingStatus = "PERMISSION DENIED";
        statusReason = "Required location permissions are denied or revoked";
      } else if (primaryDevice?.isTrackingRunning === false) {
        trackingStatus = "TRACKING INTERRUPTED";
        statusReason = "Location tracking service has stopped";
      } else if (loc && (now - locTime <= LOC_STALE_THRESHOLD_MS)) {
        if (loc.source === "NETWORK") {
          trackingStatus = "NETWORK LOCATION";
          statusReason = `Approximate network-based fix (±${Math.round(loc.accuracy)}m)`;
        } else {
          trackingStatus = "GPS ACTIVE";
          statusReason = `Verified GPS satellite fix (±${Math.round(loc.accuracy)}m)`;
        }
      } else if (primaryDevice?.gpsAvailable === false || (ev && ev.eventType === "LOCATION_UNAVAILABLE" && evTime >= locTime)) {
        trackingStatus = "GPS UNAVAILABLE";
        statusReason = "Location enabled but GPS provider fix is unavailable";
      } else if (loc) {
        trackingStatus = "GPS UNAVAILABLE";
        statusReason = "Awaiting fresh location fix (previous fix stale)";
      } else {
        trackingStatus = "GPS UNAVAILABLE";
        statusReason = "Awaiting initial location fix from device";
      }
    }

    // Determine locationStatus (for backward compatibility and live map filters):
    let locationStatus = "LOCATION UNAVAILABLE";
    if (trackingStatus === "GPS ACTIVE" || trackingStatus === "NETWORK LOCATION") {
      locationStatus = "TRACKING ACTIVE";
    } else if (!activeDuty) {
      locationStatus = "OFF DUTY";
    } else if (deviceStatus === "STALE" || trackingStatus === "STALE / OFFLINE") {
      locationStatus = "STALE";
    } else {
      locationStatus = "LOCATION UNAVAILABLE";
    }

    // Assess GPS accuracy rating and age
    const accuracy = loc?.accuracy != null ? Number(loc.accuracy) : null;
    let accuracyRating: "OPTIMAL" | "MODERATE" | "COARSE" | null = null;
    let accuracyAgeSeconds: number | null = null;

    if (loc) {
      const recTime = new Date(loc.recordedAt as any).getTime();
      accuracyAgeSeconds = Math.max(0, Math.floor((now - recTime) / 1000));
    }

    if (accuracy !== null) {
      if (accuracy <= 10.0) accuracyRating = "OPTIMAL";
      else if (accuracy <= 20.0) accuracyRating = "MODERATE"; // Verified target <= 20m
      else accuracyRating = "COARSE"; // > 20m is Low Accuracy
    }

    const lastGpsFixTime = primaryDevice?.lastGpsFixTime
      ? new Date(primaryDevice.lastGpsFixTime)
      : loc?.source === "GPS"
        ? new Date(loc.recordedAt)
        : null;

    return {
      id: p.id,
      name: p.name,
      personnelCode: p.personnelCode,
      designation: p.designation,
      unit: p.unit,
      dutyStatus: activeDuty ? "ON DUTY" : "OFF DUTY",
      locationStatus,
      trackingStatus,
      statusReason,
      confirmedByDevice,
      deviceStatus,
      networkStatus,
      sosStatus: activeSOS ? "SOS ACTIVE" : "NONE",
      lastSeen,
      lastHeartbeat,
      lastGpsFixTime,
      lastKnownLocationAgeSeconds: accuracyAgeSeconds,
      location: loc
        ? {
            latitude: loc.latitude,
            longitude: loc.longitude,
            accuracy: loc.accuracy,
            accuracyRating,
            accuracyAgeSeconds,
            source: loc.source,
            recordedAt: new Date(loc.recordedAt as any),
          }
        : null,
      device: primaryDevice
        ? {
            identifier: primaryDevice.deviceIdentifier,
            batteryLevel: loc?.batteryLevel ?? primaryDevice.batteryLevel ?? null,
            status: deviceStatus,
          }
        : null,
      activeSOSId: activeSOS?.id ?? null,
      activeAlertId: activeSOS?.alerts?.[0]?.id ?? null,
    };
  });

  cachedOverviewMap.set(scopeKey, {
    data: result,
    timestamp: now,
  });

  return result;
}
