import jwt from 'jsonwebtoken';
import request from 'supertest';
import type { PeranPengguna } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface MockPengguna {
  id: number;
  nama: string;
  email: string;
  peran: PeranPengguna;
  aktif: boolean;
}

const {
  users,
  auditLogs,
  mockPrisma,
  mockSendChatMessage,
  mockListConversations,
  mockGetConversationById,
  mockReindexAll,
  mockCreateAndIngestDocument,
  resetStore,
} = vi.hoisted(() => {
  const users: MockPengguna[] = [];
  const auditLogs: Array<Record<string, unknown>> = [];

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

  const mockPrisma = {
    pengguna: {
      findUnique: vi.fn(async ({ where, select }: any) => {
        const found = users.find((u) => {
          if (where.id !== undefined) return u.id === where.id;
          if (where.email !== undefined) return u.email === where.email;
          return false;
        });
        return found ? applySelect(found, select) : null;
      }),
    },
    logAudit: {
      create: vi.fn(async ({ data }: any) => {
        const record = { id: auditLogs.length + 1, ...data };
        auditLogs.push(record);
        return record;
      }),
    },
  };

  const mockSendChatMessage = vi.fn();
  const mockListConversations = vi.fn();
  const mockGetConversationById = vi.fn();
  const mockReindexAll = vi.fn();
  const mockCreateAndIngestDocument = vi.fn();

  const resetStore = () => {
    users.length = 0;
    auditLogs.length = 0;
    vi.clearAllMocks();
  };

  return {
    users,
    auditLogs,
    mockPrisma,
    mockSendChatMessage,
    mockListConversations,
    mockGetConversationById,
    mockReindexAll,
    mockCreateAndIngestDocument,
    resetStore,
  };
});

vi.mock('../src/utils/database', () => ({
  default: mockPrisma,
}));

vi.mock('../src/services/ai/aiChatService', async () => {
  const actual = await vi.importActual<typeof import('../src/services/ai/aiChatService')>(
    '../src/services/ai/aiChatService'
  );
  return {
    ...actual,
    sendChatMessage: mockSendChatMessage,
    listConversations: mockListConversations,
    getConversationById: mockGetConversationById,
  };
});

vi.mock('../src/services/ai/ingestionService', async () => {
  const actual = await vi.importActual<typeof import('../src/services/ai/ingestionService')>(
    '../src/services/ai/ingestionService'
  );
  return {
    ...actual,
    reindexAll: mockReindexAll,
    createAndIngestDocument: mockCreateAndIngestDocument,
  };
});

import {
  AiChatForbiddenError,
  AiChatNotFoundError,
  AiChatValidationError,
} from '../src/services/ai/aiChatService';
import { PiiViolationError } from '../src/services/ai/ingestionService';
import { app } from '../src/index';

const TEST_JWT_SECRET = 'test-ai-routes-jwt-secret';

const signAdminToken = (user: MockPengguna) =>
  jwt.sign({ id: user.id, email: user.email, role: user.peran }, TEST_JWT_SECRET, {
    expiresIn: '1h',
  });

const signCustomerToken = (id: number, email: string) =>
  jwt.sign({ id, email, type: 'customer' }, TEST_JWT_SECRET, {
    expiresIn: '1h',
  });

