import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GEMINI_EMBEDDING_MODEL,
  createGeminiClient,
  type GeminiClient,
  type GeminiSdkLike,
} from '../src/services/ai/geminiClient';
import {
  DEFAULT_SIMILARITY_THRESHOLD,
  DEFAULT_TOP_K,
  MAX_TOP_K,
  VectorRetrieverError,
  VectorRetrieverForbiddenRoleError,
  VectorRetrieverValidationError,
  cosineSimilarity,
  createVectorRetriever,
  parseEmbeddingVector,
  resolveAllowedRoleScopes,
  type AiChunkWithDocumentRecord,
  type VectorRetrieverPrismaClient,
} from '../src/services/ai/vectorRetriever';

afterEach(() => {
  vi.clearAllMocks();
});

function makeChunk(
  overrides: Partial<AiChunkWithDocumentRecord> & {
    id: number;
    documentId: number;
    embedding: unknown;
    roleScope?: 'ALL_ADMIN' | 'SUPER_ADMIN';
    title?: string;
    sourceType?: 'SOP' | 'FAQ' | 'PRODUK' | 'CMS' | 'MANUAL';
    sourceRef?: string | null;
    aktif?: boolean;
    documentRoleScope?: 'ALL_ADMIN' | 'SUPER_ADMIN';
  }
): AiChunkWithDocumentRecord {
  const roleScope = overrides.roleScope ?? 'ALL_ADMIN';
  const documentRoleScope = overrides.documentRoleScope ?? roleScope;
  return {
    id: overrides.id,
    documentId: overrides.documentId,
    chunkIndex: overrides.chunkIndex ?? 0,
    content: overrides.content ?? `Konten chunk ${overrides.id}`,
    embedding: overrides.embedding,
    roleScope,
    document: overrides.document ?? {
      id: overrides.documentId,
      title: overrides.title ?? `Dokumen ${overrides.documentId}`,
      sourceType: overrides.sourceType ?? 'SOP',
      sourceRef: overrides.sourceRef ?? null,
      roleScope: documentRoleScope,
      aktif: overrides.aktif ?? true,
    },
  };
}

describe('cosineSimilarity', () => {
  it('computes exact cosine similarity for identical, scaled, orthogonal, angled, and opposite vectors', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1, 6);
    expect(cosineSimilarity([3, 4], [6, 8])).toBeCloseTo(1, 6);
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0, 6);
    expect(cosineSimilarity([1, 1], [1, 0])).toBeCloseTo(Math.SQRT1_2, 6);
    expect(cosineSimilarity([1, -2, 3], [-1, 2, -3])).toBeCloseTo(-1, 6);
  });

  it('returns 0 safely for empty, mismatched, zero-magnitude, or non-finite vectors', () => {
    expect(cosineSimilarity([], [])).toBe(0);
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
    expect(cosineSimilarity([1, 2, 3], [0, 0, 0])).toBe(0);
    expect(cosineSimilarity([Number.NaN, 1], [1, 1])).toBe(0);
    expect(cosineSimilarity([1, Number.POSITIVE_INFINITY], [1, 1])).toBe(0);
  });
});

