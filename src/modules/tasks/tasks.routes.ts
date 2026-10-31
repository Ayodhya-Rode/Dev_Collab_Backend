import { Router } from "express";
import { createTask, getTask, listTasks, updateTask } from "./tasks.controller.js";
import { authenticate } from "../../middleware/auth.middleware.js";
import { requireRole } from "../../middleware/role.middleware.js";


const router = Router();

router.post("/projects/:projectId/tasks", authenticate, requireRole("TEAM_LEADER"), createTask);
router.get("/projects/:projectId/tasks", authenticate, listTasks);
router.get("/tasks/:id", authenticate, getTask);
router.patch("/tasks/:id", authenticate, requireRole("TEAM_LEADER", "DEVELOPER"), updateTask);

export default router;