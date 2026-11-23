import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GEMINI_EMBEDDING_MODEL,
  GEMINI_GENERATION_MODEL,
  createGeminiClient,
  isGeminiConfigured,
  type GeminiClient,
  type GeminiSdkLike,
} from '../src/services/ai/geminiClient';
import {
  PiiViolationError,
  assertNoPii,
  chunkText,
  createIngestionService,
  detectPii,
  sanitizePii,
  type AiDocumentRecord,
  type IngestionPrismaClient,
} from '../src/services/ai/ingestionService';

const originalGeminiApiKey = process.env.GEMINI_API_KEY;

afterEach(() => {
  if (originalGeminiApiKey === undefined) {
    delete process.env.GEMINI_API_KEY;
  } else {
    process.env.GEMINI_API_KEY = originalGeminiApiKey;
  }
  vi.clearAllMocks();
});

describe('geminiClient (@google/genai wrapper)', () => {
  it('uses gemini-embedding-001 with RETRIEVAL_DOCUMENT and RETRIEVAL_QUERY taskTypes', async () => {
    const embedContent = vi.fn().mockResolvedValue({
      embeddings: [{ values: [0.12, -0.34, 0.56] }],
    });
    const createInteraction = vi.fn();

    const sdk: GeminiSdkLike = {
      models: { embedContent },
      interactions: { create: createInteraction },
    };

    const client = createGeminiClient({ sdk });

    const docVector = await client.embedText('SOP dapur SOJU', 'RETRIEVAL_DOCUMENT', {
      title: 'SOP Dapur',
    });
    expect(docVector).toEqual([0.12, -0.34, 0.56]);
    expect(embedContent).toHaveBeenNthCalledWith(1, {
      model: GEMINI_EMBEDDING_MODEL,
      contents: 'SOP dapur SOJU',
      config: {
        taskType: 'RETRIEVAL_DOCUMENT',
        title: 'SOP Dapur',
      },
    });

    const queryVector = await client.embedText('Bagaimana SOP dapur?', 'RETRIEVAL_QUERY');
    expect(queryVector).toEqual([0.12, -0.34, 0.56]);
    expect(embedContent).toHaveBeenNthCalledWith(2, {
      model: GEMINI_EMBEDDING_MODEL,
      contents: 'Bagaimana SOP dapur?',
      config: {
        taskType: 'RETRIEVAL_QUERY',
      },
    });
  });

  it('calls gemini-3.8-flash via interactions.create with store: false', async () => {
    const embedContent = vi.fn();
    const createInteraction = vi.fn().mockResolvedValue({
      output_text: '  Jawaban berbasis dokumen [D1].  ',
    });

    const client = createGeminiClient({
      sdk: {
        models: { embedContent },
        interactions: { create: createInteraction },
      },
    });

    const answer = await client.generateGroundedAnswer({
      prompt: 'Jelaskan jam operasional SOJU.',
      systemInstruction: 'Jawab hanya dari dokumen terpercaya.',
      temperature: 0.2,
    });

    expect(answer).toBe('Jawaban berbasis dokumen [D1].');
    expect(createInteraction).toHaveBeenCalledWith({
      model: GEMINI_GENERATION_MODEL,
      input: 'Jelaskan jam operasional SOJU.',
      store: false,
      system_instruction: 'Jawab hanya dari dokumen terpercaya.',
      generation_config: {
        temperature: 0.2,
      },
    });
  });

  it('throws on empty embedding input or missing embedding vector', async () => {
    const client = createGeminiClient({
      sdk: {
        models: {
          embedContent: vi.fn().mockResolvedValue({ embeddings: [] }),
        },
        interactions: {
          create: vi.fn(),
        },
      },
    });

    await expect(client.embedText('   ', 'RETRIEVAL_DOCUMENT')).rejects.toThrow(/kosong/i);
    await expect(client.embedText('teks valid', 'RETRIEVAL_DOCUMENT')).rejects.toThrow(/vektor/i);
  });

  it('rejects when GEMINI_API_KEY is unset, empty, or set to the placeholder value', async () => {
    delete process.env.GEMINI_API_KEY;
    expect(isGeminiConfigured()).toBe(false);
    await expect(createGeminiClient().embedText('SOP dapur', 'RETRIEVAL_DOCUMENT')).rejects.toThrow(
      /GEMINI_API_KEY/i
    );

    process.env.GEMINI_API_KEY = '   ';
    expect(isGeminiConfigured()).toBe(false);
    await expect(
      createGeminiClient().generateGroundedAnswer({ prompt: 'Jam buka SOJU?' })
    ).rejects.toThrow(/GEMINI_API_KEY/i);

    process.env.GEMINI_API_KEY = 'CHANGE_ME_GEMINI_API_KEY';
    expect(isGeminiConfigured()).toBe(false);
    await expect(createGeminiClient().embedText('SOP dapur', 'RETRIEVAL_QUERY')).rejects.toThrow(
      /GEMINI_API_KEY/i
    );

    process.env.GEMINI_API_KEY = 'test-real-looking-key';
    expect(isGeminiConfigured()).toBe(true);
  });
});