describe('resolveAllowedRoleScopes & parseEmbeddingVector', () => {
  it('maps ADMIN to ALL_ADMIN only, SUPER_ADMIN to ALL_ADMIN + SUPER_ADMIN, and rejects non-admin roles with 403', () => {
    expect(resolveAllowedRoleScopes('ADMIN')).toEqual(['ALL_ADMIN']);
    expect(resolveAllowedRoleScopes('SUPER_ADMIN')).toEqual(['ALL_ADMIN', 'SUPER_ADMIN']);

    for (const unauthorizedRole of ['CUSTOMER', 'GUEST', '']) {
      let caught: unknown;
      try {
        resolveAllowedRoleScopes(unauthorizedRole as never);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(VectorRetrieverError);
      expect(caught).toBeInstanceOf(VectorRetrieverForbiddenRoleError);
      expect(caught).toMatchObject({
        code: 'VECTOR_RETRIEVER_FORBIDDEN_ROLE',
        status: 403,
        statusCode: 403,
      });
    }
  });

  it('validates numeric arrays and rejects malformed embedding payloads', () => {
    expect(parseEmbeddingVector([0.1, -0.2, 0.3])).toEqual([0.1, -0.2, 0.3]);
    expect(parseEmbeddingVector([])).toBeNull();
    expect(parseEmbeddingVector(null)).toBeNull();
    expect(parseEmbeddingVector('not-an-array')).toBeNull();
    expect(parseEmbeddingVector([0.1, '0.2'])).toBeNull();
    expect(parseEmbeddingVector([0.1, Number.NaN])).toBeNull();
  });
});

describe('vectorRetriever service', () => {
  it('embeds query with gemini-embedding-001 using taskType RETRIEVAL_QUERY', async () => {
    const embedContent = vi.fn().mockResolvedValue({
      embeddings: [{ values: [1, 0, 0] }],
    });
    const sdk: GeminiSdkLike = {
      models: { embedContent },
      interactions: { create: vi.fn() },
    };
    const geminiClient = createGeminiClient({ sdk });

    const prismaMock: VectorRetrieverPrismaClient = {
      aiChunk: {
        findMany: vi.fn().mockResolvedValue([
          makeChunk({
            id: 1,
            documentId: 10,
            title: 'SOP Dapur Harian',
            content: 'Pengecekan bahan baku dilakukan pukul 08.00 WIB.',
            embedding: [1, 0, 0],
          }),
        ]),
      },
    };

    const retriever = createVectorRetriever({ prisma: prismaMock, geminiClient });
    const result = await retriever.retrieve({
      query: '  Jam berapa pengecekan bahan baku?  ',
      callerRole: 'ADMIN',
    });

    expect(embedContent).toHaveBeenCalledTimes(1);
    expect(embedContent).toHaveBeenCalledWith({
      model: GEMINI_EMBEDDING_MODEL,
      contents: 'Jam berapa pengecekan bahan baku?',
      config: {
        taskType: 'RETRIEVAL_QUERY',
      },
    });
    expect(result.hasRelevantContext).toBe(true);
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0].citationId).toBe('[D1]');
  });

  it('ranks by cosine similarity descending, caps results at top_k = 3, and emits [D1]-[D3] citations', async () => {
    const queryVector = [1, 0, 0];
    const embedText = vi.fn().mockResolvedValue(queryVector);
    const geminiClient: GeminiClient = {
      embedText,
      generateGroundedAnswer: vi.fn(),
    };

    const longContent =
      'SOP operasional dapur SOJU mengatur standar kebersihan, penyimpanan bahan baku dingin, pencatatan transaksi harian sebelum tutup kasir pukul 21.00 WIB, serta verifikasi pesanan storefront pelanggan secara berkala oleh admin operasional di setiap shift kerja.';

    const allChunks: AiChunkWithDocumentRecord[] = [
      // score = 0.60
      makeChunk({
        id: 11,
        documentId: 1,
        title: 'FAQ Operasional',
        sourceType: 'FAQ',
        content: 'FAQ mengenai jadwal pengiriman harian.',
        embedding: [0.6, 0.8, 0],
      }),
      // score = 0.96 -> #2
      makeChunk({
        id: 12,
        documentId: 2,
        title: 'SOP Dapur Utama',
        sourceType: 'SOP',
        sourceRef: 'sop:dapur-utama',
        content: longContent,
        embedding: [0.96, 0.28, 0],
      }),
      // score = 1.0 -> #1
      makeChunk({
        id: 13,
        documentId: 3,
        title: 'Produk: Sosis Bakar Keju',
        sourceType: 'PRODUK',
        sourceRef: 'produk:10',
        content: 'Produk SOJU: Sosis Bakar Keju harga Rp 18.000 per pcs.',
        embedding: [1, 0, 0],
      }),
      // score = 0.80 -> #3
      makeChunk({
        id: 14,
        documentId: 4,
        title: 'CMS: Tentang SOJU',
        sourceType: 'CMS',
        sourceRef: 'cms:20',
        content: 'SOJU buka setiap hari pukul 10.00 - 21.00 WIB.',
        embedding: [0.8, 0.6, 0],
      }),
      // score = 0.7071 -> #4 (qualifies above 0.55, but excluded by top_k = 3 cap)
      makeChunk({
        id: 15,
        documentId: 5,
        title: 'Manual Kasir',
        sourceType: 'MANUAL',
        content: 'Panduan tutup kasir harian.',
        embedding: [1, 1, 0],
      }),
    ];

    const prismaMock: VectorRetrieverPrismaClient = {
      aiChunk: {
        findMany: vi.fn().mockResolvedValue(allChunks),
      },
    };

    const retriever = createVectorRetriever({ prisma: prismaMock, geminiClient });

    // Even when requesting topK > MAX_TOP_K, retriever enforces top_k = 3 cap
    const result = await retriever.retrieve({
      query: 'Bagaimana SOP dan menu SOJU?',
      callerRole: 'ADMIN',
      topK: 10,
    });

    expect(result.topK).toBe(MAX_TOP_K);
    expect(result.threshold).toBe(DEFAULT_SIMILARITY_THRESHOLD);
    expect(result.totalCandidates).toBe(5);
    expect(result.totalQualified).toBe(5);
    expect(result.hasRelevantContext).toBe(true);
    expect(result.chunks).toHaveLength(DEFAULT_TOP_K);
    expect(result.citations).toHaveLength(DEFAULT_TOP_K);

    // Ranked descending by cosine similarity with deterministic [D1]-[D3] tags
    expect(result.chunks.map((c) => c.chunkId)).toEqual([13, 12, 14]);
    expect(result.chunks.map((c) => c.citationId)).toEqual(['[D1]', '[D2]', '[D3]']);
    expect(result.citations.map((c) => c.id)).toEqual(['[D1]', '[D2]', '[D3]']);
    expect(result.chunks[0].score).toBeCloseTo(1.0, 6);
    expect(result.chunks[1].score).toBeCloseTo(0.96, 6);
    expect(result.chunks[2].score).toBeCloseTo(0.8, 6);

    // Citation metadata matches chunk & truncates long snippets cleanly
    expect(result.citations[0]).toMatchObject({
      id: '[D1]',
      documentId: 3,
      chunkId: 13,
      title: 'Produk: Sosis Bakar Keju',
      sourceType: 'PRODUK',
      sourceRef: 'produk:10',
      roleScope: 'ALL_ADMIN',
    });
    expect(result.citations[1].snippet.endsWith('...')).toBe(true);
    expect(result.citations[1].snippet.length).toBeLessThanOrEqual(240);
  });

  it('enforces similarity threshold cutoff and returns empty result set when no chunks qualify', async () => {
    const queryVector = [1, 0, 0];
    const geminiClient: GeminiClient = {
      embedText: vi.fn().mockResolvedValue(queryVector),
      generateGroundedAnswer: vi.fn(),
    };

    const belowThresholdChunks: AiChunkWithDocumentRecord[] = [
      // score = 0.54 (< 0.55)
      makeChunk({
        id: 21,
        documentId: 1,
        embedding: [0.54, Math.sqrt(1 - 0.54 * 0.54), 0],
      }),
      // score = 0.0 (orthogonal)
      makeChunk({
        id: 22,
        documentId: 2,
        embedding: [0, 1, 0],
      }),
      // score = -0.8 (opposite)
      makeChunk({
        id: 23,
        documentId: 3,
        embedding: [-0.8, 0.6, 0],
      }),
      // malformed / wrong-dimension embeddings must be skipped safely
      makeChunk({
        id: 24,
        documentId: 4,
        embedding: [1, 0],
      }),
      makeChunk({
        id: 25,
        documentId: 5,
        embedding: null,
      }),
    ];

    const prismaMock: VectorRetrieverPrismaClient = {
      aiChunk: {
        findMany: vi.fn().mockResolvedValue(belowThresholdChunks),
      },
    };

    const retriever = createVectorRetriever({ prisma: prismaMock, geminiClient });
    const emptyResult = await retriever.retrieve({
      query: 'Siapa pemenang piala dunia 1998?',
      callerRole: 'ADMIN',
    });

    expect(emptyResult.hasRelevantContext).toBe(false);
    expect(emptyResult.chunks).toEqual([]);
    expect(emptyResult.citations).toEqual([]);
    expect(emptyResult.totalQualified).toBe(0);
    expect(emptyResult.totalCandidates).toBe(5);

    // Exact boundary (0.55 >= 0.55) must qualify
    const boundaryPrisma: VectorRetrieverPrismaClient = {
      aiChunk: {
        findMany: vi.fn().mockResolvedValue([
          makeChunk({
            id: 31,
            documentId: 6,
            embedding: [0.55, Math.sqrt(1 - 0.55 * 0.55), 0],
          }),
        ]),
      },
    };
    const boundaryRetriever = createVectorRetriever({ prisma: boundaryPrisma, geminiClient });
    const boundaryResult = await boundaryRetriever.retrieve({
      query: 'Kebijakan batas threshold',
      callerRole: 'ADMIN',
    });

    expect(boundaryResult.hasRelevantContext).toBe(true);
    expect(boundaryResult.chunks).toHaveLength(1);
    expect(boundaryResult.chunks[0].citationId).toBe('[D1]');
  });

  it('strictly isolates roleScope before scoring: ADMIN sees ALL_ADMIN only; SUPER_ADMIN sees ALL_ADMIN + SUPER_ADMIN', async () => {
    const queryVector = [1, 0, 0];
    const geminiClient: GeminiClient = {
      embedText: vi.fn().mockResolvedValue(queryVector),
      generateGroundedAnswer: vi.fn(),
    };

    const mixedChunks: AiChunkWithDocumentRecord[] = [
      // Perfect similarity = 1.0, but restricted to SUPER_ADMIN
      makeChunk({
        id: 101,
        documentId: 50,
        title: 'Kebijakan Rahasia Super Admin',
        roleScope: 'SUPER_ADMIN',
        content: 'Hanya SUPER_ADMIN yang boleh mengakses audit dan manajemen user.',
        embedding: [1, 0, 0],
      }),
      // Inactive document — must never be retrieved even with score = 1.0
      makeChunk({
        id: 102,
        documentId: 51,
        title: 'SOP Lama Nonaktif',
        roleScope: 'ALL_ADMIN',
        aktif: false,
        content: 'Dokumen lama yang sudah tidak aktif.',
        embedding: [1, 0, 0],
      }),
      // Mismatched parent document roleScope — defense-in-depth must block for ADMIN
      makeChunk({
        id: 103,
        documentId: 52,
        title: 'Dokumen Induk Super Admin',
        roleScope: 'ALL_ADMIN',
        documentRoleScope: 'SUPER_ADMIN',
        content: 'Chunk dengan parent SUPER_ADMIN.',
        embedding: [0.99, 0.14, 0],
      }),
      // Eligible ALL_ADMIN chunk with score = 0.80
      makeChunk({
        id: 104,
        documentId: 53,
        title: 'SOP Umum Admin',
        roleScope: 'ALL_ADMIN',
        content: 'Semua admin dapat melihat SOP operasional harian.',
        embedding: [0.8, 0.6, 0],
      }),
    ];

    // Intentionally return ALL chunks from mock regardless of `where` to verify BOTH Prisma filter AND in-memory guard
    const findMany = vi.fn().mockResolvedValue(mixedChunks);
    const prismaMock: VectorRetrieverPrismaClient = {
      aiChunk: { findMany },
    };

    const retriever = createVectorRetriever({ prisma: prismaMock, geminiClient });

    // 1. ADMIN call
    const adminResult = await retriever.retrieve({
      query: 'Apa kebijakan audit dan SOP admin?',
      callerRole: 'ADMIN',
    });

    expect(findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: {
          roleScope: { in: ['ALL_ADMIN'] },
          document: {
            aktif: true,
            roleScope: { in: ['ALL_ADMIN'] },
          },
        },
      })
    );
    expect(adminResult.allowedRoleScopes).toEqual(['ALL_ADMIN']);
    expect(adminResult.chunks).toHaveLength(1);
    expect(adminResult.chunks[0].chunkId).toBe(104);
    expect(adminResult.chunks[0].roleScope).toBe('ALL_ADMIN');
    expect(adminResult.chunks[0].citationId).toBe('[D1]');
    expect(adminResult.chunks.some((c) => c.roleScope === 'SUPER_ADMIN')).toBe(false);

    // 2. SUPER_ADMIN call
    const superAdminResult = await retriever.retrieve({
      query: 'Apa kebijakan audit dan SOP admin?',
      callerRole: 'SUPER_ADMIN',
    });

    expect(findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: {
          roleScope: { in: ['ALL_ADMIN', 'SUPER_ADMIN'] },
          document: {
            aktif: true,
            roleScope: { in: ['ALL_ADMIN', 'SUPER_ADMIN'] },
          },
        },
      })
    );
    expect(superAdminResult.allowedRoleScopes).toEqual(['ALL_ADMIN', 'SUPER_ADMIN']);
    // Receives active SUPER_ADMIN + ALL_ADMIN chunks (excludes inactive #102), ranked by similarity
    expect(superAdminResult.chunks.map((c) => c.chunkId)).toEqual([101, 103, 104]);
    expect(superAdminResult.chunks.map((c) => c.citationId)).toEqual(['[D1]', '[D2]', '[D3]']);
    expect(superAdminResult.chunks[0].roleScope).toBe('SUPER_ADMIN');
  });

  it('handles blank queries without calling Gemini or Prisma and validates topK/threshold', async () => {
    const findMany = vi.fn();
    const embedText = vi.fn();
    const retriever = createVectorRetriever({
      prisma: { aiChunk: { findMany } },
      geminiClient: { embedText, generateGroundedAnswer: vi.fn() },
    });

    const blankResult = await retriever.retrieve({
      query: '   \n\t  ',
      callerRole: 'ADMIN',
    });

    expect(blankResult.hasRelevantContext).toBe(false);
    expect(blankResult.chunks).toEqual([]);
    expect(blankResult.citations).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
    expect(embedText).not.toHaveBeenCalled();

    await expect(
      retriever.retrieve({ query: 'SOP', callerRole: 'ADMIN', topK: 0 })
    ).rejects.toMatchObject({
      name: 'VectorRetrieverValidationError',
      code: 'VECTOR_RETRIEVER_VALIDATION_ERROR',
      status: 400,
      statusCode: 400,
    });
    await expect(
      retriever.retrieve({ query: 'SOP', callerRole: 'ADMIN', topK: 1.5 })
    ).rejects.toBeInstanceOf(VectorRetrieverValidationError);
    await expect(
      retriever.retrieve({ query: 'SOP', callerRole: 'ADMIN', threshold: 1.5 })
    ).rejects.toMatchObject({
      name: 'VectorRetrieverValidationError',
      code: 'VECTOR_RETRIEVER_VALIDATION_ERROR',
      status: 400,
      statusCode: 400,
    });
    await expect(
      retriever.retrieve({ query: 'SOP', callerRole: 'ADMIN', threshold: -1.5 })
    ).rejects.toBeInstanceOf(VectorRetrieverError);
    await expect(
      retriever.retrieve({ query: 'SOP', callerRole: 'CUSTOMER' as never })
    ).rejects.toMatchObject({
      name: 'VectorRetrieverForbiddenRoleError',
      code: 'VECTOR_RETRIEVER_FORBIDDEN_ROLE',
      status: 403,
      statusCode: 403,
    });
    expect(findMany).not.toHaveBeenCalled();
    expect(embedText).not.toHaveBeenCalled();
  });

  it('validates returned queryEmbedding before querying Prisma or scoring and rejects empty, non-array, and non-finite vectors with 502', async () => {
    const invalidEmbeddings: unknown[] = [
      [],
      null,
      'malformed-vector',
      [0.5, Number.NaN],
      [Number.POSITIVE_INFINITY, 0.2],
    ];

    for (const invalidEmbedding of invalidEmbeddings) {
      const findMany = vi.fn();
      const embedText = vi.fn().mockResolvedValue(invalidEmbedding);
      const retriever = createVectorRetriever({
        prisma: { aiChunk: { findMany } },
        geminiClient: { embedText, generateGroundedAnswer: vi.fn() },
      });

      let caught: unknown;
      try {
        await retriever.retrieve({
          query: 'Apa SOP operasional SOJU?',
          callerRole: 'ADMIN',
        });
      } catch (error) {
        caught = error;
      }

      expect(embedText).toHaveBeenCalledTimes(1);
      expect(embedText).toHaveBeenCalledWith('Apa SOP operasional SOJU?', 'RETRIEVAL_QUERY');
      expect(findMany).not.toHaveBeenCalled();
      expect(caught).toBeInstanceOf(VectorRetrieverError);
      expect(caught).toMatchObject({
        code: 'VECTOR_RETRIEVER_INVALID_EMBEDDING',
        status: 502,
        statusCode: 502,
      });
    }
  });
});
