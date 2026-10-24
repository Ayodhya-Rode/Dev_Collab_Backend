import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";

export const authenticate = (req: Request, res: Response, next: NextFunction) => {
  const token = req.cookies?.token;

  if (!token) {
    res.status(401).json({ success: false, message: "Not authenticated" });
    return;
  }

  let decoded: string | jwt.JwtPayload;
  try {
    decoded = jwt.verify(token, env.JWT_SECRET);
  } catch {
    res.status(401).json({ success: false, message: "Invalid or expired token" });
    return;
  }

  req.user = decoded as Request["user"];
  next();
};