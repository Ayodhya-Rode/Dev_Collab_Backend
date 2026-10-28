import { Router } from "express";
import { createTeam, listTeams , getTeam,updateTeam,setTeamLeader, removeMember } from "./teams.controller.js";
import { authenticate } from "../../middleware/auth.middleware.js";
import { requireRole } from "../../middleware/role.middleware.js";

const router = Router();

router.post("/", authenticate, requireRole("ADMIN"), createTeam);
router.get("/", authenticate, listTeams);
router.get("/:id", authenticate, getTeam);
router.patch("/:id", authenticate, requireRole("ADMIN"), updateTeam);
router.patch("/:id/leader", authenticate, requireRole("ADMIN"), setTeamLeader);
router.delete("/:id/members/:userId",authenticate,requireRole("ADMIN", "TEAM_LEADER"),removeMember);

export default router;