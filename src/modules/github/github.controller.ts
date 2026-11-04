import type { Request, Response } from "express";
import { prisma } from "../../lib/prisma.js";
import { logActivity } from "../../lib/activity.js";
import {
  GithubError,
  getRepository,
  parseRepository,
  sendGithubError,
} from "../../lib/github.js";
import { visibleWhere } from "../projects/project.access.js";

type AuthUser = NonNullable<Request["user"]>;

const findProject = (user: AuthUser, id: string) =>
  prisma.project.findFirst({
    where: { id, ...visibleWhere(user) },
    select: { id: true, status: true, teamLeaderId: true },
  });

// Admin can always manage; the project lead only while the project is not archived
const manageProblem = (
  user: AuthUser,
  project: { status: string; teamLeaderId: string },
): string | null => {
  const isAdmin = user.role === "ADMIN";
  const isLead = user.role === "TEAM_LEADER" && project.teamLeaderId === user.userId;

  if (!isAdmin && !isLead) {
    return "Only an Admin or the project lead can change the repository";
  }

  if (!isAdmin && project.status === "ARCHIVED") {
    return "Archived projects are read-only";
  }

  return null;
};

const present = (c: {
  repoOwner: string;
  repoName: string;
  defaultBranch: string;
  createdAt: Date;
  connectedBy?: { id: string; name: string };
}) => ({
  repoOwner: c.repoOwner,
  repoName: c.repoName,
  defaultBranch: c.defaultBranch,
  url: `https://github.com/${c.repoOwner}/${c.repoName}`,
  connectedBy: c.connectedBy ?? null,
  createdAt: c.createdAt,
});

export const getConnection = async (req: Request, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, message: "Not authenticated" });
    return;
  }

  const id = req.params.id as string;

  try {
    const project = await findProject(req.user, id);

    if (!project) {
      res.status(404).json({ success: false, message: "Project not found" });
      return;
    }

    const connection = await prisma.githubConnection.findUnique({
      where: { projectId: id },
      include: { connectedBy: { select: { id: true, name: true } } },
    });

    res.status(200).json({
      success: true,
      connection: connection ? present(connection) : null,
      canManage: manageProblem(req.user, project) === null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Something went wrong" });
  }
};

export const connectRepository = async (req: Request, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, message: "Not authenticated" });
    return;
  }

  const { userId, organizationId } = req.user;
  const id = req.params.id as string;
  const input = typeof req.body?.repository === "string" ? req.body.repository : "";

  const parsed = parseRepository(input);

  if (!parsed) {
    res.status(400).json({
      success: false,
      message: "Enter the repository as owner/name or a GitHub URL",
    });
    return;
  }

  try {
    const project = await findProject(req.user, id);

    if (!project) {
      res.status(404).json({ success: false, message: "Project not found" });
      return;
    }

    const problem = manageProblem(req.user, project);

    if (problem) {
      res.status(403).json({ success: false, message: problem });
      return;
    }

    // Ask GitHub first, outside the database transaction
    const repo = await getRepository(parsed.owner, parsed.name);

    const connection = await prisma.$transaction(async (tx) => {
      const existing = await tx.githubConnection.findUnique({ where: { projectId: id } });

      const saved = await tx.githubConnection.upsert({
        where: { projectId: id },
        create: {
          organizationId,
          projectId: id,
          repoOwner: repo.owner,
          repoName: repo.name,
          defaultBranch: repo.defaultBranch,
          connectedById: userId,
        },
        update: {
          repoOwner: repo.owner,
          repoName: repo.name,
          defaultBranch: repo.defaultBranch,
          connectedById: userId,
        },
        include: { connectedBy: { select: { id: true, name: true } } },
      });

      // Pull request numbers belong to one repository, so links to the old one are removed
      if (existing && (existing.repoOwner !== repo.owner || existing.repoName !== repo.name)) {
        await tx.taskPrLink.deleteMany({ where: { task: { projectId: id } } });
      }

      await logActivity(tx, {
        organizationId,
        userId,
        entityType: "PROJECT",
        entityId: id,
        action: "GITHUB_CONNECTED",
        details: { repository: `${repo.owner}/${repo.name}` },
      });

      return saved;
    });

    res.status(200).json({ success: true, connection: present(connection) });
  } catch (err) {
    if (err instanceof GithubError) {
      sendGithubError(res, err);
      return;
    }

    console.error(err);
    res.status(500).json({ success: false, message: "Something went wrong" });
  }
};

export const disconnectRepository = async (req: Request, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, message: "Not authenticated" });
    return;
  }

  const { userId, organizationId } = req.user;
  const id = req.params.id as string;

  try {
    const project = await findProject(req.user, id);

    if (!project) {
      res.status(404).json({ success: false, message: "Project not found" });
      return;
    }

    const problem = manageProblem(req.user, project);

    if (problem) {
      res.status(403).json({ success: false, message: problem });
      return;
    }

    const removed = await prisma.$transaction(async (tx) => {
      const existing = await tx.githubConnection.findUnique({ where: { projectId: id } });

      if (!existing) return false;

      await tx.githubConnection.delete({ where: { projectId: id } });
      await tx.taskPrLink.deleteMany({ where: { task: { projectId: id } } });

      await logActivity(tx, {
        organizationId,
        userId,
        entityType: "PROJECT",
        entityId: id,
        action: "GITHUB_DISCONNECTED",
        details: { repository: `${existing.repoOwner}/${existing.repoName}` },
      });

      return true;
    });

    if (!removed) {
      res.status(404).json({ success: false, message: "No repository is connected" });
      return;
    }

    res.status(200).json({ success: true, message: "Repository disconnected" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Something went wrong" });
  }
};