import nodemailer from 'nodemailer';
import type { Config } from '../config';

export interface Mailer {
  send(to: string, subject: string, text: string): Promise<void>;
}

export function createMailer(smtp: Config['smtp']): Mailer | null {
  if (!smtp) return null;
  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: smtp.user ? { user: smtp.user, pass: smtp.password } : undefined,
  });
  return {
    async send(to, subject, text) {
      await transport.sendMail({ from: smtp.from, to, subject, text });
    },
  };
}
