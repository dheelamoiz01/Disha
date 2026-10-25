import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission, isSuperAdmin } from "@/lib/auth/permissions";
import { prisma } from "@/lib/prisma";
import { hashPassword } from "@/lib/auth/password";
import { logAudit } from "@/lib/auth/audit";

const resetPasswordSchema = z.object({
  newPassword: z.string().min(8, "Password must be at least 8 characters long"),
});

export async function POST(req: Request, props: { params: Promise<{ id: string }> }) {
  try {
    const { user: currentAdmin } = await requirePermission("STAFF_MANAGEMENT", req);
    const params = await props.params;
    const staffId = params.id;

    const body = await req.json();
    const { newPassword } = resetPasswordSchema.parse(body);

    const personnel = await prisma.personnel.findUnique({
      where: { id: staffId },
      include: { user: true },
    });

    if (!personnel) {
      return NextResponse.json({ error: "Staff record not found" }, { status: 404 });
    }

    // Ownership check: regular admin can only reset password for their own staff
    if (!isSuperAdmin(currentAdmin) && personnel.adminId !== currentAdmin.id) {
      return NextResponse.json({ error: "Staff record not found or access denied" }, { status: 404 });
    }

    const passwordHash = await hashPassword(newPassword);

    await prisma.user.update({
      where: { id: personnel.userId },
      data: {
        passwordHash,
        mustChangePassword: false,
      },
    });

    await logAudit({
      actorId: currentAdmin.id,
      action: "RESET_STAFF_PASSWORD",
      targetType: "Personnel",
      targetId: staffId,
      metadata: { username: personnel.user.username },
    });

    return NextResponse.json({
      success: true,
      message: `Password for ${personnel.name} (${personnel.user.username}) has been reset successfully.`,
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.issues[0]?.message || "Invalid input" }, { status: 400 });
    }
    if (error.message === "UNAUTHORIZED") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (error.message === "FORBIDDEN") return NextResponse.json({ error: "Forbidden: Staff Management permission required" }, { status: 403 });
    console.error("POST /api/staff/[id]/reset-password error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
