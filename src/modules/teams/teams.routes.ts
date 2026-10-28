import { Router } from "express";
import { createTeam, listTeams } from "./teams.controller.js";
import { authenticate } from "../../middleware/auth.middleware.js";
import { requireRole } from "../../middleware/role.middleware.js";

const router = Router();

router.post("/", authenticate, requireRole("ADMIN"), createTeam);
router.get("/", authenticate, listTeams);

export default router;