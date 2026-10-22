import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { isSuperAdmin } from "@/lib/auth/permissions";
import ReleasesClient from "./ReleasesClient";
import { getAllReleases } from "@/services/release/release_service";

export default async function ReleasesPage() {
  const { session, user } = await getSession();

  if (!session || !user) {
    redirect("/login");
  }

  if (!isSuperAdmin(user)) {
    redirect("/dashboard");
  }

  const rawReleases = await getAllReleases();
  const initialReleases = rawReleases.map((r) => ({
    ...r,
    publishedAt: r.publishedAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }));

  return <ReleasesClient initialReleases={initialReleases} />;
}