describe('chunkText', () => {
  it('splits long documents into overlapping chunks within the configured size window', () => {
    const sentence =
      'SOP operasional dapur SOJU mewajibkan pengecekan kualitas bahan baku sebelum produksi harian dimulai. ';
    const longText = sentence.repeat(20); // ~2000 chars

    const chunks = chunkText(longText, { chunkSize: 600, overlap: 100 });

    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const chunk of chunks) {
      expect(chunk.length).toBeGreaterThan(0);
      expect(chunk.length).toBeLessThanOrEqual(600);
    }

    // Verify overlap continuity between consecutive chunks
    const tailOfFirst = chunks[0].slice(-40);
    expect(chunks[1]).toContain(tailOfFirst.trim().slice(0, 20));
  });

  it('returns empty array for blank text and single chunk for short text', () => {
    expect(chunkText('   \n\t  ')).toEqual([]);
    expect(chunkText('Teks singkat tanpa pemecahan.')).toEqual(['Teks singkat tanpa pemecahan.']);
  });
});

describe('No-PII detection and sanitization', () => {
  it('detects and redacts email addresses and phone numbers while preserving prices and product codes', () => {
    const sample =
      'Produk PRD-001 harga Rp 25.000. Hubungi pelanggan budi.santoso@gmail.com atau +62 812-3456-7890 / 081398765432.';

    const detected = detectPii(sample);
    expect(detected.hasPii).toBe(true);
    expect(detected.emails).toEqual(['budi.santoso@gmail.com']);
    expect(detected.phones.length).toBe(2);

    const sanitized = sanitizePii(sample);
    expect(sanitized.hadPii).toBe(true);
    expect(sanitized.emailsRemoved).toBe(1);
    expect(sanitized.phonesRemoved).toBe(2);
    expect(sanitized.sanitizedText).not.toContain('budi.santoso@gmail.com');
    expect(sanitized.sanitizedText).not.toContain('812-3456-7890');
    expect(sanitized.sanitizedText).not.toContain('081398765432');
    expect(sanitized.sanitizedText).toContain('[REDACTED_EMAIL]');
    expect(sanitized.sanitizedText).toContain('[REDACTED_PHONE]');
    expect(sanitized.sanitizedText).toContain('PRD-001');
    expect(sanitized.sanitizedText).toContain('Rp 25.000');

    expect(() => assertNoPii(sample)).toThrow(PiiViolationError);
    expect(() => assertNoPii(sanitized.sanitizedText)).not.toThrow();
  });
});

