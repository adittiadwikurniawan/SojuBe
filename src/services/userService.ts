import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { AksiLog, PeranPengguna, Prisma } from '@prisma/client';
import prisma from '../utils/database';
import { logManualAction } from './auditLogService';
import { issueToken } from './tokenService';
import { sendAdminInviteEmail, sendPasswordResetEmail } from './emailService';

export type UserErrorCode =
  | 'INVALID_INPUT'
  | 'USER_NOT_FOUND'
  | 'EMAIL_ALREADY_EXISTS'
  | 'SELF_ACTION_FORBIDDEN'
  | 'LAST_SUPER_ADMIN_PROTECTED'
  | 'ACCOUNT_DISABLED';

export class UserServiceError extends Error {
  public readonly code: UserErrorCode;
  public readonly status: number;

  constructor(code: UserErrorCode, message: string, status: number) {
    super(message);
    this.name = 'UserServiceError';
    this.code = code;
    this.status = status;
  }
}

export const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const USER_SAFE_SELECT = {
  id: true,
  nama: true,
  email: true,
  peran: true,
  aktif: true,
  terakhirMasukPada: true,
  dibuatOleh: true,
  dibuatPada: true,
  diubahPada: true,
} as const;

export interface SafeUserRecord {
  id: number;
  nama: string;
  email: string;
  peran: PeranPengguna;
  aktif: boolean;
  terakhirMasukPada: Date | null;
  dibuatOleh: number | null;
  dibuatPada: Date;
  diubahPada: Date;
}

const toAuditSnapshot = (user: Pick<SafeUserRecord, 'id' | 'nama' | 'email' | 'peran' | 'aktif'>) => ({
  id: user.id,
  nama: user.nama,
  email: user.email,
  peran: user.peran,
  aktif: user.aktif,
});

const parsePositiveId = (value: number): number => {
  if (!Number.isInteger(value) || value <= 0) {
    throw new UserServiceError('INVALID_INPUT', 'ID pengguna tidak valid', 400);
  }
  return value;
};

const parseRole = (value: unknown): PeranPengguna | null => {
  if (value === 'ADMIN' || value === 'SUPER_ADMIN') {
    return value;
  }
  return null;
};

const assertNotLastActiveSuperAdmin = async (
  target: Pick<SafeUserRecord, 'peran' | 'aktif'>,
  actionLabel: string
): Promise<void> => {
  if (target.peran !== 'SUPER_ADMIN' || !target.aktif) {
    return;
  }

  const activeSuperAdminCount = await prisma.pengguna.count({
    where: {
      peran: 'SUPER_ADMIN',
      aktif: true,
    },
  });

  if (activeSuperAdminCount <= 1) {
    throw new UserServiceError(
      'LAST_SUPER_ADMIN_PROTECTED',
      `Tidak dapat ${actionLabel} Super Admin aktif terakhir`,
      409
    );
  }
};

export interface ListUsersParams {
  search?: string;
  peran?: string;
  aktif?: boolean | string;
}

export const listUsers = async (params: ListUsersParams = {}): Promise<SafeUserRecord[]> => {
  const where: Prisma.PenggunaWhereInput = {};

  if (typeof params.search === 'string' && params.search.trim().length > 0) {
    const query = params.search.trim();
    where.OR = [
      { nama: { contains: query } },
      { email: { contains: query } },
    ];
  }

  if (params.peran !== undefined && params.peran !== '') {
    const normalizedRole =
      typeof params.peran === 'string' ? params.peran.trim().toUpperCase() : '';
    const parsedRole = parseRole(normalizedRole);
    if (!parsedRole) {
      throw new UserServiceError('INVALID_INPUT', 'Filter peran tidak valid', 400);
    }
    where.peran = parsedRole;
  }

  if (params.aktif !== undefined && params.aktif !== '') {
    if (typeof params.aktif === 'boolean') {
      where.aktif = params.aktif;
    } else if (typeof params.aktif === 'string') {
      const normalized = params.aktif.trim().toLowerCase();
      if (normalized === 'true') {
        where.aktif = true;
      } else if (normalized === 'false') {
        where.aktif = false;
      } else {
        throw new UserServiceError('INVALID_INPUT', 'Filter status aktif tidak valid', 400);
      }
    } else {
      throw new UserServiceError('INVALID_INPUT', 'Filter status aktif tidak valid', 400);
    }
  }

  return prisma.pengguna.findMany({
    where,
    select: USER_SAFE_SELECT,
    orderBy: { dibuatPada: 'asc' },
  });
};

