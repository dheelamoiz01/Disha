/**
 * Server-side inactivity detection thresholds for field personnel and devices.
 * Configurable via environment variables with production defaults.
 */

// Heartbeat interval from Android client is 30 seconds.
// A 2-minute (120s) timeout represents 4 consecutively missed heartbeats.
export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 1000 * 60 * 2; // 2 minutes

// 45 seconds represents 1 missed 30s heartbeat + 15s network latency buffer.
export const DEFAULT_HEARTBEAT_STALE_MS = 1000 * 45; // 45 seconds

// 2 minutes for location telemetry freshness (accommodates 30-second trail recording interval + 90-second buffer).
export const DEFAULT_LOCATION_STALE_MS = 1000 * 60 * 2; // 2 minutes

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
