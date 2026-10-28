import crypto from "crypto";
import type { Request, Response } from "express";
import { prisma } from "../../lib/prisma.js";
import { env } from "../../config/env.js";
import { sendEmail } from "../../lib/mailer.js";
import bcrypt from "bcrypt";
import type { Prisma, Role } from "../../generated/prisma/client.js";


const escapeHtml = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");


const hashToken = (token: string) =>
  crypto.createHash("sha256").update(token).digest("hex");

const findValidInvitation = async (token: unknown) => {
  if (typeof token !== "string" || !token) return null;

  const invitation = await prisma.invitation.findUnique({
    where: { tokenHash: hashToken(token) },
    include: {
      team: { select: { id: true, name: true } },
      organization: { select: { name: true } },
    },
  });

  if (!invitation) return null;

  if (invitation.status === "PENDING" && invitation.expiresAt < new Date()) {
    await prisma.invitation.update({
      where: { id: invitation.id },
      data: { status: "EXPIRED" },
    });
    return null;
  }

  if (invitation.status !== "PENDING") return null;

  return invitation;
};

const attachToTeam = async (
  tx: Prisma.TransactionClient,
  teamId: string,
  organizationId: string,
  role: Role,
  userId: string,
) => {
  if (role === "TEAM_LEADER") {
    const updated = await tx.team.updateMany({
      where: { id: teamId, organizationId, teamLeaderId: null },
      data: { teamLeaderId: userId },
    });
    if (updated.count !== 1) throw new Error("TEAM_HAS_LEADER");
  } else {
    await tx.teamMember.upsert({
      where: { teamId_userId: { teamId, userId } },
      update: { status: "ACTIVE" },
      create: { teamId, userId },
    });
  }
};

const claimInvitation = async (tx: Prisma.TransactionClient, id: string) => {
  const claimed = await tx.invitation.updateMany({
    where: { id, status: "PENDING", expiresAt: { gt: new Date() } },
    data: { status: "ACCEPTED", acceptedAt: new Date() },
  });
  if (claimed.count !== 1) throw new Error("INVITATION_INVALID");
};

const handleAcceptError = (err: unknown, res: Response) => {
  if (err instanceof Error && err.message === "INVITATION_INVALID") {
    res.status(400).json({ success: false, message: "Invalid or expired invitation" });
    return;
  }
  if (err instanceof Error && err.message === "TEAM_HAS_LEADER") {
    res.status(409).json({ success: false, message: "This team already has a Team Leader" });
    return;
  }
  console.error(err);
  res.status(500).json({ success: false, message: "Something went wrong" });
};


/**
 * POST /api/invitations
 * Admin invites a Team Leader to a team without a leader;
 * a Team Leader invites a Developer to their own team.
 * The email contains a single-use link that expires in 24 hours.
 */