export interface CreateUserParams {
  actorId: number;
  actorName?: string;
  nama: string;
  email: string;
  password?: string;
  peran?: string;
  sendInvite?: boolean;
}

export interface CreateUserResult {
  user: SafeUserRecord;
  inviteSent: boolean;
}

export const createUser = async (params: CreateUserParams): Promise<CreateUserResult> => {
  const actorId = parsePositiveId(params.actorId);
  const nama = typeof params.nama === 'string' ? params.nama.trim() : '';
  const email = typeof params.email === 'string' ? params.email.trim().toLowerCase() : '';
  const rawPassword = typeof params.password === 'string' ? params.password : '';
  const sendInvite = params.sendInvite === true;
  const peran =
    params.peran === undefined || params.peran === ''
      ? 'ADMIN'
      : parseRole(params.peran.trim().toUpperCase());

  if (!nama || !email || !EMAIL_REGEX.test(email) || !peran) {
    throw new UserServiceError(
      'INVALID_INPUT',
      'Nama, email valid, dan peran yang sesuai wajib diisi',
      400
    );
  }

  if (!sendInvite && rawPassword.length < 8) {
    throw new UserServiceError(
      'INVALID_INPUT',
      'Password awal minimal 8 karakter wajib diisi',
      400
    );
  }

  if (sendInvite && rawPassword.length > 0 && rawPassword.length < 8) {
    throw new UserServiceError(
      'INVALID_INPUT',
      'Password awal minimal 8 karakter',
      400
    );
  }

  const existing = await prisma.pengguna.findUnique({
    where: { email },
    select: { id: true },
  });

  if (existing) {
    throw new UserServiceError('EMAIL_ALREADY_EXISTS', 'Email sudah digunakan', 409);
  }

  const effectivePassword =
    rawPassword.length >= 8 ? rawPassword : crypto.randomBytes(24).toString('hex');
  const passwordHash = await bcrypt.hash(effectivePassword, 10);

  const created = await prisma.pengguna.create({
    data: {
      nama,
      email,
      passwordHash,
      peran,
      aktif: true,
      dibuatOleh: actorId,
    },
    select: USER_SAFE_SELECT,
  });

  if (sendInvite) {
    const issued = await issueToken({
      purpose: 'ADMIN_INVITE',
      targetType: 'ADMIN',
      targetId: created.id,
    });

    await sendAdminInviteEmail({
      to: created.email,
      nama: created.nama,
      peran: created.peran,
      token: issued.token,
      invitedBy: params.actorName,
      expiresInMinutes: issued.ttlMinutes,
    });
  }

  await logManualAction(
    actorId,
    'pengguna',
    AksiLog.TAMBAH,
    created.email,
    sendInvite
      ? `Admin baru dibuat dengan undangan: ${created.email}`
      : `Admin baru dibuat: ${created.email}`,
    created.id,
    undefined,
    {
      ...toAuditSnapshot(created),
      dibuatOleh: created.dibuatOleh,
      undanganDikirim: sendInvite,
    }
  );

  return {
    user: created,
    inviteSent: sendInvite,
  };
};

export interface UpdateUserParams {
  actorId: number;
  targetId: number;
  nama?: string;
  email?: string;
  peran?: string;
}

