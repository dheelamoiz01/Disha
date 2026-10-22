"use client";

import { useState } from "react";
import {
  Smartphone,
  Upload,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  Download,
  Copy,
  Check,
  ShieldCheck,
  FileCheck,
  AlertCircle,
  Plus,
  RefreshCw,
  ExternalLink,
  Info,
} from "lucide-react";

export type ReleaseItem = {
  id: string;
  versionCode: number;
  versionName: string;
  releaseNotes: string;
  downloadUrl: string;
  sha256Checksum: string;
  fileSizeBytes: number | null;
  minSupportedVersionCode: number;
  isMandatory: boolean;
  isActive: boolean;
  publishedBy: string | null;
  publishedAt: string;
  updatedAt: string;
};

export default function ReleasesClient({
  initialReleases,
}: {
  initialReleases: ReleaseItem[];
}) {
  const [releases, setReleases] = useState<ReleaseItem[]>(initialReleases);
  const [loading, setLoading] = useState(false);
  const [showPublishModal, setShowPublishModal] = useState(false);
  const [notification, setNotification] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  // Upload & Form state
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const [formData, setFormData] = useState({
    versionCode: "",
    versionName: "",
    releaseNotes: "",
    downloadUrl: "",
    sha256Checksum: "",
    fileSizeBytes: 0,
    minSupportedVersionCode: "1",
    isMandatory: false,
  });

  const showNotification = (message: string, type: "success" | "error" = "success") => {
    setNotification({ type, message });
    setTimeout(() => setNotification(null), 5000);
  };

  const refreshReleases = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/releases");
      if (!res.ok) throw new Error("Failed to fetch releases");
      const data = await res.json();
      setReleases(data.releases || []);
    } catch (err: any) {
      showNotification(err.message || "Failed to refresh releases", "error");
    } finally {
      setLoading(false);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.name.toLowerCase().endsWith(".apk")) {
      showNotification("Please select a valid Android APK file (.apk)", "error");
      return;
    }

    setUploading(true);
    const body = new FormData();
    body.append("file", file);

    try {
      const res = await fetch("/api/admin/releases/upload", {
        method: "POST",
        body,
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to upload APK");

      setFormData((prev) => ({
        ...prev,
        downloadUrl: data.downloadUrl,
        sha256Checksum: data.sha256Checksum,
        fileSizeBytes: data.fileSizeBytes,
      }));

      showNotification(`APK uploaded and SHA-256 verified: ${data.fileName}`);
    } catch (err: any) {
      showNotification(err.message || "Error uploading APK", "error");
    } finally {
      setUploading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);

    try {
      const res = await fetch("/api/admin/releases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          versionCode: parseInt(formData.versionCode, 10),
          versionName: formData.versionName,
          releaseNotes: formData.releaseNotes,
          downloadUrl: formData.downloadUrl,
          sha256Checksum: formData.sha256Checksum,
          fileSizeBytes: formData.fileSizeBytes ? formData.fileSizeBytes : undefined,
          minSupportedVersionCode: parseInt(formData.minSupportedVersionCode, 10),
          isMandatory: formData.isMandatory,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to publish release");

      showNotification(data.message || "Release published successfully!");
      setShowPublishModal(false);
      setFormData({
        versionCode: "",
        versionName: "",
        releaseNotes: "",
        downloadUrl: "",
        sha256Checksum: "",
        fileSizeBytes: 0,
        minSupportedVersionCode: "1",
        isMandatory: false,
      });
      await refreshReleases();
    } catch (err: any) {
      showNotification(err.message || "Failed to publish release", "error");
    } finally {
      setSubmitting(false);
    }
  };

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const formatFileSize = (bytes: number | null) => {
    if (!bytes || bytes <= 0) return "N/A";
    const mb = bytes / (1024 * 1024);
    return `${mb.toFixed(2)} MB`;
  };

  const latestRelease = releases[0];

  return (
    <div className="flex-1 bg-slate-950 text-slate-100 min-h-screen p-4 sm:p-6 lg:p-8 space-y-6">
      {/* Toast Notification */}
      {notification && (
        <div
          className={`fixed bottom-5 right-5 z-50 flex items-center gap-3 px-4 py-3 rounded-xl border shadow-xl transition-all ${
            notification.type === "success"
              ? "bg-slate-900 border-emerald-500/50 text-emerald-300"
              : "bg-slate-900 border-rose-500/50 text-rose-300"
          }`}
        >
          {notification.type === "success" ? (
            <CheckCircle2 size={18} className="text-emerald-400" />
          ) : (
            <AlertCircle size={18} className="text-rose-400" />
          )}
          <span className="text-sm font-medium">{notification.message}</span>
        </div>
      )}

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-800 pb-5">
        <div>
          <div className="flex items-center gap-2.5">
            <Smartphone className="text-sky-400" size={24} />
            <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-white">
              In-App OTA Release Management
            </h1>
          </div>
          <p className="text-xs sm:text-sm text-slate-400 mt-1">
            Publish signed Android APK releases, enforce mandatory upgrades, and cryptographically verify downloads.
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          <button
            onClick={refreshReleases}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-xl bg-slate-900 border border-slate-800 text-slate-300 hover:text-white hover:bg-slate-800 transition"
          >
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
            <span>Refresh</span>
          </button>
          <button
            onClick={() => setShowPublishModal(true)}
            className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-xl bg-sky-600 hover:bg-sky-500 text-white shadow-lg shadow-sky-600/20 transition cursor-pointer"
          >
            <Plus size={16} />
            <span>Publish New Release</span>
          </button>
        </div>
      </div>

      {/* Overview Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-slate-900/60 border border-slate-800/80 rounded-2xl p-4">
          <span className="text-xs text-slate-400 font-medium">Active Release Version</span>
          <div className="text-xl font-bold text-white mt-1 flex items-center gap-2">
            <span>{latestRelease ? `v${latestRelease.versionName}` : "None"}</span>
            {latestRelease && (
              <span className="text-xs font-mono px-2 py-0.5 rounded bg-sky-950 text-sky-400 border border-sky-800/50">
                Code {latestRelease.versionCode}
              </span>
            )}
          </div>
          <p className="text-[11px] text-slate-500 mt-1">
            Latest OTA target served to worker devices
          </p>
        </div>

        <div className="bg-slate-900/60 border border-slate-800/80 rounded-2xl p-4">
          <span className="text-xs text-slate-400 font-medium">Mandatory Policy</span>
          <div className="text-xl font-bold mt-1 flex items-center gap-2">
            {latestRelease?.isMandatory ? (
              <span className="text-rose-400 flex items-center gap-1.5 text-base">
                <AlertTriangle size={16} /> Mandatory Update
              </span>
            ) : (
              <span className="text-emerald-400 flex items-center gap-1.5 text-base">
                <CheckCircle2 size={16} /> Optional (Worker Choice)
              </span>
            )}
          </div>
          <p className="text-[11px] text-slate-500 mt-1">
            Min supported: Code {latestRelease?.minSupportedVersionCode ?? 1}
          </p>
        </div>

        <div className="bg-slate-900/60 border border-slate-800/80 rounded-2xl p-4">
          <span className="text-xs text-slate-400 font-medium">Total Releases</span>
          <div className="text-xl font-bold text-white mt-1">
            {releases.length}
          </div>
          <p className="text-[11px] text-slate-500 mt-1">
            Archived and active APK versions
          </p>
        </div>

        <div className="bg-slate-900/60 border border-slate-800/80 rounded-2xl p-4">
          <span className="text-xs text-slate-400 font-medium">Package Verification</span>
          <div className="text-sm font-semibold text-sky-400 mt-1 flex items-center gap-1.5">
            <ShieldCheck size={16} className="text-sky-400" />
            <span>SHA-256 Incremental Stream</span>
          </div>
          <p className="text-[11px] text-slate-500 mt-1">
            Zero-memory streaming hash verification
          </p>
        </div>
      </div>

      {/* Releases Table */}
      <div className="bg-slate-900/50 border border-slate-800 rounded-2xl overflow-hidden shadow-sm">
        <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between">
          <h2 className="text-sm font-bold text-slate-200">Release History & Distribution</h2>
          <span className="text-xs text-slate-400">{releases.length} total releases</span>
        </div>

        {releases.length === 0 ? (
          <div className="p-12 text-center text-slate-500 space-y-2">
            <Smartphone size={36} className="mx-auto text-slate-600 mb-2" />
            <p className="text-sm font-medium text-slate-400">No releases published yet</p>
            <p className="text-xs">Upload your compiled Android APK to enable in-app OTA updates for worker devices.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-800/80 bg-slate-900/80 text-slate-400 font-semibold uppercase tracking-wider">
                  <th className="py-3 px-4">Version</th>
                  <th className="py-3 px-4">Policy</th>
                  <th className="py-3 px-4">Size</th>
                  <th className="py-3 px-4">SHA-256 Checksum</th>
                  <th className="py-3 px-4">Release Notes</th>
                  <th className="py-3 px-4">Published At</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {releases.map((rel) => (
                  <tr key={rel.id} className="hover:bg-slate-800/30 transition">
                    <td className="py-3.5 px-4">
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-white text-sm">v{rel.versionName}</span>
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-sky-950 text-sky-400 border border-sky-800/60">
                          Code {rel.versionCode}
                        </span>
                        {rel.isActive && (
                          <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-950 text-emerald-400 border border-emerald-800/60">
                            Active
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="py-3.5 px-4">
                      {rel.isMandatory ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-rose-950/60 text-rose-300 border border-rose-800/50">
                          <AlertTriangle size={12} /> Mandatory
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-slate-800 text-slate-300">
                          Optional
                        </span>
                      )}
                      <div className="text-[10px] text-slate-500 mt-0.5">
                        Min: Code {rel.minSupportedVersionCode}
                      </div>
                    </td>
                    <td className="py-3.5 px-4 font-mono text-slate-300">
                      {formatFileSize(rel.fileSizeBytes)}
                    </td>
                    <td className="py-3.5 px-4">
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono text-[11px] text-slate-400 max-w-[140px] truncate" title={rel.sha256Checksum}>
                          {rel.sha256Checksum.substring(0, 16)}...
                        </span>
                        <button
                          onClick={() => copyToClipboard(rel.sha256Checksum, `sha-${rel.id}`)}
                          className="p-1 rounded text-slate-500 hover:text-slate-200 transition"
                          title="Copy full SHA-256 checksum"
                        >
                          {copiedId === `sha-${rel.id}` ? (
                            <Check size={12} className="text-emerald-400" />
                          ) : (
                            <Copy size={12} />
                          )}
                        </button>
                      </div>
                    </td>
                    <td className="py-3.5 px-4 max-w-xs text-slate-300 truncate" title={rel.releaseNotes}>
                      {rel.releaseNotes}
                    </td>
                    <td className="py-3.5 px-4 text-slate-400 whitespace-nowrap">
                      {new Date(rel.publishedAt).toLocaleString("en-IN", {
                        timeZone: "Asia/Kolkata",
                        dateStyle: "medium",
                        timeStyle: "short",
                      })}
                    </td>
                    <td className="py-3.5 px-4 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <a
                          href={`/api/app/release/download/${rel.id}`}
                          download
                          className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-sky-600/20 text-sky-300 hover:bg-sky-600 hover:text-white border border-sky-500/30 transition text-xs font-medium"
                          title="Download APK"
                        >
                          <Download size={12} />
                          <span>Download</span>
                        </a>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Publish Release Modal */}
      {showPublishModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-150">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-2xl w-full p-6 space-y-5 shadow-2xl overflow-y-auto max-h-[90vh]">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2">
                <Smartphone className="text-sky-400" size={20} />
                <h3 className="text-base font-bold text-white">Publish New Android OTA Release</h3>
              </div>
              <button
                onClick={() => setShowPublishModal(false)}
                className="text-slate-400 hover:text-white p-1 rounded-lg"
              >
                ✕
              </button>
            </div>

            {/* Step 1: Upload APK File */}
            <div className="p-4 rounded-xl bg-slate-950 border border-dashed border-slate-800 space-y-3">
              <span className="text-xs font-semibold text-slate-300 uppercase tracking-wider block">
                1. Upload Signed APK Package (.apk)
              </span>
              <p className="text-xs text-slate-400">
                Uploading the APK automatically computes its SHA-256 hash and file size.
              </p>
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-2 px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-200 cursor-pointer transition border border-slate-700">
                  <Upload size={14} />
                  <span>{uploading ? "Uploading & Hashing..." : "Choose APK File"}</span>
                  <input
                    type="file"
                    accept=".apk"
                    onChange={handleFileUpload}
                    disabled={uploading}
                    className="hidden"
                  />
                </label>
                {uploading && <Loader2 size={16} className="animate-spin text-sky-400" />}
                {formData.fileSizeBytes > 0 && (
                  <span className="text-xs text-emerald-400 flex items-center gap-1">
                    <CheckCircle2 size={14} /> {formatFileSize(formData.fileSizeBytes)} verified
                  </span>
                )}
              </div>
            </div>

            {/* Step 2: Release Metadata Form */}
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="text-xs font-medium text-slate-300 block mb-1">
                    Version Code (Integer, strictly ascending) *
                  </label>
                  <input
                    type="number"
                    min="1"
                    required
                    placeholder="e.g. 2"
                    value={formData.versionCode}
                    onChange={(e) => setFormData({ ...formData, versionCode: e.target.value })}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-sky-500 font-mono"
                  />
                </div>

                <div>
                  <label className="text-xs font-medium text-slate-300 block mb-1">
                    Version Name (Display semantic version) *
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. 2.1.0"
                    value={formData.versionName}
                    onChange={(e) => setFormData({ ...formData, versionName: e.target.value })}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-sky-500 font-mono"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="text-xs font-medium text-slate-300 block mb-1">
                    Min Supported Version Code *
                  </label>
                  <input
                    type="number"
                    min="1"
                    required
                    placeholder="1"
                    value={formData.minSupportedVersionCode}
                    onChange={(e) => setFormData({ ...formData, minSupportedVersionCode: e.target.value })}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-sky-500 font-mono"
                  />
                  <span className="text-[10px] text-slate-500">
                    Devices below this version code cannot skip this update.
                  </span>
                </div>

                <div className="flex items-center pt-5">
                  <label className="flex items-center gap-2 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={formData.isMandatory}
                      onChange={(e) => setFormData({ ...formData, isMandatory: e.target.checked })}
                      className="rounded bg-slate-950 border-slate-800 text-sky-600 focus:ring-0 w-4 h-4 cursor-pointer"
                    />
                    <span className="text-xs font-semibold text-slate-200">
                      Force Mandatory Update (No "Later" bypass)
                    </span>
                  </label>
                </div>
              </div>

              <div>
                <label className="text-xs font-medium text-slate-300 block mb-1">
                  Download URL (Relative or secure HTTPS) *
                </label>
                <input
                  type="text"
                  required
                  placeholder="/downloads/apk/disha-tracker.apk"
                  value={formData.downloadUrl}
                  onChange={(e) => setFormData({ ...formData, downloadUrl: e.target.value })}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-sky-500 font-mono"
                />
              </div>

              <div>
                <label className="text-xs font-medium text-slate-300 block mb-1">
                  SHA-256 Checksum (64 hexadecimal characters) *
                </label>
                <input
                  type="text"
                  required
                  pattern="[a-fA-F0-9]{64}"
                  placeholder="Auto-populated when APK file is uploaded"
                  value={formData.sha256Checksum}
                  onChange={(e) => setFormData({ ...formData, sha256Checksum: e.target.value })}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-sky-500 font-mono"
                />
              </div>

              <div>
                <label className="text-xs font-medium text-slate-300 block mb-1">
                  Release Notes / Changelog *
                </label>
                <textarea
                  required
                  rows={3}
                  placeholder="• 24x7 Continuous Location Tracking&#10;• 10-Second Telemetry Interval&#10;• Offline Queue Sync Improvements"
                  value={formData.releaseNotes}
                  onChange={(e) => setFormData({ ...formData, releaseNotes: e.target.value })}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-sky-500 font-sans"
                />
              </div>

              <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setShowPublishModal(false)}
                  className="px-4 py-2 rounded-xl text-xs font-semibold text-slate-400 hover:text-white transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold shadow-lg shadow-sky-600/20 transition cursor-pointer disabled:opacity-50"
                >
                  {submitting ? (
                    <>
                      <Loader2 size={14} className="animate-spin" />
                      <span>Publishing...</span>
                    </>
                  ) : (
                    <>
                      <FileCheck size={14} />
                      <span>Publish Release</span>
                    </>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
