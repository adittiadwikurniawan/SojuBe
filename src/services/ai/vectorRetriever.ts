import type { AiDocumentSourceType, AiRoleScope, PeranPengguna } from '@prisma/client';
import defaultPrisma from '../../utils/database';
import defaultGeminiClient, { type GeminiClient } from './geminiClient';

export const DEFAULT_TOP_K = 3;
export const MAX_TOP_K = 3;
export const DEFAULT_SIMILARITY_THRESHOLD = 0.55;
export const DEFAULT_SNIPPET_MAX_LENGTH = 240;

export const VALID_CALLER_ROLES: readonly PeranPengguna[] = ['ADMIN', 'SUPER_ADMIN'] as const;

export type VectorRetrieverErrorCode =
  | 'VECTOR_RETRIEVER_VALIDATION_ERROR'
  | 'VECTOR_RETRIEVER_FORBIDDEN_ROLE'
  | 'VECTOR_RETRIEVER_INVALID_EMBEDDING';

export class VectorRetrieverError extends Error {
  readonly code: VectorRetrieverErrorCode | string;
  readonly status: number;
  readonly statusCode: number;

  constructor(code: VectorRetrieverErrorCode | string, message: string, status: number = 400) {
    super(message);
    this.name = 'VectorRetrieverError';
    this.code = code;
    this.status = status;
    this.statusCode = status;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class VectorRetrieverForbiddenRoleError extends VectorRetrieverError {
  readonly callerRole: string;

  constructor(callerRole: unknown) {
    const roleLabel = String(callerRole);
    super(
      'VECTOR_RETRIEVER_FORBIDDEN_ROLE',
      `Peran pengguna "${roleLabel}" tidak diizinkan untuk mengakses basis pengetahuan AI.`,
      403
    );
    this.name = 'VectorRetrieverForbiddenRoleError';
    this.callerRole = roleLabel;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class VectorRetrieverValidationError extends VectorRetrieverError {
  constructor(message: string, status: number = 400) {
    super('VECTOR_RETRIEVER_VALIDATION_ERROR', message, status);
    this.name = 'VectorRetrieverValidationError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface AiChunkWithDocumentRecord {
  id: number;
  documentId: number;
  chunkIndex: number;
  content: string;
  embedding: unknown;
  roleScope: AiRoleScope;
  document: {
    id: number;
    title: string;
    sourceType: AiDocumentSourceType;
    sourceRef: string | null;
    roleScope: AiRoleScope;
    aktif: boolean;
  };
}

/**
 * Strictly read-only Prisma subset for vector retrieval.
 */
export interface VectorRetrieverPrismaClient {
  aiChunk: {
    findMany(args: Record<string, unknown>): Promise<AiChunkWithDocumentRecord[]>;
  };
}

export interface VectorRetrieverDependencies {
  prisma?: VectorRetrieverPrismaClient;
  geminiClient?: GeminiClient;
}

export interface DocumentCitation {
  id: string;
  documentId: number;
  chunkId: number;
  chunkIndex: number;
  title: string;
  sourceType: AiDocumentSourceType;
  sourceRef: string | null;
  roleScope: AiRoleScope;
  snippet: string;
  score: number;
}

export interface RetrievedChunk {
  citationId: string;
  chunkId: number;
  documentId: number;
  chunkIndex: number;
  title: string;
  sourceType: AiDocumentSourceType;
  sourceRef: string | null;
  roleScope: AiRoleScope;
  content: string;
  score: number;
  citation: DocumentCitation;
}

export interface VectorRetrievalParams {
  query: string;
  callerRole: PeranPengguna;
  topK?: number;
  threshold?: number;
}

export interface VectorRetrievalResult {
  query: string;
  callerRole: PeranPengguna;
  allowedRoleScopes: AiRoleScope[];
  threshold: number;
  topK: number;
  totalCandidates: number;
  totalQualified: number;
  chunks: RetrievedChunk[];
  citations: DocumentCitation[];
  hasRelevantContext: boolean;
}

/**
 * Resolves allowed AiRoleScope values for a given caller role.
 * - ADMIN: ALL_ADMIN only
 * - SUPER_ADMIN: ALL_ADMIN and SUPER_ADMIN
 */
export function resolveAllowedRoleScopes(callerRole: PeranPengguna): AiRoleScope[] {
  if (callerRole === 'ADMIN') {
    return ['ALL_ADMIN'];
  }
  if (callerRole === 'SUPER_ADMIN') {
    return ['ALL_ADMIN', 'SUPER_ADMIN'];
  }
  throw new VectorRetrieverForbiddenRoleError(callerRole);
}

/**
 * Validates and extracts a numeric embedding vector from Prisma Json storage.
 */
export function parseEmbeddingVector(raw: unknown): number[] | null {
  if (!Array.isArray(raw) || raw.length === 0) {
    return null;
  }

  const vector: number[] = new Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) {
    const value = raw[i];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return null;
    }
    vector[i] = value;
  }

  return vector;
}

/**
 * Computes cosine similarity between two numeric vectors in [-1, 1].
 * Returns 0 for empty, mismatched-length, non-finite, or zero-magnitude vectors.
 */
export function cosineSimilarity(vecA: readonly number[], vecB: readonly number[]): number {
  if (vecA.length === 0 || vecA.length !== vecB.length) {
    return 0;
  }

  let dotProduct = 0;
  let normASq = 0;
  let normBSq = 0;

  for (let i = 0; i < vecA.length; i += 1) {
    const a = vecA[i];
    const b = vecB[i];
    if (!Number.isFinite(a) || !Number.isFinite(b)) {
      return 0;
    }
    dotProduct += a * b;
    normASq += a * a;
    normBSq += b * b;
  }

  if (normASq === 0 || normBSq === 0) {
    return 0;
  }

  const rawSimilarity = dotProduct / (Math.sqrt(normASq) * Math.sqrt(normBSq));
  if (!Number.isFinite(rawSimilarity)) {
    return 0;
  }

  if (rawSimilarity > 1) {
    return 1;
  }
  if (rawSimilarity < -1) {
    return -1;
  }
  return rawSimilarity;
}

function roundScore(score: number): number {
  return Math.round((score + Number.EPSILON) * 1_000_000) / 1_000_000;
}

function buildSnippet(content: string, maxLength: number = DEFAULT_SNIPPET_MAX_LENGTH): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(1, maxLength - 3)).trimEnd()}...`;
}

function resolveTopK(topK?: number): number {
  if (topK === undefined || topK === null) {
    return DEFAULT_TOP_K;
  }
  if (!Number.isFinite(topK) || !Number.isInteger(topK) || topK < 1) {
    throw new VectorRetrieverValidationError('Parameter topK harus berupa bilangan bulat positif.');
  }
  return Math.min(topK, MAX_TOP_K);
}

function resolveThreshold(threshold?: number): number {
  if (threshold === undefined || threshold === null) {
    return DEFAULT_SIMILARITY_THRESHOLD;
  }
  if (!Number.isFinite(threshold) || threshold < -1 || threshold > 1) {
    throw new VectorRetrieverValidationError(
      'Parameter threshold cosine similarity harus berada di antara -1 dan 1.'
    );
  }
  return threshold;
}

export function createVectorRetriever(deps: VectorRetrieverDependencies = {}) {
  const prisma = (deps.prisma ?? defaultPrisma) as unknown as VectorRetrieverPrismaClient;
  const geminiClient = deps.geminiClient ?? defaultGeminiClient;

  async function retrieve(params: VectorRetrievalParams): Promise<VectorRetrievalResult> {
    const allowedRoleScopes = resolveAllowedRoleScopes(params.callerRole);
    const topK = resolveTopK(params.topK);
    const threshold = resolveThreshold(params.threshold);
    const normalizedQuery = typeof params.query === 'string' ? params.query.trim() : '';

    if (!normalizedQuery) {
      return {
        query: '',
        callerRole: params.callerRole,
        allowedRoleScopes,
        threshold,
        topK,
        totalCandidates: 0,
        totalQualified: 0,
        chunks: [],
        citations: [],
        hasRelevantContext: false,
      };
    }

    // 1. Embed user query with gemini-embedding-001 using taskType: 'RETRIEVAL_QUERY' and validate vector
    const rawQueryEmbedding = await geminiClient.embedText(normalizedQuery, 'RETRIEVAL_QUERY');
    const queryEmbedding = parseEmbeddingVector(rawQueryEmbedding);
    if (!queryEmbedding) {
      throw new VectorRetrieverError(
        'VECTOR_RETRIEVER_INVALID_EMBEDDING',
        'Embedding query dari Gemini tidak valid untuk perhitungan cosine similarity.',
        502
      );
    }

    // 2. Load AiChunk rows strictly filtered by caller roleScope & active parent document BEFORE scoring
    const rawChunks = await prisma.aiChunk.findMany({
      where: {
        roleScope: { in: allowedRoleScopes },
        document: {
          aktif: true,
          roleScope: { in: allowedRoleScopes },
        },
      },
      select: {
        id: true,
        documentId: true,
        chunkIndex: true,
        content: true,
        embedding: true,
        roleScope: true,
        document: {
          select: {
            id: true,
            title: true,
            sourceType: true,
            sourceRef: true,
            roleScope: true,
            aktif: true,
          },
        },
      },
      orderBy: [{ documentId: 'asc' }, { chunkIndex: 'asc' }, { id: 'asc' }],
    });

    // Defense-in-depth in-memory roleScope & active-document guard BEFORE scoring
    const allowedScopeSet = new Set<AiRoleScope>(allowedRoleScopes);
    const eligibleChunks = rawChunks.filter((chunk) => {
      if (!allowedScopeSet.has(chunk.roleScope)) {
        return false;
      }
      if (!chunk.document || chunk.document.aktif === false) {
        return false;
      }
      if (!allowedScopeSet.has(chunk.document.roleScope)) {
        return false;
      }
      return true;
    });

    if (eligibleChunks.length === 0) {
      return {
        query: normalizedQuery,
        callerRole: params.callerRole,
        allowedRoleScopes,
        threshold,
        topK,
        totalCandidates: 0,
        totalQualified: 0,
        chunks: [],
        citations: [],
        hasRelevantContext: false,
      };
    }

    // 3. Score eligible chunks by cosine similarity and apply threshold cutoff
    const scored: Array<{
      chunk: AiChunkWithDocumentRecord;
      rawScore: number;
      score: number;
    }> = [];

    for (const chunk of eligibleChunks) {
      const chunkVector = parseEmbeddingVector(chunk.embedding);
      if (!chunkVector || chunkVector.length !== queryEmbedding.length) {
        continue;
      }

      const rawScore = cosineSimilarity(queryEmbedding, chunkVector);
      if (rawScore >= threshold) {
        scored.push({
          chunk,
          rawScore,
          score: roundScore(rawScore),
        });
      }
    }

    // 4. Rank descending by score (deterministic tie-breakers) and cap at topK (max 3)
    scored.sort((a, b) => {
      if (b.rawScore !== a.rawScore) {
        return b.rawScore - a.rawScore;
      }
      if (a.chunk.documentId !== b.chunk.documentId) {
        return a.chunk.documentId - b.chunk.documentId;
      }
      if (a.chunk.chunkIndex !== b.chunk.chunkIndex) {
        return a.chunk.chunkIndex - b.chunk.chunkIndex;
      }
      return a.chunk.id - b.chunk.id;
    });

    const topScored = scored.slice(0, topK);

    // 5. Emit deterministic [D1]-[D3] citation metadata
    const chunks: RetrievedChunk[] = topScored.map((entry, idx) => {
      const citationId = `[D${idx + 1}]`;
      const citation: DocumentCitation = {
        id: citationId,
        documentId: entry.chunk.documentId,
        chunkId: entry.chunk.id,
        chunkIndex: entry.chunk.chunkIndex,
        title: entry.chunk.document.title,
        sourceType: entry.chunk.document.sourceType,
        sourceRef: entry.chunk.document.sourceRef,
        roleScope: entry.chunk.roleScope,
        snippet: buildSnippet(entry.chunk.content),
        score: entry.score,
      };

      return {
        citationId,
        chunkId: entry.chunk.id,
        documentId: entry.chunk.documentId,
        chunkIndex: entry.chunk.chunkIndex,
        title: entry.chunk.document.title,
        sourceType: entry.chunk.document.sourceType,
        sourceRef: entry.chunk.document.sourceRef,
        roleScope: entry.chunk.roleScope,
        content: entry.chunk.content,
        score: entry.score,
        citation,
      };
    });

    const citations = chunks.map((item) => item.citation);

    return {
      query: normalizedQuery,
      callerRole: params.callerRole,
      allowedRoleScopes,
      threshold,
      topK,
      totalCandidates: eligibleChunks.length,
      totalQualified: scored.length,
      chunks,
      citations,
      hasRelevantContext: chunks.length > 0,
    };
  }

  return {
    retrieve,
  };
}

const defaultVectorRetriever = createVectorRetriever();

export const retrieveRelevantChunks = defaultVectorRetriever.retrieve;

export default defaultVectorRetriever;