export const createInvitation = async (req: Request, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, message: "Not authenticated" });
    return;
  }

  const { userId, role, organizationId } = req.user;
  const { email, teamId } = req.body;

  if (
    typeof email !== "string" ||
    typeof teamId !== "string" ||
    !email.trim() ||
    !teamId.trim()
  ) {
    res.status(400).json({ success: false, message: "Email and teamId are required" });
    return;
  }

  const cleanEmail = email.toLowerCase().trim();
  const intendedRole = role === "ADMIN" ? "TEAM_LEADER" : "DEVELOPER";

  try {
    const team = await prisma.team.findFirst({
      where: { id: teamId, organizationId, status: "ACTIVE" },
      include: { organization: { select: { name: true } } },
    });

    if (!team) {
      res.status(404).json({ success: false, message: "Team not found" });
      return;
    }

    if (role === "TEAM_LEADER" && team.teamLeaderId !== userId) {
      res.status(403).json({ success: false, message: "You can invite only to your own teams" });
      return;
    }

    if (role === "ADMIN" && team.teamLeaderId) {
      res.status(400).json({ success: false, message: "This team already has a Team Leader" });
      return;
    }

    const existingUser = await prisma.user.findUnique({
      where: { email: cleanEmail },
    });

    if (
      existingUser &&
      (existingUser.organizationId !== organizationId || existingUser.role !== intendedRole)
    ) {
      res.status(409).json({ success: false, message: "This email cannot be invited" });
      return;
    }

    if (existingUser) {
      const alreadyMember = await prisma.teamMember.findUnique({
        where: { teamId_userId: { teamId, userId: existingUser.id } },
      });

      if (alreadyMember) {
        res.status(409).json({ success: false, message: "User is already a member of this team" });
        return;
      }
    }

    const recentInvite = await prisma.invitation.findFirst({
      where: {
        email: cleanEmail,
        teamId,
        status: "PENDING",
        createdAt: { gt: new Date(Date.now() - 60 * 1000) },
      },
    });

    if (recentInvite) {
      res.status(429).json({
        success: false,
        message: "An invitation was sent recently. Please wait a minute before resending.",
      });
      return;
    }

    await prisma.invitation.updateMany({
      where: { email: cleanEmail, teamId, status: "PENDING" },
      data: { status: "REVOKED" },
    });

    const token = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    const invitation = await prisma.invitation.create({
      data: {
        organizationId,
        teamId,
        email: cleanEmail,
        invitedById: userId,
        intendedRole,
        tokenHash,
        expiresAt,
      },
      select: {
        id: true,
        email: true,
        intendedRole: true,
        status: true,
        expiresAt: true,
      },
    });

    const link = `${env.CLIENT_URL}/accept-invitation?token=${token}`;

    try {
      await sendEmail(
        cleanEmail,
        `You are invited to join ${team.organization.name} on DevCollab`,
        `<p>You have been invited to join <b>${escapeHtml(team.name)}</b> at <b>${escapeHtml(team.organization.name)}</b> as a ${intendedRole.replace("_", " ").toLowerCase()}.</p>
         <p><a href="${link}">Accept invitation</a></p>
         <p>This link expires in 24 hours and can be used once.</p>`,
      );
    } catch (mailErr) {
      console.error("Invitation email failed:", mailErr);
      await prisma.invitation.update({
        where: { id: invitation.id },
        data: { status: "REVOKED" },
      });
      res.status(502).json({ success: false, message: "Could not send the invitation email" });
      return;
    }

    res.status(201).json({ success: true, invitation });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Something went wrong" });
  }
};

/**
 * GET /api/invitations/:token
 * Validates the invitation token and returns the invitation details if valid.
 * The response includes the email, intended role, team name, organization name, and whether the user already exists in the system.
 * If the token is invalid or expired, an error message is returned.
 * @access Public
 */
