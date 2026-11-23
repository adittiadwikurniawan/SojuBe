import express from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import type {
  PasswordResetToken,
  PeranPengguna,
  TokenPurpose,
  TokenTargetType,
} from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface MockPengguna {
  id: number;
  nama: string;
  email: string;
  passwordHash: string;
  peran: PeranPengguna;
  aktif: boolean;
  terakhirMasukPada: Date | null;
  dibuatPada: Date;
}

interface TokenWhereClause {
  tokenHash?: string;
  purpose?: TokenPurpose;
  targetType?: TokenTargetType;
  penggunaId?: number | null;
  pelangganId?: number | null;
  usedAt?: null;
  expiresAt?: { gt: Date };
}

const { users, tokens, resetStore, mockPrisma, mockSendPasswordResetEmail } = vi.hoisted(() => {
  const users: MockPengguna[] = [];
  const tokens: PasswordResetToken[] = [];
  let nextTokenId = 1;

  const matchesTokenWhere = (row: PasswordResetToken, where: TokenWhereClause): boolean => {
    if (where.tokenHash !== undefined && row.tokenHash !== where.tokenHash) return false;
    if (where.purpose !== undefined && row.purpose !== where.purpose) return false;
    if (where.targetType !== undefined && row.targetType !== where.targetType) return false;
    if (where.penggunaId !== undefined && row.penggunaId !== where.penggunaId) return false;
    if (where.pelangganId !== undefined && row.pelangganId !== where.pelangganId) return false;
    if (where.usedAt === null && row.usedAt !== null) return false;
    if (
      where.expiresAt?.gt !== undefined &&
      row.expiresAt.getTime() <= where.expiresAt.gt.getTime()
    ) {
      return false;
    }
    return true;
  };

  const applySelect = <T extends Record<string, any>>(
    row: T,
    select?: Record<string, boolean>
  ): Partial<T> => {
    if (!select) return { ...row };
    const selected: Record<string, any> = {};
    for (const [key, include] of Object.entries(select)) {
      if (include) {
        selected[key] = row[key];
      }
    }
    return selected as Partial<T>;
  };

  const passwordResetTokenDelegate = {
    create: vi.fn(async ({ data }: any): Promise<PasswordResetToken> => {
      const created: PasswordResetToken = {
        id: nextTokenId++,
        tokenHash: data.tokenHash,
        purpose: data.purpose,
        targetType: data.targetType,
        penggunaId: data.penggunaId ?? null,
        pelangganId: data.pelangganId ?? null,
        expiresAt: data.expiresAt,
        usedAt: null,
        createdAt: new Date(),
      };
      tokens.push(created);
      return { ...created };
    }),
    updateMany: vi.fn(async ({ where, data }: any): Promise<{ count: number }> => {
      let count = 0;
      for (const row of tokens) {
        if (matchesTokenWhere(row, where)) {
          row.usedAt = data.usedAt;
          count += 1;
        }
      }
      return { count };
    }),
    findUnique: vi.fn(async ({ where }: any): Promise<PasswordResetToken | null> => {
      const found = tokens.find((row) => row.tokenHash === where.tokenHash);
      return found ? { ...found } : null;
    }),
  };

  const penggunaDelegate = {
    findUnique: vi.fn(async ({ where, select }: any) => {
      const found = users.find((user) => {
        if (where.id !== undefined) return user.id === where.id;
        if (where.email !== undefined) return user.email === where.email;
        return false;
      });
      return found ? applySelect(found, select) : null;
    }),
    findFirst: vi.fn(async ({ where, select }: any) => {
      const found = users.find((user) => {
        if (where.email !== undefined && user.email !== where.email) return false;
        if (where.id?.not !== undefined && user.id === where.id.not) return false;
        return true;
      });
      return found ? applySelect(found, select) : null;
    }),
    update: vi.fn(async ({ where, data, select }: any) => {
      const found = users.find((user) => user.id === where.id);
      if (!found) {
        throw new Error(`Pengguna ${where.id} tidak ditemukan`);
      }
      Object.assign(found, data);
      return applySelect(found, select);
    }),
  };

  const mockPrisma = {
    pengguna: penggunaDelegate,
    passwordResetToken: passwordResetTokenDelegate,
    $transaction: vi.fn(async (callback: (tx: any) => Promise<any>) =>
      callback({
        pengguna: penggunaDelegate,
        passwordResetToken: passwordResetTokenDelegate,
      })
    ),
  };

  const mockSendPasswordResetEmail = vi.fn(async (params: any) => ({
    delivered: true,
    mode: 'console' as const,
    to: params.to,
    subject: 'Reset Password Akun Admin SOJU FnB',
    actionUrl: `http://localhost:3000/reset-password?token=${params.token}`,
  }));

  const resetStore = () => {
    users.length = 0;
    tokens.length = 0;
    nextTokenId = 1;
  };

  return { users, tokens, resetStore, mockPrisma, mockSendPasswordResetEmail };
});

vi.mock('../src/utils/database', () => ({
  default: mockPrisma,
}));

