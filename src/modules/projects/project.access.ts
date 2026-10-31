import type { Request } from "express";
import type { Prisma } from "../../generated/prisma/client.js";

export type AuthUser = NonNullable<Request["user"]>;

export const visibleWhere = ({
  userId,
  role,
  organizationId,
}: AuthUser): Prisma.ProjectWhereInput => {
  if (role === "ADMIN") return { organizationId };

  if (role === "TEAM_LEADER") {
    return {
      organizationId,
      OR: [
        { teamLeaderId: userId },
        { teams: { some: { team: { teamLeaderId: userId } } } },
      ],
    };
  }

  return {
    organizationId,
    teams: {
      some: { team: { members: { some: { userId, status: "ACTIVE" } } } },
    },
  };
};