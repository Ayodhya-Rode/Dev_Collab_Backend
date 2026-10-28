import { Router } from "express";
import {
  createInvitation,
  getInvitation,
  acceptInvitationNew,
  acceptInvitation,
} from "./invitations.controller.js";
import { authenticate } from "../../middleware/auth.middleware.js";
import { requireRole } from "../../middleware/role.middleware.js";

const router = Router();

router.post("/", authenticate, requireRole("ADMIN", "TEAM_LEADER"), createInvitation);
router.get("/:token", getInvitation);
router.post("/accept-new", acceptInvitationNew);
router.post("/accept", authenticate, acceptInvitation);

export default router;