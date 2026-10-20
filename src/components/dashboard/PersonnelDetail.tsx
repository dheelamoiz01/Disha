"use client";

import { useState } from "react";
import Link from "next/link";
import { DashboardPersonnel } from "@/hooks/useDashboardData";
import { formatIST } from "@/lib/utils/time";
import {
  X,
  ShieldAlert,
  Navigation,
  Smartphone,
  User,
  Battery,
  BatteryLow,
  BatteryMedium,
  CheckCircle,
  AlertCircle,
  MapPin,
  Loader2,
  History,
  Route,
} from "lucide-react";

interface Props {
  personnel: DashboardPersonnel;
  onClose: () => void;
  className?: string;
}

export default function PersonnelDetail({ personnel, onClose, className = "" }: Props) {
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyPoints, setHistoryPoints] = useState<Array<{ id: string; latitude: number; longitude: number; recordedAt: string; accuracy: number }>>([]);

  const handleAcknowledge = async () => {
    if (!personnel.activeAlertId) return;
    setActionLoading("ack");
    setActionMessage(null);

    try {
      const res = await fetch(`/api/alerts/${personnel.activeAlertId}/ack`, {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to acknowledge alert");
      }
      setActionMessage({ type: "success", text: "Emergency alert acknowledged by Control Room." });
    } catch (err: unknown) {
      setActionMessage({ type: "error", text: err instanceof Error ? err.message : "Failed to acknowledge" });
    } finally {
      setActionLoading(null);
    }
  };

  const handleResolve = async () => {
    if (!personnel.activeAlertId) return;
    setActionLoading("resolve");
    setActionMessage(null);

    try {
      const res = await fetch(`/api/alerts/${personnel.activeAlertId}/resolve`, {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to resolve alert");
      }
      setActionMessage({ type: "success", text: "Emergency marked resolved." });
    } catch (err: unknown) {
      setActionMessage({ type: "error", text: err instanceof Error ? err.message : "Failed to resolve" });
    } finally {
      setActionLoading(null);
    }
  };

  const loadHistory = async () => {
    if (showHistory) {
      setShowHistory(false);
      return;
    }

    setHistoryLoading(true);
    setShowHistory(true);
    try {
      const end = new Date();
      const start = new Date(Date.now() - 24 * 60 * 60 * 1000); // Past 24 hours
      const res = await fetch(
        `/api/control-room/personnel/${personnel.id}/location-history?start=${start.toISOString()}&end=${end.toISOString()}`
      );
      if (res.ok) {
        const json = await res.json();
        setHistoryPoints(json.locations || []);
      }
    } catch (err) {
      console.error("Failed to load location history:", err);
    } finally {
      setHistoryLoading(false);
    }
  };

  const renderBattery = (level: number | null | undefined) => {
    if (level === null || level === undefined) return "Unknown";
    let Icon = Battery;
    let color = "text-emerald-400";
    if (level <= 20) {
      Icon = BatteryLow;
      color = "text-rose-400";
    } else if (level <= 50) {
      Icon = BatteryMedium;
      color = "text-amber-400";
    }
    return (
      <span className={`flex items-center gap-1.5 font-bold ${color}`}>
        <Icon size={14} />
        {level}%
      </span>
    );
  };

  return (
    <div className={`flex flex-col h-full bg-slate-900 text-slate-100 ${className}`}>
      {/* Header */}
      <div className="p-4 border-b border-slate-800 flex justify-between items-center sticky top-0 bg-slate-900/95 backdrop-blur-md z-10 flex-shrink-0">
        <div className="min-w-0 pr-2">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-base sm:text-lg font-bold text-white truncate">{personnel.name}</h2>
          </div>
          <p className="text-xs text-slate-400 mt-0.5 truncate">
            {[personnel.designation, personnel.unit].filter(Boolean).join(" • ") || "Field Personnel"}
          </p>
        </div>

        <button
          onClick={onClose}
          aria-label="Close personnel details"
          className="p-1.5 hover:bg-slate-800 rounded-xl text-slate-400 hover:text-white transition-colors cursor-pointer flex-shrink-0"
        >
          <X size={20} />
        </button>
      </div>

      {/* Body with scrolling */}
      <div className="flex-1 overflow-y-auto p-4 space-y-5 custom-scrollbar pb-8">
        {/* Action feedback */}
        {actionMessage && (
          <div
            className={`p-3 rounded-xl border text-xs flex items-center gap-2 ${
              actionMessage.type === "success"
                ? "bg-emerald-950/40 border-emerald-800 text-emerald-300"
                : "bg-rose-950/40 border-rose-800 text-rose-300"
            }`}
          >
            {actionMessage.type === "success" ? <CheckCircle size={15} /> : <AlertCircle size={15} />}
            <span>{actionMessage.text}</span>
          </div>
        )}

        {/* SOS Alert Section */}
        {personnel.sosStatus === "SOS ACTIVE" && (
          <div className="bg-rose-950/50 border border-rose-700/80 p-4 rounded-xl shadow-lg shadow-rose-950/40 animate-pulse">
            <div className="flex items-center gap-2 text-rose-400 font-bold mb-2 text-sm">
              <ShieldAlert size={18} className="animate-bounce" /> ACTIVE SOS EMERGENCY
            </div>
            <p className="text-slate-300 text-xs mb-3.5 leading-relaxed">
              SOS beacon broadcasting from this unit. Immediate control room intervention required.
            </p>
            {personnel.activeAlertId ? (
              <div className="flex gap-2.5 flex-wrap">
                <button
                  onClick={handleAcknowledge}
                  disabled={actionLoading !== null}
                  className="flex-1 min-w-[120px] py-2 px-3 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold transition-all flex items-center justify-center gap-1.5 shadow-md shadow-rose-600/30 active:scale-95 disabled:opacity-50 cursor-pointer"
                >
                  {actionLoading === "ack" ? <Loader2 size={13} className="animate-spin" /> : "Acknowledge"}
                </button>
                <button
                  onClick={handleResolve}
                  disabled={actionLoading !== null}
                  className="flex-1 min-w-[120px] py-2 px-3 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-bold transition-all flex items-center justify-center gap-1.5 active:scale-95 disabled:opacity-50 cursor-pointer"
                >
                  {actionLoading === "resolve" ? <Loader2 size={13} className="animate-spin" /> : "Resolve Alert"}
                </button>
              </div>
            ) : (
              <p className="text-slate-400 text-[11px] italic">No active alert ID found for this session.</p>
            )}
          </div>
        )}

        {/* Identity & Duty Section */}
        <section>
          <h3 className="text-slate-400 font-bold mb-2.5 flex items-center gap-2 text-xs uppercase tracking-wider">
            <User size={13} className="text-sky-400" /> Identity &amp; Duty Profile
          </h3>
          <div className="bg-slate-950/70 rounded-xl border border-slate-800/80 p-3.5 space-y-2.5 text-xs">
            <div className="flex justify-between items-center">
              <span className="text-slate-400">Unit</span>
              <span className="text-slate-200 font-semibold">{personnel.unit || "Not Assigned"}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-slate-400">Designation</span>
              <span className="text-slate-200 font-semibold">{personnel.designation || "Field Officer"}</span>
            </div>
            <div className="flex justify-between items-center border-t border-slate-800/60 pt-2 mt-2">
              <span className="text-slate-400">Duty State</span>
              <span
                className={`font-bold px-2 py-0.5 rounded text-[11px] ${
                  personnel.dutyStatus === "ON DUTY"
                    ? "bg-emerald-950/50 text-emerald-400 border border-emerald-900/50"
                    : "bg-slate-800 text-slate-400"
                }`}
              >
                {personnel.dutyStatus}
              </span>
            </div>
          </div>
        </section>

        {/* Telemetry & Location Section */}
        <section>
          <div className="flex items-center justify-between mb-2.5">
            <h3 className="text-slate-400 font-bold flex items-center gap-2 text-xs uppercase tracking-wider">
              <Navigation size={13} className="text-sky-400" /> Location Telemetry
            </h3>
            <button
              onClick={loadHistory}
              className="text-[11px] text-sky-400 hover:text-sky-300 flex items-center gap-1 font-semibold transition-colors cursor-pointer"
            >
              <History size={12} />
              {showHistory ? "Hide Trail" : "View History"}
            </button>
          </div>

          <div className="bg-slate-950/70 rounded-xl border border-slate-800/80 p-3.5 space-y-2.5 text-xs">
            <div className="flex justify-between items-center">
              <span className="text-slate-400">Tracking Status</span>
              <span
                className={`font-bold px-2 py-0.5 rounded text-[11px] border ${
                  personnel.trackingStatus === "GPS ACTIVE"
                    ? "bg-emerald-950/80 text-emerald-300 border-emerald-800/60"
                    : personnel.trackingStatus === "NETWORK LOCATION"
                      ? "bg-cyan-950/80 text-cyan-300 border-cyan-800/60"
                      : personnel.trackingStatus === "LOCATION OFF" || personnel.trackingStatus === "PERMISSION DENIED"
                        ? "bg-rose-950/80 text-rose-300 border-rose-800/60"
                        : personnel.trackingStatus === "GPS UNAVAILABLE" || personnel.trackingStatus === "INTERNET DISCONNECTED" || personnel.trackingStatus === "TRACKING INTERRUPTED"
                          ? "bg-amber-950/80 text-amber-300 border-amber-800/60"
                          : "bg-slate-900 text-slate-400 border-slate-800"
                }`}
              >
                {personnel.trackingStatus || personnel.locationStatus}
              </span>
            </div>

            {personnel.statusReason && (
              <div className="text-[11px] text-slate-400 bg-slate-900/80 border border-slate-800/60 px-2.5 py-1.5 rounded-lg">
                <span className="text-slate-300 font-medium">{personnel.statusReason}</span>
                {personnel.confirmedByDevice && (
                  <span className="ml-1.5 text-[9px] uppercase tracking-wider text-emerald-400 font-bold font-mono">
                    • Verified Device Report
                  </span>
                )}
              </div>
            )}

            <div className="flex justify-between items-center">
              <span className="text-slate-400">Network Link</span>
              <span
                className={`font-bold flex items-center gap-1.5 ${
                  personnel.networkStatus === "ONLINE" ? "text-emerald-400" : "text-rose-400"
                }`}
              >
                <span
                  className={`w-1.5 h-1.5 rounded-full ${
                    personnel.networkStatus === "ONLINE" ? "bg-emerald-400" : "bg-rose-400"
                  }`}
                />
                {personnel.networkStatus}
              </span>
            </div>

            {personnel.location ? (
              <>
                <div className="flex justify-between items-center border-t border-slate-800/60 pt-2 mt-2">
                  <span className="text-slate-400">Coordinates</span>
                  <span className="text-slate-200 font-mono text-[11px] bg-slate-900 px-2 py-0.5 rounded border border-slate-800">
                    {personnel.location.latitude.toFixed(5)}, {personnel.location.longitude.toFixed(5)}
                  </span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-slate-400">Provider & Accuracy</span>
                  <div className="flex items-center gap-1.5">
                    {personnel.location.source && (
                      <span
                        className={`text-[10px] font-mono font-bold px-1.5 py-0.2 rounded border ${
                          personnel.location.source === "NETWORK"
                            ? "bg-cyan-950/90 text-cyan-300 border-cyan-800/70"
                            : "bg-emerald-950/90 text-emerald-300 border-emerald-800/70"
                        }`}
                      >
                        {personnel.location.source}
                      </span>
                    )}
                    <span className="text-slate-300 font-medium">±{personnel.location.accuracy.toFixed(1)} m</span>
                  </div>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-slate-400">Recorded At</span>
                  <span className="text-slate-300">{formatIST(personnel.location.recordedAt, true)}</span>
                </div>
              </>
            ) : (
              <div className="border-t border-slate-800/60 pt-2 text-slate-500 text-center py-1">
                No GPS coordinates received for this officer.
              </div>
            )}

            {personnel.lastGpsFixTime && (
              <div className="flex justify-between items-center border-t border-slate-800/60 pt-2 mt-2">
                <span className="text-slate-400">Last GPS Fix</span>
                <span className="text-slate-300 font-mono text-[11px]">
                  {formatIST(personnel.lastGpsFixTime, true)}
                </span>
              </div>
            )}

            {personnel.lastHeartbeat && (
              <div className="flex justify-between items-center">
                <span className="text-slate-400">Last Heartbeat</span>
                <span className="text-slate-300 font-mono text-[11px]">
                  {formatIST(personnel.lastHeartbeat, true)}
                </span>
              </div>
            )}

            <div className="flex justify-between items-center border-t border-slate-800/60 pt-2 mt-2">
              <span className="text-slate-400">Last Contact</span>
              <span className="text-slate-300">
                {personnel.lastSeen ? formatIST(personnel.lastSeen, true) : "Never"}
              </span>
            </div>

            <Link
              href={`/dashboard/trail?personnelId=${personnel.id}`}
              className="mt-3 w-full py-2 px-3 rounded-xl bg-sky-600 hover:bg-sky-500 text-white text-xs font-bold transition-all flex items-center justify-center gap-2 shadow-md shadow-sky-600/20"
            >
              <Route size={14} />
              <span>View Route Trail &amp; Movement History</span>
            </Link>
          </div>
        </section>

        {/* Location History Accordion */}
        {showHistory && (
          <section className="bg-slate-950 rounded-xl border border-slate-800 p-3.5 text-xs animate-in fade-in duration-200">
            <h4 className="font-bold text-slate-300 mb-2 flex items-center gap-1.5">
              <MapPin size={13} className="text-sky-400" />
              Past 24 Hours Breadcrumbs ({historyPoints.length} points)
            </h4>

            {historyLoading ? (
              <div className="py-6 flex items-center justify-center text-slate-400 gap-2">
                <Loader2 size={16} className="animate-spin" /> Loading breadcrumb history...
              </div>
            ) : historyPoints.length === 0 ? (
              <p className="text-slate-500 py-3 text-center">No location history recorded in the past 24 hours.</p>
            ) : (
              <div className="max-h-48 overflow-y-auto space-y-1.5 pr-1 custom-scrollbar">
                {historyPoints.slice(-20).reverse().map((pt, idx) => (
                  <div key={pt.id || idx} className="flex justify-between items-center p-1.5 bg-slate-900/60 rounded border border-slate-800/40 text-[11px]">
                    <span className="font-mono text-slate-400">{pt.latitude.toFixed(4)}, {pt.longitude.toFixed(4)}</span>
                    <span className="text-slate-500">{formatIST(pt.recordedAt)}</span>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        {/* Device Health Section */}
        <section>
          <h3 className="text-slate-400 font-bold mb-2.5 flex items-center gap-2 text-xs uppercase tracking-wider">
            <Smartphone size={13} className="text-sky-400" /> Device Diagnostics
          </h3>
          <div className="bg-slate-950/70 rounded-xl border border-slate-800/80 p-3.5 space-y-2.5 text-xs">
            <div className="flex justify-between items-center">
              <span className="text-slate-400">Communication State</span>
              <span
                className={`font-bold flex items-center gap-1.5 ${
                  personnel.deviceStatus === "ONLINE"
                    ? "text-emerald-400"
                    : personnel.deviceStatus === "STALE"
                      ? "text-amber-400"
                      : "text-rose-400"
                }`}
              >
                <span
                  className={`w-2 h-2 rounded-full ${
                    personnel.deviceStatus === "ONLINE"
                      ? "bg-emerald-400"
                      : personnel.deviceStatus === "STALE"
                        ? "bg-amber-400"
                        : "bg-rose-400"
                  }`}
                />
                {personnel.deviceStatus}
              </span>
            </div>

            <div className="flex justify-between items-center">
              <span className="text-slate-400">Battery Level</span>
              {renderBattery(personnel.device?.batteryLevel)}
            </div>

            <div className="flex justify-between items-center">
              <span className="text-slate-400">Assigned Hardware ID</span>
              <span className="text-slate-300 font-mono text-[11px]">
                {personnel.device?.identifier || "None"}
              </span>
            </div>

            <div className="flex justify-between items-center border-t border-slate-800/60 pt-2 mt-2">
              <span className="text-slate-400">Last System Heartbeat</span>
              <span className="text-slate-300">
                {personnel.lastHeartbeat ? formatIST(personnel.lastHeartbeat, true) : "Never"}
              </span>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