vi.mock('../src/services/emailService', () => ({
  sendPasswordResetEmail: mockSendPasswordResetEmail,
}));

import authRoutes from '../src/routes/auth';
import {
  GENERIC_FORGOT_PASSWORD_MESSAGE,
  RESET_PASSWORD_SUCCESS_MESSAGE,
} from '../src/services/authService';
import { hashToken, issueToken } from '../src/services/tokenService';

const createTestApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/auth', authRoutes);
  app.use(
    (
      err: any,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction
    ) => {
      res.status(err.status || 500).json({
        success: false,
        message: err.message || 'Internal server error',
      });
    }
  );
  return app;
};

describe('TASK-006: Admin Auth Extensions (aktif Enforcement, Forgot/Reset Password)', () => {
  const originalJwtSecret = process.env.JWT_SECRET;
  const app = createTestApp();

  beforeEach(async () => {
    vi.clearAllMocks();
    resetStore();
    process.env.JWT_SECRET = 'test-admin-jwt-secret-key';

    const activePasswordHash = await bcrypt.hash('PasswordLama123!', 10);
    const disabledPasswordHash = await bcrypt.hash('DisabledPass123!', 10);

    users.push(
      {
        id: 1,
        nama: 'Admin Aktif',
        email: 'admin@soju.id',
        passwordHash: activePasswordHash,
        peran: 'ADMIN',
        aktif: true,
        terakhirMasukPada: null,
        dibuatPada: new Date('2026-11-01T00:00:00.000Z'),
      },
      {
        id: 2,
        nama: 'Admin Nonaktif',
        email: 'disabled@soju.id',
        passwordHash: disabledPasswordHash,
        peran: 'ADMIN',
        aktif: false,
        terakhirMasukPada: null,
        dibuatPada: new Date('2026-11-01T00:00:00.000Z'),
      }
    );
  });

  afterEach(() => {
    if (originalJwtSecret === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = originalJwtSecret;
    }
    vi.clearAllMocks();
  });

  describe('aktif enforcement & terakhirMasukPada tracking', () => {
    it('rejects login for disabled Pengguna (aktif = false) with HTTP 403', async () => {
      const res = await request(app).post('/api/v1/auth/login').send({
        email: 'disabled@soju.id',
        password: 'DisabledPass123!',
      });

      expect(res.status).toBe(403);
      expect(res.body).toEqual({
        success: false,
        message: expect.stringMatching(/dinonaktifkan/i),
      });
      expect(users[1].terakhirMasukPada).toBeNull();
    });

    it('rejects authenticated requests for disabled Pengguna (aktif = false) via authenticate middleware with HTTP 403', async () => {
      const token = jwt.sign(
        { id: 2, email: 'disabled@soju.id', type: 'admin' },
        process.env.JWT_SECRET!,
        { expiresIn: '1h' }
      );

      const res = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(403);
      expect(res.body).toEqual({
        success: false,
        message: expect.stringMatching(/dinonaktifkan/i),
      });
    });

    it('allows active admin login, updates Pengguna.terakhirMasukPada, and grants /me access', async () => {
      const beforeLogin = Date.now();
      const loginRes = await request(app).post('/api/v1/auth/login').send({
        email: 'ADMIN@SOJU.ID',
        password: 'PasswordLama123!',
      });
      const afterLogin = Date.now();

      expect(loginRes.status).toBe(200);
      expect(loginRes.body.success).toBe(true);
      expect(typeof loginRes.body.data.token).toBe('string');
      expect(loginRes.body.data.user).toMatchObject({
        id: 1,
        nama: 'Admin Aktif',
        email: 'admin@soju.id',
        peran: 'ADMIN',
        aktif: true,
      });

      expect(users[0].terakhirMasukPada).toBeInstanceOf(Date);
      const updatedMs = users[0].terakhirMasukPada!.getTime();
      expect(updatedMs).toBeGreaterThanOrEqual(beforeLogin);
      expect(updatedMs).toBeLessThanOrEqual(afterLogin);

      const meRes = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${loginRes.body.data.token}`);

      expect(meRes.status).toBe(200);
      expect(meRes.body.success).toBe(true);
      expect(meRes.body.data.email).toBe('admin@soju.id');
    });
  });

  describe('POST /api/v1/auth/forgot-password', () => {
    it('returns an identical generic Bahasa Indonesia 200 response for existing, disabled, and non-existent emails', async () => {
      const activeRes = await request(app)
        .post('/api/v1/auth/forgot-password')
        .send({ email: 'admin@soju.id' });

      const disabledRes = await request(app)
        .post('/api/v1/auth/forgot-password')
        .send({ email: 'disabled@soju.id' });

      const missingRes = await request(app)
        .post('/api/v1/auth/forgot-password')
        .send({ email: 'tidakada@soju.id' });

      expect(activeRes.status).toBe(200);
      expect(disabledRes.status).toBe(200);
      expect(missingRes.status).toBe(200);

      expect(activeRes.body).toEqual({
        success: true,
        data: null,
        message: GENERIC_FORGOT_PASSWORD_MESSAGE,
      });
      expect(disabledRes.body).toEqual(activeRes.body);
      expect(missingRes.body).toEqual(activeRes.body);

      // Only the active admin triggers token issuance and email dispatch
      expect(tokens).toHaveLength(1);
      expect(tokens[0].purpose).toBe('RESET_PASSWORD');
      expect(tokens[0].targetType).toBe('ADMIN');
      expect(tokens[0].penggunaId).toBe(1);
      expect(mockSendPasswordResetEmail).toHaveBeenCalledTimes(1);
      expect(mockSendPasswordResetEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'admin@soju.id',
          nama: 'Admin Aktif',
          targetType: 'ADMIN',
          token: expect.any(String),
        })
      );
    });
  });

  describe('POST /api/v1/auth/reset-password', () => {
    it('validates single-use RESET_PASSWORD (ADMIN) token, updates bcrypt passwordHash, consumes token, and rejects replay', async () => {
      const forgotRes = await request(app)
        .post('/api/v1/auth/forgot-password')
        .send({ email: 'admin@soju.id' });
      expect(forgotRes.status).toBe(200);

      const rawToken = mockSendPasswordResetEmail.mock.calls[0][0].token as string;
      expect(tokens[0].tokenHash).toBe(hashToken(rawToken));
      expect(tokens[0].usedAt).toBeNull();

      // Short password rejected without consuming token
      const shortPassRes = await request(app)
        .post('/api/v1/auth/reset-password')
        .send({ token: rawToken, passwordBaru: '1234567' });
      expect(shortPassRes.status).toBe(400);
      expect(tokens[0].usedAt).toBeNull();

      // Valid reset succeeds
      const resetRes = await request(app)
        .post('/api/v1/auth/reset-password')
        .send({ token: rawToken, passwordBaru: 'PasswordBaru123!' });
      expect(resetRes.status).toBe(200);
      expect(resetRes.body).toEqual({
        success: true,
        data: null,
        message: RESET_PASSWORD_SUCCESS_MESSAGE,
      });

      // Token is consumed and bcrypt hash updated
      expect(tokens[0].usedAt).toBeInstanceOf(Date);
      expect(await bcrypt.compare('PasswordBaru123!', users[0].passwordHash)).toBe(true);
      expect(await bcrypt.compare('PasswordLama123!', users[0].passwordHash)).toBe(false);

      // Login with new password succeeds
      const newLoginRes = await request(app).post('/api/v1/auth/login').send({
        email: 'admin@soju.id',
        password: 'PasswordBaru123!',
      });
      expect(newLoginRes.status).toBe(200);

      // Reusing the same token fails
      const replayRes = await request(app)
        .post('/api/v1/auth/reset-password')
        .send({ token: rawToken, passwordBaru: 'PasswordLain123!' });
      expect(replayRes.status).toBe(400);
      expect(replayRes.body.success).toBe(false);
    });

    it('rejects expired RESET_PASSWORD token', async () => {
      const issued = await issueToken(
        {
          purpose: 'RESET_PASSWORD',
          targetType: 'ADMIN',
          targetId: 1,
          now: new Date(Date.now() - 2 * 60 * 60 * 1000),
          ttlMinutes: 45,
        },
        mockPrisma as any
      );

      const res = await request(app)
        .post('/api/v1/auth/reset-password')
        .send({ token: issued.token, passwordBaru: 'PasswordBaru123!' });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        success: false,
        message: expect.stringMatching(/kedaluwarsa/i),
      });
    });

    it('rejects CUSTOMER token or non-RESET_PASSWORD token on admin reset endpoint', async () => {
      const customerToken = await issueToken(
        {
          purpose: 'RESET_PASSWORD',
          targetType: 'CUSTOMER',
          targetId: 99,
        },
        mockPrisma as any
      );

      const customerRes = await request(app)
        .post('/api/v1/auth/reset-password')
        .send({ token: customerToken.token, passwordBaru: 'PasswordBaru123!' });

      expect(customerRes.status).toBe(400);
      expect(customerRes.body.success).toBe(false);

      const verifyToken = await issueToken(
        {
          purpose: 'VERIFY_EMAIL',
          targetType: 'ADMIN',
          targetId: 1,
        },
        mockPrisma as any
      );

      const wrongPurposeRes = await request(app)
        .post('/api/v1/auth/reset-password')
        .send({ token: verifyToken.token, passwordBaru: 'PasswordBaru123!' });

      expect(wrongPurposeRes.status).toBe(400);
      expect(wrongPurposeRes.body.success).toBe(false);
    });
  });

  describe('Public admin registration closed', () => {
    it('does not expose POST /api/v1/auth/register', async () => {
      const res = await request(app).post('/api/v1/auth/register').send({
        nama: 'Hacker',
        email: 'hacker@soju.id',
        password: 'Password123!',
      });

      expect(res.status).toBe(404);
    });
  });
});
