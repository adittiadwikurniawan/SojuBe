import nodemailer from 'nodemailer';
import { Resend } from 'resend';

export type EmailDeliveryMode = 'smtp' | 'resend' | 'console';

export interface EmailSendResult {
  delivered: boolean;
  mode: EmailDeliveryMode;
  messageId?: string;
  to: string;
  subject: string;
  actionUrl: string;
}

export interface PasswordResetEmailParams {
  to: string;
  nama?: string;
  token: string;
  targetType: 'ADMIN' | 'CUSTOMER';
  actionUrl?: string;
  expiresInMinutes?: number;
}

export interface VerificationEmailParams {
  to: string;
  nama?: string;
  token: string;
  actionUrl?: string;
  expiresInMinutes?: number;
}

export interface AdminInviteEmailParams {
  to: string;
  nama: string;
  peran?: 'ADMIN' | 'SUPER_ADMIN';
  token: string;
  invitedBy?: string;
  actionUrl?: string;
  expiresInMinutes?: number;
}

interface InternalEmailPayload {
  to: string;
  subject: string;
  actionUrl: string;
  token: string;
  html: string;
  text: string;
}

const DEFAULT_EMAIL_FROM = 'SOJU FnB <no-reply@example.com>';
const DEFAULT_WEB_APP_URL = 'http://localhost:3000';

const getWebAppBaseUrl = (): string => {
  const raw = process.env.WEB_APP_URL?.trim() || DEFAULT_WEB_APP_URL;
  return raw.replace(/\/+$/, '');
};

const DEFAULT_SMTP_HOST = 'smtp.gmail.com';
const DEFAULT_SMTP_PORT = 465;

const getSmtpConfig = () => {
  const user = (process.env.SMTP_USER || process.env.GMAIL_USER || '').trim();
  const rawPass = (process.env.SMTP_PASS || process.env.GMAIL_APP_PASSWORD || '').trim();
  const pass = rawPass.replace(/\s+/g, '');

  if (!user || !pass) {
    return null;
  }

  const host = process.env.SMTP_HOST?.trim() || DEFAULT_SMTP_HOST;
  const parsedPort = Number(process.env.SMTP_PORT);
  const port = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : DEFAULT_SMTP_PORT;
  const secureEnv = process.env.SMTP_SECURE?.trim().toLowerCase();
  const secure =
    secureEnv === 'true' ? true : secureEnv === 'false' ? false : port === 465;

  return { host, port, secure, user, pass };
};

const getEmailFrom = (smtpUser?: string): string => {
  const configured = process.env.EMAIL_FROM?.trim();
  if (configured) {
    return configured;
  }
  if (smtpUser) {
    return `SOJU FnB <${smtpUser}>`;
  }
  return DEFAULT_EMAIL_FROM;
};

const escapeHtml = (value: string): string => {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
};

