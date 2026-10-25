"use client";

import { useState, useEffect, useMemo } from "react";
import Link from "next/link";
import {
  Users,
  UserPlus,
  Search,
  RefreshCw,
  KeyRound,
  Edit2,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Loader2,
  ShieldCheck,
  Phone,
  Radio,
  Eye,
  EyeOff,
  X,
  AlertCircle,
  BadgeCheck,
  Trash2,
  Route,
} from "lucide-react";
import { formatIST } from "@/lib/utils/time";

export type StaffMember = {
  id: string;
  userId: string;
  adminId?: string | null;
  admin?: {
    id: string;
    username: string;
    displayName: string;
    role: string;
  } | null;
  username: string;
  name: string;
  personnelCode: string;
  designation: string | null;
  unit: string | null;
  phone: string | null;
  active: boolean;
  status: "ACTIVE" | "INACTIVE";
  connectionStatus?: "ONLINE" | "OFFLINE";
  lastSeenAt?: string | null;
  mustChangePassword: boolean;
  device: {
    id: string;
    deviceIdentifier: string;
    platform: string;
    status: string;
    connectionStatus?: "ONLINE" | "OFFLINE";
    lastSeenAt: string | null;
  } | null;
  activeDuty: {
    id: string;
    status: string;
    startedAt: string;
  } | null;
  createdAt: string;
  updatedAt: string;
};

