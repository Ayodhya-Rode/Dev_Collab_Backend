import type { Request, Response } from "express";
import bcrypt from "bcrypt";
import { prisma } from "../../lib/prisma.js";
import { env } from "../../config/env.js";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { sendEmail } from "../../lib/mailer.js";

/**
 * To register a new user, we need to create an organization and a user in a transaction. The user will be assigned the role of "ADMIN" for the newly created organization.
 * route: POST /api/auth/register
 * description: This endpoint will create a new organization and a new user with the role of "ADMIN". The user's password will be hashed before storing it in the database. The organization slug will be generated from the organization name.
 */
export const register = async (req: Request, res: Response) => {
  const { organizationName, name, email, password } = req.body;

  if (!organizationName || !name || !email || !password) {
    res.status(400).json({ success: false, message: "All fields required" });
    return;
  }
  if (password.length < 8) {
    res.status(400).json({
      success: false,
      message: "Password must be at least 8 characters",
    });
    return;
  }

  try {
    const cleanEmail = email.toLowerCase().trim();

    const existing = await prisma.user.findUnique({
      where: { email: cleanEmail },
    });
    if (existing) {
      res
        .status(409)
        .json({ success: false, message: "Email already registered" });
      return;
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const slug = organizationName.toLowerCase().trim().replace(/\s+/g, "-");

    const user = await prisma.$transaction(async (tx) => {
      const org = await tx.organization.create({
        data: { name: organizationName, slug },
      });

      return tx.user.create({
        data: {
          organizationId: org.id,
          name,
          email: cleanEmail,
          passwordHash,
          role: "ADMIN",
        },
        omit: { passwordHash: true },
      });
    });

    res.status(201).json({ success: true, user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Something went wrong" });
  }
};

/**
 * To login a user, we need to verify the user's credentials and generate a JWT token.
 * route: POST /api/auth/login
 * description: This endpoint will verify the user's credentials and generate a JWT token for authentication.
 */
export const login = async (req: Request, res: Response) => {
  const { email, password } = req.body;

  if (!email || !password) {
    res.status(400).json({ success: false, message: "All fields required" });
    return;
  }

  try {
    const cleanEmail = email.toLowerCase().trim();

    const existing = await prisma.user.findUnique({
      where: { email: cleanEmail },
    });

    if (!existing) {
      res.status(401).json({ success: false, message: "Invalid credentials" });
      return;
    }

    const isMatch = await bcrypt.compare(password, existing.passwordHash);
    if (!isMatch) {
      res.status(401).json({ success: false, message: "Invalid credentials" });
      return;
    }

    if (existing.status !== "ACTIVE") {
      res
        .status(403)
        .json({ success: false, message: "Account is not active" });
      return;
    }

    const token = jwt.sign(
      {
        userId: existing.id,
        role: existing.role,
        organizationId: existing.organizationId,
      },
      env.JWT_SECRET,
      { expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions["expiresIn"] },
    );

    const { passwordHash, ...safeUser } = existing;
    res.cookie("token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 24 * 60 * 60 * 1000, // 1 day
    });

    res.status(200).json({ success: true, user: safeUser });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Something went wrong" });
  }
};

/**
 * To logout a user, we need to clear the JWT token from the cookies.
 * route: POST /api/auth/logout
 * description: This endpoint will clear the JWT token from the cookies, effectively logging out the user.
 */

export const logout = (_req: Request, res: Response) => {
  res.clearCookie("token", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
  });
  res.status(200).json({ success: true, message: "Logged out" });
};

/**
 * To get the details of the currently authenticated user, we need to verify the JWT token and fetch the user details from the database.
 * route: GET /api/auth/me
 * description: This endpoint will return the details of the currently authenticated user. The user must be authenticated to access this endpoint.
 */

export const me = async (req: Request, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, message: "Not authenticated" });
    return;
  }

  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.userId },
      omit: { passwordHash: true },
    });

    if (!user) {
      res.status(404).json({ success: false, message: "User not found" });
      return;
    }

    res.status(200).json({ success: true, user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Something went wrong" });
  }
};

/**
 * To initiate a password reset, we need to generate a unique token and store its hash in the database. The token will be sent to the user's email for them to reset their password.
 * route: POST /api/auth/forgot-password
 * description: This endpoint will generate a unique token for password reset and store its hash in the database. The token will be sent to the user's email for them to reset their password. If the email does not exist, a generic success message will be returned to prevent email enumeration.
 */

export const forgotPassword = async (req: Request, res: Response) => {
  const { email } = req.body;

  if (!email) {
    res.status(400).json({ success: false, message: "Email is required" });
    return;
  }

  try {
    const cleanEmail = email.toLowerCase().trim();

    const user = await prisma.user.findUnique({
      where: { email: cleanEmail },
    });

    if (user) {
      const token = crypto.randomBytes(32).toString("hex");
      const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

      await prisma.passwordResetToken.create({
        data: { userId: user.id, tokenHash, expiresAt },
      });

      const resetLink = `${env.CLIENT_URL}/reset-password?token=${token}`;

    try {
      await sendEmail(
        user.email,
        "Reset your DevCollab password",
        `<p>Hi ${user.name},</p>
     <p>Click the link below to reset your password. It expires in 1 hour.</p>
     <p><a href="${resetLink}">Reset password</a></p>
     <p>If you did not request this, you can ignore this email.</p>`,
      );
    } catch (mailErr) {
      console.error("Email failed:", mailErr);
    }
    }
    

    res.status(200).json({
      success: true,
      message: "If the email exists, a reset link has been sent",
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Something went wrong" });
  }
};


export const resetPassword = async (req: Request, res: Response) => {
  const { token, newPassword } = req.body;

  if (!token || !newPassword) {
    res.status(400).json({ success: false, message: "All fields required" });
    return;
  }
  if (newPassword.length < 8) {
    res.status(400).json({ success: false, message: "Password must be at least 8 characters" });
    return;
  }

  try {
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

    const record = await prisma.passwordResetToken.findUnique({
      where: { tokenHash },
    });

    if (!record || record.usedAt || record.expiresAt < new Date()) {
      res.status(400).json({ success: false, message: "Invalid or expired token" });
      return;
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);

    await prisma.$transaction([
      prisma.user.update({
        where: { id: record.userId },
        data: { passwordHash },
      }),
      prisma.passwordResetToken.update({
        where: { id: record.id },
        data: { usedAt: new Date() },
      }),
    ]);

    res.status(200).json({ success: true, message: "Password reset successful" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Something went wrong" });
  }
};