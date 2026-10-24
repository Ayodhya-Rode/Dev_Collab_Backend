import express from "express";
import cors from "cors";
import helmet from "helmet";
import { env } from "./config/env.js";
import { prisma } from "./lib/prisma.js";
import authRoutes from "./modules/auth/auth.routes.js";
import cookieParser from "cookie-parser";

export const app = express();

app.use(helmet());
app.use(cors({ origin: env.CLIENT_URL, credentials: true }));
app.use(cookieParser());
app.use(express.json());

app.use("/api/auth", authRoutes);

app.get("/api/health", async (_req, res) => {
  await prisma.$queryRaw`SELECT 1`;
  res.json({ status: "ok", db: "connected" });
});