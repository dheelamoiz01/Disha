import { NextResponse } from "next/server";
import { requirePermission, isSuperAdmin } from "@/lib/auth/permissions";
import { prisma } from "@/lib/prisma";

export async function GET(req: Request) {
  try {
    const { user } = await requirePermission("LIVE_MAP", req);

    const personnelList = await prisma.personnel.findMany({
      where: isSuperAdmin(user) ? undefined : { adminId: user.id },
      orderBy: [
        { active: "desc" },
        { name: "asc" },
      ],
      select: {
        id: true,
        name: true,
        personnelCode: true,
        designation: true,
        unit: true,
        active: true,
        dutySessions: {
          where: { status: "DUTY_STARTED" },
          take: 1,
          select: { id: true },
        },
      },
    });

    const formatted = personnelList.map((p) => ({
      id: p.id,
      name: p.name,
      personnelCode: p.personnelCode,
      designation: p.designation,
      unit: p.unit,
      active: p.active,
      isOnDuty: p.dutySessions.length > 0,
    }));

    return NextResponse.json({ personnel: formatted });
  } catch (error: any) {
    if (error.message === "UNAUTHORIZED") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error.message === "FORBIDDEN") {
      return NextResponse.json({ error: "Forbidden: Live Map permission required" }, { status: 403 });
    }
    console.error("Trail personnel list error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
