import bcrypt from 'bcrypt';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import type {
  AksiLog,
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
  dibuatOleh: number | null;
  dibuatPada: Date;
  diubahPada: Date;
}

interface MockPelanggan {
  id: number;
  nama: string;
  email: string;
  telepon: string | null;
  alamat: string | null;
  passwordHash: string;
  aktif: boolean;
  promosiDiizinkan: boolean;
  emailTerverifikasiPada: Date | null;
  dibuatPada: Date;
}

interface MockAuditLog {
  id: number;
  penggunaId: number;
  tabelTarget: string;
  targetId: number | null;
  aksi: AksiLog;
  sumber: string;
  command: string | null;
  labelRecord: string;
  detail: string | null;
  dataSebelum: string | null;
  dataSesudah: string | null;
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

const {
  users,
  customers,
  tokens,
  auditLogs,
  resetStore,
  mockPrisma,
  mockSendPasswordResetEmail,
  mockSendAdminInviteEmail,
  mockSendVerificationEmail,
} = vi.hoisted(() => {
  const users: MockPengguna[] = [];
  const customers: MockPelanggan[] = [];
  const tokens: PasswordResetToken[] = [];
  const auditLogs: MockAuditLog[] = [];
  let nextTokenId = 1;
  let nextAuditId = 1;

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

  const matchesPenggunaWhere = (user: MockPengguna, where: any = {}): boolean => {
    if (where.id !== undefined) {
      if (typeof where.id === 'number' && user.id !== where.id) return false;
      if (where.id?.not !== undefined && user.id === where.id.not) return false;
    }
    if (where.email !== undefined && user.email !== where.email) return false;
    if (where.peran !== undefined && user.peran !== where.peran) return false;
    if (where.aktif !== undefined && user.aktif !== where.aktif) return false;
    return true;
  };

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

  const penggunaDelegate = {
    findUnique: vi.fn(async ({ where, select }: any) => {
      const found = users.find((u) => {
        if (where.id !== undefined) return u.id === where.id;
        if (where.email !== undefined) return u.email === where.email;
        return false;
      });
      return found ? applySelect(found, select) : null;
    }),
    findFirst: vi.fn(async ({ where, select }: any) => {
      const found = users.find((u) => matchesPenggunaWhere(u, where));
      return found ? applySelect(found, select) : null;
    }),
    count: vi.fn(async ({ where }: any = {}) =>
      users.filter((u) => matchesPenggunaWhere(u, where)).length
    ),
    update: vi.fn(async ({ where, data, select }: any) => {
      const found = users.find((u) => u.id === where.id);
      if (!found) throw new Error('Pengguna tidak ditemukan');
      Object.assign(found, data, { diubahPada: new Date() });
      return applySelect(found, select);
    }),
  };

  const pelangganDelegate = {
    findUnique: vi.fn(async ({ where, select }: any) => {
      const found = customers.find((c) => {
        if (where.id !== undefined) return c.id === where.id;
        if (where.email !== undefined) return c.email === where.email;
        return false;
      });
      return found ? applySelect(found, select) : null;
    }),
    update: vi.fn(async ({ where, data, select }: any) => {
      const found = customers.find((c) => c.id === where.id);
      if (!found) throw new Error('Pelanggan tidak ditemukan');
      Object.assign(found, data);
      return applySelect(found, select);
    }),
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

  const logAuditDelegate = {
    create: vi.fn(async ({ data }: any) => {
      const entry: MockAuditLog = {
        id: nextAuditId++,
        penggunaId: data.penggunaId,
        tabelTarget: data.tabelTarget,
        targetId: data.targetId ?? null,
        aksi: data.aksi,
        sumber: data.sumber,
        command: data.command ?? null,
        labelRecord: data.labelRecord,
        detail: data.detail ?? null,
        dataSebelum: data.dataSebelum ?? null,
        dataSesudah: data.dataSesudah ?? null,
        dibuatPada: new Date(),
      };
      auditLogs.push(entry);
      return { ...entry };
    }),
  };

  const mockPrisma = {
    pengguna: penggunaDelegate,
    pelanggan: pelangganDelegate,
    passwordResetToken: passwordResetTokenDelegate,
    logAudit: logAuditDelegate,
    $transaction: vi.fn(async (callback: (tx: any) => Promise<any>) =>
      callback({
        pengguna: penggunaDelegate,
        pelanggan: pelangganDelegate,
        passwordResetToken: passwordResetTokenDelegate,
        logAudit: logAuditDelegate,
      })
    ),
  };

  const mockSendPasswordResetEmail = vi.fn(async () => ({
    mode: 'console' as const,
    id: 'mock-reset-email',
  }));
  const mockSendAdminInviteEmail = vi.fn(async () => ({
    mode: 'console' as const,
    id: 'mock-invite-email',
  }));
  const mockSendVerificationEmail = vi.fn(async () => ({
    mode: 'console' as const,
    id: 'mock-verify-email',
  }));

  const resetStore = () => {
    users.length = 0;
    customers.length = 0;
    tokens.length = 0;
    auditLogs.length = 0;
    nextTokenId = 1;
    nextAuditId = 1;
    vi.clearAllMocks();
  };

  return {
    users,
    customers,
    tokens,
    auditLogs,
    resetStore,
    mockPrisma,
    mockSendPasswordResetEmail,
    mockSendAdminInviteEmail,
    mockSendVerificationEmail,
  };
});

vi.mock('../src/utils/database', () => ({
  default: mockPrisma,
}));

vi.mock('../src/services/emailService', () => ({
  sendPasswordResetEmail: mockSendPasswordResetEmail,
  sendAdminInviteEmail: mockSendAdminInviteEmail,
  sendVerificationEmail: mockSendVerificationEmail,
}));

import { app } from '../src/index';
import {
  UserServiceError,
  softDisableUser,
  updateUser,
  updateUserStatus,
} from '../src/services/userService';

const TEST_JWT_SECRET = 'test-users-protection-jwt-secret';

const signAdminToken = (user: MockPengguna) =>
  jwt.sign({ id: user.id, email: user.email, role: user.peran }, TEST_JWT_SECRET, {
    expiresIn: '1h',
  });

const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

describe('Multi-User Protection & Reset Token Security Integration (TASK-009)', () => {
  const originalJwtSecret = process.env.JWT_SECRET;
  let primarySuperAdmin: MockPengguna;
  let secondarySuperAdmin: MockPengguna;
  let customer: MockPelanggan;

  beforeEach(async () => {
    process.env.JWT_SECRET = TEST_JWT_SECRET;
    resetStore();

    const passwordHash = await bcrypt.hash('OldPassword123!', 4);
    const now = new Date('2026-01-10T08:00:00Z');

    primarySuperAdmin = {
      id: 1,
      nama: 'Super Admin Pertama',
      email: 'super1@soju.test',
      passwordHash,
      peran: 'SUPER_ADMIN',
      aktif: true,
      terakhirMasukPada: null,
      dibuatOleh: null,
      dibuatPada: now,
      diubahPada: now,
    };

    secondarySuperAdmin = {
      id: 2,
      nama: 'Super Admin Kedua',
      email: 'super2@soju.test',
      passwordHash,
      peran: 'SUPER_ADMIN',
      aktif: true,
      terakhirMasukPada: null,
      dibuatOleh: 1,
      dibuatPada: now,
      diubahPada: now,
    };

    customer = {
      id: 201,
      nama: 'Customer Uji',
      email: 'pelanggan@soju.test',
      telepon: '081234567890',
      alamat: 'Jl. Uji Reset No. 2',
      passwordHash,
      aktif: true,
      promosiDiizinkan: true,
      emailTerverifikasiPada: now,
      dibuatPada: now,
    };

    users.push(primarySuperAdmin, secondarySuperAdmin);
    customers.push(customer);
  });

  afterEach(() => {
    if (originalJwtSecret === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = originalJwtSecret;
    }
    vi.clearAllMocks();
  });

  describe('Self-deactivation and self-role-change rejection (403)', () => {
    it('rejects self-deactivation via PATCH /api/v1/users/:id/status with 403', async () => {
      const res = await request(app)
        .patch(`/api/v1/users/${primarySuperAdmin.id}/status`)
        .set('Authorization', `Bearer ${signAdminToken(primarySuperAdmin)}`)
        .send({ aktif: false });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(primarySuperAdmin.aktif).toBe(true);
      expect(mockPrisma.pengguna.update).not.toHaveBeenCalled();
      expect(mockPrisma.logAudit.create).not.toHaveBeenCalled();
      expect(auditLogs).toHaveLength(0);
    });

    it('rejects self-deactivation via DELETE /api/v1/users/:id with 403', async () => {
      const res = await request(app)
        .delete(`/api/v1/users/${primarySuperAdmin.id}`)
        .set('Authorization', `Bearer ${signAdminToken(primarySuperAdmin)}`);

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(primarySuperAdmin.aktif).toBe(true);
      expect(mockPrisma.pengguna.update).not.toHaveBeenCalled();
      expect(mockPrisma.logAudit.create).not.toHaveBeenCalled();
      expect(auditLogs).toHaveLength(0);
    });

    it('rejects self-role-change via PATCH /api/v1/users/:id with 403', async () => {
      const res = await request(app)
        .patch(`/api/v1/users/${primarySuperAdmin.id}`)
        .set('Authorization', `Bearer ${signAdminToken(primarySuperAdmin)}`)
        .send({ peran: 'ADMIN' });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(primarySuperAdmin.peran).toBe('SUPER_ADMIN');
      expect(mockPrisma.pengguna.update).not.toHaveBeenCalled();
      expect(mockPrisma.logAudit.create).not.toHaveBeenCalled();
      expect(auditLogs).toHaveLength(0);
    });
  });

  describe('Last active SUPER_ADMIN protection (409)', () => {
    it('allows deactivating a second SUPER_ADMIN when two are active, then blocks deactivating or demoting the last remaining active SUPER_ADMIN (409)', async () => {
      // Step 1: With 2 active SUPER_ADMINs, primary can soft-disable secondary via HTTP
      const disableSecondRes = await request(app)
        .delete(`/api/v1/users/${secondarySuperAdmin.id}`)
        .set('Authorization', `Bearer ${signAdminToken(primarySuperAdmin)}`);

      expect(disableSecondRes.status).toBe(200);
      expect(secondarySuperAdmin.aktif).toBe(false);

      // Step 2: Now primarySuperAdmin is the last active SUPER_ADMIN.
      // Any attempt to deactivate or demote the last active SUPER_ADMIN must fail with 409.
      await expect(
        updateUserStatus({
          actorId: 999,
          targetId: primarySuperAdmin.id,
          aktif: false,
        })
      ).rejects.toMatchObject({
        name: 'UserServiceError',
        status: 409,
      } satisfies Partial<UserServiceError>);

      await expect(
        softDisableUser({
          actorId: 999,
          targetId: primarySuperAdmin.id,
        })
      ).rejects.toMatchObject({
        name: 'UserServiceError',
        status: 409,
      } satisfies Partial<UserServiceError>);

      await expect(
        updateUser({
          actorId: 999,
          targetId: primarySuperAdmin.id,
          peran: 'ADMIN',
        })
      ).rejects.toMatchObject({
        name: 'UserServiceError',
        status: 409,
      } satisfies Partial<UserServiceError>);

      expect(primarySuperAdmin.aktif).toBe(true);
      expect(primarySuperAdmin.peran).toBe('SUPER_ADMIN');
    });
  });

  describe('Single-use and expired reset token failure (Admin & Customer)', () => {
    it('enforces single-use admin reset token and rejects expired admin reset token', async () => {
      // Issue reset token via forgot-password endpoint
      const forgotRes = await request(app)
        .post('/api/v1/auth/forgot-password')
        .send({ email: primarySuperAdmin.email });
      expect(forgotRes.status).toBe(200);
      expect(mockSendPasswordResetEmail).toHaveBeenCalledTimes(1);

      const firstCallArg = (mockSendPasswordResetEmail.mock.calls[0] as unknown as Array<{ token: string }>)[0];
      const rawToken = firstCallArg.token;

      // First consumption succeeds
      const firstReset = await request(app)
        .post('/api/v1/auth/reset-password')
        .send({ token: rawToken, password: 'NewAdminPassword123!' });
      expect(firstReset.status).toBe(200);
      expect(firstReset.body.success).toBe(true);
      expect(await bcrypt.compare('NewAdminPassword123!', primarySuperAdmin.passwordHash)).toBe(true);

      // Replay of the exact same token fails (single-use)
      const replayReset = await request(app)
        .post('/api/v1/auth/reset-password')
        .send({ token: rawToken, password: 'AnotherPassword123!' });
      expect(replayReset.status).toBe(400);
      expect(replayReset.body.success).toBe(false);

      // Expired admin reset token fails and does not mutate passwordHash
      const expiredRawToken = 'expired-admin-reset-token-32bytes-hex-value';
      tokens.push({
        id: 9001,
        tokenHash: sha256(expiredRawToken),
        purpose: 'RESET_PASSWORD',
        targetType: 'ADMIN',
        penggunaId: primarySuperAdmin.id,
        pelangganId: null,
        expiresAt: new Date(Date.now() - 60_000),
        usedAt: null,
        createdAt: new Date(Date.now() - 3_600_000),
      });

      const expiredRes = await request(app)
        .post('/api/v1/auth/reset-password')
        .send({ token: expiredRawToken, password: 'ShouldNotApply123!' });
      expect(expiredRes.status).toBe(400);
      expect(expiredRes.body.success).toBe(false);
      expect(await bcrypt.compare('NewAdminPassword123!', primarySuperAdmin.passwordHash)).toBe(true);
    });

    it('enforces single-use customer reset token and rejects expired customer reset token', async () => {
      // Issue reset token via customer lupa-password endpoint
      const forgotRes = await request(app)
        .post('/api/customer/auth/lupa-password')
        .send({ email: customer.email });
      expect(forgotRes.status).toBe(200);
      expect(mockSendPasswordResetEmail).toHaveBeenCalledTimes(1);

      const firstCallArg = (mockSendPasswordResetEmail.mock.calls[0] as unknown as Array<{ token: string }>)[0];
      const rawToken = firstCallArg.token;

      // First consumption succeeds
      const firstReset = await request(app)
        .post('/api/customer/auth/reset-password')
        .send({ token: rawToken, password: 'NewCustomerPassword123!' });
      expect(firstReset.status).toBe(200);
      expect(firstReset.body.success).toBe(true);
      expect(await bcrypt.compare('NewCustomerPassword123!', customer.passwordHash)).toBe(true);

      // Replay of the exact same token fails (single-use)
      const replayReset = await request(app)
        .post('/api/customer/auth/reset-password')
        .send({ token: rawToken, password: 'ReplayPassword123!' });
      expect(replayReset.status).toBe(400);
      expect(replayReset.body.success).toBe(false);

      // Expired customer reset token fails and does not mutate passwordHash
      const expiredRawToken = 'expired-customer-reset-token-32bytes-hex-value';
      tokens.push({
        id: 9002,
        tokenHash: sha256(expiredRawToken),
        purpose: 'RESET_PASSWORD',
        targetType: 'CUSTOMER',
        penggunaId: null,
        pelangganId: customer.id,
        expiresAt: new Date(Date.now() - 60_000),
        usedAt: null,
        createdAt: new Date(Date.now() - 3_600_000),
      });

      const expiredRes = await request(app)
        .post('/api/customer/auth/reset-password')
        .send({ token: expiredRawToken, password: 'ShouldNotApply123!' });
      expect(expiredRes.status).toBe(400);
      expect(expiredRes.body.success).toBe(false);
      expect(await bcrypt.compare('NewCustomerPassword123!', customer.passwordHash)).toBe(true);
    });

    it('rejects cross-target reset token usage between admin and customer endpoints', async () => {
      const adminTokenRaw = 'valid-admin-token-for-cross-target-test';
      const customerTokenRaw = 'valid-customer-token-for-cross-target-test';
      const future = new Date(Date.now() + 30 * 60_000);

      tokens.push(
        {
          id: 9003,
          tokenHash: sha256(adminTokenRaw),
          purpose: 'RESET_PASSWORD',
          targetType: 'ADMIN',
          penggunaId: primarySuperAdmin.id,
          pelangganId: null,
          expiresAt: future,
          usedAt: null,
          createdAt: new Date(),
        },
        {
          id: 9004,
          tokenHash: sha256(customerTokenRaw),
          purpose: 'RESET_PASSWORD',
          targetType: 'CUSTOMER',
          penggunaId: null,
          pelangganId: customer.id,
          expiresAt: future,
          usedAt: null,
          createdAt: new Date(),
        }
      );

      const adminTokenOnCustomer = await request(app)
        .post('/api/customer/auth/reset-password')
        .send({ token: adminTokenRaw, password: 'CrossTarget123!' });
      expect(adminTokenOnCustomer.status).toBe(400);

      const customerTokenOnAdmin = await request(app)
        .post('/api/v1/auth/reset-password')
        .send({ token: customerTokenRaw, password: 'CrossTarget123!' });
      expect(customerTokenOnAdmin.status).toBe(400);
    });
  });
});
