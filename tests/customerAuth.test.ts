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

interface MockPelanggan {
  id: number;
  nama: string;
  email: string;
  noTelepon: string;
  alamat: string;
  passwordHash: string;
  keranjang: unknown;
  aktif: boolean;
  dibuatPada: Date;
  diubahPada: Date;
  emailTerverifikasiPada: Date | null;
  terakhirMasukPada: Date | null;
  promosiDiizinkan: boolean;
  promosiDisetujuiPada: Date | null;
  promosiBerhentiPada: Date | null;
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

const {
  admins,
  customers,
  tokens,
  resetStore,
  mockPrisma,
  mockSendPasswordResetEmail,
  mockSendVerificationEmail,
} = vi.hoisted(() => {
  const admins: MockPengguna[] = [];
  const customers: MockPelanggan[] = [];
  const tokens: PasswordResetToken[] = [];
  let nextTokenId = 1;
  let nextCustomerId = 100;

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
      const found = admins.find((user) => {
        if (where.id !== undefined) return user.id === where.id;
        if (where.email !== undefined) return user.email === where.email;
        return false;
      });
      return found ? applySelect(found, select) : null;
    }),
    update: vi.fn(async ({ where, data, select }: any) => {
      const found = admins.find((user) => user.id === where.id);
      if (!found) {
        throw new Error(`Pengguna ${where.id} tidak ditemukan`);
      }
      Object.assign(found, data);
      return applySelect(found, select);
    }),
  };

  const pelangganDelegate = {
    findUnique: vi.fn(async ({ where, select }: any) => {
      const found = customers.find((customer) => {
        if (where.id !== undefined) return customer.id === where.id;
        if (where.email !== undefined) return customer.email === where.email;
        return false;
      });
      return found ? applySelect(found, select) : null;
    }),
    findFirst: vi.fn(async ({ where, select }: any) => {
      const found = customers.find((customer) => {
        if (where.email !== undefined && customer.email !== where.email) return false;
        if (where.id?.not !== undefined && customer.id === where.id.not) return false;
        return true;
      });
      return found ? applySelect(found, select) : null;
    }),
    create: vi.fn(async ({ data, select }: any) => {
      const now = new Date();
      const created: MockPelanggan = {
        id: nextCustomerId++,
        nama: data.nama,
        email: data.email,
        noTelepon: data.noTelepon,
        alamat: data.alamat,
        passwordHash: data.passwordHash,
        keranjang: data.keranjang ?? [],
        aktif: data.aktif ?? true,
        dibuatPada: now,
        diubahPada: now,
        emailTerverifikasiPada: data.emailTerverifikasiPada ?? null,
        terakhirMasukPada: data.terakhirMasukPada ?? null,
        promosiDiizinkan: data.promosiDiizinkan ?? false,
        promosiDisetujuiPada: data.promosiDisetujuiPada ?? null,
        promosiBerhentiPada: data.promosiBerhentiPada ?? null,
      };
      customers.push(created);
      return applySelect(created, select);
    }),
    update: vi.fn(async ({ where, data, select }: any) => {
      const found = customers.find((customer) => customer.id === where.id);
      if (!found) {
        throw new Error(`Pelanggan ${where.id} tidak ditemukan`);
      }
      Object.assign(found, data, { diubahPada: new Date() });
      return applySelect(found, select);
    }),
  };

  const mockPrisma = {
    pengguna: penggunaDelegate,
    pelanggan: pelangganDelegate,
    passwordResetToken: passwordResetTokenDelegate,
    $transaction: vi.fn(async (callback: (tx: any) => Promise<any>) =>
      callback({
        pengguna: penggunaDelegate,
        pelanggan: pelangganDelegate,
        passwordResetToken: passwordResetTokenDelegate,
      })
    ),
  };

  const mockSendPasswordResetEmail = vi.fn(async (params: any) => ({
    delivered: true,
    mode: 'console' as const,
    to: params.to,
    subject:
      params.targetType === 'ADMIN'
        ? 'Reset Password Akun Admin SOJU FnB'
        : 'Reset Password Akun Pelanggan SOJU FnB',
    actionUrl: `http://localhost:3000/customer/reset-password?token=${params.token}`,
  }));

  const mockSendVerificationEmail = vi.fn(async (params: any) => ({
    delivered: true,
    mode: 'console' as const,
    to: params.to,
    subject: 'Verifikasi Email Akun SOJU FnB',
    actionUrl: `http://localhost:3000/customer/verifikasi-email?token=${params.token}`,
  }));

  const resetStore = () => {
    admins.length = 0;
    customers.length = 0;
    tokens.length = 0;
    nextTokenId = 1;
    nextCustomerId = 100;
  };

  return {
    admins,
    customers,
    tokens,
    resetStore,
    mockPrisma,
    mockSendPasswordResetEmail,
    mockSendVerificationEmail,
  };
});

