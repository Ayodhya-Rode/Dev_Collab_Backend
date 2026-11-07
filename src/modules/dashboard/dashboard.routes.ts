import { Router } from "express";
import { getDashboard } from "./dashboard.controller.js";
import { authenticate } from "../../middleware/auth.middleware.js";

const router = Router();

router.get("/dashboard", authenticate, getDashboard);

export default router;