export const updateUser = async (params: UpdateUserParams): Promise<SafeUserRecord> => {
  const actorId = parsePositiveId(params.actorId);
  const targetId = parsePositiveId(params.targetId);

  const updateData: Prisma.PenggunaUpdateInput = {};
  let requestedRole: PeranPengguna | undefined;
  let requestedEmail: string | undefined;

  if (params.nama !== undefined) {
    const nama = typeof params.nama === 'string' ? params.nama.trim() : '';
    if (!nama) {
      throw new UserServiceError('INVALID_INPUT', 'Nama tidak boleh kosong', 400);
    }
    updateData.nama = nama;
  }

  if (params.email !== undefined) {
    const email = typeof params.email === 'string' ? params.email.trim().toLowerCase() : '';
    if (!email || !EMAIL_REGEX.test(email)) {
      throw new UserServiceError('INVALID_INPUT', 'Format email tidak valid', 400);
    }
    requestedEmail = email;
    updateData.email = email;
  }

  if (params.peran !== undefined) {
    const parsedRole =
      typeof params.peran === 'string'
        ? parseRole(params.peran.trim().toUpperCase())
        : null;
    if (!parsedRole) {
      throw new UserServiceError('INVALID_INPUT', 'Peran tidak valid', 400);
    }
    requestedRole = parsedRole;
    updateData.peran = parsedRole;
  }

  if (Object.keys(updateData).length === 0) {
    throw new UserServiceError(
      'INVALID_INPUT',
      'Minimal satu field (nama, email, atau peran) wajib diisi',
      400
    );
  }

  const existing = await prisma.pengguna.findUnique({
    where: { id: targetId },
    select: USER_SAFE_SELECT,
  });

  if (!existing) {
    throw new UserServiceError('USER_NOT_FOUND', 'Akun admin tidak ditemukan', 404);
  }

  if (requestedRole !== undefined && targetId === actorId && requestedRole !== existing.peran) {
    throw new UserServiceError(
      'SELF_ACTION_FORBIDDEN',
      'Tidak dapat mengubah peran akun sendiri',
      403
    );
  }

  if (requestedRole !== undefined && requestedRole !== 'SUPER_ADMIN') {
    await assertNotLastActiveSuperAdmin(existing, 'menurunkan peran');
  }

  if (requestedEmail && requestedEmail !== existing.email) {
    const duplicate = await prisma.pengguna.findFirst({
      where: {
        email: requestedEmail,
        id: { not: targetId },
      },
      select: { id: true },
    });

    if (duplicate) {
      throw new UserServiceError('EMAIL_ALREADY_EXISTS', 'Email sudah digunakan akun lain', 409);
    }
  }

  const updated = await prisma.pengguna.update({
    where: { id: targetId },
    data: updateData,
    select: USER_SAFE_SELECT,
  });

  await logManualAction(
    actorId,
    'pengguna',
    AksiLog.UBAH,
    updated.email,
    `Data akun admin diperbarui: ${updated.email}`,
    updated.id,
    toAuditSnapshot(existing),
    toAuditSnapshot(updated)
  );

  return updated;
};

export interface UpdateUserStatusParams {
  actorId: number;
  targetId: number;
  aktif: boolean;
}

export const updateUserStatus = async (
  params: UpdateUserStatusParams
): Promise<SafeUserRecord> => {
  const actorId = parsePositiveId(params.actorId);
  const targetId = parsePositiveId(params.targetId);

  if (typeof params.aktif !== 'boolean') {
    throw new UserServiceError('INVALID_INPUT', 'Status aktif harus berupa boolean', 400);
  }

  const existing = await prisma.pengguna.findUnique({
    where: { id: targetId },
    select: USER_SAFE_SELECT,
  });

  if (!existing) {
    throw new UserServiceError('USER_NOT_FOUND', 'Akun admin tidak ditemukan', 404);
  }

  if (!params.aktif && targetId === actorId) {
    throw new UserServiceError(
      'SELF_ACTION_FORBIDDEN',
      'Tidak dapat menonaktifkan akun sendiri',
      403
    );
  }

  if (!params.aktif) {
    await assertNotLastActiveSuperAdmin(existing, 'menonaktifkan');
  }

  const updated = await prisma.pengguna.update({
    where: { id: targetId },
    data: { aktif: params.aktif },
    select: USER_SAFE_SELECT,
  });

  await logManualAction(
    actorId,
    'pengguna',
    AksiLog.UBAH,
    updated.email,
    params.aktif
      ? `Akun admin diaktifkan: ${updated.email}`
      : `Akun admin dinonaktifkan: ${updated.email}`,
    updated.id,
    toAuditSnapshot(existing),
    toAuditSnapshot(updated)
  );

  return updated;
};

