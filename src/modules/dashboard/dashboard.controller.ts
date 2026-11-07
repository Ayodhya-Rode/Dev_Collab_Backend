import type { Request, Response } from "express";
import type { Prisma, TaskStatus } from "../../generated/prisma/client.js";
import { prisma } from "../../lib/prisma.js";
import type { AuthUser } from "../projects/project.access.js";
import { visibleWhere } from "../projects/project.access.js";
import { getProjectStats } from "../projects/project.stats.js";
import { TASK_STATUSES } from "../tasks/tasks.helpers.js";

const PROJECT_STATUSES = ["PLANNING", "ACTIVE", "ON_HOLD", "COMPLETED"] as const;
const NOT_ARCHIVED: Prisma.ProjectWhereInput = { status: { not: "ARCHIVED" } };
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// One row per project: the same counts the project page shows
const projectRows = async (where: Prisma.ProjectWhereInput) => {
  const projects = await prisma.project.findMany({
    where,
    select: {
      id: true,
      name: true,
      status: true,
      priority: true,
      dueDate: true,
      teamLeader: { select: { id: true, name: true } },
      teams: { select: { team: { select: { id: true, name: true } } } },
    },
    orderBy: [{ dueDate: { sort: "asc", nulls: "last" } }, { createdAt: "desc" }],
  });

  const stats = await getProjectStats(projects.map((p) => p.id));

  return projects.map((p) => ({
    id: p.id,
    name: p.name,
    status: p.status,
    priority: p.priority,
    dueDate: p.dueDate,
    teamLeader: p.teamLeader,
    teams: p.teams.map((t) => t.team),
    stats: stats.get(p.id)!,
  }));
};

type ProjectRow = Awaited<ReturnType<typeof projectRows>>[number];

// Pending is split into "on track" and "overdue", so nothing is counted twice
const tasksByProject = (projects: ProjectRow[]) =>
  projects
    .filter((p) => p.stats.total > 0)
    .map((p) => ({
      name: p.name,
      completed: p.stats.completed,
      onTrack: p.stats.pending - p.stats.overdue,
      overdue: p.stats.overdue,
    }));

const adminDashboard = async (user: AuthUser) => {
  const { organizationId } = user;

  const [totalTeams, totalEmployees, projects] = await Promise.all([
    prisma.team.count({ where: { organizationId, status: "ACTIVE" } }),
    prisma.user.count({
      where: {
        organizationId,
        status: "ACTIVE",
        role: { in: ["TEAM_LEADER", "DEVELOPER"] },
      },
    }),
    projectRows({ organizationId, ...NOT_ARCHIVED }),
  ]);

  return {
    summary: {
      totalTeams,
      totalEmployees,
      totalProjects: projects.length,
      completedProjects: projects.filter((p) => p.status === "COMPLETED").length,
    },
    projects,
    charts: {
      projectsByStatus: PROJECT_STATUSES.map((status) => ({
        status,
        count: projects.filter((p) => p.status === status).length,
      })),
      tasksByProject: tasksByProject(projects),
    },
  };
};

// Pending tasks per Developer in the projects this Team Leader leads
const workloadFor = async (userId: string, organizationId: string) => {
  const inLedProjects: Prisma.TaskWhereInput = {
    project: { organizationId, teamLeaderId: userId, status: { not: "ARCHIVED" } },
    status: { not: "COMPLETED" },
  };

  const [pending, overdue] = await Promise.all([
    prisma.task.groupBy({
      by: ["assignedToId"],
      where: inLedProjects,
      _count: { _all: true },
    }),
    prisma.task.groupBy({
      by: ["assignedToId"],
      where: { ...inLedProjects, dueDate: { lt: new Date() } },
      _count: { _all: true },
    }),
  ]);

  const ids = pending
    .map((r) => r.assignedToId)
    .filter((id): id is string => id !== null);

  const users = await prisma.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true },
  });

  const names = new Map(users.map((u) => [u.id, u.name]));
  const overdueBy = new Map(overdue.map((r) => [r.assignedToId, r._count._all]));

  return pending
    .map((r) => {
      const total = r._count._all;
      const late = overdueBy.get(r.assignedToId) ?? 0;

      return {
        name: r.assignedToId ? (names.get(r.assignedToId) ?? "Unknown") : "Unassigned",
        onTrack: total - late,
        overdue: late,
      };
    })
    .sort((a, b) => b.onTrack + b.overdue - (a.onTrack + a.overdue))
    .slice(0, 10);
};

