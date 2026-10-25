"use client";

import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import TrailMap from "@/components/dashboard/TrailMap";
import { StaffTrailResult, TrailPoint } from "@/services/control-room/trail_service";
import { formatIST, formatTimeOnlyIST, getTodayIST } from "@/lib/utils/time";
import {
  Calendar,
  Clock,
  Play,
  Pause,
  RotateCcw,
  FastForward,
  Navigation,
  MapPin,
  CheckCircle2,
  AlertTriangle,
  ChevronRight,
  Shield,
  Activity,
  Layers,
  Search,
  RefreshCw,
  Info,
} from "lucide-react";

interface PersonnelOption {
  id: string;
  name: string;
  personnelCode: string;
  designation: string | null;
  unit: string | null;
  active: boolean;
  isOnDuty: boolean;
}

interface LocationTrailClientProps {
  initialPersonnelId?: string | null;
  initialDate?: string | null;
  initialDutySessionId?: string | null;
}

export default function LocationTrailClient({
  initialPersonnelId,
  initialDate,
  initialDutySessionId,
}: LocationTrailClientProps) {
  // Selection State
  const [personnelList, setPersonnelList] = useState<PersonnelOption[]>([]);
  const [selectedPersonnelId, setSelectedPersonnelId] = useState<string>(
    initialPersonnelId || ""
  );
  const [selectedDate, setSelectedDate] = useState<string>(
    initialDate || getTodayIST()
  );
  const [selectedDutySessionId, setSelectedDutySessionId] = useState<string>(
    initialDutySessionId || ""
  );

  // Data State
  const [trailData, setTrailData] = useState<StaffTrailResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingPersonnel, setIsLoadingPersonnel] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Playback State
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState<number>(1);
  const [currentIndex, setCurrentIndex] = useState<number>(0);
  const playbackTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Fullscreen State and Element Reference
  const mapWrapperRef = useRef<HTMLDivElement | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isCssFullscreen, setIsCssFullscreen] = useState(false);

  const enterFullscreen = useCallback(async () => {
    const el = mapWrapperRef.current;
    if (!el) return;

    if (document.fullscreenEnabled && el.requestFullscreen) {
      try {
        await el.requestFullscreen();
        setIsFullscreen(true);
        setIsCssFullscreen(false);
      } catch (err) {
        console.warn("Native fullscreen denied or unsupported, using CSS fallback:", err);
        setIsCssFullscreen(true);
        setIsFullscreen(true);
      }
    } else {
      setIsCssFullscreen(true);
      setIsFullscreen(true);
    }
  }, []);

  const exitFullscreen = useCallback(async () => {
    if (document.fullscreenElement) {
      try {
        await document.exitFullscreen();
      } catch (err) {
        console.warn("Failed to exit native fullscreen:", err);
      }
    }
    setIsCssFullscreen(false);
    setIsFullscreen(false);
  }, []);

  const handleToggleFullscreen = useCallback(() => {
    if (isFullscreen) {
      exitFullscreen();
    } else {
      enterFullscreen();
    }
  }, [isFullscreen, enterFullscreen, exitFullscreen]);

  // Synchronize fullscreen state on browser native controls or Escape key
  useEffect(() => {
    const handleFullscreenChange = () => {
      const isDocFs = Boolean(
        document.fullscreenElement || (document as any).webkitFullscreenElement
      );
      if (!isDocFs && !isCssFullscreen) {
        setIsFullscreen(false);
      } else if (isDocFs) {
        setIsFullscreen(true);
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isFullscreen) {
        exitFullscreen();
      }
    };

    document.addEventListener("fullscreenchange", handleFullscreenChange);
    document.addEventListener("webkitfullscreenchange", handleFullscreenChange);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
      document.removeEventListener("webkitfullscreenchange", handleFullscreenChange);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isFullscreen, isCssFullscreen, exitFullscreen]);

  // Fetch all staff personnel for selector
  useEffect(() => {
    let isMounted = true;
    async function loadPersonnel() {
      try {
        setIsLoadingPersonnel(true);
        const res = await fetch("/api/control-room/trail/personnel");
        if (!res.ok) throw new Error("Failed to load staff list");
        const json = await res.json();
        if (isMounted && json.personnel) {
          setPersonnelList(json.personnel);
          // If no initial personnel ID is specified, default to first available
          if (!selectedPersonnelId && json.personnel.length > 0) {
            setSelectedPersonnelId(json.personnel[0].id);
          }
        }
      } catch (err: any) {
        console.error("Failed to fetch staff:", err);
      } finally {
        if (isMounted) setIsLoadingPersonnel(false);
      }
    }
    loadPersonnel();
    return () => {
      isMounted = false;
    };
  }, []);

  // Fetch Location Trail Data
  const loadTrail = useCallback(
    async (personnelId: string, date: string, dutySessionId?: string) => {
      if (!personnelId || !date) return;

      setIsLoading(true);
      setErrorMessage(null);
      setIsPlaying(false);
      setCurrentIndex(0);

      try {
        let url = `/api/control-room/personnel/${personnelId}/location-history?date=${date}`;
        if (dutySessionId) {
          url += `&dutySessionId=${dutySessionId}`;
        }

        const res = await fetch(url);
        if (!res.ok) {
          const errJson = await res.json().catch(() => ({}));
          throw new Error(errJson.error || `Error ${res.status}: Failed to load location trail`);
        }

        const data: StaffTrailResult = await res.json();
        setTrailData(data);
        setCurrentIndex(0);
      } catch (err: any) {
        console.error("Error loading location trail:", err);
        setErrorMessage(err.message || "Failed to load trail data");
        setTrailData(null);
      } finally {
        setIsLoading(false);
      }
    },
    []
  );

  // Initial load when selectedPersonnelId is ready
  useEffect(() => {
    if (selectedPersonnelId && selectedDate) {
      loadTrail(selectedPersonnelId, selectedDate, selectedDutySessionId || undefined);
    }
  }, [selectedPersonnelId, selectedDate, loadTrail]);

  // Independent Dashboard Trail Refresh Interval (10 seconds)
  const DASHBOARD_TRAIL_REFRESH_INTERVAL_MS = 10_000;

  // Background Live Sync (10 seconds) for Today's Historical Trail
  useEffect(() => {
    if (!selectedPersonnelId || !selectedDate) return;
    // Only auto-refresh if viewing today's route and replay is not actively running
    if (selectedDate !== getTodayIST() || isPlaying) return;

    let isMounted = true;
    const intervalId = setInterval(async () => {
      if (document.hidden) return; // Save bandwidth when tab is backgrounded
      try {
        let url = `/api/control-room/personnel/${selectedPersonnelId}/location-history?date=${selectedDate}`;
        if (selectedDutySessionId) {
          url += `&dutySessionId=${selectedDutySessionId}`;
        }
        const res = await fetch(url);
        if (!res.ok) return;
        const freshData: StaffTrailResult = await res.json();
        if (!isMounted) return;

        setTrailData((prev) => {
          if (!prev) return freshData;
          if (
            prev.locations.length === freshData.locations.length &&
            prev.locations[prev.locations.length - 1]?.id ===
              freshData.locations[freshData.locations.length - 1]?.id
          ) {
            return prev;
          }
          // Ensure chronological ordering and avoid duplicates
          const existingIds = new Set(prev.locations.map((p) => p.id));
          const newUniquePoints = freshData.locations.filter((p) => !existingIds.has(p.id));
          if (newUniquePoints.length === 0) return prev;

          const merged = [...prev.locations, ...newUniquePoints].sort(
            (a, b) => new Date(a.recordedAt).getTime() - new Date(b.recordedAt).getTime()
          );

          return {
            ...freshData,
            locations: merged,
          };
        });
      } catch (err) {
        console.error("Live trail refresh error:", err);
      }
    }, DASHBOARD_TRAIL_REFRESH_INTERVAL_MS);

    return () => {
      isMounted = false;
      clearInterval(intervalId);
    };
  }, [selectedPersonnelId, selectedDate, selectedDutySessionId, isPlaying]);

  const locations = useMemo(() => trailData?.locations || [], [trailData]);
  const activePoint: TrailPoint | null = locations[currentIndex] || null;

  // Playback Loop
  useEffect(() => {
    if (!isPlaying) {
      if (playbackTimerRef.current) clearInterval(playbackTimerRef.current);
      return;
    }

    if (locations.length <= 1) {
      setIsPlaying(false);
      return;
    }

    const intervalMs = Math.max(100, Math.round(1000 / playbackSpeed));

    playbackTimerRef.current = setInterval(() => {
      setCurrentIndex((prev) => {
        if (prev >= locations.length - 1) {
          setIsPlaying(false);
          return prev;
        }
        return prev + 1;
      });
    }, intervalMs);

    return () => {
      if (playbackTimerRef.current) clearInterval(playbackTimerRef.current);
    };
  }, [isPlaying, playbackSpeed, locations.length]);

  const handleTogglePlay = () => {
    if (locations.length === 0) return;
    if (currentIndex >= locations.length - 1) {
      setCurrentIndex(0);
      setIsPlaying(true);
    } else {
      setIsPlaying(!isPlaying);
    }
  };

  const handleResetPlayback = () => {
    setIsPlaying(false);
    setCurrentIndex(0);
  };

  const selectedOfficer = useMemo(
    () => personnelList.find((p) => p.id === selectedPersonnelId),
    [personnelList, selectedPersonnelId]
  );

  return (
    <div className="flex-1 flex flex-col w-full h-full bg-slate-950 overflow-hidden relative">
      {/* Top Filter & Selector Bar */}
      <div className={isFullscreen ? "hidden" : "border-b border-slate-800 bg-slate-900/80 backdrop-blur-md px-3 sm:px-6 py-3 flex-shrink-0 z-20"}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2.5 sm:gap-4 flex-1 min-w-[280px]">
            {/* Staff Selector */}
            <div className="flex items-center gap-2 bg-slate-950 border border-slate-800 rounded-xl px-3 py-1.5 min-w-[200px] sm:min-w-[240px]">
              <Search size={15} className="text-slate-400 flex-shrink-0" />
              <select
                aria-label="Select Staff Member"
                value={selectedPersonnelId}
                onChange={(e) => {
                  setSelectedPersonnelId(e.target.value);
                  setSelectedDutySessionId("");
                }}
                disabled={isLoadingPersonnel}
                className="bg-transparent text-xs font-semibold text-white outline-none w-full cursor-pointer"
              >
                {personnelList.map((p) => (
                  <option key={p.id} value={p.id} className="bg-slate-900 text-white">
                    {p.name} ({p.personnelCode || p.designation || "Staff"}) {p.isOnDuty ? "• ON DUTY" : ""}
                  </option>
                ))}
              </select>
            </div>

            {/* Date Picker */}
            <div className="flex items-center gap-2 bg-slate-950 border border-slate-800 rounded-xl px-3 py-1.5">
              <Calendar size={15} className="text-sky-400 flex-shrink-0" />
              <input
                type="date"
                aria-label="Select Date for Location Trail"
                value={selectedDate}
                onChange={(e) => {
                  setSelectedDate(e.target.value);
                  setSelectedDutySessionId("");
                }}
                className="bg-transparent text-xs font-semibold text-white outline-none cursor-pointer"
              />
            </div>

            {/* Duty Session Selector (if available) */}
            {trailData && trailData.sessions.length > 0 && (
              <div className="flex items-center gap-2 bg-slate-950 border border-slate-800 rounded-xl px-3 py-1.5">
                <Clock size={15} className="text-emerald-400 flex-shrink-0" />
                <select
                  aria-label="Filter by Duty Session"
                  value={selectedDutySessionId}
                  onChange={(e) => setSelectedDutySessionId(e.target.value)}
                  className="bg-transparent text-xs font-semibold text-white outline-none cursor-pointer"
                >
                  <option value="" className="bg-slate-900 text-white">
                    All Duty Sessions ({trailData.sessions.length})
                  </option>
                  {trailData.sessions.map((s, idx) => (
                    <option key={s.id} value={s.id} className="bg-slate-900 text-white">
                      Session #{idx + 1}: {formatTimeOnlyIST(s.startedAt, false)} &rarr;{" "}
                      {s.endedAt ? formatTimeOnlyIST(s.endedAt, false) : "Active"}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* View Trail / Refresh Button */}
            <button
              type="button"
              onClick={() =>
                loadTrail(selectedPersonnelId, selectedDate, selectedDutySessionId || undefined)
              }
              disabled={isLoading || !selectedPersonnelId}
              className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-sky-600 hover:bg-sky-500 text-white text-xs font-bold transition-all shadow-lg shadow-sky-600/30 cursor-pointer disabled:opacity-50"
            >
              <RefreshCw size={13} className={isLoading ? "animate-spin" : ""} />
              <span>{isLoading ? "Loading..." : "View Trail"}</span>
            </button>
          </div>

          {/* Quick Date Pills & 10s Live Sync Badge */}
          <div className="hidden md:flex items-center gap-2">
            <button
              type="button"
              onClick={() => setSelectedDate(getTodayIST())}
              className={`px-2.5 py-1 text-xs font-semibold rounded-lg border transition-all cursor-pointer ${
                selectedDate === getTodayIST()
                  ? "bg-slate-800 border-sky-500 text-sky-400"
                  : "bg-slate-950 border-slate-800 text-slate-400 hover:text-white"
              }`}
            >
              Today
            </button>
            {selectedDate === getTodayIST() && (
              <span className="flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-mono font-bold rounded-lg bg-emerald-950/80 border border-emerald-800/60 text-emerald-300 shadow-sm">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                10s LIVE SYNC
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Main Trail Workspace: Map (Left/Center) + Sidebar Panel (Right) */}
      <div className="flex-1 flex flex-col lg:flex-row overflow-hidden relative">
        {/* Map View */}
        <div ref={mapWrapperRef} className={isFullscreen ? "fixed inset-0 z-50 h-[100dvh] w-[100dvw] bg-slate-950 flex flex-col overflow-hidden pt-[env(safe-area-inset-top,0px)] pb-[env(safe-area-inset-bottom,0px)]" : "flex-1 h-[55%] lg:h-full relative overflow-hidden"}>
          <TrailMap
            locations={locations}
            activeIndex={currentIndex}
            onSelectIndex={(idx) => {
              setCurrentIndex(idx);
              setIsPlaying(false);
            }}
            staffName={selectedOfficer?.name || trailData?.personnel?.name || "Staff Member"}
            isFullscreen={isFullscreen}
            onToggleFullscreen={handleToggleFullscreen}
          />

          {/* Bottom Floating Playback Scrubber on Map */}
          {locations.length > 0 && (
            <div className="absolute left-3 right-3 bottom-3 lg:left-6 lg:right-6 z-10 bg-slate-900/95 border border-slate-800/90 rounded-2xl p-3 sm:p-4 shadow-2xl backdrop-blur-md">
              <div className="flex flex-col gap-2">
                {/* Timeline Range Slider */}
                <div className="flex items-center gap-3">
                  <span className="text-[10px] font-mono font-bold text-slate-400 w-14">
                    {locations[0] ? formatTimeOnlyIST(locations[0].recordedAt, false) : "00:00"}
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={Math.max(0, locations.length - 1)}
                    value={currentIndex}
                    onChange={(e) => {
                      setCurrentIndex(Number(e.target.value));
                      setIsPlaying(false);
                    }}
                    className="flex-1 h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-sky-400"
                  />
                  <span className="text-[10px] font-mono font-bold text-slate-400 w-14 text-right">
                    {locations[locations.length - 1]
                      ? formatTimeOnlyIST(locations[locations.length - 1].recordedAt, false)
                      : "00:00"}
                  </span>
                </div>

                {/* Controls and Active Point Indicator */}
                <div className="flex items-center justify-between flex-wrap gap-2 pt-1">
                  {/* Play/Pause & Speed */}
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={handleTogglePlay}
                      title={isPlaying ? "Pause Playback" : "Play Route Animation"}
                      className="flex h-9 w-9 items-center justify-center rounded-xl bg-sky-600 hover:bg-sky-500 text-white shadow-md transition-transform active:scale-95 cursor-pointer"
                    >
                      {isPlaying ? <Pause size={16} /> : <Play size={16} className="ml-0.5" />}
                    </button>
                    <button
                      type="button"
                      onClick={handleResetPlayback}
                      title="Reset to Start"
                      className="flex h-9 w-9 items-center justify-center rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 transition-colors cursor-pointer"
                    >
                      <RotateCcw size={15} />
                    </button>

                    {/* Speed Selector */}
                    <div className="flex items-center bg-slate-950 border border-slate-800 rounded-xl p-0.5">
                      {[1, 2, 5, 10].map((spd) => (
                        <button
                          key={spd}
                          type="button"
                          onClick={() => setPlaybackSpeed(spd)}
                          className={`px-2 py-1 text-[11px] font-bold rounded-lg transition-all cursor-pointer ${
                            playbackSpeed === spd
                              ? "bg-sky-600 text-white shadow-sm"
                              : "text-slate-400 hover:text-white"
                          }`}
                        >
                          {spd}x
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Current Active Point Details */}
                  {activePoint && (
                    <div className="flex items-center gap-2 sm:gap-3 flex-wrap">
                      <span className="text-xs font-bold text-white">
                        Point {currentIndex + 1} of {locations.length}
                      </span>
                      <span className="text-xs font-mono text-sky-400">
                        {formatTimeOnlyIST(activePoint.recordedAt)}
                      </span>
                      <span
                        className={`text-[10px] font-mono font-bold px-1.5 py-0.5 rounded border ${
                          activePoint.accuracy <= 10
                            ? "bg-emerald-950/80 text-emerald-300 border-emerald-800/60"
                            : activePoint.accuracy <= 20
                              ? "bg-sky-950/80 text-sky-300 border-sky-800/60"
                              : "bg-amber-950/80 text-amber-300 border-amber-800/60"
                        }`}
                      >
                        ±{Math.round(activePoint.accuracy)}m
                        {activePoint.accuracy <= 10 ? " ≤10m" : activePoint.accuracy <= 20 ? " ≤20m" : " Low Acc"}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Right Sidebar: Summary Cards & Timeline List */}
        <div className={isFullscreen ? "hidden" : "h-[45%] lg:h-full lg:w-[380px] xl:w-[420px] border-t lg:border-t-0 lg:border-l border-slate-800 bg-slate-900/40 backdrop-blur-md flex flex-col flex-shrink-0 overflow-hidden"}>
          {/* Daily Route Summary */}
          {trailData?.summary && (
            <div className="p-4 border-b border-slate-800/80 bg-slate-950/50 flex-shrink-0">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-xs font-black uppercase tracking-wider text-slate-300 flex items-center gap-1.5">
                  <Activity size={14} className="text-sky-400" />
                  <span>Daily Route Summary</span>
                </h3>
                <span className="text-[10px] font-mono text-slate-500">
                  {formatIST(selectedDate)}
                </span>
              </div>

              {/* KPI Grid */}
              <div className="grid grid-cols-2 gap-2 sm:gap-2.5">
                {/* Distance */}
                <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-2.5">
                  <span className="text-[10px] font-semibold text-slate-400 uppercase">
                    Distance Travelled
                  </span>
                  <div className="flex items-baseline gap-1 mt-0.5">
                    <span className="text-lg font-black text-white">
                      {trailData.summary.estimatedDistanceKm.toFixed(2)}
                    </span>
                    <span className="text-xs font-bold text-slate-400">km</span>
                  </div>
                  <span className="text-[9px] text-slate-500 leading-tight block mt-0.5">
                    *Estimated based on recorded GPS coordinates
                  </span>
                </div>

                {/* Total Points */}
                <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-2.5">
                  <span className="text-[10px] font-semibold text-slate-400 uppercase">
                    GPS Points
                  </span>
                  <div className="text-lg font-black text-emerald-400 mt-0.5">
                    {trailData.summary.totalPoints}
                  </div>
                  <span className="text-[9px] text-slate-400 leading-tight block mt-0.5">
                    {trailData.summary.verifiedPointsCount} verified (&le;20m) &bull;{" "}
                    {trailData.summary.coarsePointsCount} coarse
                  </span>
                </div>

                {/* Start & End Times */}
                <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-2.5">
                  <span className="text-[10px] font-semibold text-slate-400 uppercase">
                    First & Last Fix
                  </span>
                  <div className="text-xs font-bold text-slate-200 mt-1">
                    {trailData.summary.firstRecordedAt
                      ? formatTimeOnlyIST(trailData.summary.firstRecordedAt, false)
                      : "—"}
                  </div>
                  <div className="text-[11px] text-slate-400">
                    to{" "}
                    {trailData.summary.lastRecordedAt
                      ? formatTimeOnlyIST(trailData.summary.lastRecordedAt, false)
                      : "—"}
                  </div>
                </div>

                {/* Tracking Gaps */}
                <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-2.5">
                  <span className="text-[10px] font-semibold text-slate-400 uppercase">
                    Tracking Gaps (&gt;5m)
                  </span>
                  <div className="text-lg font-black text-amber-400 mt-0.5">
                    {trailData.summary.gapCount}
                  </div>
                  <span className="text-[9px] text-slate-400 leading-tight block mt-0.5">
                    {trailData.summary.longestGapMinutes > 0
                      ? `Longest gap: ${trailData.summary.longestGapMinutes}m`
                      : "Continuous coverage"}
                  </span>
                </div>
              </div>

              {/* Duty Session Details */}
              {trailData.summary.dutyStart && (
                <div className="mt-2.5 text-[11px] bg-slate-900/60 border border-slate-800/80 rounded-lg p-2 text-slate-300 flex items-center justify-between">
                  <span className="font-semibold">Duty Started:</span>
                  <span className="font-mono text-emerald-300">
                    {formatTimeOnlyIST(trailData.summary.dutyStart, false)}{" "}
                    {trailData.summary.dutyEnd
                      ? `to ${formatTimeOnlyIST(trailData.summary.dutyEnd, false)} (${trailData.summary.dutyDurationMinutes} min)`
                      : "(Active)"}
                  </span>
                </div>
              )}
            </div>
          )}

          {/* Timeline List Header */}
          <div className="px-4 py-2 border-b border-slate-800 bg-slate-950/80 flex items-center justify-between flex-shrink-0">
            <span className="text-xs font-bold text-slate-300 uppercase tracking-wider">
              Chronological Timeline
            </span>
            <span className="text-[10px] font-mono text-slate-500">
              {locations.length} fixes
            </span>
          </div>

          {/* Scrollable Timeline Entries */}
          <div className="flex-1 overflow-y-auto custom-scrollbar p-3 space-y-1.5">
            {locations.length === 0 && !isLoading && (
              <div className="py-12 text-center text-slate-500">
                <MapPin size={28} className="mx-auto mb-2 opacity-40" />
                <p className="text-xs font-semibold">No recorded coordinates for this date.</p>
                <p className="text-[11px] text-slate-600 mt-1">
                  Try selecting another date or duty session.
                </p>
              </div>
            )}

            {locations.map((loc, idx) => {
              const isSelected = currentIndex === idx;
              const isOptimal = loc.accuracy <= 10;
              const isVerified = loc.accuracy <= 20;

              return (
                <button
                  key={loc.id || `loc-${idx}`}
                  type="button"
                  onClick={() => {
                    setCurrentIndex(idx);
                    setIsPlaying(false);
                  }}
                  className={`w-full text-left p-2.5 rounded-xl border transition-all cursor-pointer flex items-center justify-between gap-3 ${
                    isSelected
                      ? "bg-sky-950/40 border-sky-500/80 shadow-md ring-1 ring-sky-500/40"
                      : "bg-slate-900/60 border-slate-800/70 hover:bg-slate-800/50 hover:border-slate-700"
                  }`}
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <span
                      className={`h-2.5 w-2.5 rounded-full flex-shrink-0 ${
                        isOptimal
                          ? "bg-emerald-400"
                          : isVerified
                            ? "bg-sky-400"
                            : "bg-amber-400"
                      }`}
                    />
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs font-bold text-white">
                          #{idx + 1}
                        </span>
                        <span className="text-[11px] font-mono text-slate-300">
                          {formatTimeOnlyIST(loc.recordedAt)}
                        </span>
                      </div>
                      <div className="text-[10px] font-mono text-slate-500 truncate mt-0.5">
                        {loc.latitude.toFixed(5)}, {loc.longitude.toFixed(5)}
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-col items-end flex-shrink-0">
                    <span
                      className={`text-[9px] font-mono font-bold px-1.5 py-0.2 rounded border ${
                        isOptimal
                          ? "bg-emerald-950/80 text-emerald-300 border-emerald-800/60"
                          : isVerified
                            ? "bg-sky-950/80 text-sky-300 border-sky-800/60"
                            : "bg-amber-950/80 text-amber-300 border-amber-800/60"
                      }`}
                    >
                      &plusmn;{Math.round(loc.accuracy)}m
                    </span>
                    <span className="text-[9px] text-slate-500 font-mono mt-0.5 uppercase">
                      {loc.source} {loc.speedKmh != null ? `&bull; ${loc.speedKmh}kph` : ""}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
