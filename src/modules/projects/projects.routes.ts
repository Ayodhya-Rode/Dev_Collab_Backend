import { Router } from "express";
import { createProject, listProjects, getProject, updateProject, setProjectLeader, setProjectTeams } from "./projects.controller.js";
import { authenticate } from "../../middleware/auth.middleware.js";
import { requireRole } from "../../middleware/role.middleware.js";

const router = Router();

router.post("/", authenticate, requireRole("ADMIN", "TEAM_LEADER"), createProject);
router.get("/", authenticate, listProjects);
router.get("/:id", authenticate, getProject);
router.patch("/:id", authenticate, requireRole("ADMIN", "TEAM_LEADER"), updateProject);
router.patch("/:id/leader", authenticate, requireRole("ADMIN"), setProjectLeader);
router.put("/:id/teams", authenticate, requireRole("ADMIN", "TEAM_LEADER"), setProjectTeams);

export default router;