export const getInvitation = async (req: Request, res: Response) => {
  try {
    const invitation = await findValidInvitation(req.params.token);

    if (!invitation) {
      res.status(400).json({ success: false, message: "Invalid or expired invitation" });
      return;
    }

    const existingUser = await prisma.user.findUnique({
      where: { email: invitation.email },
      select: { id: true },
    });

    res.status(200).json({
      success: true,
      invitation: {
        email: invitation.email,
        intendedRole: invitation.intendedRole,
        teamName: invitation.team?.name ?? null,
        organizationName: invitation.organization.name,
        userExists: !!existingUser,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Something went wrong" });
  }
};

/**
 * POST /api/invitations/accept-new
 * Accepts an invitation for a new user. The user provides their name and password to create an account and join the team.
 * The endpoint validates the invitation token, checks if the email is already registered, and creates a new user with the provided details.
 * If successful, the response includes the newly created user's details.
 * @access Public
 */
export const acceptInvitationNew = async (req: Request, res: Response) => {
  const { token, name, password } = req.body;

  if (typeof name !== "string" || !name.trim() || typeof password !== "string") {
    res.status(400).json({ success: false, message: "Name and password are required" });
    return;
  }
  if (password.length < 8) {
    res.status(400).json({ success: false, message: "Password must be at least 8 characters" });
    return;
  }

  try {
    const invitation = await findValidInvitation(token);

    if (!invitation || !invitation.teamId) {
      res.status(400).json({ success: false, message: "Invalid or expired invitation" });
      return;
    }

    const existingUser = await prisma.user.findUnique({
      where: { email: invitation.email },
    });

    if (existingUser) {
      res.status(409).json({
        success: false,
        message: "An account with this email already exists. Please log in to accept.",
      });
      return;
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const teamId = invitation.teamId;

    const user = await prisma.$transaction(async (tx) => {
      await claimInvitation(tx, invitation.id);

      const newUser = await tx.user.create({
        data: {
          organizationId: invitation.organizationId,
          name: name.trim(),
          email: invitation.email,
          passwordHash,
          role: invitation.intendedRole,
        },
        omit: { passwordHash: true },
      });

      await attachToTeam(tx, teamId, invitation.organizationId, invitation.intendedRole, newUser.id);

      return newUser;
    });

    res.status(201).json({ success: true, user });
  } catch (err) {
    handleAcceptError(err, res);
  }
};

/**
 * POST /api/invitations/accept
 * Accepts an invitation for an existing user. The user must be authenticated and their account must match the invitation details.
 * The endpoint validates the invitation token, checks if the authenticated user matches the invitation, and attaches the user to the team.
 * @access Private (Authenticated users)
 */
export const acceptInvitation = async (req: Request, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, message: "Not authenticated" });
    return;
  }

  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.userId } });

    if (!user || user.status !== "ACTIVE") {
      res.status(401).json({ success: false, message: "Not authenticated" });
      return;
    }

    const invitation = await findValidInvitation(req.body.token);

    if (!invitation || !invitation.teamId) {
      res.status(400).json({ success: false, message: "Invalid or expired invitation" });
      return;
    }

    if (
      user.email !== invitation.email ||
      user.organizationId !== invitation.organizationId ||
      user.role !== invitation.intendedRole
    ) {
      res.status(403).json({ success: false, message: "This invitation is not for your account" });
      return;
    }

    const teamId = invitation.teamId;

    await prisma.$transaction(async (tx) => {
      await claimInvitation(tx, invitation.id);
      await attachToTeam(tx, teamId, invitation.organizationId, invitation.intendedRole, user.id);
    });

    res.status(200).json({ success: true, message: "Invitation accepted" });
  } catch (err) {
    handleAcceptError(err, res);
  }
};

export const listInvitations = async (req: Request, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, message: "Not authenticated" });
    return;
  }

  const { userId, role, organizationId } = req.user;

  try {
    const invitations = await prisma.invitation.findMany({
      where: {
        organizationId,
        status: "PENDING",
        expiresAt: { gt: new Date() },
        ...(role === "TEAM_LEADER" ? { team: { teamLeaderId: userId } } : {}),
      },
      select: {
        id: true,
        email: true,
        intendedRole: true,
        status: true,
        expiresAt: true,
        createdAt: true,
        team: { select: { id: true, name: true } },
        invitedBy: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    res.status(200).json({ success: true, invitations });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Something went wrong" });
  }
};

export const revokeInvitation = async (req: Request, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, message: "Not authenticated" });
    return;
  }

  const { userId, role, organizationId } = req.user;
  const id = req.params.id as string;

  try {
    const result = await prisma.invitation.updateMany({
      where: {
        id,
        organizationId,
        status: "PENDING",
        ...(role === "TEAM_LEADER" ? { team: { teamLeaderId: userId } } : {}),
      },
      data: { status: "REVOKED" },
    });

    if (result.count === 0) {
      res.status(404).json({ success: false, message: "Pending invitation not found" });
      return;
    }

    res.status(200).json({ success: true, message: "Invitation revoked" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Something went wrong" });
  }
};