export default function StaffManagementClient({ initialStaff }: { initialStaff?: StaffMember[] }) {
  const [staffList, setStaffList] = useState<StaffMember[]>(initialStaff || []);
  const [loading, setLoading] = useState(!initialStaff);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  // Modals state
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [editingStaff, setEditingStaff] = useState<StaffMember | null>(null);
  const [resetPasswordStaff, setResetPasswordStaff] = useState<StaffMember | null>(null);
  const [deletingStaff, setDeletingStaff] = useState<StaffMember | null>(null);

  // Notification Banner
  const [notification, setNotification] = useState<{ type: "success" | "error"; message: string } | null>(null);

  const fetchStaff = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/staff");
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to load staff accounts");
      }
      const data = await res.json();
      setStaffList(data.staff || []);
    } catch (err: any) {
      setError(err.message || "Failed to fetch staff accounts.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!initialStaff) {
      fetchStaff();
    }

    // Auto-refresh polling every 10 seconds to update worker connection status automatically
    const timer = setInterval(() => {
      if (!createModalOpen && !editingStaff && !resetPasswordStaff && !deletingStaff) {
        fetch("/api/staff")
          .then((res) => (res.ok ? res.json() : null))
          .then((data) => {
            if (data?.staff) {
              setStaffList(data.staff);
            }
          })
          .catch(() => {});
      }
    }, 10000);

    return () => clearInterval(timer);
  }, [createModalOpen, editingStaff, resetPasswordStaff, deletingStaff, initialStaff]);

  const showNotification = (message: string, type: "success" | "error" = "success") => {
    setNotification({ type, message });
    setTimeout(() => setNotification(null), 4000);
  };

  // Filtered staff list
  const filteredStaff = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    if (!q) return staffList;
    return staffList.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.username.toLowerCase().includes(q) ||
        s.personnelCode.toLowerCase().includes(q) ||
        (s.unit && s.unit.toLowerCase().includes(q)) ||
        (s.designation && s.designation.toLowerCase().includes(q)) ||
        (s.phone && s.phone.includes(q))
    );
  }, [staffList, searchQuery]);

  // Statistics
  const stats = useMemo(() => {
    return {
      total: staffList.length,
      active: staffList.filter((s) => s.active && s.status === "ACTIVE").length,
      inactive: staffList.filter((s) => !s.active || s.status === "INACTIVE").length,
      onDuty: staffList.filter((s) => !!s.activeDuty).length,
    };
  }, [staffList]);

  // Toggle status quick action
  const handleToggleStatus = async (staff: StaffMember) => {
    const nextActive = !staff.active;
    try {
      const res = await fetch(`/api/staff/${staff.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: nextActive }),
      });
      const data = await res.json();
      if (!res.ok) {
        showNotification(data.error || "Failed to update staff status", "error");
        return;
      }
      showNotification(`Staff member ${staff.name} is now ${nextActive ? "active" : "inactive"}.`);
      fetchStaff();
    } catch {
      showNotification("Network error updating staff status", "error");
    }
  };

  return (
    <div className="flex-1 flex flex-col h-full bg-slate-950 overflow-y-auto custom-scrollbar p-4 sm:p-6 lg:p-8">
      {/* Top Notification Banner */}
      {notification && (
        <div
          className={`mb-4 p-3.5 rounded-xl border flex items-center justify-between text-xs font-semibold animate-in fade-in duration-200 ${
            notification.type === "success"
              ? "bg-emerald-950/40 border-emerald-800 text-emerald-300"
              : "bg-rose-950/40 border-rose-800 text-rose-300"
          }`}
        >
          <div className="flex items-center gap-2">
            {notification.type === "success" ? <CheckCircle size={16} /> : <AlertTriangle size={16} />}
            <span>{notification.message}</span>
          </div>
          <button onClick={() => setNotification(null)} className="text-slate-400 hover:text-white">
            <X size={14} />
          </button>
        </div>
      )}

      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <div>
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-sky-500/10 border border-sky-500/20 text-sky-400">
              <Users size={22} />
            </div>
            <div>
              <h1 className="text-xl sm:text-2xl font-black text-white tracking-tight">Staff Management</h1>
              <p className="text-xs text-slate-400 mt-0.5">
                Register, manage, and assign credentials for field-operation officers and tracker devices.
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2.5">
          <button
            onClick={fetchStaff}
            disabled={loading}
            className="p-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-300 hover:text-white text-xs font-semibold transition"
            title="Refresh list"
          >
            <RefreshCw size={15} className={loading ? "animate-spin" : ""} />
          </button>

          <button
            onClick={() => setCreateModalOpen(true)}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-sky-600 hover:bg-sky-500 text-white text-xs font-bold transition shadow-lg shadow-sky-600/20 cursor-pointer"
          >
            <UserPlus size={15} />
            <span>Add Staff</span>
          </button>
        </div>
      </div>

      {/* KPI Stats Strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <div className="p-4 rounded-xl bg-slate-900/80 border border-slate-800 flex flex-col justify-center">
          <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Total Personnel</span>
          <span className="text-2xl font-black text-white mt-1">{stats.total}</span>
        </div>

        <div className="p-4 rounded-xl bg-emerald-950/20 border border-emerald-900/40 flex flex-col justify-center">
          <span className="text-[11px] font-bold uppercase tracking-wider text-emerald-400 flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" /> Active Staff
          </span>
          <span className="text-2xl font-black text-emerald-300 mt-1">{stats.active}</span>
        </div>

        <div className="p-4 rounded-xl bg-sky-950/20 border border-sky-900/40 flex flex-col justify-center">
          <span className="text-[11px] font-bold uppercase tracking-wider text-sky-400 flex items-center gap-1.5">
            <Radio size={13} className="animate-pulse" /> On Duty Now
          </span>
          <span className="text-2xl font-black text-sky-300 mt-1">{stats.onDuty}</span>
        </div>

        <div className="p-4 rounded-xl bg-slate-900/80 border border-slate-800 flex flex-col justify-center">
          <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Inactive / Suspended</span>
          <span className="text-2xl font-black text-slate-400 mt-1">{stats.inactive}</span>
        </div>
      </div>

      {/* Table & Controls Section */}
      <div className="flex-1 flex flex-col bg-slate-900/70 border border-slate-800 rounded-2xl overflow-hidden shadow-xl">
        {/* Search bar */}
        <div className="p-3 sm:p-4 border-b border-slate-800 flex items-center justify-between gap-4">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-500" size={15} />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by name, login ID, phone..."
              className="w-full bg-slate-950 border border-slate-700/80 rounded-xl pl-9 pr-3.5 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-sky-500 transition"
            />
          </div>
          <div className="text-xs text-slate-400 font-medium">
            Showing <span className="font-bold text-white">{filteredStaff.length}</span> of {staffList.length}
          </div>
        </div>

        {/* Content View */}
        {error ? (
          <div className="p-8 text-center flex flex-col items-center justify-center">
            <AlertCircle size={36} className="text-rose-400 mb-2" />
            <p className="text-sm font-semibold text-white">{error}</p>
            <button
              onClick={fetchStaff}
              className="mt-4 px-4 py-2 rounded-xl bg-sky-600 hover:bg-sky-500 text-xs font-semibold text-white"
            >
              Retry
            </button>
          </div>
        ) : loading && staffList.length === 0 ? (
          <div className="p-16 flex flex-col items-center justify-center text-slate-400">
            <Loader2 size={32} className="animate-spin text-sky-400 mb-3" />
            <p className="text-xs font-medium">Loading field staff accounts...</p>
          </div>
        ) : filteredStaff.length === 0 ? (
          <div className="p-16 text-center text-slate-400">
            <Users size={36} className="mx-auto text-slate-600 mb-2" />
            <p className="text-sm font-bold text-white">No staff members found</p>
            <p className="text-xs text-slate-500 mt-1">
              {searchQuery ? "Try refining your search filter." : "Click '+ Add Staff' to register new field personnel."}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto custom-scrollbar flex-1">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-950/80 text-slate-400 font-bold uppercase tracking-wider border-b border-slate-800">
                <tr>
                  <th className="py-3 px-4">Staff Member</th>
                  <th className="py-3 px-4">Login ID</th>
                  <th className="py-3 px-4">Connection</th>
                  <th className="py-3 px-4">Duty Status</th>
                  <th className="py-3 px-4">Phone</th>
                  <th className="py-3 px-4">Account Status</th>
                  <th className="py-3 px-4">Credentials</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {filteredStaff.map((staff) => (
                  <tr key={staff.id} className="hover:bg-slate-800/30 transition">
                    {/* Name */}
                    <td className="py-3.5 px-4">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-xl bg-sky-500/10 border border-sky-500/30 text-sky-300 flex items-center justify-center font-bold text-xs uppercase flex-shrink-0">
                          {staff.name.charAt(0)}
                        </div>
                        <div>
                          <div className="font-bold text-white flex items-center gap-1.5">
                            <span>{staff.name}</span>
                          </div>
                          {staff.admin && (
                            <div className="text-[10px] text-sky-400 font-mono flex items-center gap-1 mt-0.5">
                              <span className="text-slate-500">Admin:</span> @{staff.admin.username}
                            </div>
                          )}
                        </div>
                      </div>
                    </td>

                    {/* Login ID */}
                    <td className="py-3.5 px-4 font-mono text-slate-300 whitespace-nowrap">
                      @{staff.username}
                    </td>

                    {/* Connection Status */}
                    <td className="py-3.5 px-4 whitespace-nowrap">
                      <div className="flex flex-col gap-0.5">
                        {staff.connectionStatus === "ONLINE" ? (
                          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/10 text-emerald-300 border border-emerald-500/30 uppercase w-fit">
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" /> Online
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium bg-slate-800 text-slate-400 border border-slate-700 w-fit">
                            <span className="w-1.5 h-1.5 rounded-full bg-slate-500" /> Offline
                          </span>
                        )}
                        <span className="text-[10px] text-slate-500 font-mono">
                          {staff.lastSeenAt ? `Seen ${formatIST(staff.lastSeenAt)}` : "Never"}
                        </span>
                      </div>
                    </td>

                    {/* Duty Status */}
                    <td className="py-3.5 px-4 whitespace-nowrap">
                      {staff.activeDuty ? (
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/10 text-emerald-300 border border-emerald-500/30 uppercase">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" /> On Duty
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-slate-800 text-slate-400 border border-slate-700">
                          Off Duty
                        </span>
                      )}
                    </td>

                    {/* Phone */}
                    <td className="py-3.5 px-4 whitespace-nowrap">
                      {staff.phone ? (
                        <div className="flex items-center gap-1 text-slate-300 font-mono text-[11px]">
                          <Phone size={11} className="text-slate-500" />
                          <span>{staff.phone}</span>
                        </div>
                      ) : (
                        <span className="text-slate-500 italic">—</span>
                      )}
                    </td>

                    {/* Account Status */}
                    <td className="py-3.5 px-4 whitespace-nowrap">
                      <span
                        className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide ${
                          staff.active && staff.status === "ACTIVE"
                            ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                            : "bg-rose-500/10 text-rose-400 border border-rose-500/20"
                        }`}
                      >
                        <span
                          className={`w-1.5 h-1.5 rounded-full ${
                            staff.active && staff.status === "ACTIVE" ? "bg-emerald-400" : "bg-rose-400"
                          }`}
                        />
                        {staff.active && staff.status === "ACTIVE" ? "Active" : "Inactive"}
                      </span>
                    </td>

                    {/* Password status */}
                    <td className="py-3.5 px-4 whitespace-nowrap">
                      <span className="text-[10px] font-semibold text-slate-400">
                        Verified
                      </span>
                    </td>

                    {/* Actions */}
                    <td className="py-3.5 px-4 text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-1.5">
                        {/* View Location Trail */}
                        <Link
                          href={`/dashboard/trail?personnelId=${staff.id}`}
                          className="p-1.5 rounded-lg text-sky-400 hover:text-white hover:bg-sky-950/60 transition"
                          title="View Location Trail & Movement History"
                        >
                          <Route size={14} />
                        </Link>

                        {/* Edit Staff */}
                        <button
                          onClick={() => setEditingStaff(staff)}
                          className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition"
                          title="Edit staff details"
                        >
                          <Edit2 size={14} />
                        </button>

                        {/* Reset Password */}
                        <button
                          onClick={() => setResetPasswordStaff(staff)}
                          className="p-1.5 rounded-lg text-amber-400/80 hover:text-amber-300 hover:bg-slate-800 transition"
                          title="Reset staff password"
                        >
                          <KeyRound size={14} />
                        </button>

                        {/* Activate / Deactivate Toggle */}
                        <button
                          onClick={() => handleToggleStatus(staff)}
                          className={`p-1.5 rounded-lg transition ${
                            staff.active
                              ? "text-rose-400 hover:bg-rose-950/40"
                              : "text-emerald-400 hover:bg-emerald-950/40"
                          }`}
                          title={staff.active ? "Deactivate Staff Account" : "Activate Staff Account"}
                        >
                          {staff.active ? <XCircle size={14} /> : <CheckCircle size={14} />}
                        </button>

                        {/* Delete Staff Member */}
                        <button
                          onClick={() => setDeletingStaff(staff)}
                          className="p-1.5 rounded-lg text-rose-400/80 hover:text-rose-300 hover:bg-rose-950/40 transition"
                          title="Delete staff member permanently"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ADD STAFF MODAL */}
      {createModalOpen && (
        <CreateStaffModal
          isOpen={createModalOpen}
          onClose={() => setCreateModalOpen(false)}
          onSuccess={() => {
            setCreateModalOpen(false);
            showNotification("Field staff member created successfully.");
            fetchStaff();
          }}
        />
      )}

      {/* EDIT STAFF MODAL */}
      {editingStaff && (
        <EditStaffModal
          staff={editingStaff}
          onClose={() => setEditingStaff(null)}
          onSuccess={() => {
            setEditingStaff(null);
            showNotification(`Updated staff member ${editingStaff.name} successfully.`);
            fetchStaff();
          }}
        />
      )}

      {/* RESET PASSWORD MODAL */}
      {resetPasswordStaff && (
        <ResetStaffPasswordModal
          staff={resetPasswordStaff}
          onClose={() => setResetPasswordStaff(null)}
          onSuccess={() => {
            setResetPasswordStaff(null);
            showNotification(`Password for ${resetPasswordStaff.name} reset successfully.`);
            fetchStaff();
          }}
        />
      )}

      {/* DELETE STAFF MODAL */}
      {deletingStaff && (
        <DeleteStaffModal
          staff={deletingStaff}
          onClose={() => setDeletingStaff(null)}
          onSuccess={() => {
            const deletedName = deletingStaff.name;
            setDeletingStaff(null);
            showNotification(`Staff member ${deletedName} deleted permanently.`);
            fetchStaff();
          }}
        />
      )}
    </div>
  );
}