describe('Hybrid RAG HTTP Routes (/api/v1/ai/*) & Role Gating (TASK-015)', () => {
  const originalJwtSecret = process.env.JWT_SECRET;
  let superAdmin: MockPengguna;
  let adminA: MockPengguna;
  let adminB: MockPengguna;
  let inactiveAdmin: MockPengguna;

  beforeEach(() => {
    resetStore();
    process.env.JWT_SECRET = TEST_JWT_SECRET;

    superAdmin = {
      id: 1,
      nama: 'Super Admin',
      email: 'superadmin@soju.id',
      peran: 'SUPER_ADMIN',
      aktif: true,
    };
    adminA = {
      id: 2,
      nama: 'Admin Satu',
      email: 'admin1@soju.id',
      peran: 'ADMIN',
      aktif: true,
    };
    adminB = {
      id: 3,
      nama: 'Admin Dua',
      email: 'admin2@soju.id',
      peran: 'ADMIN',
      aktif: true,
    };
    inactiveAdmin = {
      id: 4,
      nama: 'Admin Nonaktif',
      email: 'nonaktif@soju.id',
      peran: 'ADMIN',
      aktif: false,
    };

    users.push(superAdmin, adminA, adminB, inactiveAdmin);
  });

  afterEach(() => {
    if (originalJwtSecret === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = originalJwtSecret;
    }
  });

  describe('Auth & Token Isolation', () => {
    it('rejects unauthenticated requests to /api/v1/ai/conversations with 401', async () => {
      const res = await request(app).get('/api/v1/ai/conversations');
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('rejects CUSTOMER JWT on /api/v1/ai/chat with 401', async () => {
      const customerToken = signCustomerToken(99, 'pelanggan@soju.id');
      const res = await request(app)
        .post('/api/v1/ai/chat')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({ message: 'Halo AI' });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(mockSendChatMessage).not.toHaveBeenCalled();
    });

    it('rejects inactive ADMIN JWT on /api/v1/ai/chat with 403', async () => {
      const token = signAdminToken(inactiveAdmin);
      const res = await request(app)
        .post('/api/v1/ai/chat')
        .set('Authorization', `Bearer ${token}`)
        .send({ message: 'Berapa omzet hari ini?' });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(mockSendChatMessage).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/v1/ai/chat', () => {
    it('allows ADMIN to chat and returns standard { success, data } envelope with rate-limit headers', async () => {
      const chatResult = {
        conversationId: 10,
        title: 'Total omzet hari ini',
        routePath: 'SQL_TOOL',
        reply: 'Total penjualan hari ini adalah Rp 1.500.000 [SQL-1].',
        citations: [{ id: 'SQL-1', sourceType: 'SQL_TOOL', title: 'Ringkasan Penjualan', excerpt: 'Rp 1.500.000' }],
        actions: [],
        userMessage: {
          id: 101,
          conversationId: 10,
          role: 'USER',
          content: 'Total omzet hari ini',
          routePath: null,
          citations: [],
          actions: [],
          createdAt: '2026-11-24T01:00:00.000Z',
        },
        assistantMessage: {
          id: 102,
          conversationId: 10,
          role: 'ASSISTANT',
          content: 'Total penjualan hari ini adalah Rp 1.500.000 [SQL-1].',
          routePath: 'SQL_TOOL',
          citations: [{ id: 'SQL-1', sourceType: 'SQL_TOOL', title: 'Ringkasan Penjualan', excerpt: 'Rp 1.500.000' }],
          actions: [],
          createdAt: '2026-11-24T01:00:01.000Z',
        },
        intent: { routePath: 'SQL_TOOL', reason: 'numeric_query' },
      };
      mockSendChatMessage.mockResolvedValueOnce(chatResult);

      const res = await request(app)
        .post('/api/v1/ai/chat')
        .set('Authorization', `Bearer ${signAdminToken(adminA)}`)
        .send({ message: 'Total omzet hari ini', conversationId: 10 });

      expect(res.status).toBe(200);
      expect(res.headers['ratelimit-limit']).toBe('30');
      expect(res.body).toEqual({
        success: true,
        data: chatResult,
      });
      expect(mockSendChatMessage).toHaveBeenCalledWith({
        penggunaId: adminA.id,
        callerRole: 'ADMIN',
        message: 'Total omzet hari ini',
        conversationId: 10,
      });
    });

    it('maps AiChatValidationError and invalid conversationId to 400', async () => {
      const invalidIdRes = await request(app)
        .post('/api/v1/ai/chat')
        .set('Authorization', `Bearer ${signAdminToken(adminA)}`)
        .send({ message: 'Halo', conversationId: 'abc' });

      expect(invalidIdRes.status).toBe(400);
      expect(invalidIdRes.body.success).toBe(false);
      expect(mockSendChatMessage).not.toHaveBeenCalled();

      mockSendChatMessage.mockRejectedValueOnce(new AiChatValidationError('Pesan tidak boleh kosong.'));
      const emptyMsgRes = await request(app)
        .post('/api/v1/ai/chat')
        .set('Authorization', `Bearer ${signAdminToken(adminA)}`)
        .send({ message: '   ' });

      expect(emptyMsgRes.status).toBe(400);
      expect(emptyMsgRes.body).toEqual({
        success: false,
        message: 'Pesan tidak boleh kosong.',
      });
    });
  });

  describe('GET /api/v1/ai/conversations & GET /api/v1/ai/conversations/:id', () => {
    it('lists conversations strictly scoped to authenticated user', async () => {
      const summaries = [
        {
          id: 10,
          penggunaId: adminA.id,
          title: 'SOP Pengiriman',
          messageCount: 2,
          lastMessagePreview: 'Berdasarkan SOP [D1]...',
          createdAt: '2026-11-24T01:00:00.000Z',
          updatedAt: '2026-11-24T01:01:00.000Z',
        },
      ];
      mockListConversations.mockResolvedValueOnce(summaries);

      const res = await request(app)
        .get('/api/v1/ai/conversations?limit=5')
        .set('Authorization', `Bearer ${signAdminToken(adminA)}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        success: true,
        data: summaries,
      });
      expect(mockListConversations).toHaveBeenCalledWith(adminA.id, 5);
    });

    it('returns own conversation detail on GET /api/v1/ai/conversations/:id', async () => {
      const detail = {
        id: 10,
        penggunaId: adminA.id,
        title: 'SOP Pengiriman',
        createdAt: '2026-11-24T01:00:00.000Z',
        updatedAt: '2026-11-24T01:01:00.000Z',
        messages: [],
      };
      mockGetConversationById.mockResolvedValueOnce(detail);

      const res = await request(app)
        .get('/api/v1/ai/conversations/10')
        .set('Authorization', `Bearer ${signAdminToken(adminA)}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        success: true,
        data: detail,
      });
      expect(mockGetConversationById).toHaveBeenCalledWith(adminA.id, 10);
    });

    it('rejects cross-user conversation access with 404 or 403', async () => {
      mockGetConversationById.mockRejectedValueOnce(
        new AiChatNotFoundError('Percakapan AI tidak ditemukan atau bukan milik pengguna ini.')
      );

      const notFoundRes = await request(app)
        .get('/api/v1/ai/conversations/10')
        .set('Authorization', `Bearer ${signAdminToken(adminB)}`);

      expect(notFoundRes.status).toBe(404);
      expect(notFoundRes.body).toEqual({
        success: false,
        message: 'Percakapan AI tidak ditemukan atau bukan milik pengguna ini.',
      });
      expect(mockGetConversationById).toHaveBeenCalledWith(adminB.id, 10);

      mockGetConversationById.mockRejectedValueOnce(
        new AiChatForbiddenError('Anda tidak memiliki akses ke percakapan ini.')
      );

      const forbiddenRes = await request(app)
        .get('/api/v1/ai/conversations/10')
        .set('Authorization', `Bearer ${signAdminToken(adminB)}`);

      expect(forbiddenRes.status).toBe(403);
      expect(forbiddenRes.body).toEqual({
        success: false,
        message: 'Anda tidak memiliki akses ke percakapan ini.',
      });
    });

    it('rejects invalid conversation :id param with 400', async () => {
      const res = await request(app)
        .get('/api/v1/ai/conversations/not-a-number')
        .set('Authorization', `Bearer ${signAdminToken(adminA)}`);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(mockGetConversationById).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/v1/ai/reindex (SUPER_ADMIN only)', () => {
    it('rejects ADMIN with 403 and does not run reindex or write audit log', async () => {
      const res = await request(app)
        .post('/api/v1/ai/reindex')
        .set('Authorization', `Bearer ${signAdminToken(adminA)}`);

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(mockReindexAll).not.toHaveBeenCalled();
      expect(auditLogs).toHaveLength(0);
    });

    it('allows SUPER_ADMIN to trigger reindex and logs action to LogAudit', async () => {
      const reindexSummary = {
        documentsProcessed: 4,
        chunksCreated: 12,
        piiRedactedChunks: 0,
        sources: { documents: 2, products: 1, cms: 1 },
      };
      mockReindexAll.mockResolvedValueOnce(reindexSummary);

      const res = await request(app)
        .post('/api/v1/ai/reindex')
        .set('Authorization', `Bearer ${signAdminToken(superAdmin)}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        success: true,
        data: reindexSummary,
        message: 'Reindex basis pengetahuan AI berhasil dijalankan',
      });
      expect(mockReindexAll).toHaveBeenCalledTimes(1);
      expect(auditLogs).toHaveLength(1);
      expect(auditLogs[0]).toMatchObject({
        penggunaId: superAdmin.id,
        tabelTarget: 'AiDocument',
        aksi: 'UBAH',
        sumber: 'MANUAL',
        labelRecord: 'Reindex Basis Pengetahuan AI',
      });
    });
  });

  describe('POST /api/v1/ai/documents (SUPER_ADMIN only)', () => {
    it('rejects ADMIN with 403 and does not ingest document or write audit log', async () => {
      const res = await request(app)
        .post('/api/v1/ai/documents')
        .set('Authorization', `Bearer ${signAdminToken(adminA)}`)
        .send({
          title: 'SOP Dapur',
          sourceType: 'SOP',
          content: 'Standar kebersihan dapur harian.',
        });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(mockCreateAndIngestDocument).not.toHaveBeenCalled();
      expect(auditLogs).toHaveLength(0);
    });

    it('allows SUPER_ADMIN to upload & ingest document and logs action to LogAudit', async () => {
      const ingestResult = {
        document: {
          id: 55,
          title: 'SOP Dapur SOJU',
          sourceType: 'SOP',
          sourceRef: 'sop-dapur-v1',
          roleScope: 'ALL_ADMIN',
          content: 'Standar kebersihan dapur harian.',
          aktif: true,
          createdBy: superAdmin.id,
        },
        indexing: {
          documentId: 55,
          chunksCreated: 2,
          piiRedactedChunks: 0,
          roleScope: 'ALL_ADMIN',
        },
      };
      mockCreateAndIngestDocument.mockResolvedValueOnce(ingestResult);

      const res = await request(app)
        .post('/api/v1/ai/documents')
        .set('Authorization', `Bearer ${signAdminToken(superAdmin)}`)
        .send({
          title: 'SOP Dapur SOJU',
          sourceType: 'SOP',
          roleScope: 'ALL_ADMIN',
          sourceRef: 'sop-dapur-v1',
          content: 'Standar kebersihan dapur harian.',
        });

      expect(res.status).toBe(201);
      expect(res.body).toEqual({
        success: true,
        data: ingestResult,
        message: 'Dokumen AI berhasil ditambahkan dan diindeks',
      });
      expect(mockCreateAndIngestDocument).toHaveBeenCalledWith({
        title: 'SOP Dapur SOJU',
        sourceType: 'SOP',
        content: 'Standar kebersihan dapur harian.',
        roleScope: 'ALL_ADMIN',
        sourceRef: 'sop-dapur-v1',
        createdBy: superAdmin.id,
        rejectOnPii: true,
      });
      expect(auditLogs).toHaveLength(1);
      expect(auditLogs[0]).toMatchObject({
        penggunaId: superAdmin.id,
        tabelTarget: 'AiDocument',
        targetId: 55,
        aksi: 'TAMBAH',
        sumber: 'MANUAL',
        labelRecord: 'SOP Dapur SOJU',
      });
    });

    it('maps PiiViolationError and invalid sourceType/roleScope to 400', async () => {
      const invalidSourceRes = await request(app)
        .post('/api/v1/ai/documents')
        .set('Authorization', `Bearer ${signAdminToken(superAdmin)}`)
        .send({
          title: 'Dokumen Tidak Valid',
          sourceType: 'PELANGGAN',
          content: 'Isi dokumen',
        });

      expect(invalidSourceRes.status).toBe(400);
      expect(invalidSourceRes.body.success).toBe(false);
      expect(mockCreateAndIngestDocument).not.toHaveBeenCalled();

      mockCreateAndIngestDocument.mockRejectedValueOnce(
        new PiiViolationError({
          hasPii: true,
          emails: ['budi@example.com'],
          phones: [],
        })
      );

      const piiRes = await request(app)
        .post('/api/v1/ai/documents')
        .set('Authorization', `Bearer ${signAdminToken(superAdmin)}`)
        .send({
          title: 'SOP Kontak',
          sourceType: 'SOP',
          content: 'Hubungi budi@example.com',
        });

      expect(piiRes.status).toBe(400);
      expect(piiRes.body.success).toBe(false);
      expect(piiRes.body.message).toContain('PII');
    });
  });

  describe('AI Rate Limiter Enforcement (/api/v1/ai/*)', () => {
    it('returns 429 once the AI rate limit window (30 requests) is exceeded', async () => {
      mockListConversations.mockResolvedValue([]);
      const token = signAdminToken(adminA);

      let lastStatus = 200;
      let lastBody: any = null;
      for (let i = 0; i < 31; i += 1) {
        const res = await request(app)
          .get('/api/v1/ai/conversations')
          .set('Authorization', `Bearer ${token}`);
        lastStatus = res.status;
        lastBody = res.body;
        if (lastStatus === 429) {
          break;
        }
      }

      expect(lastStatus).toBe(429);
      expect(lastBody).toEqual({
        success: false,
        message: 'Terlalu banyak permintaan AI. Silakan coba lagi beberapa saat.',
      });
    });
  });
});
