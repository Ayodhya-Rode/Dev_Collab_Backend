import type { Request, Response } from "express";
import { prisma } from "../../lib/prisma.js";
import type { Priority } from "../../generated/prisma/client.js";

const PRIORITIES: Priority[] = ["LOW", "MEDIUM", "HIGH"];

const hasValue = (v: unknown) => v !== undefined && v !== null && v !== "";

const isDateString = (v: unknown): v is string =>
  typeof v === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(v) &&
  !Number.isNaN(new Date(v).getTime());

const projectInclude = {
  teamLeader: { select: { id: true, name: true, email: true } },
  teams: { select: { team: { select: { id: true, name: true } } } },
} as const;

export const createProject = async (req: Request, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, message: "Not authenticated" });
    return;
  }

  const { userId, role, organizationId } = req.user;
  const { name, description, priority, startDate, dueDate, teamIds, teamLeaderId } =
    req.body;

  if (typeof name !== "string" || !name.trim()) {
    res.status(400).json({ success: false, message: "Project name is required" });
    return;
  }

  if (
    !Array.isArray(teamIds) ||
    teamIds.length === 0 ||
    !teamIds.every((id) => typeof id === "string")
  ) {
    res.status(400).json({ success: false, message: "Select at least one team" });
    return;
  }

  if (description !== undefined && description !== null && typeof description !== "string") {
    res.status(400).json({ success: false, message: "Invalid description" });
    return;
  }

  if (priority !== undefined && !PRIORITIES.includes(priority)) {
    res.status(400).json({ success: false, message: "Priority must be LOW, MEDIUM or HIGH" });
    return;
  }

  if (hasValue(startDate) && !isDateString(startDate)) {
    res.status(400).json({ success: false, message: "Start date must be YYYY-MM-DD" });
    return;
  }

  if (hasValue(dueDate) && !isDateString(dueDate)) {
    res.status(400).json({ success: false, message: "Due date must be YYYY-MM-DD" });
    return;
  }

  if (hasValue(startDate) && hasValue(dueDate) && new Date(dueDate) < new Date(startDate)) {
    res.status(400).json({ success: false, message: "Due date cannot be before the start date" });
    return;
  }

  const leaderId = role === "ADMIN" ? teamLeaderId : userId;

  if (typeof leaderId !== "string") {
    res.status(400).json({ success: false, message: "Project lead is required" });
    return;
  }

  const uniqueTeamIds = [...new Set(teamIds as string[])];

  try {
    const teams = await prisma.team.findMany({
      where: { id: { in: uniqueTeamIds }, organizationId, status: "ACTIVE" },
      select: { id: true, teamLeaderId: true },
    });

    if (teams.length !== uniqueTeamIds.length) {
      res.status(400).json({ success: false, message: "One or more teams were not found" });
      return;
    }

    const leader = await prisma.user.findFirst({
      where: { id: leaderId, organizationId, role: "TEAM_LEADER", status: "ACTIVE" },
    });

    if (!leader) {
      res.status(400).json({
        success: false,
        message: "Project lead must be an active Team Leader of your organization",
      });
      return;
    }

    if (!teams.some((t) => t.teamLeaderId === leader.id)) {
      res.status(400).json({
        success: false,
        message: "The project lead must be the Team Leader of one of the linked teams",
      });
      return;
    }

    const project = await prisma.project.create({
      data: {
        organizationId,
        name: name.trim(),
        description: description?.trim() || null,
        priority: priority ?? "MEDIUM",
        startDate: hasValue(startDate) ? new Date(startDate) : null,
        dueDate: hasValue(dueDate) ? new Date(dueDate) : null,
        teamLeaderId: leader.id,
        createdById: userId,
        teams: { create: uniqueTeamIds.map((teamId) => ({ teamId })) },
      },
      include: projectInclude,
    });

    res.status(201).json({ success: true, project });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Something went wrong" });
  }
};

export const listProjects = async (req: Request, res: Response) => {
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
          ? {
              organizationId,
              OR: [
                { teamLeaderId: userId },
                { teams: { some: { team: { teamLeaderId: userId } } } },
              ],
            }
          : {
              organizationId,
              teams: {
                some: {
                  team: {
                    members: { some: { userId, status: "ACTIVE" as const } },
                  },
                },
              },
            };

    const projects = await prisma.project.findMany({
      where,
      include: projectInclude,
      orderBy: { createdAt: "desc" },
    });

    res.status(200).json({ success: true, projects });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Something went wrong" });
  }
};