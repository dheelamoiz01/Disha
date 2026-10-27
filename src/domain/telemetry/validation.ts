import { z } from "zod";
import { LocationSource, TrackingMode, LocationEventType } from "../../../generated/prisma/enums";

export const MAX_BATCH_SIZE = 100; // Bounded to 100 items per batch to prevent long-running serverless executions
export const MAX_FUTURE_TOLERANCE_MS = 1000 * 60 * 5; // 5 minutes (clock drift)
export const MAX_PAST_TOLERANCE_MS = 1000 * 60 * 60 * 24 * 7; // 7 days (offline queue limit)

// Common schema fields
const clientEventId = z.string().min(1).max(128);
const recordedAt = z.coerce.date().refine(
  (date) => {
    const now = Date.now();
    const time = date.getTime();
    return time <= now + MAX_FUTURE_TOLERANCE_MS && time >= now - MAX_PAST_TOLERANCE_MS;
  },
  { message: "recordedAt is outside acceptable tolerance (max 7 days past, 5 mins future)" }
);

// Flexible source schema that gracefully normalizes Fused/Cellular/WiFi identifiers into LocationSource enum
const locationSourceSchema = z.preprocess((val) => {
  if (typeof val === "string") {
    const upper = val.toUpperCase().trim();
    if (upper === "GPS" || upper === "FUSED" || upper === "FUSED_LAST_KNOWN") return LocationSource.GPS;
    if (upper === "NETWORK" || upper === "CELLULAR" || upper === "WIFI") return LocationSource.NETWORK;
  }
  return val;
}, z.nativeEnum(LocationSource)).default(LocationSource.UNKNOWN);

// Graceful battery schema: clamps out-of-range OEM charger percentages (e.g. 101%, 100.5%) safely to 100
const batteryLevelSchema = z.preprocess((val) => {
  if (typeof val === "number") {
    if (isNaN(val)) return null;
    return Math.max(0, Math.min(100, Math.round(val)));
  }
  return val;
}, z.number().min(0).max(100).nullable().optional());

// Graceful accuracy schema: ensures non-negative numbers and recovers from NaN
const accuracySchema = z.preprocess((val) => {
  if (typeof val === "number") {
    if (isNaN(val) || val < 0) return 0;
    return val;
  }
  return val;
}, z.number().min(0));

export const singleLocationSchema = z.object({
  clientEventId,
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  accuracy: accuracySchema,
  recordedAt,
  source: locationSourceSchema,
  trackingMode: z.nativeEnum(TrackingMode).default(TrackingMode.NORMAL),
  batteryLevel: batteryLevelSchema,
  networkState: z.string().max(50).nullable().optional(),
});

export const locationEventSchema = z.object({
  clientEventId,
  eventType: z.nativeEnum(LocationEventType),
  recordedAt,
  metadata: z.record(z.string(), z.any()).nullable().optional(),
});

export const batchIngestionSchema = z.object({
  locations: z.array(singleLocationSchema).max(MAX_BATCH_SIZE).optional(),
  events: z.array(locationEventSchema).max(MAX_BATCH_SIZE).optional(),
});

export type SingleLocationInput = z.infer<typeof singleLocationSchema>;
export type LocationEventInput = z.infer<typeof locationEventSchema>;
export type BatchIngestionInput = z.infer<typeof batchIngestionSchema>;
