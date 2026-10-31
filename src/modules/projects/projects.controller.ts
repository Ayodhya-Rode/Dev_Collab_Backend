import type { Request, Response } from "express";
import { prisma } from "../../lib/prisma.js";
import type { Priority,Prisma, ProjectStatus } from "../../generated/prisma/client.js";
import { visibleWhere } from "./project.access.js";


const PRIORITIES: Priority[] = ["LOW", "MEDIUM", "HIGH"];

const hasValue = (v: unknown) => v !== undefined && v !== null && v !== "";

const isDateString = (v: unknown): v is string =>
  typeof v === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(v) &&
  !Number.isNaN(new Date(v).getTime());

const projectInclude = {
  teamLeader: { select: { id: true, name: true, email: true } },
  createdBy: { select: { id: true, name: true } },
  teams: { select: { team: { select: { id: true, name: true } } } },
} as const;


const STATUSES: ProjectStatus[] = [
  "PLANNING",
  "ACTIVE",
  "ON_HOLD",
  "COMPLETED",
  "ARCHIVED",
];


const checkLeadAndTeams = async (
  organizationId: string,
  leaderId: string,
  teamIds: string[],
): Promise<string | null> => {
  const teams = await prisma.team.findMany({
    where: { id: { in: teamIds }, organizationId, status: "ACTIVE" },
    select: { id: true, teamLeaderId: true },
  });

  if (teams.length !== teamIds.length) return "One or more teams were not found";

  const leader = await prisma.user.findFirst({
    where: { id: leaderId, organizationId, role: "TEAM_LEADER", status: "ACTIVE" },
  });

  if (!leader) return "Project lead must be an active Team Leader of your organization";

  if (!teams.some((t) => t.teamLeaderId === leader.id)) {
    return "The project lead must be the Team Leader of one of the linked teams";
  }

  return null;
};8




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

  try {
    const projects = await prisma.project.findMany({
      where: visibleWhere(req.user),
      include: projectInclude,
      orderBy: { createdAt: "desc" },
    });

    res.status(200).json({ success: true, projects });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Something went wrong" });
  }
};


export const getProject = async (req: Request, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, message: "Not authenticated" });
    return;
  }

  const id = req.params.id as string;

  try {
    const project = await prisma.project.findFirst({
      where: { id, ...visibleWhere(req.user) },
      include: {
        teamLeader: { select: { id: true, name: true, email: true } },
        createdBy: { select: { id: true, name: true } },
        teams: {
          select: {
            team: {
              select: {
                id: true,
                name: true,
                teamLeader: { select: { id: true, name: true } },
                _count: { select: { members: true } },
              },
            },
          },
        },
      },
    });

    if (!project) {
      res.status(404).json({ success: false, message: "Project not found" });
      return;
    }

    const canManage =
      req.user.role === "ADMIN" || project.teamLeaderId === req.user.userId;

    res.status(200).json({ success: true, project, canManage });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Something went wrong" });
  }
};


export const updateProject = async (req: Request, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, message: "Not authenticated" });
    return;
  }

  const { userId, role, organizationId } = req.user;
  const id = req.params.id as string;
  const { name, description, status, priority, startDate, dueDate } = req.body;

  const data: Prisma.ProjectUpdateInput = {};

  if (name !== undefined) {
    if (typeof name !== "string" || !name.trim()) {
      res.status(400).json({ success: false, message: "Project name cannot be empty" });
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
    if (!STATUSES.includes(status)) {
      res.status(400).json({
        success: false,
        message: "Status must be PLANNING, ACTIVE, ON_HOLD, COMPLETED or ARCHIVED",
      });
      return;
    }
    if (status === "ARCHIVED" && role !== "ADMIN") {
      res.status(403).json({ success: false, message: "Only an Admin can archive a project" });
      return;
    }
    data.status = status;
  }

  if (priority !== undefined) {
    if (!PRIORITIES.includes(priority)) {
      res.status(400).json({ success: false, message: "Priority must be LOW, MEDIUM or HIGH" });
      return;
    }
    data.priority = priority;
  }

  if (startDate !== undefined) {
    if (!hasValue(startDate)) {
      data.startDate = null;
    } else if (isDateString(startDate)) {
      data.startDate = new Date(startDate);
    } else {
      res.status(400).json({ success: false, message: "Start date must be YYYY-MM-DD" });
      return;
    }
  }

  if (dueDate !== undefined) {
    if (!hasValue(dueDate)) {
      data.dueDate = null;
    } else if (isDateString(dueDate)) {
      data.dueDate = new Date(dueDate);
    } else {
      res.status(400).json({ success: false, message: "Due date must be YYYY-MM-DD" });
      return;
    }
  }

  if (Object.keys(data).length === 0) {
    res.status(400).json({ success: false, message: "Nothing to update" });
    return;
  }

  try {
    const project = await prisma.project.findFirst({ where: { id, organizationId } });

    if (!project || (role !== "ADMIN" && project.teamLeaderId !== userId)) {
      res.status(404).json({ success: false, message: "Project not found" });
      return;
    }

    if (project.status === "ARCHIVED" && role !== "ADMIN") {
      res.status(403).json({
        success: false,
        message: "Archived projects can only be changed by an Admin",
      });
      return;
    }

    const effectiveStart =
      data.startDate !== undefined ? (data.startDate as Date | null) : project.startDate;
    const effectiveDue =
      data.dueDate !== undefined ? (data.dueDate as Date | null) : project.dueDate;

    if (effectiveStart && effectiveDue && effectiveDue < effectiveStart) {
      res.status(400).json({
        success: false,
        message: "Due date cannot be before the start date",
      });
      return;
    }

    const updated = await prisma.project.update({
      where: { id },
      data,
      include: projectInclude,
    });

    res.status(200).json({ success: true, project: updated });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Something went wrong" });
  }
};


