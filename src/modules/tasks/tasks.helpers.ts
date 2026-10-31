import { prisma } from "../../lib/prisma.js";
import type { Priority, TaskStatus } from "../../generated/prisma/client.js";

export const TASK_STATUSES: TaskStatus[] = [
  "TODO",
  "IN_PROGRESS",
  "IN_REVIEW",
  "COMPLETED",
];

export const PRIORITIES: Priority[] = ["LOW", "MEDIUM", "HIGH"];

export const taskInclude = {
  assignedTo: { select: { id: true, name: true, email: true } },
  createdBy: { select: { id: true, name: true } },
} as const;

export const hasValue = (v: unknown) => v !== undefined && v !== null && v !== "";

// "2026-11-05" means the end of that day; a full ISO date-time is used as it is
export const toDueDate = (value: string): Date | null => {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Date(`${value}T23:59:59.999Z`)
    : new Date(value);

  return Number.isNaN(date.getTime()) ? null : date;
};

// Overdue is never stored; it is worked out from the due date and the status
export const withOverdue = <T extends { status: TaskStatus; dueDate: Date | null }>(
  task: T,
) => ({
  ...task,
  isOverdue:
    task.status !== "COMPLETED" && task.dueDate !== null && task.dueDate < new Date(),
});

// The assignee must be an active Developer of the same organization who is an
// active member of an active team linked to the project
export const isValidAssignee = async (
  organizationId: string,
  projectId: string,
  assigneeId: string,
): Promise<boolean> => {
  const membership = await prisma.teamMember.findFirst({
    where: {
      userId: assigneeId,
      status: "ACTIVE",
      user: { organizationId, role: "DEVELOPER", status: "ACTIVE" },
      team: { organizationId, status: "ACTIVE", projects: { some: { projectId } } },
    },
    select: { id: true },
  });

  return membership !== null;
};