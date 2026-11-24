import type { AiMessageRole, AiRoutePath, PeranPengguna } from '@prisma/client';
import defaultPrisma from '../../utils/database';
import defaultActionDraftService, {
  type ActionDraft,
  type ActionDraftResult,
  type BuildActionDraftParams,
} from './actionDraftService';
import defaultGeminiClient, { type GeminiClient } from './geminiClient';
import { sanitizePii } from './ingestionService';
import { classifyIntent, type IntentClassification } from './intentRouter';
import {
  buildGroundedPrompt,
  ensureInlineCitations,
  REFUSAL_MESSAGE_ID,
  type ConversationHistoryTurn,
} from './promptGuard';
import defaultSqlToolsService, {
  type SqlCitation,
  type SqlToolExecutionOptions,
  type SqlToolResult,
} from './sqlToolsService';
import defaultVectorRetriever, {
  type DocumentCitation,
  type RetrievedChunk,
  type VectorRetrievalParams,
  type VectorRetrievalResult,
} from './vectorRetriever';

export const MAX_CHAT_MESSAGE_LENGTH = 4000;
export const MAX_CONVERSATION_TITLE_LENGTH = 120;
export const DEFAULT_CONVERSATION_LIST_LIMIT = 20;
export const MAX_CONVERSATION_LIST_LIMIT = 100;

export const VALID_CHAT_ROLES: readonly PeranPengguna[] = ['ADMIN', 'SUPER_ADMIN'] as const;

export type AiCitation = DocumentCitation | SqlCitation;

export type AiChatErrorCode =
  | 'AI_CHAT_VALIDATION_ERROR'
  | 'AI_CHAT_FORBIDDEN'
  | 'AI_CHAT_CONVERSATION_NOT_FOUND';

export class AiChatServiceError extends Error {
  readonly code: AiChatErrorCode | string;
  readonly status: number;
  readonly statusCode: number;

