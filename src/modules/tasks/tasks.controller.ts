import type { Request, Response } from "express";
import type { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../lib/prisma.js";
import { logActivity } from "../../lib/activity.js";
import { visibleWhere } from "../projects/project.access.js";
import {
  PRIORITIES,
  TASK_STATUSES,
  hasValue,
  isValidAssignee,
  taskInclude,
  toDueDate,
  withOverdue,
} from "./tasks.helpers.js";

export const createTask = async (req: Request, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, message: "Not authenticated" });
    return;
  }

  const { userId, organizationId } = req.user;
  const projectId = req.params.projectId as string;
  const { title, description, priority, dueDate, assignedToId } = req.body;

  if (typeof title !== "string" || !title.trim()) {
    res.status(400).json({ success: false, message: "Task title is required" });
    return;
  }

  if (title.trim().length > 200) {
    res.status(400).json({ success: false, message: "Title must be 200 characters or less" });
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

  let due: Date | null = null;
  if (hasValue(dueDate)) {
    due = typeof dueDate === "string" ? toDueDate(dueDate) : null;
    if (!due) {
      res.status(400).json({ success: false, message: "Invalid due date" });
      return;
    }
  }

  if (hasValue(assignedToId) && typeof assignedToId !== "string") {
    res.status(400).json({ success: false, message: "Invalid assignee" });
    return;
  }

  try {
    const project = await prisma.project.findFirst({
      where: { id: projectId, ...visibleWhere(req.user) },
      select: { id: true, status: true, teamLeaderId: true },
    });

    if (!project) {
      res.status(404).json({ success: false, message: "Project not found" });
      return;
    }

    if (project.teamLeaderId !== userId) {
      res.status(403).json({
        success: false,
        message: "Only the project lead can create tasks",
      });
      return;
    }

    if (project.status === "ARCHIVED") {
      res.status(400).json({
        success: false,
        message: "Tasks cannot be added to an archived project",
      });
      return;
    }

    if (hasValue(assignedToId)) {
      const valid = await isValidAssignee(organizationId, projectId, assignedToId);

      if (!valid) {
        res.status(400).json({
          success: false,
          message: "The assignee must be a Developer of a team linked to this project",
        });
        return;
      }
    }

    const task = await prisma.$transaction(async (tx) => {
      const last = await tx.task.aggregate({
        where: { projectId, status: "TODO" },
        _max: { position: true },
      });

      const created = await tx.task.create({
        data: {
          organizationId,
          projectId,
          title: title.trim(),
          description: description?.trim() || null,
          priority: priority ?? "MEDIUM",
          dueDate: due,
          assignedToId: hasValue(assignedToId) ? assignedToId : null,
          createdById: userId,
          position: (last._max.position ?? 0) + 1,
        },
        include: taskInclude,
      });

      await logActivity(tx, {
        organizationId,
        userId,
        entityType: "TASK",
        entityId: created.id,
        action: "TASK_CREATED",
        details: {
          title: created.title,
          projectId,
          assignedToId: created.assignedToId,
        },
      });

      return created;
    });

    res.status(201).json({ success: true, task: withOverdue(task) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Something went wrong" });
  }
};

const queryString = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

export const listTasks = async (req: Request, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, message: "Not authenticated" });
    return;
  }

  const projectId = req.params.projectId as string;

  const status = queryString(req.query.status);
  const priority = queryString(req.query.priority);
  const assigneeId = queryString(req.query.assigneeId);
  const search = queryString(req.query.search);
  const dueFrom = queryString(req.query.dueFrom);
  const dueTo = queryString(req.query.dueTo);
  const overdue = queryString(req.query.overdue);

  if (status && !TASK_STATUSES.includes(status as (typeof TASK_STATUSES)[number])) {
    res.status(400).json({ success: false, message: "Invalid status filter" });
    return;
  }

  if (priority && !PRIORITIES.includes(priority as (typeof PRIORITIES)[number])) {
    res.status(400).json({ success: false, message: "Invalid priority filter" });
    return;
  }

  const from = dueFrom ? toDueDate(`${dueFrom}`.slice(0, 10)) : null;
  const to = dueTo ? toDueDate(`${dueTo}`.slice(0, 10)) : null;

  if ((dueFrom && !from) || (dueTo && !to)) {
    res.status(400).json({ success: false, message: "Dates must be YYYY-MM-DD" });
    return;
  }

  try {
    const project = await prisma.project.findFirst({
      where: { id: projectId, ...visibleWhere(req.user) },
      select: { id: true },
    });

    if (!project) {
      res.status(404).json({ success: false, message: "Project not found" });
      return;
    }

    const and: Prisma.TaskWhereInput[] = [];

    if (status) and.push({ status: status as (typeof TASK_STATUSES)[number] });
    if (priority) and.push({ priority: priority as (typeof PRIORITIES)[number] });

    if (assigneeId === "unassigned") {
      and.push({ assignedToId: null });
    } else if (assigneeId) {
      and.push({ assignedToId: assigneeId });
    }

    if (search) and.push({ title: { contains: search, mode: "insensitive" } });

    if (overdue === "true") {
      and.push({ status: { not: "COMPLETED" }, dueDate: { lt: new Date() } });
    }

    if (from) {
      // dueFrom is the start of the day
      and.push({ dueDate: { gte: new Date(from.getTime() - 23 * 3600000 - 59 * 60000 - 59999) } });
    }
    if (to) and.push({ dueDate: { lte: to } });

    const tasks = await prisma.task.findMany({
      where: { projectId, AND: and },
      include: taskInclude,
      orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    });

    res.status(200).json({ success: true, tasks: tasks.map(withOverdue) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Something went wrong" });
  }
};

export const getTask = async (req: Request, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, message: "Not authenticated" });
    return;
  }

  const id = req.params.id as string;
  const { userId, role } = req.user;

  try {
    const task = await prisma.task.findFirst({
      where: { id, project: visibleWhere(req.user) },
      include: {
        ...taskInclude,
        project: { select: { id: true, name: true, status: true, teamLeaderId: true } },
      },
    });

    if (!task) {
      res.status(404).json({ success: false, message: "Task not found" });
      return;
    }

    const isLead = role === "TEAM_LEADER" && task.project.teamLeaderId === userId;
    const isAssignee = task.assignedToId === userId;

    res.status(200).json({
      success: true,
      task: withOverdue(task),
      permissions: {
        canManage: isLead,
        canUpdateStatus: isLead || isAssignee,
        canEditDescription: isLead || isAssignee,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Something went wrong" });
  }
};


const LEAD_ONLY_FIELDS = ["title", "priority", "dueDate", "assignedToId"] as const;
const EDITABLE_FIELDS = ["title", "description", "priority", "dueDate", "assignedToId"];

export const updateTask = async (req: Request, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, message: "Not authenticated" });
    return;
  }

  const { userId, role, organizationId } = req.user;
  const id = req.params.id as string;
  const body = (req.body ?? {}) as Record<string, unknown>;

  if ("status" in body) {
    res.status(400).json({
      success: false,
      message: "The status is changed by moving the task, not by editing it",
    });
    return;
  }

  if (!EDITABLE_FIELDS.some((field) => field in body)) {
    res.status(400).json({ success: false, message: "Nothing to update" });
    return;
  }

  try {
    const task = await prisma.task.findFirst({
      where: { id, project: visibleWhere(req.user) },
      include: { project: { select: { status: true, teamLeaderId: true } } },
    });

    if (!task) {
      res.status(404).json({ success: false, message: "Task not found" });
      return;
    }

    const isLead = role === "TEAM_LEADER" && task.project.teamLeaderId === userId;
    const isAssignee = role === "DEVELOPER" && task.assignedToId === userId;

    if (!isLead && !isAssignee) {
      res.status(403).json({ success: false, message: "You cannot edit this task" });
      return;
    }

    if (task.project.status === "ARCHIVED") {
      res.status(403).json({
        success: false,
        message: "Tasks of an archived project are read-only",
      });
      return;
    }

    if (!isLead) {
      const forbidden = LEAD_ONLY_FIELDS.find((field) => field in body);

      if (forbidden) {
        res.status(403).json({
          success: false,
          message: `Only the project lead can change the ${forbidden}`,
        });
        return;
      }
    }

    const data: Prisma.TaskUncheckedUpdateInput = {};
    const changes: Record<string, Prisma.InputJsonValue> = {};

    if ("title" in body) {
      const title = typeof body.title === "string" ? body.title.trim() : "";

      if (!title || title.length > 200) {
        res.status(400).json({
          success: false,
          message: "Title is required and must be 200 characters or less",
        });
        return;
      }

      if (title !== task.title) {
        data.title = title;
        changes.title = { from: task.title, to: title };
      }
    }

    if ("description" in body) {
      if (body.description !== null && typeof body.description !== "string") {
        res.status(400).json({ success: false, message: "Invalid description" });
        return;
      }

      const description = body.description?.trim() || null;

      if (description !== task.description) {
        data.description = description;
        changes.description = "edited";
      }
    }

    if ("priority" in body) {
      if (!PRIORITIES.includes(body.priority as (typeof PRIORITIES)[number])) {
        res.status(400).json({
          success: false,
          message: "Priority must be LOW, MEDIUM or HIGH",
        });
        return;
      }

      const priority = body.priority as (typeof PRIORITIES)[number];

      if (priority !== task.priority) {
        data.priority = priority;
        changes.priority = { from: task.priority, to: priority };
      }
    }

    if ("dueDate" in body) {
      let dueDate: Date | null = null;

      if (hasValue(body.dueDate)) {
        dueDate = typeof body.dueDate === "string" ? toDueDate(body.dueDate) : null;

        if (!dueDate) {
          res.status(400).json({ success: false, message: "Invalid due date" });
          return;
        }
      }

      if ((dueDate?.getTime() ?? null) !== (task.dueDate?.getTime() ?? null)) {
        data.dueDate = dueDate;
        changes.dueDate = {
          from: task.dueDate?.toISOString() ?? null,
          to: dueDate?.toISOString() ?? null,
        };
      }
    }

    if ("assignedToId" in body) {
      if (hasValue(body.assignedToId) && typeof body.assignedToId !== "string") {
        res.status(400).json({ success: false, message: "Invalid assignee" });
        return;
      }

      const assignedToId = hasValue(body.assignedToId) ? (body.assignedToId as string) : null;

      if (assignedToId !== task.assignedToId) {
        if (assignedToId) {
          const valid = await isValidAssignee(organizationId, task.projectId, assignedToId);

          if (!valid) {
            res.status(400).json({
              success: false,
              message: "The assignee must be a Developer of a team linked to this project",
            });
            return;
          }
        }

        data.assignedToId = assignedToId;
        changes.assignedToId = { from: task.assignedToId, to: assignedToId };
      }
    }

    if (Object.keys(data).length === 0) {
      const current = await prisma.task.findUnique({ where: { id }, include: taskInclude });
      res.status(200).json({
        success: true,
        message: "No changes",
        task: current ? withOverdue(current) : null,
      });
      return;
    }

    const updated = await prisma.$transaction(async (tx) => {
      const result = await tx.task.update({
        where: { id },
        data,
        include: taskInclude,
      });

      await logActivity(tx, {
        organizationId,
        userId,
        entityType: "TASK",
        entityId: id,
        action: "TASK_UPDATED",
        details: { changes },
      });

      return result;
    });

    res.status(200).json({ success: true, task: withOverdue(updated) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Something went wrong" });
  }
};

export const moveTask = async (req: Request, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, message: "Not authenticated" });
    return;
  }

  const { userId, role, organizationId } = req.user;
  const id = req.params.id as string;
  const { status, position } = req.body;

  if (!TASK_STATUSES.includes(status)) {
    res.status(400).json({
      success: false,
      message: "Status must be TODO, IN_PROGRESS, IN_REVIEW or COMPLETED",
    });
    return;
  }

  if (!Number.isInteger(position) || position < 0) {
    res.status(400).json({
      success: false,
      message: "Position must be a whole number, 0 or more",
    });
    return;
  }

  try {
    const task = await prisma.task.findFirst({
      where: { id, project: visibleWhere(req.user) },
      include: { project: { select: { status: true, teamLeaderId: true } } },
    });

    if (!task) {
      res.status(404).json({ success: false, message: "Task not found" });
      return;
    }

    const isLead = role === "TEAM_LEADER" && task.project.teamLeaderId === userId;
    const isAssignee = role === "DEVELOPER" && task.assignedToId === userId;

    if (!isLead && !isAssignee) {
      res.status(403).json({ success: false, message: "You cannot move this task" });
      return;
    }

    if (task.project.status === "ARCHIVED") {
      res.status(403).json({
        success: false,
        message: "Tasks of an archived project are read-only",
      });
      return;
    }

    const projectId = task.projectId;

    const result = await prisma.$transaction(async (tx) => {
      // One move at a time per project, so positions never clash
      await tx.$queryRaw`SELECT id FROM projects WHERE id = ${projectId}::uuid FOR UPDATE`;

      const current = await tx.task.findUnique({
        where: { id },
        select: { status: true, completedAt: true },
      });

      if (!current) throw new Error("TASK_GONE");

      const column = await tx.task.findMany({
        where: { projectId, status },
        orderBy: [{ position: "asc" }, { createdAt: "asc" }],
        select: { id: true, position: true },
      });

      const oldIndex = column.findIndex((t) => t.id === id);
      const others = column.filter((t) => t.id !== id);
      const index = Math.min(position, others.length);

      if (current.status === status && oldIndex === index) {
        const same = await tx.task.findUniqueOrThrow({
          where: { id },
          include: taskInclude,
        });
        return { changed: false, task: same };
      }

      // Put the task into its new place and number the column 1, 2, 3...
      const ordered = others.map((t) => t.id);
      ordered.splice(index, 0, id);

      for (const [i, taskId] of ordered.entries()) {
        const newPosition = i + 1;
        const existing = column.find((t) => t.id === taskId);

        if (taskId === id) continue;
        if (existing && existing.position === newPosition) continue;

        await tx.task.update({ where: { id: taskId }, data: { position: newPosition } });
      }

      const completedAt =
        status === "COMPLETED"
          ? current.status === "COMPLETED"
            ? current.completedAt
            : new Date()
          : null;

      await tx.task.update({
        where: { id },
        data: { status, position: index + 1, completedAt },
      });

      // Close the gap in the column the task left
      if (current.status !== status) {
        const oldColumn = await tx.task.findMany({
          where: { projectId, status: current.status, NOT: { id } },
          orderBy: [{ position: "asc" }, { createdAt: "asc" }],
          select: { id: true, position: true },
        });

        for (const [i, t] of oldColumn.entries()) {
          if (t.position !== i + 1) {
            await tx.task.update({ where: { id: t.id }, data: { position: i + 1 } });
          }
        }
      }

      const statusChanged = current.status !== status;

      await logActivity(tx, {
        organizationId,
        userId,
        entityType: "TASK",
        entityId: id,
        action: statusChanged ? "TASK_STATUS_CHANGED" : "TASK_REORDERED",
        details: statusChanged
          ? { from: current.status, to: status, position: index + 1 }
          : { status, from: oldIndex + 1, to: index + 1 },
      });

      const moved = await tx.task.findUniqueOrThrow({
        where: { id },
        include: taskInclude,
      });

      return { changed: true, task: moved };
    });

    res.status(200).json({
      success: true,
      changed: result.changed,
      task: withOverdue(result.task),
    });
  } catch (err) {
    if (err instanceof Error && err.message === "TASK_GONE") {
      res.status(404).json({ success: false, message: "Task not found" });
      return;
    }

    console.error(err);
    res.status(500).json({ success: false, message: "Something went wrong" });
  }
};