import crypto from 'crypto';
import type {
  PasswordResetToken,
  Prisma,
  PrismaClient,
  TokenPurpose,
  TokenTargetType,
} from '@prisma/client';
import prisma from '../utils/database';

export const RAW_TOKEN_BYTES = 32;
export const MIN_TTL_MINUTES = 30;
export const MAX_TTL_MINUTES = 60;

export const DEFAULT_TTL_MINUTES: Record<TokenPurpose, number> = {
  RESET_PASSWORD: 45,
  VERIFY_EMAIL: 45,
  ADMIN_INVITE: 60,
};

export type TokenErrorCode =
  | 'INVALID_TTL'
  | 'INVALID_TARGET'
  | 'INVALID_TOKEN'
  | 'TOKEN_EXPIRED'
  | 'TOKEN_ALREADY_USED'
  | 'TOKEN_SCOPE_MISMATCH';

export class TokenServiceError extends Error {
  public readonly code: TokenErrorCode;

  constructor(code: TokenErrorCode, message: string) {
    super(message);
    this.name = 'TokenServiceError';
    this.code = code;
  }
}

export interface IssueTokenParams {
  purpose: TokenPurpose;
  targetType: TokenTargetType;
  targetId: number;
  ttlMinutes?: number;
  now?: Date;
}

export interface IssuedTokenResult {
  token: string;
  tokenId: number;
  purpose: TokenPurpose;
  targetType: TokenTargetType;
  targetId: number;
  expiresAt: Date;
  ttlMinutes: number;
}

export interface ConsumeTokenParams {
  rawToken: string;
  purpose: TokenPurpose;
  targetType: TokenTargetType;
  now?: Date;
}

export interface ConsumedTokenResult {
  tokenId: number;
  purpose: TokenPurpose;
  targetType: TokenTargetType;
  targetId: number;
  penggunaId: number | null;
  pelangganId: number | null;
  usedAt: Date;
  expiresAt: Date;
}

type TokenPrismaClient = Pick<PrismaClient, '$transaction'> & {
  passwordResetToken: Prisma.TransactionClient['passwordResetToken'];
};

export const generateRawToken = (): string => {
  return crypto.randomBytes(RAW_TOKEN_BYTES).toString('hex');
};

export const hashToken = (rawToken: string): string => {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
};

export const resolveTtlMinutes = (
  purpose: TokenPurpose,
  ttlMinutes?: number
): number => {
  const resolved = ttlMinutes ?? DEFAULT_TTL_MINUTES[purpose];
  if (
    typeof resolved !== 'number' ||
    !Number.isFinite(resolved) ||
    resolved < MIN_TTL_MINUTES ||
    resolved > MAX_TTL_MINUTES
  ) {
    throw new TokenServiceError(
      'INVALID_TTL',
      `Masa berlaku token harus antara ${MIN_TTL_MINUTES} sampai ${MAX_TTL_MINUTES} menit.`
    );
  }
  return resolved;
};

const validateTargetId = (targetId: number): void => {
  if (!Number.isInteger(targetId) || targetId <= 0) {
    throw new TokenServiceError(
      'INVALID_TARGET',
      'ID target token tidak valid.'
    );
  }
};

const buildTargetWhere = (
  targetType: TokenTargetType,
  targetId: number
): Pick<Prisma.PasswordResetTokenWhereInput, 'penggunaId' | 'pelangganId'> => {
  return targetType === 'ADMIN'
    ? { penggunaId: targetId }
    : { pelangganId: targetId };
};

const extractTargetId = (record: PasswordResetToken): number => {
  const targetId =
    record.targetType === 'ADMIN' ? record.penggunaId : record.pelangganId;
  if (typeof targetId !== 'number' || targetId <= 0) {
    throw new TokenServiceError(
      'INVALID_TARGET',
      'Data target pada token tidak valid.'
    );
  }
  return targetId;
};

export const issueToken = async (
  params: IssueTokenParams,
  db: TokenPrismaClient = prisma
): Promise<IssuedTokenResult> => {
  validateTargetId(params.targetId);
  const ttlMinutes = resolveTtlMinutes(params.purpose, params.ttlMinutes);
  const now = params.now ?? new Date();
  const expiresAt = new Date(now.getTime() + ttlMinutes * 60_000);

  const rawToken = generateRawToken();
  const tokenHash = hashToken(rawToken);

  const record = await db.$transaction(async (tx) => {
    await tx.passwordResetToken.updateMany({
      where: {
        purpose: params.purpose,
        targetType: params.targetType,
        ...buildTargetWhere(params.targetType, params.targetId),
        usedAt: null,
      },
      data: {
        usedAt: now,
      },
    });

    return tx.passwordResetToken.create({
      data: {
        tokenHash,
        purpose: params.purpose,
        targetType: params.targetType,
        penggunaId: params.targetType === 'ADMIN' ? params.targetId : null,
        pelangganId: params.targetType === 'CUSTOMER' ? params.targetId : null,
        expiresAt,
      },
    });
  });

  return {
    token: rawToken,
    tokenId: record.id,
    purpose: record.purpose,
    targetType: record.targetType,
    targetId: params.targetId,
    expiresAt: record.expiresAt,
    ttlMinutes,
  };
};

export const consumeToken = async (
  params: ConsumeTokenParams,
  db: TokenPrismaClient = prisma
): Promise<ConsumedTokenResult> => {
  const normalizedToken =
    typeof params.rawToken === 'string' ? params.rawToken.trim() : '';

  if (!normalizedToken) {
    throw new TokenServiceError('INVALID_TOKEN', 'Token tidak valid.');
  }

  const tokenHash = hashToken(normalizedToken);
  const now = params.now ?? new Date();

  const record = await db.$transaction(async (tx) => {
    const updateResult = await tx.passwordResetToken.updateMany({
      where: {
        tokenHash,
        purpose: params.purpose,
        targetType: params.targetType,
        usedAt: null,
        expiresAt: {
          gt: now,
        },
      },
      data: {
        usedAt: now,
      },
    });

    const existing = await tx.passwordResetToken.findUnique({
      where: { tokenHash },
    });

    if (updateResult.count === 1) {
      if (!existing) {
        throw new TokenServiceError('INVALID_TOKEN', 'Token tidak ditemukan.');
      }
      return existing;
    }

    if (!existing) {
      throw new TokenServiceError(
        'INVALID_TOKEN',
        'Token tidak valid atau tidak ditemukan.'
      );
    }

    if (
      existing.purpose !== params.purpose ||
      existing.targetType !== params.targetType
    ) {
      throw new TokenServiceError(
        'TOKEN_SCOPE_MISMATCH',
        'Token tidak sesuai dengan tujuan atau jenis akun.'
      );
    }

    if (existing.usedAt !== null) {
      throw new TokenServiceError(
        'TOKEN_ALREADY_USED',
        'Token sudah pernah digunakan atau telah digantikan.'
      );
    }

    if (existing.expiresAt.getTime() <= now.getTime()) {
      throw new TokenServiceError('TOKEN_EXPIRED', 'Token sudah kedaluwarsa.');
    }

    throw new TokenServiceError('INVALID_TOKEN', 'Token tidak valid.');
  });

  return {
    tokenId: record.id,
    purpose: record.purpose,
    targetType: record.targetType,
    targetId: extractTargetId(record),
    penggunaId: record.penggunaId,
    pelangganId: record.pelangganId,
    usedAt: record.usedAt ?? now,
    expiresAt: record.expiresAt,
  };
};