  constructor(code: AiChatErrorCode | string, message: string, status: number = 400) {
    super(message);
    this.name = 'AiChatServiceError';
    this.code = code;
    this.status = status;
    this.statusCode = status;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class AiChatValidationError extends AiChatServiceError {
  constructor(message: string) {
    super('AI_CHAT_VALIDATION_ERROR', message, 400);
    this.name = 'AiChatValidationError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class AiChatForbiddenError extends AiChatServiceError {
  constructor(message: string) {
    super('AI_CHAT_FORBIDDEN', message, 403);
    this.name = 'AiChatForbiddenError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class AiChatNotFoundError extends AiChatServiceError {
  constructor(message: string = 'Percakapan AI tidak ditemukan.') {
    super('AI_CHAT_CONVERSATION_NOT_FOUND', message, 404);
    this.name = 'AiChatNotFoundError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface AiConversationRecord {
  id: number;
  penggunaId: number;
  title: string;
  createdAt: Date;
  updatedAt: Date;
  messages?: AiMessageRecord[];
  _count?: {
    messages: number;
  };
}

export interface AiMessageRecord {
  id: number;
  conversationId: number;
  role: AiMessageRole;
  content: string;
  routePath: AiRoutePath | null;
  citations: unknown;
  actions: unknown;
  createdAt: Date;
}

export interface AiChatPrismaClient {
  aiConversation: {
    findFirst(args: Record<string, unknown>): Promise<AiConversationRecord | null>;
    findMany(args: Record<string, unknown>): Promise<AiConversationRecord[]>;
    create(args: Record<string, unknown>): Promise<AiConversationRecord>;
    update(args: Record<string, unknown>): Promise<AiConversationRecord>;
  };
  aiMessage: {
    create(args: Record<string, unknown>): Promise<AiMessageRecord>;
    findMany(args: Record<string, unknown>): Promise<AiMessageRecord[]>;
  };
}

export interface SqlToolsExecutorLike {
  executeSqlTool(
    toolName: string,
    params?: Record<string, unknown>,
    options?: SqlToolExecutionOptions
  ): Promise<SqlToolResult<unknown>>;
}

export interface VectorRetrieverLike {
  retrieve(params: VectorRetrievalParams): Promise<VectorRetrievalResult>;
}

export interface ActionDraftBuilderLike {
  buildActionDraft(params: BuildActionDraftParams): Promise<ActionDraftResult>;
}

export interface AiChatServiceDependencies {
  prisma?: AiChatPrismaClient;
  geminiClient?: GeminiClient;
  sqlToolsService?: SqlToolsExecutorLike;
  vectorRetriever?: VectorRetrieverLike;
  actionDraftService?: ActionDraftBuilderLike;
  now?: () => Date;
}

export interface SendChatMessageParams {
  penggunaId: number;
  callerRole: PeranPengguna;
  message: string;
  conversationId?: number | null;
}

export interface PersistedAiMessageDto {
  id: number;
  conversationId: number;
  role: AiMessageRole;
  content: string;
  routePath: AiRoutePath | null;
  citations: AiCitation[];
  actions: ActionDraft[];
  createdAt: string;
}

export interface SendChatMessageResult {
  conversationId: number;
  title: string;
  routePath: AiRoutePath;
  reply: string;
  citations: AiCitation[];
  actions: ActionDraft[];
  userMessage: PersistedAiMessageDto;
  assistantMessage: PersistedAiMessageDto;
  intent: IntentClassification;
}

export interface ConversationSummaryDto {
  id: number;
  penggunaId: number;
  title: string;
  messageCount: number;
  lastMessagePreview: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationDetailDto {
  id: number;
  penggunaId: number;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: PersistedAiMessageDto[];
}

function assertValidPenggunaId(penggunaId: unknown): number {
  if (typeof penggunaId !== 'number' || !Number.isInteger(penggunaId) || penggunaId <= 0) {
    throw new AiChatValidationError('penggunaId harus berupa bilangan bulat positif.');
  }
  return penggunaId;
}

function assertValidCallerRole(callerRole: unknown): PeranPengguna {
  if (
    typeof callerRole !== 'string' ||
    !VALID_CHAT_ROLES.includes(callerRole as PeranPengguna)
  ) {
    throw new AiChatForbiddenError(
      `Peran "${String(callerRole)}" tidak diizinkan menggunakan Asisten AI Admin.`
    );
  }
  return callerRole as PeranPengguna;
}

function assertValidMessage(message: unknown): string {
  if (typeof message !== 'string') {
    throw new AiChatValidationError('Pesan chat wajib berupa teks.');
  }
  const trimmed = message.trim();
  if (!trimmed) {
    throw new AiChatValidationError('Pesan chat tidak boleh kosong.');
  }
  if (trimmed.length > MAX_CHAT_MESSAGE_LENGTH) {
    throw new AiChatValidationError(
      `Pesan chat terlalu panjang (maksimal ${MAX_CHAT_MESSAGE_LENGTH} karakter).`
    );
  }
  return trimmed;
}

function assertValidConversationId(conversationId: unknown): number {
  if (
    typeof conversationId !== 'number' ||
    !Number.isInteger(conversationId) ||
    conversationId <= 0
  ) {
    throw new AiChatValidationError('conversationId harus berupa bilangan bulat positif.');
  }
  return conversationId;
}

function buildConversationTitle(message: string): string {
  const sanitized = sanitizePii(message).sanitizedText.replace(/\s+/g, ' ').trim();
  if (!sanitized) {
    return 'Percakapan AI SOJU';
  }
  if (sanitized.length <= MAX_CONVERSATION_TITLE_LENGTH) {
    return sanitized;
  }
  return `${sanitized.slice(0, MAX_CONVERSATION_TITLE_LENGTH - 3).trimEnd()}...`;
}

function normalizeCitationsArray(raw: unknown): AiCitation[] {
  return Array.isArray(raw) ? (raw as AiCitation[]) : [];
}

function normalizeActionsArray(raw: unknown): ActionDraft[] {
  return Array.isArray(raw) ? (raw as ActionDraft[]) : [];
}

function toMessageDto(record: AiMessageRecord): PersistedAiMessageDto {
  return {
    id: record.id,
    conversationId: record.conversationId,
    role: record.role,
    content: record.content,
    routePath: record.routePath ?? null,
    citations: normalizeCitationsArray(record.citations),
    actions: normalizeActionsArray(record.actions),
    createdAt:
      record.createdAt instanceof Date
        ? record.createdAt.toISOString()
        : new Date(record.createdAt).toISOString(),
  };
}

/**
 * Factory for the Hybrid RAG Chat Orchestrator & Conversation Persistence Service (AD-01, AD-07).
 */
export function createAiChatService(deps: AiChatServiceDependencies = {}) {
  const prisma = (deps.prisma ?? (defaultPrisma as unknown as AiChatPrismaClient));
  const geminiClient = deps.geminiClient ?? defaultGeminiClient;
  const sqlToolsService = deps.sqlToolsService ?? defaultSqlToolsService;
  const vectorRetriever = deps.vectorRetriever ?? defaultVectorRetriever;
  const actionDraftService = deps.actionDraftService ?? defaultActionDraftService;
  const getNow = deps.now ?? (() => new Date());

  async function sendMessage(params: SendChatMessageParams): Promise<SendChatMessageResult> {
    const penggunaId = assertValidPenggunaId(params.penggunaId);
    const callerRole = assertValidCallerRole(params.callerRole);
    const normalizedMessage = assertValidMessage(params.message);
    const now = getNow();

    // 1. Resolve or create AiConversation strictly scoped to penggunaId
    let conversation: AiConversationRecord;
    let historyTurns: ConversationHistoryTurn[] = [];

    if (params.conversationId !== undefined && params.conversationId !== null) {
      const targetConversationId = assertValidConversationId(params.conversationId);
      const existing = await prisma.aiConversation.findFirst({
        where: {
          id: targetConversationId,
          penggunaId,
        },
      });
      if (!existing) {
        throw new AiChatNotFoundError(
          'Percakapan AI tidak ditemukan atau bukan milik pengguna ini.'
        );
      }
      conversation = existing;

      const previousMessages = await prisma.aiMessage.findMany({
        where: { conversationId: conversation.id },
        orderBy: { createdAt: 'desc' },
        take: 6,
      });
      historyTurns = previousMessages
        .slice()
        .reverse()
        .map((msg) => ({
          role: msg.role,
          content: msg.content,
        }));
    } else {
      conversation = await prisma.aiConversation.create({
        data: {
          penggunaId,
          title: buildConversationTitle(normalizedMessage),
        },
      });
    }

    // 2. Persist USER turn immediately
    const userMessageRecord = await prisma.aiMessage.create({
      data: {
        conversationId: conversation.id,
        role: 'USER',
        content: normalizedMessage,
      },
    });

    // 3. Deterministic Intent Routing (zero LLM bypass)
    const intent = classifyIntent(normalizedMessage);

    let resolvedRoutePath: AiRoutePath;
    let assistantContent: string;
    let citations: AiCitation[] = [];
    let actions: ActionDraft[] = [];

    if (intent.routePath === 'ACTION_DRAFT') {
      // Path C: Human-in-the-loop Action Draft Builder (zero DB commit)
      const draftResult = await actionDraftService.buildActionDraft({
        prompt: normalizedMessage,
        now,
      });
      resolvedRoutePath = 'ACTION_DRAFT';
      assistantContent = draftResult.assistantMessage;
      citations = [];
      actions = draftResult.actions;
    } else if (intent.routePath === 'SQL_TOOL') {
      // Path A: Deterministic Read-Only SQL/Prisma Tools (+ optional Vector context for hybrid queries)
      const sqlResults: SqlToolResult<unknown>[] = [];
      for (let idx = 0; idx < intent.sqlPlan.length; idx += 1) {
        const step = intent.sqlPlan[idx];
        const result = await sqlToolsService.executeSqlTool(step.toolName, step.params, {
          citationIndex: idx + 1,
          now,
        });
        sqlResults.push(result);
      }

      let retrievedChunks: RetrievedChunk[] = [];
      let docCitations: DocumentCitation[] = [];
      if (intent.includeVectorContext) {
        const retrieval = await vectorRetriever.retrieve({
          query: normalizedMessage,
          callerRole,
        });
        retrievedChunks = retrieval.chunks;
        docCitations = retrieval.citations;
      }

      citations = [
        ...sqlResults.map((item) => item.citation),
        ...docCitations,
      ];

      const grounded = buildGroundedPrompt({
        query: normalizedMessage,
        callerRole,
        routePath: 'SQL_TOOL',
        sqlResults,
        retrievedChunks,
        history: historyTurns,
      });

      const rawAnswer = await geminiClient.generateGroundedAnswer({
        prompt: grounded.prompt,
        systemInstruction: grounded.systemInstruction,
        temperature: 0.1,
      });

      resolvedRoutePath = 'SQL_TOOL';
      assistantContent = ensureInlineCitations(
        rawAnswer || 'Berikut ringkasan data operasional SOJU berdasarkan hasil kueri.',
        grounded.expectedCitationIds
      );
      actions = [];
    } else {
      // Path B: Vector Knowledge Retrieval with Role-Scope Isolation & Explicit Refusal Gate
      const retrieval = await vectorRetriever.retrieve({
        query: normalizedMessage,
        callerRole,
      });

      if (!retrieval.hasRelevantContext || retrieval.chunks.length === 0) {
        // Explicit Bahasa Indonesia refusal without invoking Gemini (zero hallucination)
        resolvedRoutePath = 'REFUSAL';
        assistantContent = REFUSAL_MESSAGE_ID;
        citations = [];
        actions = [];
      } else {
        const grounded = buildGroundedPrompt({
          query: normalizedMessage,
          callerRole,
          routePath: 'VECTOR_RAG',
          retrievedChunks: retrieval.chunks,
          history: historyTurns,
        });

        const rawAnswer = await geminiClient.generateGroundedAnswer({
          prompt: grounded.prompt,
          systemInstruction: grounded.systemInstruction,
          temperature: 0.1,
        });

        resolvedRoutePath = 'VECTOR_RAG';
        citations = retrieval.citations;
        assistantContent = ensureInlineCitations(
          rawAnswer || REFUSAL_MESSAGE_ID,
          grounded.expectedCitationIds
        );
        actions = [];
      }
    }

    // 4. Persist ASSISTANT turn with routePath, citations, actions & update conversation timestamp
    const assistantMessageRecord = await prisma.aiMessage.create({
      data: {
        conversationId: conversation.id,
        role: 'ASSISTANT',
        content: assistantContent,
        routePath: resolvedRoutePath,
        citations,
        actions,
      },
    });

    await prisma.aiConversation.update({
      where: { id: conversation.id },
      data: { updatedAt: now },
    });

    return {
      conversationId: conversation.id,
      title: conversation.title,
      routePath: resolvedRoutePath,
      reply: assistantContent,
      citations,
      actions,
      userMessage: toMessageDto(userMessageRecord),
      assistantMessage: toMessageDto(assistantMessageRecord),
      intent,
    };
  }

  async function listConversations(
    penggunaId: number,
    limit: number = DEFAULT_CONVERSATION_LIST_LIMIT
  ): Promise<ConversationSummaryDto[]> {
    const validPenggunaId = assertValidPenggunaId(penggunaId);
    const clampedLimit = Math.min(
      Math.max(Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_CONVERSATION_LIST_LIMIT, 1),
      MAX_CONVERSATION_LIST_LIMIT
    );

    const records = await prisma.aiConversation.findMany({
      where: { penggunaId: validPenggunaId },
      orderBy: { updatedAt: 'desc' },
      take: clampedLimit,
      include: {
        _count: { select: { messages: true } },
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    });

    return records.map((conv) => {
      const lastMsg = conv.messages?.[0];
      return {
        id: conv.id,
        penggunaId: conv.penggunaId,
        title: conv.title,
        messageCount: conv._count?.messages ?? conv.messages?.length ?? 0,
        lastMessagePreview: lastMsg ? lastMsg.content.slice(0, 140) : null,
        createdAt:
          conv.createdAt instanceof Date
            ? conv.createdAt.toISOString()
            : new Date(conv.createdAt).toISOString(),
        updatedAt:
          conv.updatedAt instanceof Date
            ? conv.updatedAt.toISOString()
            : new Date(conv.updatedAt).toISOString(),
      };
    });
  }

  async function getConversationById(
    penggunaId: number,
    conversationId: number
  ): Promise<ConversationDetailDto> {
    const validPenggunaId = assertValidPenggunaId(penggunaId);
    const validConversationId = assertValidConversationId(conversationId);

    const conversation = await prisma.aiConversation.findFirst({
      where: {
        id: validConversationId,
        penggunaId: validPenggunaId,
      },
      include: {
        messages: {
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!conversation) {
      throw new AiChatNotFoundError(
        'Percakapan AI tidak ditemukan atau bukan milik pengguna ini.'
      );
    }

    return {
      id: conversation.id,
      penggunaId: conversation.penggunaId,
      title: conversation.title,
      createdAt:
        conversation.createdAt instanceof Date
          ? conversation.createdAt.toISOString()
          : new Date(conversation.createdAt).toISOString(),
      updatedAt:
        conversation.updatedAt instanceof Date
          ? conversation.updatedAt.toISOString()
          : new Date(conversation.updatedAt).toISOString(),
      messages: (conversation.messages ?? []).map(toMessageDto),
    };
  }

  return {
    sendMessage,
    listConversations,
    getConversationById,
  };
}

const defaultAiChatService = createAiChatService();

export const sendChatMessage = defaultAiChatService.sendMessage;
export const listConversations = defaultAiChatService.listConversations;
export const getConversationById = defaultAiChatService.getConversationById;

export default defaultAiChatService;