const dispatchEmail = async (payload: InternalEmailPayload): Promise<EmailSendResult> => {
  const smtpConfig = getSmtpConfig();

  if (smtpConfig) {
    const from = getEmailFrom(smtpConfig.user);
    const transporter = nodemailer.createTransport({
      host: smtpConfig.host,
      port: smtpConfig.port,
      secure: smtpConfig.secure,
      auth: {
        user: smtpConfig.user,
        pass: smtpConfig.pass,
      },
    });

    try {
      const info = await transporter.sendMail({
        from,
        to: payload.to,
        subject: payload.subject,
        html: payload.html,
        text: payload.text,
      });

      return {
        delivered: true,
        mode: 'smtp',
        messageId: info.messageId,
        to: payload.to,
        subject: payload.subject,
        actionUrl: payload.actionUrl,
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Gagal mengirim email melalui SMTP: ${reason}`);
    }
  }

  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = getEmailFrom();

  if (!apiKey) {
    console.info(
      '[EmailService][LOCAL_FALLBACK]',
      JSON.stringify({
        mode: 'console',
        from,
        to: payload.to,
        subject: payload.subject,
        actionUrl: payload.actionUrl,
        token: payload.token,
      })
    );

    return {
      delivered: true,
      mode: 'console',
      to: payload.to,
      subject: payload.subject,
      actionUrl: payload.actionUrl,
    };
  }

  const resend = new Resend(apiKey);
  const response = await resend.emails.send({
    from,
    to: [payload.to],
    subject: payload.subject,
    html: payload.html,
    text: payload.text,
  });

  if (response.error) {
    throw new Error(`Gagal mengirim email melalui Resend: ${response.error.message}`);
  }

  return {
    delivered: true,
    mode: 'resend',
    messageId: response.data?.id,
    to: payload.to,
    subject: payload.subject,
    actionUrl: payload.actionUrl,
  };
};

export const sendPasswordResetEmail = async (
  params: PasswordResetEmailParams
): Promise<EmailSendResult> => {
  const baseUrl = getWebAppBaseUrl();
  const defaultPath =
    params.targetType === 'ADMIN' ? '/reset-password' : '/customer/reset-password';
  const actionUrl =
    params.actionUrl?.trim() ||
    `${baseUrl}${defaultPath}?token=${encodeURIComponent(params.token)}`;
  const expiresInMinutes = params.expiresInMinutes ?? 45;
  const greetingName = params.nama?.trim() || 'Pengguna';
  const subject =
    params.targetType === 'ADMIN'
      ? 'Reset Password Akun Admin SOJU FnB'
      : 'Reset Password Akun Pelanggan SOJU FnB';

  const safeName = escapeHtml(greetingName);
  const safeUrl = escapeHtml(actionUrl);

  const html = [
    `<p>Halo ${safeName},</p>`,
    '<p>Kami menerima permintaan untuk mengatur ulang kata sandi akun SOJU FnB Anda.</p>',
    `<p>Silakan klik tautan berikut untuk membuat kata sandi baru (berlaku selama ${expiresInMinutes} menit):</p>`,
    `<p><a href="${safeUrl}">${safeUrl}</a></p>`,
    '<p>Jika Anda tidak merasa mengajukan permintaan ini, abaikan email ini.</p>',
  ].join('\n');

  const text = [
    `Halo ${greetingName},`,
    'Kami menerima permintaan untuk mengatur ulang kata sandi akun SOJU FnB Anda.',
    `Gunakan tautan berikut untuk membuat kata sandi baru (berlaku selama ${expiresInMinutes} menit):`,
    actionUrl,
    'Jika Anda tidak merasa mengajukan permintaan ini, abaikan email ini.',
  ].join('\n\n');

  return dispatchEmail({
    to: params.to,
    subject,
    actionUrl,
    token: params.token,
    html,
    text,
  });
};

export const sendVerificationEmail = async (
  params: VerificationEmailParams
): Promise<EmailSendResult> => {
  const baseUrl = getWebAppBaseUrl();
  const actionUrl =
    params.actionUrl?.trim() ||
    `${baseUrl}/customer/verifikasi-email?token=${encodeURIComponent(params.token)}`;
  const expiresInMinutes = params.expiresInMinutes ?? 45;
  const greetingName = params.nama?.trim() || 'Pelanggan';
  const subject = 'Verifikasi Email Akun SOJU FnB';

  const safeName = escapeHtml(greetingName);
  const safeUrl = escapeHtml(actionUrl);

  const html = [
    `<p>Halo ${safeName},</p>`,
    '<p>Terima kasih telah mendaftar di SOJU FnB.</p>',
    `<p>Silakan verifikasi alamat email Anda melalui tautan berikut (berlaku selama ${expiresInMinutes} menit):</p>`,
    `<p><a href="${safeUrl}">${safeUrl}</a></p>`,
    '<p>Jika Anda tidak mendaftar di SOJU FnB, silakan abaikan email ini.</p>',
  ].join('\n');

  const text = [
    `Halo ${greetingName},`,
    'Terima kasih telah mendaftar di SOJU FnB.',
    `Verifikasi alamat email Anda melalui tautan berikut (berlaku selama ${expiresInMinutes} menit):`,
    actionUrl,
    'Jika Anda tidak mendaftar di SOJU FnB, silakan abaikan email ini.',
  ].join('\n\n');

  return dispatchEmail({
    to: params.to,
    subject,
    actionUrl,
    token: params.token,
    html,
    text,
  });
};

export const sendAdminInviteEmail = async (
  params: AdminInviteEmailParams
): Promise<EmailSendResult> => {
  const baseUrl = getWebAppBaseUrl();
  const actionUrl =
    params.actionUrl?.trim() ||
    `${baseUrl}/reset-password?token=${encodeURIComponent(params.token)}&purpose=invite`;
  const expiresInMinutes = params.expiresInMinutes ?? 60;
  const roleLabel = params.peran === 'SUPER_ADMIN' ? 'Super Admin' : 'Admin';
  const inviterInfo = params.invitedBy?.trim()
    ? ` oleh ${params.invitedBy.trim()}`
    : '';
  const subject = 'Undangan Akun Admin SOJU FnB';

  const safeName = escapeHtml(params.nama.trim());
  const safeInviter = escapeHtml(inviterInfo);
  const safeUrl = escapeHtml(actionUrl);

  const html = [
    `<p>Halo ${safeName},</p>`,
    `<p>Anda telah diundang${safeInviter} sebagai <strong>${roleLabel}</strong> di dashboard SOJU FnB.</p>`,
    `<p>Silakan atur kata sandi akun Anda melalui tautan berikut (berlaku selama ${expiresInMinutes} menit):</p>`,
    `<p><a href="${safeUrl}">${safeUrl}</a></p>`,
  ].join('\n');

  const text = [
    `Halo ${params.nama.trim()},`,
    `Anda telah diundang${inviterInfo} sebagai ${roleLabel} di dashboard SOJU FnB.`,
    `Silakan atur kata sandi akun Anda melalui tautan berikut (berlaku selama ${expiresInMinutes} menit):`,
    actionUrl,
  ].join('\n\n');

  return dispatchEmail({
    to: params.to,
    subject,
    actionUrl,
    token: params.token,
    html,
    text,
  });
};