export const setProjectLeader = async (req: Request, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, message: "Not authenticated" });
    return;
  }

  const { organizationId } = req.user;
  const id = req.params.id as string;
  const { teamLeaderId } = req.body;

  if (typeof teamLeaderId !== "string" || !teamLeaderId) {
    res.status(400).json({ success: false, message: "teamLeaderId is required" });
    return;
  }

  try {
    const project = await prisma.project.findFirst({ where: { id, organizationId } });

    if (!project) {
      res.status(404).json({ success: false, message: "Project not found" });
      return;
    }

    const leader = await prisma.user.findFirst({
      where: { id: teamLeaderId, organizationId, role: "TEAM_LEADER", status: "ACTIVE" },
    });

    if (!leader) {
      res.status(400).json({
        success: false,
        message: "Project lead must be an active Team Leader of your organization",
      });
      return;
    }

    const leadsLinkedTeam = await prisma.projectTeam.findFirst({
      where: { projectId: id, team: { teamLeaderId: leader.id } },
    });

    if (!leadsLinkedTeam) {
      res.status(400).json({
        success: false,
        message: "The project lead must be the Team Leader of one of the linked teams",
      });
      return;
    }

    const updated = await prisma.project.update({
      where: { id },
      data: { teamLeaderId: leader.id },
      include: projectInclude,
    });

    res.status(200).json({ success: true, project: updated });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Something went wrong" });
  }
};


export const setProjectTeams = async (req: Request, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, message: "Not authenticated" });
    return;
  }

  const { userId, role, organizationId } = req.user;
  const id = req.params.id as string;
  const { teamIds, teamLeaderId } = req.body;

  if (
    !Array.isArray(teamIds) ||
    teamIds.length === 0 ||
    !teamIds.every((t) => typeof t === "string")
  ) {
    res.status(400).json({ success: false, message: "Select at least one team" });
    return;
  }

  const uniqueTeamIds = [...new Set(teamIds as string[])];

  try {
    const project = await prisma.project.findFirst({ where: { id, organizationId } });

    if (!project || (role !== "ADMIN" && project.teamLeaderId !== userId)) {
      res.status(404).json({ success: false, message: "Project not found" });
      return;
    }

    if (project.status === "ARCHIVED" && role !== "ADMIN") {
      res.status(403).json({
        success: false,
        message: "Archived projects can only be changed by an Admin",
      });
      return;
    }

    // Only the Admin can change the lead at the same time
    const leaderId =
      role === "ADMIN" && typeof teamLeaderId === "string" && teamLeaderId
        ? teamLeaderId
        : project.teamLeaderId;

    const problem = await checkLeadAndTeams(organizationId, leaderId, uniqueTeamIds);

    if (problem) {
      res.status(400).json({ success: false, message: problem });
      return;
    }

    await prisma.$transaction([
      prisma.projectTeam.deleteMany({
        where: { projectId: id, teamId: { notIn: uniqueTeamIds } },
      }),
      prisma.projectTeam.createMany({
        data: uniqueTeamIds.map((teamId) => ({ projectId: id, teamId })),
        skipDuplicates: true,
      }),
      prisma.project.update({ where: { id }, data: { teamLeaderId: leaderId } }),
    ]);

    const updated = await prisma.project.findUnique({
      where: { id },
      include: projectInclude,
    });

    res.status(200).json({ success: true, project: updated });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Something went wrong" });
  }
};