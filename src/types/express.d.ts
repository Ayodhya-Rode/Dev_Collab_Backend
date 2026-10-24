/**
 * To Add user details to Express Request for TypeScript
 * This file is used to extend the Express Request interface to include a user property.
 * This is useful for authentication and authorization purposes.
 */

declare global {
  namespace Express {   // Extending the Express namespace
    interface Request { // Extending the Request interface
      user?: {  // Adding an optional user property to the Request interface
        userId: string;
        role: "ADMIN" | "TEAM_LEADER" | "DEVELOPER";
        organizationId: string;
      };
    }
  }
}

export {};