import nodemailer from "nodemailer";
import { env } from "../config/env.js";

const transporter = nodemailer.createTransport({
  host: env.SMTP_HOST,
  port: env.SMTP_PORT,
  secure: false, // port 587 STARTTLS vaparto
  auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
});

export const sendEmail = async (to: string, subject: string, html: string) => {
  await transporter.sendMail({ from: env.EMAIL_FROM, to, subject, html });
};