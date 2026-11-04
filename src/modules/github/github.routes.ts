import { Router } from "express";
import {
  connectRepository,
  disconnectRepository,
  getConnection,
} from "./github.controller.js";
import { authenticate } from "../../middleware/auth.middleware.js";
import { requireRole } from "../../middleware/role.middleware.js";

const router = Router();

router.get("/projects/:id/github", authenticate, getConnection);
router.put("/projects/:id/github", authenticate, requireRole("ADMIN", "TEAM_LEADER"), connectRepository);
router.delete("/projects/:id/github", authenticate, requireRole("ADMIN", "TEAM_LEADER"), disconnectRepository);

export default router;