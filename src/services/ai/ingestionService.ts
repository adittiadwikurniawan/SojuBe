import type { AiDocumentSourceType, AiRoleScope, Prisma } from '@prisma/client';
import defaultPrisma from '../../utils/database';
import defaultGeminiClient, { type GeminiClient } from './geminiClient';

export const DEFAULT_CHUNK_SIZE = 700;
export const DEFAULT_CHUNK_OVERLAP = 120;

const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE_PATTERN =
  /(?:(?:\+|00)\s?62|(?:\+|00)\s?\d{1,3}|0)\s?(?:\(?\d{2,4}\)?[\s.-]?)\d{3,4}[\s.-]?\d{3,5}\b/g;

export interface ChunkOptions {
  chunkSize?: number;
  overlap?: number;
}

export interface PiiDetectionResult {
  hasPii: boolean;
  emails: string[];
  phones: string[];
}

export interface PiiSanitizationResult {
  sanitizedText: string;
  hadPii: boolean;
  emailsRemoved: number;
  phonesRemoved: number;
}

export class PiiViolationError extends Error {
  readonly emails: string[];
  readonly phones: string[];

  constructor(detection: PiiDetectionResult) {
    super(
      'Dokumen ditolak karena mengandung PII (email atau nomor telepon) yang dilarang masuk ke indeks vektor.'
    );
    this.name = 'PiiViolationError';
    this.emails = detection.emails;
    this.phones = detection.phones;
  }
}

export function detectPii(text: string): PiiDetectionResult {
  const emails = Array.from(text.matchAll(EMAIL_PATTERN), (m) => m[0]);
  const phones = Array.from(text.matchAll(PHONE_PATTERN), (m) => m[0]).filter((match) => {
    const digits = match.replace(/\D/g, '');
    return digits.length >= 9 && digits.length <= 15;
  });

  return {
    hasPii: emails.length > 0 || phones.length > 0,
    emails,
    phones,
  };
}

export function sanitizePii(text: string): PiiSanitizationResult {
  let emailsRemoved = 0;
  let phonesRemoved = 0;

  const withoutEmails = text.replace(EMAIL_PATTERN, () => {
    emailsRemoved += 1;
    return '[REDACTED_EMAIL]';
  });

  const sanitizedText = withoutEmails.replace(PHONE_PATTERN, (match) => {
    const digits = match.replace(/\D/g, '');
    if (digits.length < 9 || digits.length > 15) {
      return match;
    }
    phonesRemoved += 1;
    return '[REDACTED_PHONE]';
  });

  return {
    sanitizedText,
    hadPii: emailsRemoved > 0 || phonesRemoved > 0,
    emailsRemoved,
    phonesRemoved,
  };
}

export function assertNoPii(text: string): void {
  const detection = detectPii(text);
  if (detection.hasPii) {
    throw new PiiViolationError(detection);
  }
}

export function chunkText(rawText: string, options: ChunkOptions = {}): string[] {
  const chunkSize = Math.max(100, options.chunkSize ?? DEFAULT_CHUNK_SIZE);
  const overlap = Math.min(
    Math.max(0, options.overlap ?? DEFAULT_CHUNK_OVERLAP),
    Math.floor(chunkSize / 2)
  );

  const normalized = rawText
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!normalized) {
    return [];
  }

  if (normalized.length <= chunkSize) {
    return [normalized];
  }

  const chunks: string[] = [];
  let start = 0;

  while (start < normalized.length) {
    let end = Math.min(start + chunkSize, normalized.length);

    if (end < normalized.length) {
      const slice = normalized.slice(start, end);
      const minBreak = Math.floor(chunkSize * 0.55);

      const paragraphBreak = slice.lastIndexOf('\n\n');
      const sentenceBreak = Math.max(
        slice.lastIndexOf('. '),
        slice.lastIndexOf('! '),
        slice.lastIndexOf('? '),
        slice.lastIndexOf('\n')
      );
      const spaceBreak = slice.lastIndexOf(' ');

      if (paragraphBreak >= minBreak) {
        end = start + paragraphBreak + 2;
      } else if (sentenceBreak >= minBreak) {
        end = start + sentenceBreak + 1;
      } else if (spaceBreak >= minBreak) {
        end = start + spaceBreak;
      }
    }

    const piece = normalized.slice(start, end).trim();
    if (piece) {
      chunks.push(piece);
    }

    if (end >= normalized.length) {
      break;
    }

    const nextStart = end - overlap;
    start = nextStart > start ? nextStart : end;
  }

  return chunks;
}

