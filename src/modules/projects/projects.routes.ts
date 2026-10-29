import { Router } from "express";
import { createProject, listProjects } from "./projects.controller.js";
import { authenticate } from "../../middleware/auth.middleware.js";
import { requireRole } from "../../middleware/role.middleware.js";

const router = Router();

router.post("/", authenticate, requireRole("ADMIN", "TEAM_LEADER"), createProject);
router.get("/", authenticate, listProjects);

export default router;