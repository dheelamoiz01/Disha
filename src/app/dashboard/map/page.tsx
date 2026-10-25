import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { hasPermission, isSuperAdmin } from "@/lib/auth/permissions";
import LiveMapClient from "@/components/dashboard/LiveMapClient";
import { getDashboardOverview } from "@/services/control-room/dashboard_service";

export default async function LiveMapPage() {
  const { session, user } = await getSession();

  if (!session || !user) {
    redirect("/login");
  }

  if (!hasPermission(user, "LIVE_MAP")) {
    redirect("/dashboard");
  }

  const scopedAdminId = isSuperAdmin(user) ? null : user.id;
  const initialData = await getDashboardOverview(false, scopedAdminId);

  return <LiveMapClient initialData={initialData} />;
}
