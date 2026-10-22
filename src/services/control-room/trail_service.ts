import { prisma } from "@/lib/prisma";
import { getISTDayRange } from "@/lib/utils/time";

export interface TrailPoint {
  id: string;
  latitude: number;
  longitude: number;
  accuracy: number;
  recordedAt: Date;
  trackingMode: string;
  source: string;
  dutySessionId: string | null;
  speedKmh?: number | null;
  isAnomaly?: boolean;
}

export interface TrackingGap {
  startTime: Date;
  endTime: Date;
  durationMinutes: number;
}

export interface RouteSummary {
  totalPoints: number;
  verifiedPointsCount: number; // <= 20m
  optimalPointsCount: number; // <= 10m
  coarsePointsCount: number; // > 20m
  estimatedDistanceKm: number;
  firstRecordedAt: Date | null;
  lastRecordedAt: Date | null;
  dutyStart: Date | null;
  dutyEnd: Date | null;
  dutyDurationMinutes: number | null;
  longestGapMinutes: number;
  gapCount: number;
  jumpAnomaliesCount: number;
}

export interface StaffTrailResult {
  personnel: {
    id: string;
    name: string;
    personnelCode: string;
    designation: string | null;
    unit: string | null;
    active: boolean;
  };
  sessions: {
    id: string;
    status: string;
    startedAt: Date;
    endedAt: Date | null;
  }[];
  locations: TrailPoint[];
  summary: RouteSummary;
  trackingGaps: TrackingGap[];
}

/**
 * Calculates geodesic haversine distance between two coordinates in meters.
 */
export function haversineDistanceMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371000; // Earth radius in meters
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Fetches and analyzes chronological location trail for a staff member.
 */