const teamLeaderDashboard = async (user: AuthUser) => {
  const { userId, organizationId } = user;

  const [projects, members, teamsLed, workload] = await Promise.all([
    projectRows({ AND: [visibleWhere(user), NOT_ARCHIVED] }),
    prisma.teamMember.findMany({
      where: {
        status: "ACTIVE",
        team: { organizationId, teamLeaderId: userId, status: "ACTIVE" },
        user: { status: "ACTIVE", role: "DEVELOPER" },
      },
      select: { userId: true },
      distinct: ["userId"],
    }),
    prisma.team.count({
      where: { organizationId, teamLeaderId: userId, status: "ACTIVE" },
    }),
    workloadFor(userId, organizationId),
  ]);

  return {
    summary: {
      teamMembers: members.length,
      teamsLed,
      totalProjects: projects.length,
    },
    projects,
    charts: { tasksByProject: tasksByProject(projects), workload },
  };
};

const developerDashboard = async (user: AuthUser, teamId: string | undefined) => {
  const { userId, organizationId } = user;

  const memberships = await prisma.teamMember.findMany({
    where: { userId, status: "ACTIVE", team: { organizationId, status: "ACTIVE" } },
    select: { team: { select: { id: true, name: true } } },
    orderBy: { team: { name: "asc" } },
  });

  const teams = memberships.map((m) => m.team);

  // Only one of the Developer's own teams can be selected
  if (teamId && !teams.some((t) => t.id === teamId)) return null;

  const projectWhere: Prisma.ProjectWhereInput = {
    AND: [
      visibleWhere(user),
      NOT_ARCHIVED,
      ...(teamId ? [{ teams: { some: { teamId } } }] : []),
    ],
  };

  const taskWhere: Prisma.TaskWhereInput = { assignedToId: userId, project: projectWhere };

  const now = new Date();
  const soon = new Date(now.getTime() + WEEK_MS);

  const [projects, byStatus, overdue, deadlines] = await Promise.all([
    projectRows(projectWhere),
    prisma.task.groupBy({ by: ["status"], where: taskWhere, _count: { _all: true } }),
    prisma.task.count({
      where: { ...taskWhere, status: { not: "COMPLETED" }, dueDate: { lt: now } },
    }),
    prisma.task.findMany({
      where: { ...taskWhere, status: { not: "COMPLETED" }, dueDate: { lte: soon } },
      select: {
        id: true,
        title: true,
        status: true,
        priority: true,
        dueDate: true,
        project: { select: { id: true, name: true } },
      },
      orderBy: { dueDate: "asc" },
      take: 10,
    }),
  ]);

  const countOf = (status: TaskStatus) =>
    byStatus.find((r) => r.status === status)?._count._all ?? 0;

  return {
    teams,
    selectedTeamId: teamId ?? null,
    summary: {
      myTasks: byStatus.reduce((sum, r) => sum + r._count._all, 0),
      inProgress: countOf("IN_PROGRESS"),
      completed: countOf("COMPLETED"),
      overdue,
    },
    projects,
    charts: {
      myTasksByStatus: TASK_STATUSES.map((status) => ({ status, count: countOf(status) })),
    },
    upcomingDeadlines: deadlines.map((t) => ({
      ...t,
      isOverdue: t.dueDate !== null && t.dueDate < now,
    })),
    notifications: null,
  };
};

export const getDashboard = async (req: Request, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, message: "Not authenticated" });
    return;
  }

  try {
    if (req.user.role === "ADMIN") {
      res.status(200).json({ success: true, role: "ADMIN", ...(await adminDashboard(req.user)) });
      return;
    }

    if (req.user.role === "TEAM_LEADER") {
      res.status(200).json({
        success: true,
        role: "TEAM_LEADER",
        ...(await teamLeaderDashboard(req.user)),
      });
      return;
    }

    const raw = req.query.teamId;
    const teamId = typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
    const data = await developerDashboard(req.user, teamId);

    if (!data) {
      res.status(404).json({ success: false, message: "Team not found" });
      return;
    }

    res.status(200).json({ success: true, role: "DEVELOPER", ...data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Something went wrong" });
  }
};