vi.mock('../src/utils/database', () => ({
  default: mockPrisma,
}));

vi.mock('../src/services/emailService', () => ({
  sendPasswordResetEmail: mockSendPasswordResetEmail,
  sendVerificationEmail: mockSendVerificationEmail,
}));

import authRoutes from '../src/routes/auth';
import customerRoutes from '../src/routes/customer';
import {
  CUSTOMER_CHANGE_PASSWORD_SUCCESS_MESSAGE,
  CUSTOMER_RESET_PASSWORD_SUCCESS_MESSAGE,
  CUSTOMER_VERIFY_EMAIL_SUCCESS_MESSAGE,
  GENERIC_CUSTOMER_FORGOT_PASSWORD_MESSAGE,
  GENERIC_RESEND_VERIFICATION_MESSAGE,
} from '../src/services/customerAuthService';
import { hashToken, issueToken } from '../src/services/tokenService';

const createTestApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/auth', authRoutes);
  app.use('/api/customer', customerRoutes);
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

describe('TASK-007: Customer Auth Extensions (Verification, Forgot/Reset, Change Password, Cross-Target Isolation)', () => {
  const originalJwtSecret = process.env.JWT_SECRET;
  const app = createTestApp();

  beforeEach(async () => {
    vi.clearAllMocks();
    resetStore();
    process.env.JWT_SECRET = 'test-customer-auth-jwt-secret';

    const adminHash = await bcrypt.hash('AdminPass123!', 10);
    const customerHash = await bcrypt.hash('CustomerPass123!', 10);

    admins.push({
      id: 1,
      nama: 'Admin Utama',
      email: 'admin@soju.id',
      passwordHash: adminHash,
      peran: 'ADMIN',
      aktif: true,
      terakhirMasukPada: null,
      dibuatPada: new Date('2026-11-01T00:00:00.000Z'),
    });

    customers.push(
      {
        id: 10,
        nama: 'Budi Belum Verifikasi',
        email: 'budi@example.com',
        noTelepon: '081234567890',
        alamat: 'Jl. Melati No. 1',
        passwordHash: customerHash,
        keranjang: [],
        aktif: true,
        dibuatPada: new Date('2026-11-01T00:00:00.000Z'),
        diubahPada: new Date('2026-11-01T00:00:00.000Z'),
        emailTerverifikasiPada: null,
        terakhirMasukPada: null,
        promosiDiizinkan: false,
        promosiDisetujuiPada: null,
        promosiBerhentiPada: null,
      },
      {
        id: 11,
        nama: 'Siti Sudah Verifikasi',
        email: 'siti@example.com',
        noTelepon: '081298765432',
        alamat: 'Jl. Kenanga No. 2',
        passwordHash: customerHash,
        keranjang: [],
        aktif: true,
        dibuatPada: new Date('2026-11-01T00:00:00.000Z'),
        diubahPada: new Date('2026-11-01T00:00:00.000Z'),
        emailTerverifikasiPada: new Date('2026-11-02T00:00:00.000Z'),
        terakhirMasukPada: null,
        promosiDiizinkan: true,
        promosiDisetujuiPada: new Date('2026-11-01T00:00:00.000Z'),
        promosiBerhentiPada: null,
      },
      {
        id: 12,
        nama: 'Nonaktif Customer',
        email: 'nonaktif@example.com',
        noTelepon: '081200000000',
        alamat: 'Jl. Mawar No. 3',
        passwordHash: customerHash,
        keranjang: [],
        aktif: false,
        dibuatPada: new Date('2026-11-01T00:00:00.000Z'),
        diubahPada: new Date('2026-11-01T00:00:00.000Z'),
        emailTerverifikasiPada: null,
        terakhirMasukPada: null,
        promosiDiizinkan: false,
        promosiDisetujuiPada: null,
        promosiBerhentiPada: null,
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

  describe('Registration & Email Verification (daftar, verifikasi-email, kirim-ulang-verifikasi)', () => {
    it('POST /api/customer/auth/daftar issues VERIFY_EMAIL token, sends verification email, and exposes emailTerverifikasiPada', async () => {
      const res = await request(app).post('/api/customer/auth/daftar').send({
        nama: 'Rina Pelanggan',
        email: 'Rina@Example.com',
        noTelepon: '081233334444',
        alamat: 'Jl. Anggrek No. 5',
        password: 'PasswordAman123!',
        promosiDiizinkan: true,
      });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(typeof res.body.data.token).toBe('string');
      expect(res.body.data.customer).toMatchObject({
        nama: 'Rina Pelanggan',
        email: 'rina@example.com',
        emailTerverifikasiPada: null,
        promosiDiizinkan: true,
      });

      expect(tokens).toHaveLength(1);
      expect(tokens[0].purpose).toBe('VERIFY_EMAIL');
      expect(tokens[0].targetType).toBe('CUSTOMER');
      expect(tokens[0].pelangganId).toBe(res.body.data.customer.id);

      expect(mockSendVerificationEmail).toHaveBeenCalledTimes(1);
      const rawToken = mockSendVerificationEmail.mock.calls[0][0].token as string;
      expect(tokens[0].tokenHash).toBe(hashToken(rawToken));
      expect(mockSendVerificationEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'rina@example.com',
          nama: 'Rina Pelanggan',
          token: rawToken,
        })
      );

      // Verify email using issued token
      const verifyRes = await request(app)
        .post('/api/customer/auth/verifikasi-email')
        .send({ token: rawToken });

      expect(verifyRes.status).toBe(200);
      expect(verifyRes.body.success).toBe(true);
      expect(verifyRes.body.message).toBe(CUSTOMER_VERIFY_EMAIL_SUCCESS_MESSAGE);
      expect(verifyRes.body.data.emailTerverifikasiPada).toBeTruthy();

      const createdCustomer = customers.find((c) => c.email === 'rina@example.com');
      expect(createdCustomer?.emailTerverifikasiPada).toBeInstanceOf(Date);
      expect(tokens[0].usedAt).toBeInstanceOf(Date);

      // Replaying the same verification token fails
      const replayRes = await request(app)
        .post('/api/customer/auth/verifikasi-email')
        .send({ token: rawToken });

      expect(replayRes.status).toBe(400);
      expect(replayRes.body.success).toBe(false);
    });

    it('POST /api/customer/auth/verifikasi-email rejects expired or wrong-purpose tokens', async () => {
      const expired = await issueToken(
        {
          purpose: 'VERIFY_EMAIL',
          targetType: 'CUSTOMER',
          targetId: 10,
          now: new Date(Date.now() - 2 * 60 * 60 * 1000),
          ttlMinutes: 45,
        },
        mockPrisma as any
      );

      const expiredRes = await request(app)
        .post('/api/customer/auth/verifikasi-email')
        .send({ token: expired.token });

      expect(expiredRes.status).toBe(400);
      expect(expiredRes.body.message).toMatch(/kedaluwarsa/i);

      const resetTok = await issueToken(
        {
          purpose: 'RESET_PASSWORD',
          targetType: 'CUSTOMER',
          targetId: 10,
        },
        mockPrisma as any
      );

      const wrongPurposeRes = await request(app)
        .post('/api/customer/auth/verifikasi-email')
        .send({ token: resetTok.token });

      expect(wrongPurposeRes.status).toBe(400);
      expect(wrongPurposeRes.body.success).toBe(false);
    });

    it('POST /api/customer/auth/kirim-ulang-verifikasi returns identical generic Bahasa Indonesia response and invalidates older unused token', async () => {
      const firstIssue = await issueToken(
        {
          purpose: 'VERIFY_EMAIL',
          targetType: 'CUSTOMER',
          targetId: 10,
        },
        mockPrisma as any
      );

      const unverifiedRes = await request(app)
        .post('/api/customer/auth/kirim-ulang-verifikasi')
        .send({ email: 'budi@example.com' });

      const alreadyVerifiedRes = await request(app)
        .post('/api/customer/auth/kirim-ulang-verifikasi')
        .send({ email: 'siti@example.com' });

      const inactiveRes = await request(app)
        .post('/api/customer/auth/kirim-ulang-verifikasi')
        .send({ email: 'nonaktif@example.com' });

      const missingRes = await request(app)
        .post('/api/customer/auth/kirim-ulang-verifikasi')
        .send({ email: 'tidakada@example.com' });

      expect(unverifiedRes.status).toBe(200);
      expect(alreadyVerifiedRes.status).toBe(200);
      expect(inactiveRes.status).toBe(200);
      expect(missingRes.status).toBe(200);

      expect(unverifiedRes.body).toEqual({
        success: true,
        data: null,
        message: GENERIC_RESEND_VERIFICATION_MESSAGE,
      });
      expect(alreadyVerifiedRes.body).toEqual(unverifiedRes.body);
      expect(inactiveRes.body).toEqual(unverifiedRes.body);
      expect(missingRes.body).toEqual(unverifiedRes.body);

      // Only the active unverified customer triggered email dispatch
      expect(mockSendVerificationEmail).toHaveBeenCalledTimes(1);
      const newToken = mockSendVerificationEmail.mock.calls[0][0].token as string;
      expect(newToken).not.toBe(firstIssue.token);

      // Older token was invalidated
      const oldTokenRes = await request(app)
        .post('/api/customer/auth/verifikasi-email')
        .send({ token: firstIssue.token });
      expect(oldTokenRes.status).toBe(400);

      // Newly issued token succeeds
      const newTokenRes = await request(app)
        .post('/api/customer/auth/verifikasi-email')
        .send({ token: newToken });
      expect(newTokenRes.status).toBe(200);
      expect(customers[0].emailTerverifikasiPada).toBeInstanceOf(Date);
    });
  });

  describe('Forgot & Reset Password (lupa-password, reset-password)', () => {
    it('POST /api/customer/auth/lupa-password returns identical generic Bahasa Indonesia 200 response for active, inactive, and non-existent emails', async () => {
      const activeRes = await request(app)
        .post('/api/customer/auth/lupa-password')
        .send({ email: 'budi@example.com' });

      const inactiveRes = await request(app)
        .post('/api/customer/auth/lupa-password')
        .send({ email: 'nonaktif@example.com' });

      const missingRes = await request(app)
        .post('/api/customer/auth/lupa-password')
        .send({ email: 'belumdaftar@example.com' });

      expect(activeRes.status).toBe(200);
      expect(inactiveRes.status).toBe(200);
      expect(missingRes.status).toBe(200);

      expect(activeRes.body).toEqual({
        success: true,
        data: null,
        message: GENERIC_CUSTOMER_FORGOT_PASSWORD_MESSAGE,
      });
      expect(inactiveRes.body).toEqual(activeRes.body);
      expect(missingRes.body).toEqual(activeRes.body);

      expect(tokens).toHaveLength(1);
      expect(tokens[0].purpose).toBe('RESET_PASSWORD');
      expect(tokens[0].targetType).toBe('CUSTOMER');
      expect(tokens[0].pelangganId).toBe(10);

      expect(mockSendPasswordResetEmail).toHaveBeenCalledTimes(1);
      expect(mockSendPasswordResetEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'budi@example.com',
          nama: 'Budi Belum Verifikasi',
          targetType: 'CUSTOMER',
          token: expect.any(String),
        })
      );
    });

    it('POST /api/customer/auth/reset-password consumes RESET_PASSWORD (CUSTOMER) token, updates password, and rejects replay', async () => {
      await request(app)
        .post('/api/customer/auth/lupa-password')
        .send({ email: 'budi@example.com' });

      const rawToken = mockSendPasswordResetEmail.mock.calls[0][0].token as string;

      // Short password rejected without consuming token
      const shortPassRes = await request(app)
        .post('/api/customer/auth/reset-password')
        .send({ token: rawToken, passwordBaru: '1234567' });
      expect(shortPassRes.status).toBe(400);
      expect(tokens[0].usedAt).toBeNull();

      // Valid reset succeeds
      const resetRes = await request(app)
        .post('/api/customer/auth/reset-password')
        .send({ token: rawToken, passwordBaru: 'CustomerBaru123!' });

      expect(resetRes.status).toBe(200);
      expect(resetRes.body).toEqual({
        success: true,
        data: null,
        message: CUSTOMER_RESET_PASSWORD_SUCCESS_MESSAGE,
      });
      expect(tokens[0].usedAt).toBeInstanceOf(Date);
      expect(await bcrypt.compare('CustomerBaru123!', customers[0].passwordHash)).toBe(true);

      // Login with new password succeeds
      const loginRes = await request(app)
        .post('/api/customer/auth/masuk')
        .send({ email: 'budi@example.com', password: 'CustomerBaru123!' });
      expect(loginRes.status).toBe(200);
      expect(loginRes.body.data.customer).toHaveProperty('emailTerverifikasiPada', null);

      // Replaying token fails
      const replayRes = await request(app)
        .post('/api/customer/auth/reset-password')
        .send({ token: rawToken, passwordBaru: 'CustomerLain123!' });
      expect(replayRes.status).toBe(400);
      expect(replayRes.body.success).toBe(false);
    });
  });

  describe('Authenticated Change Password (POST /api/customer/ubah-password)', () => {
    it('requires authenticateCustomer JWT, verifies current password, and updates passwordHash', async () => {
      // Unauthenticated request rejected with 401
      const noAuthRes = await request(app)
        .post('/api/customer/ubah-password')
        .send({ passwordLama: 'CustomerPass123!', passwordBaru: 'PasswordBaru99!' });
      expect(noAuthRes.status).toBe(401);

      // Login as customer
      const loginRes = await request(app)
        .post('/api/customer/auth/masuk')
        .send({ email: 'budi@example.com', password: 'CustomerPass123!' });
      const customerJwt = loginRes.body.data.token as string;

      // Wrong current password rejected with 401
      const wrongPassRes = await request(app)
        .post('/api/customer/ubah-password')
        .set('Authorization', `Bearer ${customerJwt}`)
        .send({ passwordLama: 'SalahPassword123!', passwordBaru: 'PasswordBaru99!' });
      expect(wrongPassRes.status).toBe(401);
      expect(wrongPassRes.body.message).toMatch(/password lama tidak sesuai/i);

      // Short new password rejected with 400
      const shortNewRes = await request(app)
        .post('/api/customer/ubah-password')
        .set('Authorization', `Bearer ${customerJwt}`)
        .send({ passwordLama: 'CustomerPass123!', passwordBaru: 'short' });
      expect(shortNewRes.status).toBe(400);

      // Valid password change succeeds
      const okRes = await request(app)
        .post('/api/customer/ubah-password')
        .set('Authorization', `Bearer ${customerJwt}`)
        .send({ passwordLama: 'CustomerPass123!', passwordBaru: 'PasswordBaru99!' });

      expect(okRes.status).toBe(200);
      expect(okRes.body).toEqual({
        success: true,
        data: null,
        message: CUSTOMER_CHANGE_PASSWORD_SUCCESS_MESSAGE,
      });
      expect(await bcrypt.compare('PasswordBaru99!', customers[0].passwordHash)).toBe(true);

      // Login with new password works; old password fails
      const newLoginRes = await request(app)
        .post('/api/customer/auth/masuk')
        .send({ email: 'budi@example.com', password: 'PasswordBaru99!' });
      expect(newLoginRes.status).toBe(200);

      const oldLoginRes = await request(app)
        .post('/api/customer/auth/masuk')
        .send({ email: 'budi@example.com', password: 'CustomerPass123!' });
      expect(oldLoginRes.status).toBe(401);
    });
  });

  describe('Cross-target Token & JWT Isolation (Customer vs Admin)', () => {
    it('prevents CUSTOMER reset tokens from resetting ADMIN passwords and ADMIN reset tokens from resetting CUSTOMER passwords', async () => {
      const customerResetToken = await issueToken(
        {
          purpose: 'RESET_PASSWORD',
          targetType: 'CUSTOMER',
          targetId: 10,
        },
        mockPrisma as any
      );

      const adminEndpointRes = await request(app)
        .post('/api/v1/auth/reset-password')
        .send({ token: customerResetToken.token, passwordBaru: 'HackAdmin123!' });
      expect(adminEndpointRes.status).toBe(400);
      expect(adminEndpointRes.body.success).toBe(false);
      expect(await bcrypt.compare('AdminPass123!', admins[0].passwordHash)).toBe(true);

      const adminResetToken = await issueToken(
        {
          purpose: 'RESET_PASSWORD',
          targetType: 'ADMIN',
          targetId: 1,
        },
        mockPrisma as any
      );

      const customerEndpointRes = await request(app)
        .post('/api/customer/auth/reset-password')
        .send({ token: adminResetToken.token, passwordBaru: 'HackCustomer123!' });
      expect(customerEndpointRes.status).toBe(400);
      expect(customerEndpointRes.body.success).toBe(false);
      expect(await bcrypt.compare('CustomerPass123!', customers[0].passwordHash)).toBe(true);

      // Admin VERIFY_EMAIL token cannot verify a customer email
      const adminVerifyToken = await issueToken(
        {
          purpose: 'VERIFY_EMAIL',
          targetType: 'ADMIN',
          targetId: 1,
        },
        mockPrisma as any
      );

      const crossVerifyRes = await request(app)
        .post('/api/customer/auth/verifikasi-email')
        .send({ token: adminVerifyToken.token });
      expect(crossVerifyRes.status).toBe(400);
      expect(crossVerifyRes.body.success).toBe(false);
    });

    it('prevents customer JWT from accessing admin auth endpoints and admin JWT from accessing customer endpoints', async () => {
      const customerJwt = jwt.sign(
        { id: 10, email: 'budi@example.com', type: 'customer' },
        process.env.JWT_SECRET!,
        { expiresIn: '1h' }
      );

      const adminJwt = jwt.sign(
        { id: 1, email: 'admin@soju.id', type: 'admin' },
        process.env.JWT_SECRET!,
        { expiresIn: '1h' }
      );

      // Customer JWT rejected on admin endpoints
      const customerOnAdminMe = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${customerJwt}`);
      expect(customerOnAdminMe.status).toBe(401);

      const customerOnAdminChangePass = await request(app)
        .post('/api/v1/auth/change-password')
        .set('Authorization', `Bearer ${customerJwt}`)
        .send({ passwordLama: 'CustomerPass123!', passwordBaru: 'NewPassword123!' });
      expect(customerOnAdminChangePass.status).toBe(401);

      // Admin JWT rejected on customer endpoints
      const adminOnCustomerChangePass = await request(app)
        .post('/api/customer/ubah-password')
        .set('Authorization', `Bearer ${adminJwt}`)
        .send({ passwordLama: 'AdminPass123!', passwordBaru: 'NewPassword123!' });
      expect(adminOnCustomerChangePass.status).toBe(401);

      const adminOnCustomerProfile = await request(app)
        .get('/api/customer/profil')
        .set('Authorization', `Bearer ${adminJwt}`);
      expect(adminOnCustomerProfile.status).toBe(401);
    });
  });
});
