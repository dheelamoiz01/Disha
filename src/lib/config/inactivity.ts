/**
 * Server-side inactivity detection thresholds for field personnel and devices.
 * Configurable via environment variables with production defaults.
 */

// Heartbeat interval from Android client is 10-15 seconds.
// Realistic thresholds for mobile networks with 4G/5G handoffs, elevators, and battery saver jitter:
// 180 seconds (3 minutes) represents ~18 missed 10s heartbeats before OFFLINE
export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 1000 * 180; // 180 seconds (3 minutes)

// 90 seconds represents ~9 missed 10s heartbeats before STALE
export const DEFAULT_HEARTBEAT_STALE_MS = 1000 * 90; // 90 seconds

// 120 seconds (2 minutes) for location telemetry freshness buffer
export const DEFAULT_LOCATION_STALE_MS = 1000 * 120; // 120 seconds (2 minutes)

export function getHeartbeatTimeoutMs(): number {
  const envVal = process.env.HEARTBEAT_TIMEOUT_MS;
  if (envVal) {
    const parsed = Number(envVal);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_HEARTBEAT_TIMEOUT_MS;
}

export function getHeartbeatStaleMs(): number {
  const envVal = process.env.HEARTBEAT_STALE_THRESHOLD_MS;
  if (envVal) {
    const parsed = Number(envVal);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_HEARTBEAT_STALE_MS;
}

export function getLocationStaleMs(): number {
  const envVal = process.env.LOCATION_STALE_THRESHOLD_MS;
  if (envVal) {
    const parsed = Number(envVal);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_LOCATION_STALE_MS;
}