export async function getStaffLocationTrail(
  personnelId: string,
  options: {
    dateStr?: string;
    startTime?: Date;
    endTime?: Date;
    dutySessionId?: string;
  }
): Promise<StaffTrailResult> {
  const personnel = await prisma.personnel.findUnique({
    where: { id: personnelId },
    select: {
      id: true,
      name: true,
      personnelCode: true,
      designation: true,
      unit: true,
      active: true,
    },
  });

  const personnelObj = personnel || {
    id: personnelId,
    name: "Field Officer",
    personnelCode: personnelId,
    designation: null,
    unit: null,
    active: false,
  };

  let rangeStart: Date;
  let rangeEnd: Date;

  if (options.dateStr) {
    const range = getISTDayRange(options.dateStr);
    rangeStart = range.startTime;
    rangeEnd = range.endTime;
  } else if (options.startTime && options.endTime) {
    rangeStart = options.startTime;
    rangeEnd = options.endTime;
  } else {
    // Default to today in IST
    const now = new Date();
    const istDate = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Kolkata",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
    const range = getISTDayRange(istDate);
    rangeStart = range.startTime;
    rangeEnd = range.endTime;
  }

  // Fetch duty sessions overlapping this date range
  const sessions = await prisma.dutySession.findMany({
    where: {
      personnelId,
      OR: [
        { startedAt: { lte: rangeEnd }, endedAt: { gte: rangeStart } },
        { startedAt: { gte: rangeStart, lte: rangeEnd } },
        { startedAt: { lte: rangeEnd }, endedAt: null },
      ],
    },
    orderBy: { startedAt: "asc" },
    select: {
      id: true,
      status: true,
      startedAt: true,
      endedAt: true,
    },
  });

  // Build location query
  const whereClause: any = {
    personnelId,
    recordedAt: {
      gte: rangeStart,
      lte: rangeEnd,
    },
  };

  if (options.dutySessionId) {
    whereClause.dutySessionId = options.dutySessionId;
  }

  const rawLocations = await prisma.location.findMany({
    where: whereClause,
    orderBy: { recordedAt: "asc" },
    take: 5000, // Safe limit covering 14+ hours of 5-sec updates
    select: {
      id: true,
      latitude: true,
      longitude: true,
      accuracy: true,
      recordedAt: true,
      trackingMode: true,
      source: true,
      dutySessionId: true,
    },
  });

  // Analyze trail points, calculate distance with jump-filter, and detect tracking gaps
  let totalDistanceMeters = 0;
  let verifiedPointsCount = 0;
  let optimalPointsCount = 0;
  let coarsePointsCount = 0;
  let jumpAnomaliesCount = 0;
  let longestGapMinutes = 0;

  const trackingGaps: TrackingGap[] = [];
  const processedLocations: TrailPoint[] = [];

  let lastValidLocation: any = null;

  for (let i = 0; i < rawLocations.length; i++) {
    const curr = rawLocations[i];
    const acc = Number(curr.accuracy);

    if (acc <= 10) optimalPointsCount++;
    if (acc <= 20) verifiedPointsCount++;
    if (acc > 20) coarsePointsCount++;

    let speedKmh: number | null = null;
    let isAnomaly = false;

    if (i > 0) {
      const prev = rawLocations[i - 1];
      const timeDiffSec =
        (new Date(curr.recordedAt).getTime() - new Date(prev.recordedAt).getTime()) / 1000;

      // Gap detection: gap occurs when elapsed time between recorded fixes exceeds 35 minutes (missed scheduled 30-minute fix + 5 min buffer)
      if (timeDiffSec > 0) {
        const gapMin = timeDiffSec / 60;
        const gapThresholdMin = process.env.TRACKING_GAP_THRESHOLD_MINUTES
          ? Number(process.env.TRACKING_GAP_THRESHOLD_MINUTES)
          : 35;
        if (gapMin >= gapThresholdMin) {
          trackingGaps.push({
            startTime: new Date(prev.recordedAt),
            endTime: new Date(curr.recordedAt),
            durationMinutes: Math.round(gapMin),
          });
          if (gapMin > longestGapMinutes) {
            longestGapMinutes = Math.round(gapMin);
          }
        }
      }

      // Distance calculation against last known valid (non-teleported) coordinate
      if (lastValidLocation && timeDiffSec > 0) {
        const distFromValid = haversineDistanceMeters(
          lastValidLocation.latitude,
          lastValidLocation.longitude,
          curr.latitude,
          curr.longitude
        );
        const elapsedSinceValid =
          (new Date(curr.recordedAt).getTime() - new Date(lastValidLocation.recordedAt).getTime()) / 1000;

        if (elapsedSinceValid > 0) {
          speedKmh = (distFromValid / elapsedSinceValid) * 3.6;

          // GPS Jump filter:
          // Exclude teleports: speed > 150 km/h or massive hops (> 3000m in < 60s) or accuracy > 100m
          if (speedKmh > 150 || (distFromValid > 3000 && elapsedSinceValid < 60) || acc > 100) {
            isAnomaly = true;
            jumpAnomaliesCount++;
          } else {
            totalDistanceMeters += distFromValid;
            lastValidLocation = curr;
          }
        }
      } else if (!lastValidLocation && acc <= 100) {
        lastValidLocation = curr;
      }
    } else {
      if (acc <= 100) {
        lastValidLocation = curr;
      }
    }

    processedLocations.push({
      id: curr.id,
      latitude: curr.latitude,
      longitude: curr.longitude,
      accuracy: acc,
      recordedAt: new Date(curr.recordedAt),
      trackingMode: curr.trackingMode,
      source: curr.source,
      dutySessionId: curr.dutySessionId,
      speedKmh: speedKmh != null ? Math.round(speedKmh * 10) / 10 : null,
      isAnomaly,
    });
  }

  // Duty times
  let dutyStart: Date | null = null;
  let dutyEnd: Date | null = null;
  let dutyDurationMinutes: number | null = null;

  if (sessions.length > 0) {
    dutyStart = sessions[0].startedAt;
    const lastSession = sessions[sessions.length - 1];
    dutyEnd = lastSession.endedAt;
    const endMs = dutyEnd ? new Date(dutyEnd).getTime() : Date.now();
    dutyDurationMinutes = Math.max(
      0,
      Math.round((endMs - new Date(dutyStart).getTime()) / 60000)
    );
  }

  const summary: RouteSummary = {
    totalPoints: rawLocations.length,
    verifiedPointsCount,
    optimalPointsCount,
    coarsePointsCount,
    estimatedDistanceKm: Math.round((totalDistanceMeters / 1000) * 100) / 100,
    firstRecordedAt: rawLocations.length > 0 ? new Date(rawLocations[0].recordedAt) : null,
    lastRecordedAt:
      rawLocations.length > 0
        ? new Date(rawLocations[rawLocations.length - 1].recordedAt)
        : null,
    dutyStart,
    dutyEnd,
    dutyDurationMinutes,
    longestGapMinutes,
    gapCount: trackingGaps.length,
    jumpAnomaliesCount,
  };

  return {
    personnel: personnelObj,
    sessions,
    locations: processedLocations,
    summary,
    trackingGaps,
  };
}