describe('ingestionService (reindexAll & createAndIngestDocument)', () => {
  function createMockEnvironment() {
    let nextDocId = 100;
    const createdChunks: Array<{
      documentId: number;
      chunkIndex: number;
      content: string;
      embedding: number[];
      roleScope: string;
    }> = [];

    const manualDocs: AiDocumentRecord[] = [
      {
        id: 1,
        title: 'SOP Dapur Harian',
        sourceType: 'SOP',
        sourceRef: null,
        roleScope: 'ALL_ADMIN',
        content: 'Semua admin wajib mencatat transaksi penjualan sebelum pukul 21.00 WIB.',
        aktif: true,
      },
      {
        id: 2,
        title: 'Kebijakan Internal Super Admin',
        sourceType: 'MANUAL',
        sourceRef: null,
        roleScope: 'SUPER_ADMIN',
        content: 'Hanya SUPER_ADMIN yang berwenang menonaktifkan akun admin dan menjalankan reindex.',
        aktif: true,
      },
      {
        id: 3,
        title: 'FAQ Pengiriman & Pembayaran',
        sourceType: 'FAQ',
        sourceRef: null,
        roleScope: 'ALL_ADMIN',
        content: 'Pesanan storefront dikonfirmasi manual oleh admin tanpa payment gateway online.',
        aktif: true,
      },
    ];

    const pelangganFindMany = vi.fn();
    const pesananFindMany = vi.fn();

    const prismaMock = {
      aiDocument: {
        findMany: vi.fn().mockResolvedValue(manualDocs),
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
          id: ++nextDocId,
          title: data.title as string,
          sourceType: data.sourceType as AiDocumentRecord['sourceType'],
          sourceRef: (data.sourceRef as string | null) ?? null,
          roleScope: (data.roleScope as AiDocumentRecord['roleScope']) ?? 'ALL_ADMIN',
          content: data.content as string,
          aktif: true,
        })),
        update: vi.fn(),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      aiChunk: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        createMany: vi.fn().mockImplementation(async ({ data }: { data: typeof createdChunks }) => {
          createdChunks.push(...data);
          return { count: data.length };
        }),
      },
      produk: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 10,
            kode: 'SJU-01',
            namaBarang: 'Sosis Bakar Keju',
            varian: 'Original, Pedas',
            satuan: 'pcs',
            hargaDefault: 18000,
            deskripsi: 'Sosis bakar dengan saus keju melimpah.',
          },
        ]),
      },
      cmsContent: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 20,
            key: 'store_info',
            judul: 'Tentang SOJU FnB',
            subJudul: 'Jam Buka & Lokasi',
            konten: 'Buka setiap hari pukul 10.00 - 21.00. Kontak resmi cs@soju.id atau 081299998888.',
          },
        ]),
      },
      // Forbidden PII tables — included on mock solely to assert they are NEVER touched
      pelanggan: { findMany: pelangganFindMany },
      pesananPelanggan: { findMany: pesananFindMany },
    };

    const embedText = vi.fn().mockResolvedValue([0.25, 0.5, 0.75]);
    const geminiClient: GeminiClient = {
      embedText,
      generateGroundedAnswer: vi.fn(),
    };

    const service = createIngestionService({
      prisma: prismaMock as unknown as IngestionPrismaClient,
      geminiClient,
    });

    return {
      service,
      prismaMock,
      embedText,
      createdChunks,
      pelangganFindMany,
      pesananFindMany,
    };
  }

  it('reindexAll chunks & embeds SOP/FAQ/MANUAL, active Produk, and active CmsContent with RETRIEVAL_DOCUMENT, roleScope, and zero PII', async () => {
    const {
      service,
      prismaMock,
      embedText,
      createdChunks,
      pelangganFindMany,
      pesananFindMany,
    } = createMockEnvironment();

    const summary = await service.reindexAll();

    expect(summary.documentsProcessed).toBe(5);
    expect(summary.sources).toEqual({ documents: 3, products: 1, cms: 1 });
    expect(summary.chunksCreated).toBe(5);
    expect(createdChunks).toHaveLength(5);

    // Every embed call must use RETRIEVAL_DOCUMENT
    expect(embedText).toHaveBeenCalledTimes(5);
    for (const call of embedText.mock.calls) {
      expect(call[1]).toBe('RETRIEVAL_DOCUMENT');
      const embeddedText = call[0] as string;
      expect(embeddedText).not.toContain('cs@soju.id');
      expect(embeddedText).not.toContain('081299998888');
    }

    // Explicit roleScope preserved on every AiChunk
    const superAdminChunks = createdChunks.filter((c) => c.roleScope === 'SUPER_ADMIN');
    const allAdminChunks = createdChunks.filter((c) => c.roleScope === 'ALL_ADMIN');
    expect(superAdminChunks).toHaveLength(1);
    expect(superAdminChunks[0].documentId).toBe(2);
    expect(allAdminChunks).toHaveLength(4);
    expect(allAdminChunks.some((c) => c.documentId === 3)).toBe(true);

    // Stored chunks contain float embeddings and zero PII
    for (const chunk of createdChunks) {
      expect(chunk.embedding).toEqual([0.25, 0.5, 0.75]);
      expect(detectPii(chunk.content).hasPii).toBe(false);
    }

    // Produk query must not select raw gambarData BLOB
    const produkCallArgs = prismaMock.produk.findMany.mock.calls[0][0] as {
      select: Record<string, boolean>;
    };
    expect(produkCallArgs.select.gambarData).toBeUndefined();

    // Forbidden PII tables must never be queried
    expect(pelangganFindMany).not.toHaveBeenCalled();
    expect(pesananFindMany).not.toHaveBeenCalled();
  });

  it('createAndIngestDocument rejects PII by default and never calls embedText or persists document', async () => {
    const { service, prismaMock, embedText } = createMockEnvironment();

    await expect(
      service.createAndIngestDocument({
        title: 'Daftar Kontak Pelanggan',
        sourceType: 'SOP',
        roleScope: 'SUPER_ADMIN',
        content: 'Email pelanggan utama: rahasia@contoh.co.id, HP 081234567890.',
      })
    ).rejects.toThrow(PiiViolationError);

    expect(prismaMock.aiDocument.create).not.toHaveBeenCalled();
    expect(embedText).not.toHaveBeenCalled();
  });

  it('createAndIngestDocument persists SUPER_ADMIN document and chunks when clean', async () => {
    const { service, createdChunks, embedText } = createMockEnvironment();

    const { document, indexing } = await service.createAndIngestDocument({
      title: 'SOP Audit Internal',
      sourceType: 'SOP',
      roleScope: 'SUPER_ADMIN',
      content: 'Audit log diperiksa setiap akhir pekan oleh SUPER_ADMIN.',
      createdBy: 1,
    });

    expect(document.roleScope).toBe('SUPER_ADMIN');
    expect(indexing.chunksCreated).toBe(1);
    expect(indexing.roleScope).toBe('SUPER_ADMIN');
    expect(embedText).toHaveBeenCalledWith(
      'Audit log diperiksa setiap akhir pekan oleh SUPER_ADMIN.',
      'RETRIEVAL_DOCUMENT',
      { title: 'SOP Audit Internal' }
    );
    expect(createdChunks[0].roleScope).toBe('SUPER_ADMIN');
  });
});
