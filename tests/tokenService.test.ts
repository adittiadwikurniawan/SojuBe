import crypto from 'crypto';
import type {
  PasswordResetToken,
  TokenPurpose,
  TokenTargetType,
} from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  consumeToken,
  DEFAULT_TTL_MINUTES,
  generateRawToken,
  hashToken,
  issueToken,
  MAX_TTL_MINUTES,
  MIN_TTL_MINUTES,
  resolveTtlMinutes,
  TokenServiceError,
} from '../src/services/tokenService';

interface WhereClause {
  tokenHash?: string;
  purpose?: TokenPurpose;
  targetType?: TokenTargetType;
  penggunaId?: number | null;
  pelangganId?: number | null;
  usedAt?: null;
  expiresAt?: { gt: Date };
}

const createInMemoryTokenDb = () => {
  const rows: PasswordResetToken[] = [];
  let nextId = 1;

  const matchesWhere = (row: PasswordResetToken, where: WhereClause): boolean => {
    if (where.tokenHash !== undefined && row.tokenHash !== where.tokenHash) {
      return false;
    }
    if (where.purpose !== undefined && row.purpose !== where.purpose) {
      return false;
    }
    if (where.targetType !== undefined && row.targetType !== where.targetType) {
      return false;
    }
    if (where.penggunaId !== undefined && row.penggunaId !== where.penggunaId) {
      return false;
    }
    if (where.pelangganId !== undefined && row.pelangganId !== where.pelangganId) {
      return false;
    }
    if (where.usedAt === null && row.usedAt !== null) {
      return false;
    }
    if (
      where.expiresAt?.gt !== undefined &&
      row.expiresAt.getTime() <= where.expiresAt.gt.getTime()
    ) {
      return false;
    }
    return true;
  };

  const createSpy = vi.fn(
    async ({
      data,
    }: {
      data: {
        tokenHash: string;
        purpose: TokenPurpose;
        targetType: TokenTargetType;
        penggunaId: number | null;
        pelangganId: number | null;
        expiresAt: Date;
      };
    }): Promise<PasswordResetToken> => {
      if (rows.some((row) => row.tokenHash === data.tokenHash)) {
        throw new Error('Unique constraint failed on token_hash');
      }
      const created: PasswordResetToken = {
        id: nextId++,
        tokenHash: data.tokenHash,
        purpose: data.purpose,
        targetType: data.targetType,
        penggunaId: data.penggunaId,
        pelangganId: data.pelangganId,
        expiresAt: data.expiresAt,
        usedAt: null,
        createdAt: new Date(),
      };
      rows.push(created);
      return { ...created };
    }
  );

  const updateManySpy = vi.fn(
    async ({
      where,
      data,
    }: {
      where: WhereClause;
      data: { usedAt: Date };
    }): Promise<{ count: number }> => {
      let count = 0;
      for (const row of rows) {
        if (matchesWhere(row, where)) {
          row.usedAt = data.usedAt;
          count += 1;
        }
      }
      return { count };
    }
  );

  const findUniqueSpy = vi.fn(
    async ({
      where,
    }: {
      where: { tokenHash: string };
    }): Promise<PasswordResetToken | null> => {
      const found = rows.find((row) => row.tokenHash === where.tokenHash);
      return found ? { ...found } : null;
    }
  );

  const passwordResetToken = {
    create: createSpy,
    updateMany: updateManySpy,
    findUnique: findUniqueSpy,
  };

  const db = {
    passwordResetToken,
    $transaction: vi.fn(async <T>(fn: (tx: { passwordResetToken: typeof passwordResetToken }) => Promise<T>) => {
      return fn({ passwordResetToken });
    }),
  };

  return {
    db: db as unknown as Parameters<typeof issueToken>[1],
    rows,
    spies: {
      createSpy,
      updateManySpy,
      findUniqueSpy,
      transactionSpy: db.$transaction,
    },
  };
};

