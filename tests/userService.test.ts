import express from 'express';
import bcrypt from 'bcrypt';
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
  tokens,
  auditLogs,
  resetStore,
  mockPrisma,
  mockSendAdminInviteEmail,
  mockSendPasswordResetEmail,
} = vi.hoisted(() => {
  const users: MockPengguna[] = [];
  const tokens: PasswordResetToken[] = [];
  const auditLogs: MockAuditLog[] = [];
  let nextUserId = 10;
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
    if (Array.isArray(where.OR) && where.OR.length > 0) {
      const matchedOr = where.OR.some((clause: any) => {
        if (clause.nama?.contains) {
          return user.nama.toLowerCase().includes(String(clause.nama.contains).toLowerCase());
        }
        if (clause.email?.contains) {
          return user.email.toLowerCase().includes(String(clause.email.contains).toLowerCase());
        }
        return false;
      });
      if (!matchedOr) return false;
    }
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
    findMany: vi.fn(async ({ where, select }: any = {}) => {
      return users
        .filter((u) => matchesPenggunaWhere(u, where))
        .sort((a, b) => a.dibuatPada.getTime() - b.dibuatPada.getTime())
        .map((u) => applySelect(u, select));
    }),
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
    count: vi.fn(async ({ where }: any = {}) => {
      return users.filter((u) => matchesPenggunaWhere(u, where)).length;
    }),
    create: vi.fn(async ({ data, select }: any) => {
      const now = new Date();
      const created: MockPengguna = {
        id: nextUserId++,
        nama: data.nama,
        email: data.email,
        passwordHash: data.passwordHash,
        peran: data.peran ?? 'ADMIN',
        aktif: data.aktif ?? true,
        terakhirMasukPada: data.terakhirMasukPada ?? null,
        dibuatOleh: data.dibuatOleh ?? null,
        dibuatPada: now,
        diubahPada: now,
      };
      users.push(created);
      return applySelect(created, select);
    }),
    update: vi.fn(async ({ where, data, select }: any) => {
      const found = users.find((u) => u.id === where.id);
      if (!found) {
        throw new Error(`Pengguna ${where.id} tidak ditemukan`);
      }
      Object.assign(found, data, { diubahPada: new Date() });
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
    create: vi.fn(async ({ data }: any): Promise<MockAuditLog> => {
      const created: MockAuditLog = {
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
      auditLogs.push(created);
      return { ...created };
    }),
  };

  const mockPrisma = {
    pengguna: penggunaDelegate,
    passwordResetToken: passwordResetTokenDelegate,
    logAudit: logAuditDelegate,
    $transaction: vi.fn(async (callback: (tx: any) => Promise<any>) =>
      callback({
        pengguna: penggunaDelegate,
        passwordResetToken: passwordResetTokenDelegate,
        logAudit: logAuditDelegate,
      })
    ),
  };

  const mockSendAdminInviteEmail = vi.fn(async (params: any) => ({
    delivered: true,
    mode: 'console' as const,
    to: params.to,
    subject: 'Undangan Akun Admin SOJU FnB',
    actionUrl: `http://localhost:3000/reset-password?token=${params.token}&purpose=invite`,
  }));

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
    auditLogs.length = 0;
    nextUserId = 10;
    nextTokenId = 1;
    nextAuditId = 1;
  };

  return {
    users,
    tokens,
    auditLogs,
    resetStore,
    mockPrisma,
    mockSendAdminInviteEmail,
    mockSendPasswordResetEmail,
  };
});

vi.mock('../src/utils/database', () => ({
  default: mockPrisma,
}));

vi.mock('../src/services/emailService', () => ({
  sendAdminInviteEmail: mockSendAdminInviteEmail,
  sendPasswordResetEmail: mockSendPasswordResetEmail,
}));

import usersRoutes from '../src/routes/users';
import {
  ADMIN_RESET_TRIGGER_SUCCESS_MESSAGE,
  UserServiceError,
  softDisableUser,
  updateUser,
  updateUserStatus,
} from '../src/services/userService';
import { hashToken } from '../src/services/tokenService';

const createTestApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/users', usersRoutes);
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

describe('TASK-008: SUPER_ADMIN Multi-User Management Service & Endpoints', () => {
  const originalJwtSecret = process.env.JWT_SECRET;
  const app = createTestApp();

  let superAdminToken: string;
  let adminToken: string;
  let customerToken: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    resetStore();
    process.env.JWT_SECRET = 'test-multiuser-jwt-secret';

    const hash = await bcrypt.hash('PasswordRahasia123!', 10);
    const baseDate = new Date('2026-11-01T00:00:00.000Z');

    users.push(
      {
        id: 1,
        nama: 'Super Admin Utama',
        email: 'super@soju.id',
        passwordHash: hash,
        peran: 'SUPER_ADMIN',
        aktif: true,
        terakhirMasukPada: new Date('2026-11-20T08:00:00.000Z'),
        dibuatOleh: null,
        dibuatPada: new Date(baseDate.getTime()),
        diubahPada: new Date(baseDate.getTime()),
      },
      {
        id: 2,
        nama: 'Admin Operasional',
        email: 'admin@soju.id',
        passwordHash: hash,
        peran: 'ADMIN',
        aktif: true,
        terakhirMasukPada: null,
        dibuatOleh: 1,
        dibuatPada: new Date(baseDate.getTime() + 1000),
        diubahPada: new Date(baseDate.getTime() + 1000),
      },
      {
        id: 3,
        nama: 'Admin Nonaktif',
        email: 'inactive@soju.id',
        passwordHash: hash,
        peran: 'ADMIN',
        aktif: false,
        terakhirMasukPada: null,
        dibuatOleh: 1,
        dibuatPada: new Date(baseDate.getTime() + 2000),
        diubahPada: new Date(baseDate.getTime() + 2000),
      }
    );

    superAdminToken = jwt.sign(
      { id: 1, email: 'super@soju.id', type: 'admin' },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );
    adminToken = jwt.sign(
      { id: 2, email: 'admin@soju.id', type: 'admin' },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );
    customerToken = jwt.sign(
      { id: 50, email: 'cust@example.com', type: 'customer' },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
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

  describe('GET /api/v1/users filtering & secret projection', () => {
    it('supports search, peran, and aktif filters and never returns passwordHash', async () => {
      const allRes = await request(app)
        .get('/api/v1/users')
        .set('Authorization', `Bearer ${superAdminToken}`);

      expect(allRes.status).toBe(200);
      expect(allRes.body.success).toBe(true);
      expect(allRes.body.data).toHaveLength(3);
      for (const item of allRes.body.data) {
        expect(item).not.toHaveProperty('passwordHash');
        expect(item).toHaveProperty('id');
        expect(item).toHaveProperty('nama');
        expect(item).toHaveProperty('email');
        expect(item).toHaveProperty('peran');
        expect(item).toHaveProperty('aktif');
        expect(item).toHaveProperty('terakhirMasukPada');
        expect(item).toHaveProperty('dibuatOleh');
        expect(item).toHaveProperty('dibuatPada');
        expect(item).toHaveProperty('diubahPada');
      }

      const roleAndActiveRes = await request(app)
        .get('/api/v1/users?peran=ADMIN&aktif=true')
        .set('Authorization', `Bearer ${superAdminToken}`);
      expect(roleAndActiveRes.status).toBe(200);
      expect(roleAndActiveRes.body.data).toHaveLength(1);
      expect(roleAndActiveRes.body.data[0].email).toBe('admin@soju.id');

      const searchRes = await request(app)
        .get('/api/v1/users?search=nonaktif')
        .set('Authorization', `Bearer ${superAdminToken}`);
      expect(searchRes.status).toBe(200);
      expect(searchRes.body.data).toHaveLength(1);
      expect(searchRes.body.data[0].email).toBe('inactive@soju.id');
    });
  });

  describe('POST /api/v1/users creation, dibuatOleh, optional ADMIN_INVITE & LogAudit', () => {
    it('records dibuatOleh = actorId, never exposes plain password, sends optional ADMIN_INVITE email, and logs sanitized LogAudit', async () => {
      const res = await request(app)
        .post('/api/v1/users')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({
          nama: 'Kasir Baru',
          email: 'Kasir@Soju.id',
          peran: 'ADMIN',
          sendInvite: true,
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toMatchObject({
        nama: 'Kasir Baru',
        email: 'kasir@soju.id',
        peran: 'ADMIN',
        aktif: true,
        dibuatOleh: 1,
      });
      expect(res.body.data).not.toHaveProperty('password');
      expect(res.body.data).not.toHaveProperty('passwordHash');
      expect(res.body.data).not.toHaveProperty('token');

      expect(tokens).toHaveLength(1);
      expect(tokens[0].purpose).toBe('ADMIN_INVITE');
      expect(tokens[0].targetType).toBe('ADMIN');
      expect(tokens[0].penggunaId).toBe(res.body.data.id);

      expect(mockSendAdminInviteEmail).toHaveBeenCalledTimes(1);
      const rawToken = mockSendAdminInviteEmail.mock.calls[0][0].token as string;
      expect(tokens[0].tokenHash).toBe(hashToken(rawToken));

      expect(auditLogs).toHaveLength(1);
      expect(auditLogs[0]).toMatchObject({
        penggunaId: 1,
        tabelTarget: 'pengguna',
        targetId: res.body.data.id,
        aksi: 'TAMBAH',
        labelRecord: 'kasir@soju.id',
      });
      expect(auditLogs[0].dataSesudah).not.toContain(rawToken);
      expect(auditLogs[0].dataSesudah).not.toContain('passwordHash');
    });
  });

  describe('Self-protection & Last Active SUPER_ADMIN Guards (unit & route)', () => {
    it('rejects self-deactivation and self-role-change deterministically', async () => {
      // Service-level unit checks
      await expect(
        updateUser({ actorId: 1, targetId: 1, peran: 'ADMIN' })
      ).rejects.toMatchObject({
        code: 'SELF_ACTION_FORBIDDEN',
        status: 403,
      } satisfies Partial<UserServiceError>);

      await expect(
        updateUserStatus({ actorId: 1, targetId: 1, aktif: false })
      ).rejects.toMatchObject({
        code: 'SELF_ACTION_FORBIDDEN',
        status: 403,
      } satisfies Partial<UserServiceError>);

      await expect(
        softDisableUser({ actorId: 1, targetId: 1 })
      ).rejects.toMatchObject({
        code: 'SELF_ACTION_FORBIDDEN',
        status: 403,
      } satisfies Partial<UserServiceError>);

      // Route-level HTTP checks
      const selfDemoteRes = await request(app)
        .patch('/api/v1/users/1')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ peran: 'ADMIN' });
      expect(selfDemoteRes.status).toBe(403);

      const selfDisableStatusRes = await request(app)
        .patch('/api/v1/users/1/status')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ aktif: false });
      expect(selfDisableStatusRes.status).toBe(403);

      const selfDeleteRes = await request(app)
        .delete('/api/v1/users/1')
        .set('Authorization', `Bearer ${superAdminToken}`);
      expect(selfDeleteRes.status).toBe(403);

      expect(users[0].aktif).toBe(true);
      expect(users[0].peran).toBe('SUPER_ADMIN');
      expect(auditLogs).toHaveLength(0);
    });

    it('protects the last active SUPER_ADMIN from demotion or deactivation, and allows action when another active SUPER_ADMIN exists', async () => {
      // Only user 1 is an active SUPER_ADMIN; another actor (id 99) cannot demote or disable user 1
      await expect(
        updateUser({ actorId: 99, targetId: 1, peran: 'ADMIN' })
      ).rejects.toMatchObject({
        code: 'LAST_SUPER_ADMIN_PROTECTED',
        status: 409,
      } satisfies Partial<UserServiceError>);

      await expect(
        updateUserStatus({ actorId: 99, targetId: 1, aktif: false })
      ).rejects.toMatchObject({
        code: 'LAST_SUPER_ADMIN_PROTECTED',
        status: 409,
      } satisfies Partial<UserServiceError>);

      await expect(
        softDisableUser({ actorId: 99, targetId: 1 })
      ).rejects.toMatchObject({
        code: 'LAST_SUPER_ADMIN_PROTECTED',
        status: 409,
      } satisfies Partial<UserServiceError>);

      // Promote user 2 to SUPER_ADMIN -> now 2 active SUPER_ADMINs exist
      const promoteRes = await request(app)
        .patch('/api/v1/users/2')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ peran: 'SUPER_ADMIN' });
      expect(promoteRes.status).toBe(200);
      expect(promoteRes.body.data.peran).toBe('SUPER_ADMIN');

      // Now user 1 can demote user 2 back to ADMIN
      const demoteRes = await request(app)
        .patch('/api/v1/users/2')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ peran: 'ADMIN' });
      expect(demoteRes.status).toBe(200);
      expect(demoteRes.body.data.peran).toBe('ADMIN');

      // Audit logs captured both mutations without secrets
      expect(auditLogs).toHaveLength(2);
      expect(auditLogs[0].aksi).toBe('UBAH');
      expect(auditLogs[1].aksi).toBe('UBAH');
    });
  });

  describe('Status Toggle, Soft-Disable (DELETE) & Admin Reset-Password Trigger', () => {
    it('soft-disables target admin via DELETE /api/v1/users/:id and logs AksiLog.HAPUS', async () => {
      const res = await request(app)
        .delete('/api/v1/users/2')
        .set('Authorization', `Bearer ${superAdminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toMatchObject({ id: 2, aktif: false });
      expect(users.find((u) => u.id === 2)?.aktif).toBe(false);

      expect(auditLogs).toHaveLength(1);
      expect(auditLogs[0]).toMatchObject({
        penggunaId: 1,
        tabelTarget: 'pengguna',
        targetId: 2,
        aksi: 'HAPUS',
      });
    });

    it('triggers RESET_PASSWORD email via POST /api/v1/users/:id/reset-password without exposing secrets and logs LogAudit', async () => {
      const res = await request(app)
        .post('/api/v1/users/2/reset-password')
        .set('Authorization', `Bearer ${superAdminToken}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        success: true,
        data: { userId: 2, email: 'admin@soju.id' },
        message: ADMIN_RESET_TRIGGER_SUCCESS_MESSAGE,
      });

      expect(tokens).toHaveLength(1);
      expect(tokens[0].purpose).toBe('RESET_PASSWORD');
      expect(tokens[0].targetType).toBe('ADMIN');
      expect(tokens[0].penggunaId).toBe(2);

      expect(mockSendPasswordResetEmail).toHaveBeenCalledTimes(1);
      const rawToken = mockSendPasswordResetEmail.mock.calls[0][0].token as string;
      expect(JSON.stringify(res.body)).not.toContain(rawToken);

      expect(auditLogs).toHaveLength(1);
      expect(auditLogs[0]).toMatchObject({
        penggunaId: 1,
        tabelTarget: 'pengguna',
        targetId: 2,
        aksi: 'UBAH',
      });
      expect(auditLogs[0].dataSesudah).not.toContain(rawToken);
      expect(auditLogs[0].dataSesudah).not.toContain('passwordHash');

      // Inactive admin cannot receive reset trigger
      const disabledRes = await request(app)
        .post('/api/v1/users/3/reset-password')
        .set('Authorization', `Bearer ${superAdminToken}`);
      expect(disabledRes.status).toBe(400);
    });
  });

  describe('RBAC Gating (SUPER_ADMIN only)', () => {
    it('rejects ADMIN with 403 and CUSTOMER JWT with 401 across /api/v1/users endpoints', async () => {
      const adminGet = await request(app)
        .get('/api/v1/users')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(adminGet.status).toBe(403);

      const adminPatch = await request(app)
        .patch('/api/v1/users/3')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ nama: 'Hack' });
      expect(adminPatch.status).toBe(403);

      const adminStatus = await request(app)
        .patch('/api/v1/users/3/status')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ aktif: true });
      expect(adminStatus.status).toBe(403);

      const adminReset = await request(app)
        .post('/api/v1/users/2/reset-password')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(adminReset.status).toBe(403);

      const adminDelete = await request(app)
        .delete('/api/v1/users/3')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(adminDelete.status).toBe(403);

      const customerGet = await request(app)
        .get('/api/v1/users')
        .set('Authorization', `Bearer ${customerToken}`);
      expect(customerGet.status).toBe(401);
    });
  });
});