// -------------------------------------------------------------
// SUB-MODALS: Create Staff Member
// -------------------------------------------------------------
function CreateStaffModal({
  isOpen,
  onClose,
  onSuccess,
}: {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [phone, setPhone] = useState("");
  const [status, setStatus] = useState<"ACTIVE" | "INACTIVE">("ACTIVE");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (password.length < 8) {
      setError("Password must be at least 8 characters long.");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/staff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          username: username.trim(),
          password,
          phone: phone.trim() || undefined,
          status,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Failed to create staff member");
        return;
      }

      onSuccess();
    } catch {
      setError("Network error while creating staff member.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-in fade-in duration-150">
      <div className="relative w-full max-w-lg bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-2xl max-h-[90vh] overflow-y-auto custom-scrollbar">
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-800 transition"
        >
          <X size={18} />
        </button>

        <div className="flex items-center gap-3 mb-5">
          <div className="w-10 h-10 rounded-xl bg-sky-500/10 border border-sky-500/20 text-sky-400 flex items-center justify-center flex-shrink-0">
            <UserPlus size={20} />
          </div>
          <div>
            <h3 className="text-base font-bold text-white">Add Field Personnel</h3>
            <p className="text-xs text-slate-400">
              Provision a new field staff account for Android tracker login and live duty tracking.
            </p>
          </div>
        </div>

        {error && (
          <div className="mb-4 p-3 rounded-xl bg-rose-500/10 border border-rose-500/20 flex items-center gap-2 text-xs text-rose-300">
            <AlertTriangle size={15} className="flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1">
                Full Name <span className="text-rose-400">*</span>
              </label>
              <input
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Vikram Rathore"
                className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3.5 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-sky-500"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1">
                Login ID (Username) <span className="text-rose-400">*</span>
              </label>
              <input
                type="text"
                required
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="e.g. vrathore01"
                className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3.5 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-sky-500 font-mono"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1">
                Phone Number
              </label>
              <input
                type="text"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="e.g. +91 9876543210"
                className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3.5 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-sky-500 font-mono"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1">
                Password (minimum 8 characters) <span className="text-rose-400">*</span>
              </label>
              <div className="relative">
                <input
                  type={showPassword ? "text" : "password"}
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Set password for tracker login"
                  className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3.5 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-sky-500 pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white"
                >
                  {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between pt-2">
            <label className="flex items-center gap-2 text-xs font-medium text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={status === "ACTIVE"}
                onChange={(e) => setStatus(e.target.checked ? "ACTIVE" : "INACTIVE")}
                className="rounded border-slate-700 bg-slate-900 text-emerald-500 focus:ring-emerald-500"
              />
              <span>Account Active immediately</span>
            </label>

            <div className="flex items-center gap-2.5">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-300 transition"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={loading}
                className="flex items-center gap-2 px-4 py-2 rounded-xl bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-xs font-semibold text-white transition shadow-lg shadow-sky-600/20"
              >
                {loading && <Loader2 size={13} className="animate-spin" />}
                Add Staff Member
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

// -------------------------------------------------------------
// SUB-MODALS: Edit Staff Member
// -------------------------------------------------------------
function EditStaffModal({
  staff,
  onClose,
  onSuccess,
}: {
  staff: StaffMember;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [name, setName] = useState(staff.name);
  const [phone, setPhone] = useState(staff.phone || "");
  const [active, setActive] = useState(staff.active);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    setLoading(true);
    try {
      const res = await fetch(`/api/staff/${staff.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          phone: phone.trim() || null,
          active,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Failed to update staff member");
        return;
      }

      onSuccess();
    } catch {
      setError("Network error while updating staff member.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-in fade-in duration-150">
      <div className="relative w-full max-w-lg bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-2xl">
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-800 transition"
        >
          <X size={18} />
        </button>

        <div className="flex items-center gap-3 mb-5">
          <div className="w-10 h-10 rounded-xl bg-sky-500/10 border border-sky-500/20 text-sky-400 flex items-center justify-center flex-shrink-0">
            <Edit2 size={20} />
          </div>
          <div>
            <h3 className="text-base font-bold text-white">Edit Staff Record</h3>
            <p className="text-xs text-slate-400">
              Modifying details for <span className="font-mono text-sky-300">@{staff.username}</span>
            </p>
          </div>
        </div>

        {error && (
          <div className="mb-4 p-3 rounded-xl bg-rose-500/10 border border-rose-500/20 flex items-center gap-2 text-xs text-rose-300">
            <AlertTriangle size={15} className="flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1">
                Full Name
              </label>
              <input
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3.5 py-2 text-xs text-white focus:outline-none focus:border-sky-500"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1">
                Phone Number
              </label>
              <input
                type="text"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="e.g. +91 9876543210"
                className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3.5 py-2 text-xs text-white focus:outline-none focus:border-sky-500 font-mono"
              />
            </div>
          </div>

          <div className="flex items-center justify-between pt-2">
            <label className="flex items-center gap-2 text-xs font-medium text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={active}
                onChange={(e) => setActive(e.target.checked)}
                className="rounded border-slate-700 bg-slate-900 text-emerald-500 focus:ring-emerald-500"
              />
              <span>Account is Active</span>
            </label>

            <div className="flex items-center gap-2.5">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-300 transition"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={loading}
                className="flex items-center gap-2 px-4 py-2 rounded-xl bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-xs font-semibold text-white transition shadow-lg shadow-sky-600/20"
              >
                {loading && <Loader2 size={13} className="animate-spin" />}
                Save Changes
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

// -------------------------------------------------------------
// SUB-MODALS: Reset Staff Password
// -------------------------------------------------------------
function ResetStaffPasswordModal({
  staff,
  onClose,
  onSuccess,
}: {
  staff: StaffMember;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [newPassword, setNewPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (newPassword.length < 8) {
      setError("Password must be at least 8 characters long.");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(`/api/staff/${staff.id}/reset-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newPassword }),
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Failed to reset staff password");
        return;
      }

      onSuccess();
    } catch {
      setError("Network error while resetting password.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-in fade-in duration-150">
      <div className="relative w-full max-w-md bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-2xl">
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-800 transition"
        >
          <X size={18} />
        </button>

        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-400 flex items-center justify-center flex-shrink-0">
            <KeyRound size={20} />
          </div>
          <div>
            <h3 className="text-base font-bold text-white">Reset Staff Password</h3>
            <p className="text-xs text-slate-400">
              Set new password for <span className="font-semibold text-white">{staff.name}</span> ({staff.username})
            </p>
          </div>
        </div>

        {error && (
          <div className="mb-4 p-3 rounded-xl bg-rose-500/10 border border-rose-500/20 flex items-center gap-2 text-xs text-rose-300">
            <AlertTriangle size={15} className="flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1">
              New Password (minimum 8 characters)
            </label>
            <div className="relative">
              <input
                type={showPassword ? "text" : "password"}
                required
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="Enter new password"
                className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3.5 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-amber-500 pr-10"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white"
              >
                {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
            <p className="text-[11px] text-slate-500 mt-1">
              Field officer will use this password to sign in to the Android tracker app.
            </p>
          </div>

          <div className="flex items-center justify-end gap-2.5 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-300 transition"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="flex items-center gap-2 px-4 py-2 rounded-xl bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-xs font-semibold text-slate-950 transition font-bold shadow-lg shadow-amber-600/20"
            >
              {loading && <Loader2 size={13} className="animate-spin" />}
              Reset Password
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function DeleteStaffModal({
  staff,
  onClose,
  onSuccess,
}: {
  staff: StaffMember;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDelete() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/staff/${staff.id}`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Failed to delete staff member");
        return;
      }
      onSuccess();
    } catch {
      setError("Network error while deleting staff member.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-in fade-in duration-150">
      <div className="relative w-full max-w-md bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-2xl">
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-800 transition"
        >
          <X size={18} />
        </button>

        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-400 flex items-center justify-center flex-shrink-0">
            <Trash2 size={20} />
          </div>
          <div>
            <h3 className="text-base font-bold text-white">Delete Staff Member</h3>
            <p className="text-xs text-slate-400">
              Permanent removal of personnel and account access.
            </p>
          </div>
        </div>

        {error && (
          <div className="mb-4 p-3 rounded-xl bg-rose-500/10 border border-rose-500/20 flex items-center gap-2 text-xs text-rose-300">
            <AlertTriangle size={15} className="flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div className="p-3.5 rounded-xl bg-slate-950 border border-slate-800 mb-5">
          <p className="text-xs text-slate-300">
            Are you sure you want to permanently delete{" "}
            <span className="font-bold text-white">{staff.name}</span> (
            <span className="font-mono text-sky-400">@{staff.username}</span>)?
          </p>
          <p className="text-[11px] text-rose-400/90 mt-2 font-medium">
            This will permanently remove their tracking sessions, devices, and credentials. This action cannot be undone.
          </p>
        </div>

        <div className="flex items-center justify-end gap-2.5">
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-300 transition"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleDelete}
            disabled={loading}
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-500 disabled:opacity-50 text-xs font-semibold text-white transition shadow-lg shadow-rose-600/20"
          >
            {loading && <Loader2 size={13} className="animate-spin" />}
            Delete Permanently
          </button>
        </div>
      </div>
    </div>
  );
}
