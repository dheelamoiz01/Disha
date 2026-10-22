"use client";

import { useState, useMemo } from "react";
import PersonnelList from "@/components/dashboard/PersonnelList";
import MapComponent from "@/components/dashboard/Map";
import PersonnelDetail from "@/components/dashboard/PersonnelDetail";
import { useDashboardData } from "@/hooks/useDashboardData";
import {
  AlertTriangle,
  Map as MapIcon,
  Users,
  ShieldAlert,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
} from "lucide-react";

export default function LiveMapClient({ initialData }: { initialData?: any[] }) {
  const { data, error, isLoading, lastUpdated } = useDashboardData(5000, initialData);
  const [selectedPersonnelId, setSelectedPersonnelId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [mobileTab, setMobileTab] = useState<"map" | "list" | "alerts">("map");

  const personnelList = useMemo(() => data || [], [data]);

  const selectedPersonnel = useMemo(() => {
    return selectedPersonnelId ? personnelList.find((p) => p.id === selectedPersonnelId) || null : null;
  }, [selectedPersonnelId, personnelList]);

  // KPI Calculations
  const stats = useMemo(() => {
    return {
      total: personnelList.length,
      trackingActive: personnelList.filter((d) => d.locationStatus === "TRACKING ACTIVE").length,
      onDuty: personnelList.filter((d) => d.dutyStatus === "ON DUTY").length,
      offDuty: personnelList.filter((d) => d.dutyStatus === "OFF DUTY").length,
      sosActive: personnelList.filter((d) => d.sosStatus === "SOS ACTIVE").length,
      locUnavailable: personnelList.filter((d) => d.locationStatus === "LOCATION UNAVAILABLE").length,
      networkOffline: personnelList.filter((d) => d.networkStatus === "OFFLINE").length,
    };
  }, [personnelList]);

  // Handle personnel selection (both desktop & mobile)
  const handleSelectPersonnel = (id: string) => {
    setSelectedPersonnelId(id);
  };

  if (error && personnelList.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-6 text-center bg-slate-950">
        <div className="w-16 h-16 rounded-2xl bg-rose-500/10 border border-rose-500/20 text-rose-400 flex items-center justify-center mb-4">
          <AlertTriangle size={32} />
        </div>
        <h2 className="text-xl font-bold text-white mb-2">Error Loading Live Map</h2>
        <p className="text-sm text-slate-400 max-w-md mb-6">{error.message || "Failed to fetch live telemetry overview."}</p>
        <button
          onClick={() => window.location.reload()}
          className="flex items-center gap-2 px-4 py-2 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-semibold text-xs transition-colors"
        >
          <RefreshCw size={14} /> Retry Connection
        </button>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col w-full h-full bg-slate-950 overflow-hidden relative">
      {/* KPI Cards Strip - Desktop & Tablet */}
      <div className="h-16 sm:h-20 border-b border-slate-800/80 bg-slate-900/60 backdrop-blur-md flex items-center px-3 sm:px-6 gap-2.5 sm:gap-3.5 overflow-x-auto custom-scrollbar flex-shrink-0 z-20">
        {/* Total Personnel */}
        <div className="bg-slate-900/80 border border-slate-800 rounded-xl px-3 sm:px-4 py-1.5 sm:py-2 flex flex-col justify-center min-w-[95px] sm:min-w-[110px] flex-shrink-0">
          <span className="text-[10px] sm:text-xs text-slate-400 font-bold uppercase tracking-wider">Total</span>
          <span className="text-base sm:text-xl font-black text-white">{stats.total}</span>
        </div>

        {/* Tracking Active */}
        <div className="bg-emerald-950/20 border border-emerald-900/40 rounded-xl px-3 sm:px-4 py-1.5 sm:py-2 flex flex-col justify-center min-w-[115px] sm:min-w-[130px] flex-shrink-0">
          <span className="text-[10px] sm:text-xs text-emerald-400 font-bold uppercase tracking-wider flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" /> Tracking
          </span>
          <span className="text-base sm:text-xl font-black text-emerald-300">{stats.trackingActive}</span>
        </div>

        {/* On Duty */}
        <div className="bg-sky-950/20 border border-sky-900/40 rounded-xl px-3 sm:px-4 py-1.5 sm:py-2 flex flex-col justify-center min-w-[100px] sm:min-w-[115px] flex-shrink-0">
          <span className="text-[10px] sm:text-xs text-sky-400 font-bold uppercase tracking-wider">On Duty</span>
          <span className="text-base sm:text-xl font-black text-sky-300">{stats.onDuty}</span>
        </div>

        {/* SOS Emergency (Highlighted if active) */}
        <div
          className={`rounded-xl px-3 sm:px-4 py-1.5 sm:py-2 flex flex-col justify-center min-w-[110px] sm:min-w-[125px] flex-shrink-0 transition-all ${
            stats.sosActive > 0
              ? "bg-rose-950/40 border border-rose-600/80 animate-pulse shadow-lg shadow-rose-950/40"
              : "bg-slate-900/80 border border-slate-800"
          }`}
        >
          <span className="text-[10px] sm:text-xs text-rose-400 font-black uppercase tracking-wider flex items-center gap-1">
            {stats.sosActive > 0 && <ShieldAlert size={12} className="animate-bounce" />} SOS Active
          </span>
          <span className={`text-base sm:text-xl font-black ${stats.sosActive > 0 ? "text-rose-200" : "text-slate-400"}`}>
            {stats.sosActive}
          </span>
        </div>

        {/* Off Duty */}
        <div className="bg-slate-900/80 border border-slate-800 rounded-xl px-3 sm:px-4 py-1.5 sm:py-2 flex flex-col justify-center min-w-[100px] sm:min-w-[115px] flex-shrink-0">
          <span className="text-[10px] sm:text-xs text-slate-400 font-bold uppercase tracking-wider">Off Duty</span>
          <span className="text-base sm:text-xl font-black text-slate-300">{stats.offDuty}</span>
        </div>

        {/* Location Unavailable */}
        <div className="bg-amber-950/20 border border-amber-900/40 rounded-xl px-3 sm:px-4 py-1.5 sm:py-2 flex flex-col justify-center min-w-[120px] sm:min-w-[135px] flex-shrink-0">
          <span className="text-[10px] sm:text-xs text-amber-400 font-bold uppercase tracking-wider">No GPS</span>
          <span className="text-base sm:text-xl font-black text-amber-300">{stats.locUnavailable}</span>
        </div>

        {/* Network Offline */}
        <div className="bg-rose-950/20 border border-rose-900/30 rounded-xl px-3 sm:px-4 py-1.5 sm:py-2 flex flex-col justify-center min-w-[115px] sm:min-w-[130px] flex-shrink-0">
          <span className="text-[10px] sm:text-xs text-rose-400 font-bold uppercase tracking-wider">Offline</span>
          <span className="text-base sm:text-xl font-black text-rose-300">{stats.networkOffline}</span>
        </div>
      </div>

      {/* Main Workspace */}
      <div className="flex-1 flex w-full relative overflow-hidden">
        {/* DESKTOP Left Sidebar: Personnel List */}
        <aside
          className={`hidden md:flex flex-col h-full border-r border-slate-800/80 bg-slate-900/70 backdrop-blur-md z-10 transition-all duration-300 ${
            sidebarOpen ? "w-[360px] lg:w-[400px]" : "w-0 overflow-hidden border-r-0"
          }`}
        >
          <PersonnelList
            data={personnelList}
            isLoading={isLoading}
            onSelect={handleSelectPersonnel}
            selectedId={selectedPersonnelId}
            lastUpdated={lastUpdated}
          />
        </aside>

        {/* Sidebar Toggle Button (Desktop) */}
        <button
          onClick={() => setSidebarOpen((prev) => !prev)}
          className={`hidden md:flex absolute top-1/2 -translate-y-1/2 z-20 w-5 h-12 bg-slate-800/90 hover:bg-slate-700 text-slate-300 hover:text-white rounded-r-md border border-l-0 border-slate-700 items-center justify-center shadow-lg transition-all cursor-pointer ${
            sidebarOpen ? "left-[360px] lg:left-[400px]" : "left-0"
          }`}
          aria-label={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
          title={sidebarOpen ? "Collapse personnel panel" : "Expand personnel panel"}
        >
          {sidebarOpen ? <ChevronLeft size={14} /> : <ChevronRight size={14} />}
        </button>

        {/* Center Canvas: MAP (always active, visible on mobile when mobileTab === 'map') */}
        <div
          className={`flex-1 h-full relative z-0 bg-slate-950 ${
            mobileTab !== "map" ? "hidden md:block" : "block"
          }`}
        >
          <MapComponent
            data={personnelList}
            selectedId={selectedPersonnelId}
            onMarkerClick={handleSelectPersonnel}
          />
        </div>

        {/* MOBILE VIEW: Personnel List Tab */}
        <div className={`md:hidden flex-1 h-full bg-slate-900 ${mobileTab === "list" ? "block" : "hidden"}`}>
          <PersonnelList
            data={personnelList}
            isLoading={isLoading}
            onSelect={(id) => {
              handleSelectPersonnel(id);
            }}
            selectedId={selectedPersonnelId}
            lastUpdated={lastUpdated}
          />
        </div>

        {/* MOBILE VIEW: Alerts Tab (SOS Focused) */}
        <div className={`md:hidden flex-1 h-full bg-slate-900 overflow-y-auto p-3 ${mobileTab === "alerts" ? "block" : "hidden"}`}>
          <div className="space-y-3">
            <div className="flex items-center justify-between pb-2 border-b border-slate-800">
              <h3 className="text-sm font-bold text-white uppercase tracking-wider flex items-center gap-2">
                <ShieldAlert size={16} className="text-rose-400" /> Active Emergency Alerts ({stats.sosActive})
              </h3>
            </div>

            {stats.sosActive === 0 ? (
              <div className="text-center py-16 text-slate-500">
                <ShieldAlert size={40} className="mx-auto text-slate-700 mb-3" />
                <p className="text-sm font-semibold text-slate-300">All Systems Nominal</p>
                <p className="text-xs text-slate-500 mt-1">No active SOS alerts or emergency transmissions.</p>
              </div>
            ) : (
              personnelList
                .filter((p) => p.sosStatus === "SOS ACTIVE")
                .map((p) => (
                  <div
                    key={p.id}
                    onClick={() => handleSelectPersonnel(p.id)}
                    className="p-4 rounded-xl border border-rose-600/80 bg-rose-950/40 text-slate-100 space-y-2 cursor-pointer shadow-lg shadow-rose-950/40 animate-pulse"
                  >
                    <div className="flex justify-between items-start">
                      <div>
                        <div className="font-bold text-base text-white">{p.name}</div>
                        <div className="text-xs text-rose-300 font-mono">{p.personnelCode} • {p.unit}</div>
                      </div>
                      <span className="bg-rose-600 text-white text-[10px] font-black uppercase px-2 py-0.5 rounded-full">
                        EMERGENCY
                      </span>
                    </div>
                    {p.location && (
                      <div className="text-xs text-slate-300 font-mono">
                        GPS: {p.location.latitude.toFixed(5)}, {p.location.longitude.toFixed(5)} (±{p.location.accuracy.toFixed(1)}m)
                      </div>
                    )}
                    <div className="pt-2 flex gap-2">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleSelectPersonnel(p.id);
                          setMobileTab("map");
                        }}
                        className="flex-1 py-1.5 px-3 rounded-lg bg-sky-600 text-white font-semibold text-xs flex items-center justify-center gap-1.5"
                      >
                        <MapIcon size={13} /> View on Map
                      </button>
                    </div>
                  </div>
                ))
            )}
          </div>
        </div>

        {/* DESKTOP Right Slide-out Details Drawer */}
        {selectedPersonnel && (
          <aside className="hidden md:flex absolute right-0 top-0 h-full w-[380px] lg:w-[420px] border-l border-slate-800 bg-slate-900 shadow-2xl z-20 flex-col animate-in slide-in-from-right-8 duration-200">
            <PersonnelDetail
              personnel={selectedPersonnel}
              onClose={() => setSelectedPersonnelId(null)}
            />
          </aside>
        )}

        {/* MOBILE Bottom Sheet Details Drawer */}
        {selectedPersonnel && (
          <div className="md:hidden fixed inset-0 z-50 flex flex-col justify-end bg-slate-950/60 backdrop-blur-sm animate-in fade-in duration-150">
            {/* Click-away backdrop */}
            <div className="flex-1" onClick={() => setSelectedPersonnelId(null)} />

            {/* Sheet Card */}
            <div className="h-[75vh] max-h-[600px] w-full bg-slate-900 border-t border-slate-800 rounded-t-3xl shadow-2xl flex flex-col animate-in slide-in-from-bottom duration-250">
              {/* Sheet Drag Handle */}
              <div className="w-12 h-1.5 bg-slate-700 rounded-full mx-auto my-2.5 flex-shrink-0" />

              <PersonnelDetail
                personnel={selectedPersonnel}
                onClose={() => setSelectedPersonnelId(null)}
              />
            </div>
          </div>
        )}
      </div>

      {/* MOBILE Bottom Navigation Switcher */}
      <nav className="md:hidden h-14 bg-slate-950/95 border-t border-slate-800/80 px-6 flex items-center justify-around flex-shrink-0 z-30 pb-[env(safe-area-inset-bottom)]">
        <button
          onClick={() => setMobileTab("map")}
          className={`flex flex-col items-center gap-1 py-1 px-3 text-xs font-semibold transition-colors cursor-pointer ${
            mobileTab === "map" ? "text-sky-400" : "text-slate-400 hover:text-slate-200"
          }`}
        >
          <MapIcon size={18} />
          <span>Map</span>
        </button>

        <button
          onClick={() => setMobileTab("list")}
          className={`flex flex-col items-center gap-1 py-1 px-3 text-xs font-semibold relative transition-colors cursor-pointer ${
            mobileTab === "list" ? "text-sky-400" : "text-slate-400 hover:text-slate-200"
          }`}
        >
          <Users size={18} />
          <span>Personnel ({stats.total})</span>
        </button>

        <button
          onClick={() => setMobileTab("alerts")}
          className={`flex flex-col items-center gap-1 py-1 px-3 text-xs font-semibold relative transition-colors cursor-pointer ${
            mobileTab === "alerts" ? "text-rose-400" : "text-slate-400 hover:text-slate-200"
          }`}
        >
          <ShieldAlert size={18} className={stats.sosActive > 0 ? "text-rose-400 animate-bounce" : ""} />
          <span>Alerts {stats.sosActive > 0 && `(${stats.sosActive})`}</span>
          {stats.sosActive > 0 && (
            <span className="absolute top-0.5 right-2 w-2 h-2 rounded-full bg-rose-500 animate-ping" />
          )}
        </button>
      </nav>
    </div>
  );
}
