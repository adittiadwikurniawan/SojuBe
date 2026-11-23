import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { sendMock, resendConstructorSpy } = vi.hoisted(() => ({
  sendMock: vi.fn(),
  resendConstructorSpy: vi.fn(),
}));

vi.mock('resend', () => {
  class MockResend {
    emails = {
      send: sendMock,
    };

    constructor(apiKey?: string) {
      resendConstructorSpy(apiKey);
    }
  }

  return {
    Resend: MockResend,
  };
});

import {
  sendAdminInviteEmail,
  sendPasswordResetEmail,
  sendVerificationEmail,
} from '../src/services/emailService';

describe('emailService', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.RESEND_API_KEY;
    delete process.env.EMAIL_FROM;
    delete process.env.WEB_APP_URL;
    sendMock.mockReset();
    resendConstructorSpy.mockReset();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  describe('local console fallback (RESEND_API_KEY empty or unset)', () => {
    it('logs structured preview for admin password reset when RESEND_API_KEY is unset', async () => {
      const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

      const result = await sendPasswordResetEmail({
        to: 'admin@soju.local',
        nama: 'Budi',
        token: 'raw-admin-token-123',
        targetType: 'ADMIN',
      });

      expect(result).toEqual({
        delivered: true,
        mode: 'console',
        to: 'admin@soju.local',
        subject: 'Reset Password Akun Admin SOJU FnB',
        actionUrl: 'http://localhost:3000/reset-password?token=raw-admin-token-123',
      });
      expect(resendConstructorSpy).not.toHaveBeenCalled();
      expect(sendMock).not.toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledTimes(1);
      expect(consoleSpy.mock.calls[0][0]).toBe('[EmailService][LOCAL_FALLBACK]');

      const loggedPayload = JSON.parse(String(consoleSpy.mock.calls[0][1]));
      expect(loggedPayload).toMatchObject({
        mode: 'console',
        to: 'admin@soju.local',
        subject: 'Reset Password Akun Admin SOJU FnB',
        actionUrl: 'http://localhost:3000/reset-password?token=raw-admin-token-123',
        token: 'raw-admin-token-123',
      });
    });

    it('falls back to console when RESEND_API_KEY is whitespace-only for customer verification', async () => {
      process.env.RESEND_API_KEY = '   ';
      process.env.WEB_APP_URL = 'https://soju.example.com/';
      const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

      const result = await sendVerificationEmail({
        to: 'customer@soju.local',
        nama: 'Siti',
        token: 'verify-token-456',
      });

      expect(result).toEqual({
        delivered: true,
        mode: 'console',
        to: 'customer@soju.local',
        subject: 'Verifikasi Email Akun SOJU FnB',
        actionUrl: 'https://soju.example.com/customer/verifikasi-email?token=verify-token-456',
      });
      expect(resendConstructorSpy).not.toHaveBeenCalled();
      expect(sendMock).not.toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledTimes(1);
    });

    it('logs structured preview for admin invite email in local mode', async () => {
      process.env.RESEND_API_KEY = '';
      const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

      const result = await sendAdminInviteEmail({
        to: 'newadmin@soju.local',
        nama: 'Rina',
        peran: 'ADMIN',
        token: 'invite-token-789',
        invitedBy: 'Super Admin',
      });

      expect(result).toEqual({
        delivered: true,
        mode: 'console',
        to: 'newadmin@soju.local',
        subject: 'Undangan Akun Admin SOJU FnB',
        actionUrl: 'http://localhost:3000/reset-password?token=invite-token-789&purpose=invite',
      });
      expect(sendMock).not.toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('Resend SDK dispatch (RESEND_API_KEY configured)', () => {
    it('dispatches customer password reset email via Resend SDK', async () => {
      process.env.RESEND_API_KEY = 're_test_mock_key';
      process.env.EMAIL_FROM = 'SOJU FnB <noreply@soju.test>';
      process.env.WEB_APP_URL = 'https://app.soju.test';
      sendMock.mockResolvedValue({ data: { id: 'msg_reset_001' }, error: null });

      const result = await sendPasswordResetEmail({
        to: 'pelanggan@soju.test',
        nama: 'Andi',
        token: 'cust-reset-token',
        targetType: 'CUSTOMER',
        expiresInMinutes: 30,
      });

      expect(resendConstructorSpy).toHaveBeenCalledWith('re_test_mock_key');
      expect(sendMock).toHaveBeenCalledTimes(1);
      expect(sendMock).toHaveBeenCalledWith(
        expect.objectContaining({
          from: 'SOJU FnB <noreply@soju.test>',
          to: ['pelanggan@soju.test'],
          subject: 'Reset Password Akun Pelanggan SOJU FnB',
        })
      );

      const sentArgs = sendMock.mock.calls[0][0];
      expect(sentArgs.html).toContain(
        'https://app.soju.test/customer/reset-password?token=cust-reset-token'
      );
      expect(sentArgs.text).toContain('30 menit');

      expect(result).toEqual({
        delivered: true,
        mode: 'resend',
        messageId: 'msg_reset_001',
        to: 'pelanggan@soju.test',
        subject: 'Reset Password Akun Pelanggan SOJU FnB',
        actionUrl: 'https://app.soju.test/customer/reset-password?token=cust-reset-token',
      });
    });

    it('dispatches verification email via Resend SDK with custom actionUrl', async () => {
      process.env.RESEND_API_KEY = 're_test_mock_key';
      sendMock.mockResolvedValue({ data: { id: 'msg_verify_002' }, error: null });

      const result = await sendVerificationEmail({
        to: 'buyer@soju.test',
        token: 'verify-xyz',
        actionUrl: 'https://custom.soju.test/verify?token=verify-xyz',
      });

      expect(sendMock).toHaveBeenCalledWith(
        expect.objectContaining({
          from: 'SOJU FnB <no-reply@example.com>',
          to: ['buyer@soju.test'],
          subject: 'Verifikasi Email Akun SOJU FnB',
        })
      );
      expect(result.mode).toBe('resend');
      expect(result.messageId).toBe('msg_verify_002');
      expect(result.actionUrl).toBe('https://custom.soju.test/verify?token=verify-xyz');
    });

    it('dispatches admin invite email via Resend SDK and escapes HTML in user fields', async () => {
      process.env.RESEND_API_KEY = 're_test_mock_key';
      sendMock.mockResolvedValue({ data: { id: 'msg_invite_003' }, error: null });

      const result = await sendAdminInviteEmail({
        to: 'staff@soju.test',
        nama: '<script>alert(1)</script>',
        peran: 'SUPER_ADMIN',
        token: 'invite-abc',
        invitedBy: 'Owner & Co',
      });

      const sentArgs = sendMock.mock.calls[0][0];
      expect(sentArgs.html).not.toContain('<script>');
      expect(sentArgs.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
      expect(sentArgs.html).toContain('Owner &amp; Co');
      expect(sentArgs.html).toContain('Super Admin');
      expect(result.mode).toBe('resend');
      expect(result.messageId).toBe('msg_invite_003');
    });

    it('throws a descriptive error when Resend SDK returns an error object', async () => {
      process.env.RESEND_API_KEY = 're_test_mock_key';
      sendMock.mockResolvedValue({
        data: null,
        error: { message: 'Invalid API key' },
      });

      await expect(
        sendVerificationEmail({
          to: 'fail@soju.test',
          token: 'tok-fail',
        })
      ).rejects.toThrow('Gagal mengirim email melalui Resend: Invalid API key');
    });
  });
});
