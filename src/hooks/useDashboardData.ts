import { useState, useEffect, useCallback, useRef } from 'react';

export type DashboardPersonnel = {
  id: string;
  name: string;
  personnelCode: string;
  designation: string;
  unit: string;
  dutyStatus: "ON DUTY" | "OFF DUTY" | string;
  locationStatus: "GPS ACTIVE" | "NETWORK LOCATION" | "TRACKING ACTIVE" | "LOCATION UNAVAILABLE" | "LOCATION OFF" | "PERMISSION DENIED" | "STALE" | "STALE / OFFLINE" | "OFF DUTY" | "NO DATA" | string;
  trackingStatus?: "GPS ACTIVE" | "NETWORK LOCATION" | "LOCATION OFF" | "PERMISSION DENIED" | "GPS UNAVAILABLE" | "INTERNET DISCONNECTED" | "TRACKING INTERRUPTED" | "STALE / OFFLINE" | "OUTSIDE DUTY HOURS" | string;
  statusReason?: string;
  confirmedByDevice?: boolean;
  deviceStatus: "ONLINE" | "STALE" | "OFFLINE" | string;
  networkStatus: "ONLINE" | "OFFLINE" | "UNKNOWN" | string;
  sosStatus: "SOS ACTIVE" | "NONE" | string;
  lastSeen: string | null;
  lastHeartbeat: string | null;
  lastGpsFixTime?: string | null;
  lastKnownLocationAgeSeconds?: number | null;
  location: {
    latitude: number;
    longitude: number;
    accuracy: number;
    accuracyRating?: "OPTIMAL" | "MODERATE" | "COARSE" | "HIGH" | "MEDIUM" | "LOW" | null;
    accuracyAgeSeconds?: number;
    source?: "GPS" | "NETWORK" | "FUSED" | string;
    recordedAt: string;
  } | null;
  device: {
    identifier: string;
    batteryLevel: number | null;
  } | null;
  activeSOSId: string | null;
  activeAlertId: string | null;
};

export function useDashboardData(intervalMs: number = 10000, initialData?: DashboardPersonnel[]) {
  const [data, setData] = useState<DashboardPersonnel[] | null>(initialData || null);
  const [error, setError] = useState<Error | null>(null);
  const [isLoading, setIsLoading] = useState(!initialData);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(initialData ? new Date() : null);

  const activeControllerRef = useRef<AbortController | null>(null);
  const isFetchingRef = useRef(false);
  const lastFetchTimeRef = useRef<number>(0);
  const lastEtagRef = useRef<string | null>(null);

  const fetchData = useCallback(async () => {
    // Avoid concurrent overlapping requests
    if (isFetchingRef.current) return;

    // Abort previous in-flight request if still running
    if (activeControllerRef.current) {
      activeControllerRef.current.abort();
    }

    const controller = new AbortController();
    activeControllerRef.current = controller;
    isFetchingRef.current = true;

    try {
      const headers: Record<string, string> = { "Cache-Control": "no-cache" };
      if (lastEtagRef.current) {
        headers["If-None-Match"] = lastEtagRef.current;
      }

      const res = await fetch("/api/control-room/overview", {
        signal: controller.signal,
        headers,
      });

      if (res.status === 304) {
        // Data unchanged; 0 CPU wasted re-rendering or serializing
        setLastUpdated(new Date());
        setError(null);
        lastFetchTimeRef.current = Date.now();
        return;
      }

      if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`Overview fetch failed (${res.status}): ${errorText}`);
      }

      const etag = res.headers.get("ETag");
      if (etag) lastEtagRef.current = etag;

      const json = await res.json();
      setData(json);
      setLastUpdated(new Date());
      setError(null);
      lastFetchTimeRef.current = Date.now();
    } catch (err: any) {
      if (err?.name !== 'AbortError') {
        console.error("Dashboard overview polling error:", err);
        setError(err instanceof Error ? err : new Error(String(err)));
      }
    } finally {
      isFetchingRef.current = false;
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    let timeoutId: NodeJS.Timeout | null = null;
    let isMounted = true;

    // High-efficiency adaptive conditional poller
    const scheduleNextPoll = () => {
      if (!isMounted) return;
      if (timeoutId) clearTimeout(timeoutId);
      timeoutId = setTimeout(async () => {
        if (!isMounted) return;
        if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
          await fetchData();
        }
        scheduleNextPoll();
      }, intervalMs);
    };

    // Initial connection
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
      fetchData();
      scheduleNextPoll();
    }

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        // Tab foregrounded: refresh immediately if stale (> 2s)
        const elapsed = Date.now() - lastFetchTimeRef.current;
        if (elapsed > 2000) {
          fetchData();
        }
        scheduleNextPoll();
      } else {
        // Tab backgrounded: stop polling to eliminate idle serverless compute consumption
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
      }
    };

    const handleFocus = () => {
      if (document.visibilityState === 'visible') {
        const elapsed = Date.now() - lastFetchTimeRef.current;
        if (elapsed > 2000) {
          fetchData();
        }
      }
    };

    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("focus", handleFocus);
    window.addEventListener("online", handleFocus);

    return () => {
      isMounted = false;
      if (timeoutId) clearTimeout(timeoutId);
      if (activeControllerRef.current) {
        activeControllerRef.current.abort();
      }
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("online", handleFocus);
    };
  }, [fetchData, intervalMs]);

  return { data, error, isLoading, lastUpdated };
}
