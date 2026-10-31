import type { Prisma } from "../generated/prisma/client.js";

interface ActivityInput {
  organizationId: string;
  userId: string;
  entityType: string;
  entityId: string;
  action: string;
  details?: Prisma.InputJsonValue;
}

// Always called with the transaction client so the log is saved together with the change
export const logActivity = (tx: Prisma.TransactionClient, input: ActivityInput) =>
  tx.activityLog.create({ data: input });