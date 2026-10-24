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
  const eventSourceRef = useRef<EventSource | null>(null);
  const sseFailedRef = useRef(false);

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
      const res = await fetch("/api/control-room/overview", {
        signal: controller.signal,
        headers: { "Cache-Control": "no-cache" }
      });

      if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`Overview fetch failed (${res.status}): ${errorText}`);
      }

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

    // Polling fallback scheduler
    const scheduleNextPoll = () => {
      if (!isMounted) return;
      if (timeoutId) clearTimeout(timeoutId);
      timeoutId = setTimeout(async () => {
        if (!isMounted) return;
        if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
          // If SSE is active and healthy, no need to poll
          if (!eventSourceRef.current || sseFailedRef.current) {
            await fetchData();
          }
        }
        scheduleNextPoll();
      }, intervalMs);
    };

    // SSE connection manager
    const connectSSE = () => {
      if (typeof window === 'undefined' || typeof EventSource === 'undefined') {
        sseFailedRef.current = true;
        fetchData();
        scheduleNextPoll();
        return;
      }

      if (eventSourceRef.current) {
        try { eventSourceRef.current.close(); } catch (_) {}
        eventSourceRef.current = null;
      }

      try {
        const es = new EventSource("/api/control-room/overview/sse");
        eventSourceRef.current = es;

        es.onmessage = (event) => {
          if (!isMounted) return;
          try {
            const parsed = JSON.parse(event.data);
            setData(parsed);
            setLastUpdated(new Date());
            setError(null);
            setIsLoading(false);
            sseFailedRef.current = false;
            lastFetchTimeRef.current = Date.now();
          } catch (e) {
            console.error("Error parsing SSE overview:", e);
          }
        };

        es.onerror = () => {
          if (!isMounted) return;
          // On SSE disconnect/error, smoothly fallback to polling
          sseFailedRef.current = true;
          if (eventSourceRef.current) {
            try { eventSourceRef.current.close(); } catch (_) {}
            eventSourceRef.current = null;
          }
          // Fetch immediately to guarantee fresh data, then poll
          fetchData();
          scheduleNextPoll();
        };
      } catch (err) {
        sseFailedRef.current = true;
        fetchData();
        scheduleNextPoll();
      }
    };

    // Initial connection:
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
      connectSSE();
      scheduleNextPoll();
    }

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        // Tab brought to foreground: immediately refresh data & ensure SSE is connected
        const elapsed = Date.now() - lastFetchTimeRef.current;
        if (elapsed > 2000) {
          fetchData();
        }
        if (!eventSourceRef.current) {
          connectSSE();
        }
        scheduleNextPoll();
      } else {
        // Tab backgrounded: close SSE to prevent serverless stream waste
        if (eventSourceRef.current) {
          try { eventSourceRef.current.close(); } catch (_) {}
          eventSourceRef.current = null;
        }
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
      }
    };

    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      isMounted = false;
      if (timeoutId) clearTimeout(timeoutId);
      if (eventSourceRef.current) {
        try { eventSourceRef.current.close(); } catch (_) {}
        eventSourceRef.current = null;
      }
      if (activeControllerRef.current) {
        activeControllerRef.current.abort();
      }
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [fetchData, intervalMs]);

  return { data, error, isLoading, lastUpdated };
}