export interface ProductIndexRecord {
  id: number;
  kode: string;
  namaBarang: string;
  varian: string | null;
  satuan: string;
  hargaDefault: Prisma.Decimal | number | string;
  deskripsi: string | null;
}

export interface CmsIndexRecord {
  id: number;
  key: string;
  judul: string;
  subJudul: string | null;
  konten: string | null;
}

export interface AiDocumentRecord {
  id: number;
  title: string;
  sourceType: AiDocumentSourceType;
  sourceRef: string | null;
  roleScope: AiRoleScope;
  content: string;
  aktif: boolean;
}

export interface IngestionPrismaClient {
  aiDocument: {
    findMany(args: Record<string, unknown>): Promise<AiDocumentRecord[]>;
    findFirst(args: Record<string, unknown>): Promise<AiDocumentRecord | null>;
    create(args: Record<string, unknown>): Promise<AiDocumentRecord>;
    update(args: Record<string, unknown>): Promise<AiDocumentRecord>;
    deleteMany(args: Record<string, unknown>): Promise<{ count: number }>;
  };
  aiChunk: {
    deleteMany(args: Record<string, unknown>): Promise<{ count: number }>;
    createMany(args: Record<string, unknown>): Promise<{ count: number }>;
  };
  produk: {
    findMany(args: Record<string, unknown>): Promise<ProductIndexRecord[]>;
  };
  cmsContent: {
    findMany(args: Record<string, unknown>): Promise<CmsIndexRecord[]>;
  };
}

export interface CreateDocumentInput {
  title: string;
  sourceType: Extract<AiDocumentSourceType, 'SOP' | 'FAQ' | 'MANUAL'>;
  content: string;
  roleScope?: AiRoleScope;
  sourceRef?: string | null;
  createdBy?: number | null;
  rejectOnPii?: boolean;
}

export interface IndexDocumentOptions extends ChunkOptions {
  piiMode?: 'sanitize' | 'reject';
}

export interface IndexDocumentResult {
  documentId: number;
  chunksCreated: number;
  piiRedactedChunks: number;
  roleScope: AiRoleScope;
}

export interface ReindexAllResult {
  documentsProcessed: number;
  chunksCreated: number;
  piiRedactedChunks: number;
  sources: {
    documents: number;
    products: number;
    cms: number;
  };
}

export function formatProductForIndexing(produk: ProductIndexRecord): string {
  const harga = Number(produk.hargaDefault);
  const hargaFormatted = Number.isFinite(harga)
    ? `Rp ${harga.toLocaleString('id-ID')}`
    : String(produk.hargaDefault);

  const lines = [
    `Produk SOJU: ${produk.namaBarang} (Kode: ${produk.kode})`,
    `Harga Default: ${hargaFormatted} per ${produk.satuan}`,
  ];

  if (produk.varian?.trim()) {
    lines.push(`Varian Tersedia: ${produk.varian.trim()}`);
  }
  if (produk.deskripsi?.trim()) {
    lines.push(`Deskripsi: ${produk.deskripsi.trim()}`);
  }

  return lines.join('\n');
}

export function formatCmsForIndexing(cms: CmsIndexRecord): string {
  const lines = [`Konten CMS (${cms.key}): ${cms.judul}`];
  if (cms.subJudul?.trim()) {
    lines.push(`Sub Judul: ${cms.subJudul.trim()}`);
  }
  if (cms.konten?.trim()) {
    lines.push(cms.konten.trim());
  }
  return lines.join('\n');
}

