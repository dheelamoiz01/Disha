"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ShieldCheck,
  Shield,
  Users,
  MapPin,
  Route,
  Smartphone,
  LogOut,
  KeyRound,
  User,
  Menu,
  X,
} from "lucide-react";
import InstallPrompt from "@/components/pwa/InstallPrompt";
import ChangePasswordModal from "./ChangePasswordModal";

export type HeaderUser = {
  id: string;
  username: string;
  displayName: string;
  role: string;
  isSuperAdmin: boolean;
  permissions: string[];
  mustChangePassword: boolean;
};

export default function DashboardHeader({ initialUser }: { initialUser: HeaderUser }) {
  const pathname = usePathname();
  const [user, setUser] = useState<HeaderUser>(initialUser);
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const isSuper = user.isSuperAdmin || user.role?.toUpperCase() === "SP" || user.role?.toUpperCase() === "SUPER_ADMIN";
  const perms = Array.isArray(user.permissions) ? user.permissions : [];

  const canAccessAdmins = isSuper;
  const canAccessStaff = isSuper || perms.includes("STAFF_MANAGEMENT");
  const canAccessMap = isSuper || perms.includes("LIVE_MAP");

  const navItems = [
    {
      name: "Admin Management",
      shortName: "Admins",
      href: "/dashboard/admins",
      icon: Shield,
      visible: canAccessAdmins,
      badge: "Super Admin",
    },
    {
      name: "Staff Management",
      shortName: "Staff",
      href: "/dashboard/staff",
      icon: Users,
      visible: canAccessStaff,
      badge: null,
    },
    {
      name: "Live Map",
      shortName: "Live Map",
      href: "/dashboard/map",
      icon: MapPin,
      visible: canAccessMap,
      badge: "Tracking",
    },
    {
      name: "Location Trail",
      shortName: "Trail",
      href: "/dashboard/trail",
      icon: Route,
      visible: canAccessMap,
      badge: "History",
    },
    {
      name: "Releases (OTA)",
      shortName: "Releases",
      href: "/dashboard/releases",
      icon: Smartphone,
      visible: canAccessAdmins,
      badge: "OTA",
    },
  ].filter((item) => item.visible);

  return (
    <>
      <header className="h-16 flex items-center justify-between px-2 sm:px-6 bg-slate-950 border-b border-slate-800 flex-shrink-0 z-30 select-none">
        {/* Brand & Nav Switcher */}
        <div className="flex items-center gap-2 sm:gap-4 lg:gap-8 min-w-0">
          <Link href="/dashboard" prefetch={true} className="flex items-center gap-2 sm:gap-2.5 flex-shrink-0">
            <div className="w-8 h-8 sm:w-9 sm:h-9 rounded-xl bg-gradient-to-tr from-sky-600 to-cyan-400 flex items-center justify-center shadow-lg shadow-sky-500/20 flex-shrink-0">
              <ShieldCheck size={20} className="text-white sm:hidden" />
              <ShieldCheck size={22} className="text-white hidden sm:block" />
            </div>
            <div className="flex flex-col">
              <div className="flex items-center gap-1.5 sm:gap-2">
                <span className="text-sm sm:text-base font-black tracking-widest text-white">DISHA</span>
                <span className="hidden md:inline-block text-[10px] font-semibold tracking-wide uppercase px-1.5 py-0.5 rounded bg-sky-950 text-sky-400 border border-sky-800/60">
                  {isSuper ? "SUPER ADMIN" : user.role.replace(/_/g, " ")}
                </span>
              </div>
              <span className="hidden xl:inline-block text-[11px] font-medium text-slate-400 -mt-0.5">
                Command Center
              </span>
            </div>
          </Link>

          {/* Always-Visible 3-Section Nav Switcher */}
          <nav className="flex items-center gap-1 sm:gap-1.5 bg-slate-900/90 border border-slate-800/80 p-0.5 sm:p-1 rounded-xl overflow-x-auto">
            {navItems.map((item) => {
              const Icon = item.icon;
              const isActive = pathname.startsWith(item.href);

              return (
                <Link
                  key={item.href}
                  href={item.href}
                  prefetch={true}
                  className={`flex items-center gap-1.5 sm:gap-2 px-2 sm:px-3.5 py-1 sm:py-1.5 rounded-lg text-xs font-semibold transition-all whitespace-nowrap ${
                    isActive
                      ? "bg-sky-600 text-white shadow-sm shadow-sky-600/30"
                      : "text-slate-400 hover:text-slate-200 hover:bg-slate-800/60"
                  }`}
                  title={item.name}
                >
                  <Icon size={14} className="flex-shrink-0" />
                  <span className="hidden sm:inline">{item.name}</span>
                  <span className="sm:hidden">{item.shortName}</span>
                </Link>
              );
            })}
          </nav>
        </div>

        {/* Right Section: Actions & Profile */}
        <div className="flex items-center gap-1.5 sm:gap-3 flex-shrink-0">
          <InstallPrompt variant="header-button" />

          {/* User Profile Capsule */}
          <div className="hidden lg:flex items-center gap-2 text-xs text-slate-300 bg-slate-900 border border-slate-800 px-3 py-1.5 rounded-xl">
            <User size={13} className="text-sky-400" />
            <span className="font-semibold text-slate-200 max-w-[130px] truncate" title={user.displayName}>
              {user.displayName}
            </span>
          </div>

          {/* Change Password Button */}
          <button
            onClick={() => setShowPasswordModal(true)}
            className="flex items-center gap-1.5 px-2 py-1.5 sm:px-2.5 sm:py-1.5 rounded-xl text-xs font-medium text-slate-400 hover:text-slate-200 hover:bg-slate-900 border border-transparent hover:border-slate-800 transition"
            title="Change your account password"
          >
            <KeyRound size={14} className="text-amber-400" />
            <span className="hidden xl:inline">Password</span>
          </button>

          {/* Logout Button */}
          <form action="/api/auth/logout" method="POST" suppressHydrationWarning>
            <button
              type="submit"
              className="flex items-center gap-1.5 px-2 py-1.5 sm:px-2.5 sm:py-1.5 rounded-xl text-xs font-semibold text-rose-400 hover:text-rose-300 hover:bg-rose-950/30 border border-transparent hover:border-rose-900/50 transition cursor-pointer"
              title="Sign out of DISHA"
            >
              <LogOut size={14} />
              <span className="hidden sm:inline">Logout</span>
            </button>
          </form>

          {/* Mobile Menu Button for additional actions */}
          <button
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            className="md:hidden p-1.5 text-slate-400 hover:text-white rounded-lg hover:bg-slate-900"
            aria-label="Toggle navigation menu"
          >
            {mobileMenuOpen ? <X size={18} /> : <Menu size={18} />}
          </button>
        </div>
      </header>

      {/* Mobile Dropdown Nav Menu */}
      {mobileMenuOpen && (
        <div className="md:hidden bg-slate-950/95 border-b border-slate-800 px-4 py-3 space-y-2 z-20">
          <div className="flex items-center justify-between text-[11px] font-bold uppercase tracking-wider text-slate-500 px-2 pb-1">
            <span>Signed in as: {user.displayName}</span>
            <span className="text-[10px] text-sky-400">{isSuper ? "Super Admin" : user.role}</span>
          </div>
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = pathname.startsWith(item.href);

            return (
              <Link
                key={item.href}
                href={item.href}
                prefetch={true}
                onClick={() => setMobileMenuOpen(false)}
                className={`flex items-center justify-between px-3 py-2 rounded-xl text-xs font-medium transition ${
                  isActive
                    ? "bg-sky-600 text-white font-semibold"
                    : "text-slate-300 hover:bg-slate-900"
                }`}
              >
                <div className="flex items-center gap-2.5">
                  <Icon size={16} />
                  <span>{item.name}</span>
                </div>
                {item.badge && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-300">
                    {item.badge}
                  </span>
                )}
              </Link>
            );
          })}
        </div>
      )}

      {/* Password Change Modal (Manual trigger only) */}
      <ChangePasswordModal
        isOpen={showPasswordModal}
        isForced={false}
        onClose={() => setShowPasswordModal(false)}
        onSuccess={() => {
          setShowPasswordModal(false);
        }}
      />
    </>
  );
}
