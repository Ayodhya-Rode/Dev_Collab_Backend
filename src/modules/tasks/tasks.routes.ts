import { Router } from "express";
import { createTask, getTask, listTasks, updateTask , moveTask, getTaskActivity, addComment, deleteTask,listComments} from "./tasks.controller.js";
import { authenticate } from "../../middleware/auth.middleware.js";
import { requireRole } from "../../middleware/role.middleware.js";


const router = Router();

router.post("/projects/:projectId/tasks", authenticate, requireRole("TEAM_LEADER"), createTask);
router.get("/projects/:projectId/tasks", authenticate, listTasks);
router.get("/tasks/:id", authenticate, getTask);
router.patch("/tasks/:id", authenticate, requireRole("TEAM_LEADER", "DEVELOPER"), updateTask);
router.patch("/tasks/:id/move", authenticate, requireRole("TEAM_LEADER", "DEVELOPER"), moveTask);
router.delete("/tasks/:id", authenticate, requireRole("TEAM_LEADER"), deleteTask);
router.get("/tasks/:id/comments", authenticate, listComments);
router.post("/tasks/:id/comments", authenticate, addComment);
router.get("/tasks/:id/activity", authenticate, getTaskActivity);
export default router;          