export interface IngestionServiceDependencies {
  prisma?: IngestionPrismaClient;
  geminiClient?: GeminiClient;
}

export function createIngestionService(deps: IngestionServiceDependencies = {}) {
  const prisma = (deps.prisma ?? defaultPrisma) as unknown as IngestionPrismaClient;
  const geminiClient = deps.geminiClient ?? defaultGeminiClient;

  async function indexDocument(
    doc: Pick<AiDocumentRecord, 'id' | 'title' | 'content' | 'roleScope'>,
    options: IndexDocumentOptions = {}
  ): Promise<IndexDocumentResult> {
    const piiMode = options.piiMode ?? 'sanitize';

    let preparedText = doc.content;
    let piiRedactedChunks = 0;

    if (piiMode === 'reject') {
      assertNoPii(preparedText);
    }

    const rawChunks = chunkText(preparedText, options);
    const chunkRows: Array<{
      documentId: number;
      chunkIndex: number;
      content: string;
      embedding: number[];
      roleScope: AiRoleScope;
    }> = [];

    for (let i = 0; i < rawChunks.length; i += 1) {
      const sanitized = sanitizePii(rawChunks[i]);
      if (sanitized.hadPii) {
        piiRedactedChunks += 1;
      }

      const finalChunkContent = sanitized.sanitizedText.trim();
      if (!finalChunkContent) {
        continue;
      }

      const embedding = await geminiClient.embedText(finalChunkContent, 'RETRIEVAL_DOCUMENT', {
        title: doc.title,
      });

      chunkRows.push({
        documentId: doc.id,
        chunkIndex: chunkRows.length,
        content: finalChunkContent,
        embedding,
        roleScope: doc.roleScope,
      });
    }

    await prisma.aiChunk.deleteMany({
      where: { documentId: doc.id },
    });

    if (chunkRows.length > 0) {
      await prisma.aiChunk.createMany({
        data: chunkRows,
      });
    }

    return {
      documentId: doc.id,
      chunksCreated: chunkRows.length,
      piiRedactedChunks,
      roleScope: doc.roleScope,
    };
  }

  async function upsertDerivedDocument(params: {
    sourceType: Extract<AiDocumentSourceType, 'PRODUK' | 'CMS'>;
    sourceRef: string;
    title: string;
    content: string;
    roleScope: AiRoleScope;
  }): Promise<AiDocumentRecord> {
    const existing = await prisma.aiDocument.findFirst({
      where: {
        sourceType: params.sourceType,
        sourceRef: params.sourceRef,
      },
    });

    const sanitizedContent = sanitizePii(params.content).sanitizedText;

    if (existing) {
      return prisma.aiDocument.update({
        where: { id: existing.id },
        data: {
          title: params.title,
          content: sanitizedContent,
          roleScope: params.roleScope,
          aktif: true,
        },
      });
    }

    return prisma.aiDocument.create({
      data: {
        title: params.title,
        sourceType: params.sourceType,
        sourceRef: params.sourceRef,
        roleScope: params.roleScope,
        content: sanitizedContent,
        aktif: true,
      },
    });
  }

  async function createAndIngestDocument(
    input: CreateDocumentInput,
    options: ChunkOptions = {}
  ): Promise<{ document: AiDocumentRecord; indexing: IndexDocumentResult }> {
    const title = input.title.trim();
    const content = input.content.trim();
    const roleScope: AiRoleScope = input.roleScope ?? 'ALL_ADMIN';
    const rejectOnPii = input.rejectOnPii ?? true;

    if (!title) {
      throw new Error('Judul dokumen AI wajib diisi.');
    }
    if (!content) {
      throw new Error('Konten dokumen AI wajib diisi.');
    }

    let safeContent = content;
    if (rejectOnPii) {
      assertNoPii(safeContent);
    } else {
      safeContent = sanitizePii(safeContent).sanitizedText;
    }

    const document = await prisma.aiDocument.create({
      data: {
        title,
        sourceType: input.sourceType,
        sourceRef: input.sourceRef ?? null,
        roleScope,
        content: safeContent,
        aktif: true,
        createdBy: input.createdBy ?? null,
      },
    });

    const indexing = await indexDocument(document, {
      ...options,
      piiMode: rejectOnPii ? 'reject' : 'sanitize',
    });

    return { document, indexing };
  }

  async function reindexAll(options: ChunkOptions = {}): Promise<ReindexAllResult> {
    let documentsProcessed = 0;
    let chunksCreated = 0;
    let piiRedactedChunks = 0;

    // 1. Active SOP / FAQ / MANUAL documents (preserve each document's roleScope)
    const manualDocs = await prisma.aiDocument.findMany({
      where: {
        aktif: true,
        sourceType: { in: ['SOP', 'FAQ', 'MANUAL'] },
      },
      orderBy: { id: 'asc' },
    });

    for (const doc of manualDocs) {
      const result = await indexDocument(doc, { ...options, piiMode: 'sanitize' });
      documentsProcessed += 1;
      chunksCreated += result.chunksCreated;
      piiRedactedChunks += result.piiRedactedChunks;
    }

    // 2. Active Produk catalog (strictly non-PII fields; never Pelanggan/PesananPelanggan)
    const activeProducts = await prisma.produk.findMany({
      where: { aktif: true },
      select: {
        id: true,
        kode: true,
        namaBarang: true,
        varian: true,
        satuan: true,
        hargaDefault: true,
        deskripsi: true,
      },
      orderBy: { id: 'asc' },
    });

    const activeProductRefs: string[] = [];
    for (const produk of activeProducts) {
      const sourceRef = `produk:${produk.id}`;
      activeProductRefs.push(sourceRef);
      const doc = await upsertDerivedDocument({
        sourceType: 'PRODUK',
        sourceRef,
        title: `Produk: ${produk.namaBarang}`,
        content: formatProductForIndexing(produk),
        roleScope: 'ALL_ADMIN',
      });
      const result = await indexDocument(doc, { ...options, piiMode: 'sanitize' });
      documentsProcessed += 1;
      chunksCreated += result.chunksCreated;
      piiRedactedChunks += result.piiRedactedChunks;
    }

    await prisma.aiDocument.deleteMany({
      where: {
        sourceType: 'PRODUK',
        ...(activeProductRefs.length > 0 ? { sourceRef: { notIn: activeProductRefs } } : {}),
      },
    });

    // 3. Active CmsContent entries
    const activeCms = await prisma.cmsContent.findMany({
      where: { aktif: true },
      select: {
        id: true,
        key: true,
        judul: true,
        subJudul: true,
        konten: true,
      },
      orderBy: { id: 'asc' },
    });

    const activeCmsRefs: string[] = [];
    for (const cms of activeCms) {
      const sourceRef = `cms:${cms.id}`;
      activeCmsRefs.push(sourceRef);
      const doc = await upsertDerivedDocument({
        sourceType: 'CMS',
        sourceRef,
        title: `CMS: ${cms.judul}`,
        content: formatCmsForIndexing(cms),
        roleScope: 'ALL_ADMIN',
      });
      const result = await indexDocument(doc, { ...options, piiMode: 'sanitize' });
      documentsProcessed += 1;
      chunksCreated += result.chunksCreated;
      piiRedactedChunks += result.piiRedactedChunks;
    }

    await prisma.aiDocument.deleteMany({
      where: {
        sourceType: 'CMS',
        ...(activeCmsRefs.length > 0 ? { sourceRef: { notIn: activeCmsRefs } } : {}),
      },
    });

    return {
      documentsProcessed,
      chunksCreated,
      piiRedactedChunks,
      sources: {
        documents: manualDocs.length,
        products: activeProducts.length,
        cms: activeCms.length,
      },
    };
  }

  return {
    indexDocument,
    createAndIngestDocument,
    reindexAll,
  };
}

const defaultIngestionService = createIngestionService();

export const indexDocument = defaultIngestionService.indexDocument;
export const createAndIngestDocument = defaultIngestionService.createAndIngestDocument;
export const reindexAll = defaultIngestionService.reindexAll;

export default defaultIngestionService;