export interface SoftDisableUserParams {
  actorId: number;
  targetId: number;
}

export const softDisableUser = async (
  params: SoftDisableUserParams
): Promise<SafeUserRecord> => {
  const actorId = parsePositiveId(params.actorId);
  const targetId = parsePositiveId(params.targetId);

  const existing = await prisma.pengguna.findUnique({
    where: { id: targetId },
    select: USER_SAFE_SELECT,
  });

  if (!existing) {
    throw new UserServiceError('USER_NOT_FOUND', 'Akun admin tidak ditemukan', 404);
  }

  if (targetId === actorId) {
    throw new UserServiceError(
      'SELF_ACTION_FORBIDDEN',
      'Tidak dapat menonaktifkan akun sendiri',
      403
    );
  }

  await assertNotLastActiveSuperAdmin(existing, 'menonaktifkan');

  const updated = await prisma.pengguna.update({
    where: { id: targetId },
    data: { aktif: false },
    select: USER_SAFE_SELECT,
  });

  await logManualAction(
    actorId,
    'pengguna',
    AksiLog.HAPUS,
    updated.email,
    `Akun admin dinonaktifkan (soft-delete): ${updated.email}`,
    updated.id,
    toAuditSnapshot(existing),
    toAuditSnapshot(updated)
  );

  return updated;
};

export interface TriggerUserPasswordResetParams {
  actorId: number;
  targetId: number;
}

export interface TriggerUserPasswordResetResult {
  userId: number;
  email: string;
  message: string;
}

export const ADMIN_RESET_TRIGGER_SUCCESS_MESSAGE =
  'Tautan reset password telah dikirim ke email admin.';

export const triggerUserPasswordReset = async (
  params: TriggerUserPasswordResetParams
): Promise<TriggerUserPasswordResetResult> => {
  const actorId = parsePositiveId(params.actorId);
  const targetId = parsePositiveId(params.targetId);

  const existing = await prisma.pengguna.findUnique({
    where: { id: targetId },
    select: USER_SAFE_SELECT,
  });

  if (!existing) {
    throw new UserServiceError('USER_NOT_FOUND', 'Akun admin tidak ditemukan', 404);
  }

  if (!existing.aktif) {
    throw new UserServiceError(
      'ACCOUNT_DISABLED',
      'Tidak dapat mengirim reset password untuk akun admin nonaktif',
      400
    );
  }

  const issued = await issueToken({
    purpose: 'RESET_PASSWORD',
    targetType: 'ADMIN',
    targetId: existing.id,
  });

  await sendPasswordResetEmail({
    to: existing.email,
    nama: existing.nama,
    token: issued.token,
    targetType: 'ADMIN',
    expiresInMinutes: issued.ttlMinutes,
  });

  await logManualAction(
    actorId,
    'pengguna',
    AksiLog.UBAH,
    existing.email,
    `Reset password admin dipicu oleh Super Admin untuk: ${existing.email}`,
    existing.id,
    toAuditSnapshot(existing),
    {
      ...toAuditSnapshot(existing),
      resetPasswordDipicu: true,
    }
  );

  return {
    userId: existing.id,
    email: existing.email,
    message: ADMIN_RESET_TRIGGER_SUCCESS_MESSAGE,
  };
};
