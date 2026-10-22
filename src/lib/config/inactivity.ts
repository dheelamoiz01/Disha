/**
 * Server-side inactivity detection thresholds for field personnel and devices.
 * Configurable via environment variables with production defaults.
 */

// Heartbeat interval from Android client is 10 seconds.
// A 1-minute (60s) timeout represents 6 consecutively missed heartbeats.
export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 1000 * 60; // 60 seconds (1 minute)

// 25 seconds represents 2 missed 10s heartbeats + 5s network latency buffer.
export const DEFAULT_HEARTBEAT_STALE_MS = 1000 * 25; // 25 seconds

// 45 seconds for location telemetry freshness (accommodates 10-second trail recording interval + 35-second buffer).
export const DEFAULT_LOCATION_STALE_MS = 1000 * 45; // 45 seconds

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
