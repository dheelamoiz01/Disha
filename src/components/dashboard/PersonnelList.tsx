"use client";

import { useMemo, useState } from "react";
import { DashboardPersonnel } from "@/hooks/useDashboardData";
import { Search, AlertTriangle, WifiOff, Battery, BatteryLow, BatteryMedium, X, Radio } from "lucide-react";
import { formatIST } from "@/lib/utils/time";

interface Props {
  data: DashboardPersonnel[];
  isLoading: boolean;
  onSelect: (id: string) => void;
  selectedId: string | null;
  lastUpdated: Date | null;
  className?: string;
}

export default function PersonnelList({
  data,
  isLoading,
  onSelect,
  selectedId,
  lastUpdated,
  className = "",
}: Props) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"ALL" | "ON_DUTY" | "OFF_DUTY" | "SOS" | "UNAVAILABLE" | "OFFLINE">("ALL");

  const filtered = useMemo(() => {
    return data
      .filter((p) => {
        if (filter === "ON_DUTY" && p.dutyStatus !== "ON DUTY") return false;
        if (filter === "OFF_DUTY" && p.dutyStatus !== "OFF DUTY") return false;
        if (filter === "SOS" && p.sosStatus !== "SOS ACTIVE") return false;
        if (filter === "UNAVAILABLE" && p.locationStatus !== "LOCATION UNAVAILABLE") return false;
        if (filter === "OFFLINE" && p.networkStatus !== "OFFLINE" && p.deviceStatus !== "OFFLINE") return false;

        if (search.trim()) {
          const term = search.toLowerCase().trim();
          return (
            p.name.toLowerCase().includes(term) ||
            p.personnelCode.toLowerCase().includes(term) ||
            p.unit.toLowerCase().includes(term) ||
            p.designation.toLowerCase().includes(term)
          );
        }
        return true;
      })
      .sort((a, b) => {
        // Priority 1: SOS Active always first
        if (a.sosStatus === "SOS ACTIVE" && b.sosStatus !== "SOS ACTIVE") return -1;
        if (b.sosStatus === "SOS ACTIVE" && a.sosStatus !== "SOS ACTIVE") return 1;
        // Priority 2: On Duty before Off Duty
        if (a.dutyStatus === "ON DUTY" && b.dutyStatus !== "ON DUTY") return -1;
        if (b.dutyStatus === "ON DUTY" && a.dutyStatus !== "ON DUTY") return 1;
        // Priority 3: Alphabetical by name
        return a.name.localeCompare(b.name);
      });
  }, [data, search, filter]);

  // Counts for filter pills
  const counts = useMemo(() => {
    return {
      ALL: data.length,
      ON_DUTY: data.filter((p) => p.dutyStatus === "ON DUTY").length,
      OFF_DUTY: data.filter((p) => p.dutyStatus === "OFF DUTY").length,
      SOS: data.filter((p) => p.sosStatus === "SOS ACTIVE").length,
      OFFLINE: data.filter((p) => p.networkStatus === "OFFLINE" || p.deviceStatus === "OFFLINE").length,
    };
  }, [data]);

  const renderBattery = (level: number | null | undefined) => {
    if (level === null || level === undefined) return null;
    let Icon = Battery;
    let colorClass = "text-emerald-400";
    if (level <= 20) {
      Icon = BatteryLow;
      colorClass = "text-rose-400 animate-pulse";
    } else if (level <= 50) {
      Icon = BatteryMedium;
      colorClass = "text-amber-400";
    }

    return (
      <span className={`flex items-center gap-1 text-[11px] font-semibold ${colorClass}`} title={`Battery: ${level}%`}>
        <Icon size={13} />
        {level}%
      </span>
    );
  };

  return (
    <div className={`flex flex-col h-full bg-slate-900/90 text-slate-100 ${className}`}>
      {/* Header with Search and Quick Filters */}
      <div className="p-3.5 sm:p-4 border-b border-slate-800 bg-slate-950/80 backdrop-blur-md flex-shrink-0 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-bold text-white tracking-wide uppercase">Field Personnel</h2>
            <span className="px-2 py-0.5 rounded-full bg-slate-800 text-slate-300 text-xs font-semibold">
              {filtered.length}
            </span>
          </div>

          <div className="text-[11px] text-slate-400 flex items-center gap-1.5">
            <Radio size={12} className={isLoading ? "text-amber-400 animate-spin" : "text-emerald-400"} />
            <span className="hidden sm:inline">
              {lastUpdated ? `Sync ${formatIST(lastUpdated)}` : "Connecting..."}
            </span>
          </div>
        </div>

        {/* Search Bar */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" size={15} />
          <input
            type="text"
            placeholder="Search personnel, code, unit..."
            className="w-full bg-slate-900 border border-slate-700/80 rounded-xl py-2 pl-9 pr-9 text-xs sm:text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500/20 transition-all"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && (
            <button
              onClick={() => setSearch("")}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white p-1"
              aria-label="Clear search"
            >
              <X size={14} />
            </button>
          )}
        </div>

        {/* Filter Pills */}
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1 custom-scrollbar">
          <button
            onClick={() => setFilter("ALL")}
            className={`px-2.5 py-1 rounded-lg text-xs font-medium whitespace-nowrap transition-colors cursor-pointer ${
              filter === "ALL"
                ? "bg-sky-500/20 text-sky-300 border border-sky-500/40"
                : "bg-slate-800/80 text-slate-400 hover:text-slate-200 border border-transparent"
            }`}
          >
            All ({counts.ALL})
          </button>

          <button
            onClick={() => setFilter("ON_DUTY")}
            className={`px-2.5 py-1 rounded-lg text-xs font-medium whitespace-nowrap transition-colors cursor-pointer ${
              filter === "ON_DUTY"
                ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40"
                : "bg-slate-800/80 text-slate-400 hover:text-slate-200 border border-transparent"
            }`}
          >
            On Duty ({counts.ON_DUTY})
          </button>

          {counts.SOS > 0 && (
            <button
              onClick={() => setFilter("SOS")}
              className={`px-2.5 py-1 rounded-lg text-xs font-bold whitespace-nowrap transition-colors cursor-pointer animate-pulse ${
                filter === "SOS"
                  ? "bg-rose-500 text-white border border-rose-400"
                  : "bg-rose-500/20 text-rose-300 hover:bg-rose-500/30 border border-rose-500/40"
              }`}
            >
              ⚠️ SOS ({counts.SOS})
            </button>
          )}

          <button
            onClick={() => setFilter("OFF_DUTY")}
            className={`px-2.5 py-1 rounded-lg text-xs font-medium whitespace-nowrap transition-colors cursor-pointer ${
              filter === "OFF_DUTY"
                ? "bg-slate-700 text-white border border-slate-600"
                : "bg-slate-800/80 text-slate-400 hover:text-slate-200 border border-transparent"
            }`}
          >
            Off Duty ({counts.OFF_DUTY})
          </button>

          <button
            onClick={() => setFilter("OFFLINE")}
            className={`px-2.5 py-1 rounded-lg text-xs font-medium whitespace-nowrap transition-colors cursor-pointer ${
              filter === "OFFLINE"
                ? "bg-amber-500/20 text-amber-300 border border-amber-500/40"
                : "bg-slate-800/80 text-slate-400 hover:text-slate-200 border border-transparent"
            }`}
          >
            Offline ({counts.OFFLINE})
          </button>
        </div>
      </div>

      {/* Personnel List Body */}
      <div className="flex-1 overflow-y-auto p-2.5 sm:p-3 space-y-2 custom-scrollbar">
        {filtered.length === 0 && !isLoading && (
          <div className="text-center py-12 px-4">
            <Search size={32} className="mx-auto text-slate-600 mb-2" />
            <p className="text-sm font-semibold text-slate-400">No personnel match your search</p>
            <p className="text-xs text-slate-500 mt-1">Try resetting the filter or search query</p>
          </div>
        )}

        {filtered.map((p) => {
          const isSelected = selectedId === p.id;
          const isSOS = p.sosStatus === "SOS ACTIVE";

          return (
            <div
              key={p.id}
              onClick={() => onSelect(p.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelect(p.id);
                }
              }}
              className={`p-3 rounded-xl border transition-all cursor-pointer outline-none ${
                isSelected
                  ? "bg-sky-950/40 border-sky-500/80 ring-1 ring-sky-500/30 shadow-lg shadow-sky-950/30"
                  : isSOS
                    ? "bg-rose-950/30 border-rose-700/70 hover:bg-rose-900/40 animate-pulse shadow-md shadow-rose-950/30"
                    : "bg-slate-900/60 border-slate-800/90 hover:bg-slate-850 hover:border-slate-700"
              }`}
            >
              {/* Top row: Name, SOS alert */}
              <div className="flex justify-between items-start gap-2 mb-1.5">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="font-bold text-sm text-slate-100 truncate">{p.name}</span>
                  </div>
                  <div className="text-xs text-slate-400 truncate mt-0.5">
                    {[p.designation, p.unit].filter(Boolean).join(" • ") || "Field Personnel"}
                  </div>
                </div>

                {isSOS && (
                  <span className="flex-shrink-0 bg-rose-600 text-white text-[10px] font-black uppercase px-2 py-0.5 rounded-full flex items-center gap-1 shadow-md shadow-rose-600/40">
                    <AlertTriangle size={11} /> SOS
                  </span>
                )}
              </div>

              {/* Status Tags Grid */}
              <div className="grid grid-cols-2 gap-1.5 text-[11px] mt-2.5">
                <div
                  className={`px-2 py-1 rounded-md flex items-center gap-1.5 font-medium ${
                    p.dutyStatus === "ON DUTY"
                      ? "bg-emerald-950/40 text-emerald-300 border border-emerald-900/40"
                      : "bg-slate-800/60 text-slate-400 border border-slate-700/40"
                  }`}
                >
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${
                      p.dutyStatus === "ON DUTY" ? "bg-emerald-400" : "bg-slate-500"
                    }`}
                  />
                  <span>Duty: {p.dutyStatus}</span>
                </div>

                <div
                  className={`px-2 py-1 rounded-md flex items-center gap-1.5 font-medium ${
                    p.dutyStatus === "OFF DUTY"
                      ? "bg-slate-800/60 text-slate-400 border border-slate-700/40"
                      : p.trackingStatus === "GPS ACTIVE"
                        ? "bg-emerald-950/60 text-emerald-300 border border-emerald-800/50"
                        : p.trackingStatus === "NETWORK LOCATION"
                          ? "bg-cyan-950/60 text-cyan-300 border border-cyan-800/50"
                          : p.trackingStatus === "LOCATION OFF" || p.trackingStatus === "PERMISSION DENIED"
                            ? "bg-rose-950/60 text-rose-300 border border-rose-800/50"
                            : p.trackingStatus === "GPS UNAVAILABLE" || p.trackingStatus === "INTERNET DISCONNECTED" || p.trackingStatus === "TRACKING INTERRUPTED"
                              ? "bg-amber-950/60 text-amber-300 border border-amber-800/50"
                              : p.locationStatus === "TRACKING ACTIVE"
                                ? "bg-sky-950/40 text-sky-300 border border-sky-900/40"
                                : "bg-slate-800/60 text-slate-400 border border-slate-700/40"
                  }`}
                >
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${
                      p.dutyStatus === "OFF DUTY"
                        ? "bg-slate-500"
                        : p.trackingStatus === "GPS ACTIVE"
                          ? "bg-emerald-400"
                          : p.trackingStatus === "NETWORK LOCATION"
                            ? "bg-cyan-400"
                            : p.trackingStatus === "LOCATION OFF" || p.trackingStatus === "PERMISSION DENIED"
                              ? "bg-rose-400"
                              : p.trackingStatus === "GPS UNAVAILABLE" || p.trackingStatus === "INTERNET DISCONNECTED" || p.trackingStatus === "TRACKING INTERRUPTED"
                                ? "bg-amber-400"
                                : "bg-slate-500"
                    }`}
                  />
                  <span className="truncate flex items-center gap-1">
                    <span>
                      {p.dutyStatus === "OFF DUTY"
                        ? "OFF DUTY"
                        : p.trackingStatus || p.locationStatus}
                    </span>
                    {p.location?.accuracy != null && (p.trackingStatus === "GPS ACTIVE" || p.trackingStatus === "NETWORK LOCATION" || p.locationStatus === "TRACKING ACTIVE") && (
                      <span className={`text-[10px] font-mono ${p.trackingStatus === "NETWORK LOCATION" ? "text-cyan-400" : "text-emerald-400"}`}>
                        ±{Math.round(p.location.accuracy)}m
                      </span>
                    )}
                  </span>
                </div>
              </div>

              {/* Bottom Info: Battery, Last Seen, Connection Status */}
              <div className="flex items-center justify-between text-[11px] text-slate-400 pt-2 mt-1 border-t border-slate-800/60">
                <span className="truncate">
                  {p.lastSeen ? `Seen ${formatIST(p.lastSeen)}` : "No contact recorded"}
                </span>

                <div className="flex items-center gap-2 flex-shrink-0">
                  {renderBattery(p.device?.batteryLevel)}
                  <span
                    className={`flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded ${
                      p.deviceStatus === "ONLINE"
                        ? "bg-emerald-950/60 text-emerald-300 border border-emerald-800/50"
                        : p.deviceStatus === "STALE"
                          ? "bg-amber-950/60 text-amber-300 border border-amber-800/50"
                          : "bg-rose-950/60 text-rose-300 border border-rose-800/50"
                    }`}
                  >
                    <span
                      className={`w-1.5 h-1.5 rounded-full ${
                        p.deviceStatus === "ONLINE"
                          ? "bg-emerald-400 animate-pulse"
                          : p.deviceStatus === "STALE"
                            ? "bg-amber-400"
                            : "bg-rose-400"
                      }`}
                    />
                    {p.deviceStatus}
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
