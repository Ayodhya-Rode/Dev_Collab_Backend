import { prisma } from "../../lib/prisma.js";
import type { TaskStatus } from "../../generated/prisma/client.js";

export interface ProjectStats {
  total: number;
  completed: number;
  pending: number;
  overdue: number;
  progress: number;
  byStatus: Record<TaskStatus, number>;
}

const emptyStats = (): ProjectStats => ({
  total: 0,
  completed: 0,
  pending: 0,
  overdue: 0,
  progress: 0,
  byStatus: { TODO: 0, IN_PROGRESS: 0, IN_REVIEW: 0, COMPLETED: 0 },
});

// One entry per requested project, even when it has no tasks
export const getProjectStats = async (
  projectIds: string[],
): Promise<Map<string, ProjectStats>> => {
  const stats = new Map<string, ProjectStats>(
    projectIds.map((id) => [id, emptyStats()]),
  );

  if (projectIds.length === 0) return stats;

  const [byStatus, overdue] = await Promise.all([
    prisma.task.groupBy({
      by: ["projectId", "status"],
      where: { projectId: { in: projectIds } },
      _count: { _all: true },
    }),
    prisma.task.groupBy({
      by: ["projectId"],
      where: {
        projectId: { in: projectIds },
        status: { not: "COMPLETED" },
        dueDate: { lt: new Date() },
      },
      _count: { _all: true },
    }),
  ]);

  for (const row of byStatus) {
    const entry = stats.get(row.projectId);
    if (!entry) continue;

    entry.byStatus[row.status] = row._count._all;
    entry.total += row._count._all;
  }

  for (const row of overdue) {
    const entry = stats.get(row.projectId);
    if (entry) entry.overdue = row._count._all;
  }

  for (const entry of stats.values()) {
    entry.completed = entry.byStatus.COMPLETED;
    entry.pending = entry.total - entry.completed;
    entry.progress =
      entry.total === 0 ? 0 : Math.round((entry.completed / entry.total) * 100);
  }

  return stats;
};