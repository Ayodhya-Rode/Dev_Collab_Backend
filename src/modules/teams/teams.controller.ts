import type { Request, Response } from "express";
import { prisma } from "../../lib/prisma.js";

/**
 * TO Creste new team
 * only ADMIN can create new team
 * @route POST /api/teams
 * @description Create a new team within the organization. Only users with the "ADMIN" role can create teams. The request body should include the team name, an optional description, and an optional team leader ID. If a team leader ID is provided, it must correspond to an active user with the "TEAM_LEADER" role within the same organization.
 * @access Private (ADMIN only)
 * @param {string} name - The name of the team (required). 
 */
export const createTeam = async (req: Request, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, message: "Not authenticated" });
    return;
  }

  const { name, description, teamLeaderId } = req.body;

  if (!name || typeof name !== "string" || !name.trim()) {
    res.status(400).json({ success: false, message: "Team name is required" });
    return;
  }

  try {
    if (teamLeaderId) {
      const leader = await prisma.user.findFirst({
        where: {
          id: teamLeaderId,
          organizationId: req.user.organizationId,
          role: "TEAM_LEADER",
          status: "ACTIVE",
        },
      });

      if (!leader) {
        res.status(400).json({
          success: false,
          message: "Team leader must be an active Team Leader of your organization",
        });
        return;
      }
    }

    const team = await prisma.team.create({
      data: {
        organizationId: req.user.organizationId,
        name: name.trim(),
        description: description?.trim() || null,
        teamLeaderId: teamLeaderId ?? null,
      },
    });

    res.status(201).json({ success: true, team });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Something went wrong" });
  }
};


/**
 * TO List all teams
 * @route GET /api/teams
 * @description List all teams within the organization. The response includes team details, the team leader's information, and the count of active members in each team. The visibility of teams is based on the user's role: "ADMIN" users can see all teams, "TEAM_LEADER" users can see only their own teams, and "MEMBER" users can see only the teams they belong to.
 * @access Private (Authenticated users)
 */
export const listTeams = async (req: Request, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, message: "Not authenticated" });
    return;
  }

  const { userId, role, organizationId } = req.user;

  try {
    const where =
      role === "ADMIN"
        ? { organizationId }
        : role === "TEAM_LEADER"
          ? { organizationId, teamLeaderId: userId }
          : {
              organizationId,
              members: { some: { userId, status: "ACTIVE" as const } },
            };

    const teams = await prisma.team.findMany({
      where,
      include: {
        teamLeader: { select: { id: true, name: true, email: true } },
        _count: { select: { members: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    res.status(200).json({ success: true, teams });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Something went wrong" });
  }
};


export const getTeam = async (req: Request, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, message: "Not authenticated" });
    return;
  }

  const { userId, role, organizationId } = req.user;
  const id = req.params.id as string;

  try {
    const team = await prisma.team.findFirst({
      where: { id, organizationId },
      include: {
        teamLeader: { select: { id: true, name: true, email: true } },
        members: {
          where: { status: "ACTIVE" },
          select: {
            joinedAt: true,
            user: { select: { id: true, name: true, email: true } },
          },
        },
      },
    });

    const canView =
      team &&
      (role === "ADMIN" ||
        (role === "TEAM_LEADER" && team.teamLeaderId === userId) ||
        (role === "DEVELOPER" && team.members.some((m) => m.user.id === userId)));

    if (!team || !canView) {
      res.status(404).json({ success: false, message: "Team not found" });
      return;
    }

    res.status(200).json({ success: true, team });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Something went wrong" });
  }
};


export const updateTeam = async (req: Request, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, message: "Not authenticated" });
    return;
  }

  const { organizationId } = req.user;
  const id = req.params.id as string;
  const { name, description, status } = req.body;

  const data: {
    name?: string;
    description?: string | null;
    status?: "ACTIVE" | "INACTIVE";
  } = {};

  if (name !== undefined) {
    if (typeof name !== "string" || !name.trim()) {
      res.status(400).json({ success: false, message: "Team name cannot be empty" });
      return;
    }
    data.name = name.trim();
  }

  if (description !== undefined) {
    if (description !== null && typeof description !== "string") {
      res.status(400).json({ success: false, message: "Invalid description" });
      return;
    }
    data.description = description?.trim() || null;
  }

  if (status !== undefined) {
    if (status !== "ACTIVE" && status !== "INACTIVE") {
      res.status(400).json({ success: false, message: "Status must be ACTIVE or INACTIVE" });
      return;
    }
    data.status = status;
  }

  if (Object.keys(data).length === 0) {
    res.status(400).json({ success: false, message: "Nothing to update" });
    return;
  }

  try {
    const result = await prisma.team.updateMany({
      where: { id, organizationId },
      data,
    });

    if (result.count === 0) {
      res.status(404).json({ success: false, message: "Team not found" });
      return;
    }

    const team = await prisma.team.findUnique({ where: { id } });
    res.status(200).json({ success: true, team });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Something went wrong" });
  }
};


export const setTeamLeader = async (req: Request, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, message: "Not authenticated" });
    return;
  }

  const { organizationId } = req.user;
  const id = req.params.id as string;
  const { teamLeaderId } = req.body;

  if (teamLeaderId !== null && typeof teamLeaderId !== "string") {
    res.status(400).json({
      success: false,
      message: "teamLeaderId must be a user id, or null to remove the leader",
    });
    return;
  }

  try {
    if (typeof teamLeaderId === "string") {
      const leader = await prisma.user.findFirst({
        where: {
          id: teamLeaderId,
          organizationId,
          role: "TEAM_LEADER",
          status: "ACTIVE",
        },
      });

      if (!leader) {
        res.status(400).json({
          success: false,
          message: "Team leader must be an active Team Leader of your organization",
        });
        return;
      }
    }

    const result = await prisma.team.updateMany({
      where: { id, organizationId },
      data: { teamLeaderId },
    });

    if (result.count === 0) {
      res.status(404).json({ success: false, message: "Team not found" });
      return;
    }

    const team = await prisma.team.findUnique({
      where: { id },
      include: { teamLeader: { select: { id: true, name: true, email: true } } },
    });

    res.status(200).json({ success: true, team });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Something went wrong" });
  }
};