describe('tokenService', () => {
  const baseNow = new Date('2026-11-23T10:00:00.000Z');
  let store: ReturnType<typeof createInMemoryTokenDb>;

  beforeEach(() => {
    store = createInMemoryTokenDb();
  });

  describe('cryptographic generation & SHA-256 hashing', () => {
    it('generates 32-byte (64 hex char) cryptographically random tokens', () => {
      const first = generateRawToken();
      const second = generateRawToken();

      expect(first).toMatch(/^[a-f0-9]{64}$/);
      expect(second).toMatch(/^[a-f0-9]{64}$/);
      expect(first).not.toBe(second);
    });

    it('persists only SHA-256 hex digest and never passes raw token to Prisma', async () => {
      const issued = await issueToken(
        {
          purpose: 'RESET_PASSWORD',
          targetType: 'ADMIN',
          targetId: 7,
          now: baseNow,
        },
        store.db
      );

      const expectedHash = crypto
        .createHash('sha256')
        .update(issued.token)
        .digest('hex');

      expect(hashToken(issued.token)).toBe(expectedHash);
      expect(store.rows).toHaveLength(1);
      expect(store.rows[0].tokenHash).toBe(expectedHash);
      expect(store.rows[0].tokenHash).not.toBe(issued.token);
      expect(JSON.stringify(store.spies.createSpy.mock.calls[0])).not.toContain(
        issued.token
      );
    });
  });

  describe('TTL enforcement & purpose/target support', () => {
    it('uses default TTLs (45 min reset/verify, 60 min admin invite) and accepts 30-60 min bounds', () => {
      expect(resolveTtlMinutes('RESET_PASSWORD')).toBe(
        DEFAULT_TTL_MINUTES.RESET_PASSWORD
      );
      expect(resolveTtlMinutes('VERIFY_EMAIL')).toBe(
        DEFAULT_TTL_MINUTES.VERIFY_EMAIL
      );
      expect(resolveTtlMinutes('ADMIN_INVITE')).toBe(
        DEFAULT_TTL_MINUTES.ADMIN_INVITE
      );
      expect(resolveTtlMinutes('RESET_PASSWORD', MIN_TTL_MINUTES)).toBe(30);
      expect(resolveTtlMinutes('RESET_PASSWORD', MAX_TTL_MINUTES)).toBe(60);
    });

    it('rejects TTL outside 30-60 minutes with INVALID_TTL', async () => {
      for (const badTtl of [29, 61, 0, -15, Number.NaN]) {
        await expect(
          issueToken(
            {
              purpose: 'RESET_PASSWORD',
              targetType: 'ADMIN',
              targetId: 1,
              ttlMinutes: badTtl,
              now: baseNow,
            },
            store.db
          )
        ).rejects.toMatchObject({
          name: 'TokenServiceError',
          code: 'INVALID_TTL',
        });
      }
      expect(store.rows).toHaveLength(0);
    });

    it('rejects invalid targetId with INVALID_TARGET', async () => {
      for (const badId of [0, -5, 1.5]) {
        await expect(
          issueToken(
            {
              purpose: 'VERIFY_EMAIL',
              targetType: 'CUSTOMER',
              targetId: badId,
              now: baseNow,
            },
            store.db
          )
        ).rejects.toMatchObject({
          name: 'TokenServiceError',
          code: 'INVALID_TARGET',
        });
      }
    });

    it('supports RESET_PASSWORD, VERIFY_EMAIL, and ADMIN_INVITE across ADMIN and CUSTOMER targets', async () => {
      const combinations: Array<{
        purpose: TokenPurpose;
        targetType: TokenTargetType;
        targetId: number;
        expectedTtl: number;
      }> = [
        { purpose: 'RESET_PASSWORD', targetType: 'ADMIN', targetId: 1, expectedTtl: 45 },
        { purpose: 'ADMIN_INVITE', targetType: 'ADMIN', targetId: 2, expectedTtl: 60 },
        { purpose: 'VERIFY_EMAIL', targetType: 'ADMIN', targetId: 3, expectedTtl: 45 },
        { purpose: 'RESET_PASSWORD', targetType: 'CUSTOMER', targetId: 11, expectedTtl: 45 },
        { purpose: 'VERIFY_EMAIL', targetType: 'CUSTOMER', targetId: 12, expectedTtl: 45 },
        { purpose: 'ADMIN_INVITE', targetType: 'CUSTOMER', targetId: 13, expectedTtl: 60 },
      ];

      for (const combo of combinations) {
        const issued = await issueToken(
          {
            purpose: combo.purpose,
            targetType: combo.targetType,
            targetId: combo.targetId,
            now: baseNow,
          },
          store.db
        );

        expect(issued.ttlMinutes).toBe(combo.expectedTtl);
        expect(issued.expiresAt.getTime()).toBe(
          baseNow.getTime() + combo.expectedTtl * 60_000
        );

        const persisted = store.rows.find((row) => row.id === issued.tokenId);
        expect(persisted).toBeDefined();
        if (combo.targetType === 'ADMIN') {
          expect(persisted?.penggunaId).toBe(combo.targetId);
          expect(persisted?.pelangganId).toBeNull();
        } else {
          expect(persisted?.pelangganId).toBe(combo.targetId);
          expect(persisted?.penggunaId).toBeNull();
        }
      }
    });
  });

  describe('re-issue invalidation', () => {
    it('invalidates prior unused tokens for the same target and purpose while keeping unrelated tokens active', async () => {
      const firstReset = await issueToken(
        {
          purpose: 'RESET_PASSWORD',
          targetType: 'CUSTOMER',
          targetId: 42,
          now: baseNow,
        },
        store.db
      );

      const verifyToken = await issueToken(
        {
          purpose: 'VERIFY_EMAIL',
          targetType: 'CUSTOMER',
          targetId: 42,
          now: baseNow,
        },
        store.db
      );

      const otherCustomerReset = await issueToken(
        {
          purpose: 'RESET_PASSWORD',
          targetType: 'CUSTOMER',
          targetId: 99,
          now: baseNow,
        },
        store.db
      );

      const reissueTime = new Date(baseNow.getTime() + 2 * 60_000);
      const secondReset = await issueToken(
        {
          purpose: 'RESET_PASSWORD',
          targetType: 'CUSTOMER',
          targetId: 42,
          now: reissueTime,
        },
        store.db
      );

      const consumeTime = new Date(baseNow.getTime() + 5 * 60_000);

      await expect(
        consumeToken(
          {
            rawToken: firstReset.token,
            purpose: 'RESET_PASSWORD',
            targetType: 'CUSTOMER',
            now: consumeTime,
          },
          store.db
        )
      ).rejects.toMatchObject({
        name: 'TokenServiceError',
        code: 'TOKEN_ALREADY_USED',
      });

      const consumedSecond = await consumeToken(
        {
          rawToken: secondReset.token,
          purpose: 'RESET_PASSWORD',
          targetType: 'CUSTOMER',
          now: consumeTime,
        },
        store.db
      );
      expect(consumedSecond.targetId).toBe(42);

      const consumedVerify = await consumeToken(
        {
          rawToken: verifyToken.token,
          purpose: 'VERIFY_EMAIL',
          targetType: 'CUSTOMER',
          now: consumeTime,
        },
        store.db
      );
      expect(consumedVerify.targetId).toBe(42);

      const consumedOther = await consumeToken(
        {
          rawToken: otherCustomerReset.token,
          purpose: 'RESET_PASSWORD',
          targetType: 'CUSTOMER',
          now: consumeTime,
        },
        store.db
      );
      expect(consumedOther.targetId).toBe(99);
    });
  });

  describe('single-use atomic consumption & replay rejection', () => {
    it('consumes a valid token once and rejects any subsequent replay attempt', async () => {
      const issued = await issueToken(
        {
          purpose: 'RESET_PASSWORD',
          targetType: 'ADMIN',
          targetId: 5,
          ttlMinutes: 45,
          now: baseNow,
        },
        store.db
      );

      const consumeTime = new Date(baseNow.getTime() + 10 * 60_000);
      const consumed = await consumeToken(
        {
          rawToken: issued.token,
          purpose: 'RESET_PASSWORD',
          targetType: 'ADMIN',
          now: consumeTime,
        },
        store.db
      );

      expect(consumed).toEqual({
        tokenId: issued.tokenId,
        purpose: 'RESET_PASSWORD',
        targetType: 'ADMIN',
        targetId: 5,
        penggunaId: 5,
        pelangganId: null,
        usedAt: consumeTime,
        expiresAt: issued.expiresAt,
      });

      await expect(
        consumeToken(
          {
            rawToken: issued.token,
            purpose: 'RESET_PASSWORD',
            targetType: 'ADMIN',
            now: new Date(consumeTime.getTime() + 1_000),
          },
          store.db
        )
      ).rejects.toMatchObject({
        name: 'TokenServiceError',
        code: 'TOKEN_ALREADY_USED',
      });
    });

    it('allows only one winner when concurrent consume attempts race on the same token', async () => {
      const issued = await issueToken(
        {
          purpose: 'ADMIN_INVITE',
          targetType: 'ADMIN',
          targetId: 8,
          now: baseNow,
        },
        store.db
      );

      const consumeTime = new Date(baseNow.getTime() + 5 * 60_000);
      const results = await Promise.allSettled([
        consumeToken(
          {
            rawToken: issued.token,
            purpose: 'ADMIN_INVITE',
            targetType: 'ADMIN',
            now: consumeTime,
          },
          store.db
        ),
        consumeToken(
          {
            rawToken: issued.token,
            purpose: 'ADMIN_INVITE',
            targetType: 'ADMIN',
            now: consumeTime,
          },
          store.db
        ),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      const error = (rejected[0] as PromiseRejectedResult).reason;
      expect(error).toBeInstanceOf(TokenServiceError);
      expect((error as TokenServiceError).code).toBe('TOKEN_ALREADY_USED');
    });
  });

  describe('expiration & purpose/targetType isolation', () => {
    it('rejects expired tokens (at or past expiresAt) with TOKEN_EXPIRED', async () => {
      const issued = await issueToken(
        {
          purpose: 'RESET_PASSWORD',
          targetType: 'CUSTOMER',
          targetId: 21,
          ttlMinutes: 30,
          now: baseNow,
        },
        store.db
      );

      await expect(
        consumeToken(
          {
            rawToken: issued.token,
            purpose: 'RESET_PASSWORD',
            targetType: 'CUSTOMER',
            now: new Date(baseNow.getTime() + 30 * 60_000),
          },
          store.db
        )
      ).rejects.toMatchObject({
        name: 'TokenServiceError',
        code: 'TOKEN_EXPIRED',
      });

      await expect(
        consumeToken(
          {
            rawToken: issued.token,
            purpose: 'RESET_PASSWORD',
            targetType: 'CUSTOMER',
            now: new Date(baseNow.getTime() + 31 * 60_000),
          },
          store.db
        )
      ).rejects.toMatchObject({
        name: 'TokenServiceError',
        code: 'TOKEN_EXPIRED',
      });
    });

    it('rejects cross-targetType and cross-purpose token usage without consuming the token', async () => {
      const adminReset = await issueToken(
        {
          purpose: 'RESET_PASSWORD',
          targetType: 'ADMIN',
          targetId: 3,
          now: baseNow,
        },
        store.db
      );

      const consumeTime = new Date(baseNow.getTime() + 5 * 60_000);

      await expect(
        consumeToken(
          {
            rawToken: adminReset.token,
            purpose: 'RESET_PASSWORD',
            targetType: 'CUSTOMER',
            now: consumeTime,
          },
          store.db
        )
      ).rejects.toMatchObject({
        name: 'TokenServiceError',
        code: 'TOKEN_SCOPE_MISMATCH',
      });

      await expect(
        consumeToken(
          {
            rawToken: adminReset.token,
            purpose: 'ADMIN_INVITE',
            targetType: 'ADMIN',
            now: consumeTime,
          },
          store.db
        )
      ).rejects.toMatchObject({
        name: 'TokenServiceError',
        code: 'TOKEN_SCOPE_MISMATCH',
      });

      expect(store.rows[0].usedAt).toBeNull();

      const validConsume = await consumeToken(
        {
          rawToken: adminReset.token,
          purpose: 'RESET_PASSWORD',
          targetType: 'ADMIN',
          now: consumeTime,
        },
        store.db
      );
      expect(validConsume.targetId).toBe(3);
    });

    it('rejects empty or unknown tokens with INVALID_TOKEN', async () => {
      await expect(
        consumeToken(
          {
            rawToken: '   ',
            purpose: 'RESET_PASSWORD',
            targetType: 'ADMIN',
            now: baseNow,
          },
          store.db
        )
      ).rejects.toMatchObject({
        name: 'TokenServiceError',
        code: 'INVALID_TOKEN',
      });

      await expect(
        consumeToken(
          {
            rawToken: 'non-existent-raw-token',
            purpose: 'VERIFY_EMAIL',
            targetType: 'CUSTOMER',
            now: baseNow,
          },
          store.db
        )
      ).rejects.toMatchObject({
        name: 'TokenServiceError',
        code: 'INVALID_TOKEN',
      });
    });
  });
});
