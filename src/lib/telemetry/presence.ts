export interface DeviceMemoryPresence {
  lastSeenAt: Date;
  batteryLevel?: number | null;
  networkState?: string | null;
}

export const deviceHeartbeatMemoryMap = new Map<string, DeviceMemoryPresence>();
