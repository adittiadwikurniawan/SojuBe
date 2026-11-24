import { Router, Response, NextFunction } from 'express';
import { AksiLog, type AiDocumentSourceType, type AiRoleScope } from '@prisma/client';
import { authenticate, authorizeRoles, type AuthRequest } from '../middleware/auth';
import { errorResponse, successResponse } from '../utils/response';
import {
  AiChatServiceError,
  getConversationById,
  listConversations,
  sendChatMessage,
} from '../services/ai/aiChatService';
import {
  PiiViolationError,
  createAndIngestDocument,
  reindexAll,
} from '../services/ai/ingestionService';
import { logManualAction } from '../services/auditLogService';

type ManualAiSourceType = Extract<AiDocumentSourceType, 'SOP' | 'FAQ' | 'MANUAL'>;

const VALID_MANUAL_SOURCE_TYPES = new Set<ManualAiSourceType>(['SOP', 'FAQ', 'MANUAL']);
const VALID_ROLE_SCOPES = new Set<AiRoleScope>(['ALL_ADMIN', 'SUPER_ADMIN']);

const router = Router();
router.use(authenticate, authorizeRoles('ADMIN', 'SUPER_ADMIN'));

const mapAiRouteError = (error: unknown) => {
  if (error instanceof AiChatServiceError) {
    return errorResponse(error.message, error.status);
  }
  if (error instanceof PiiViolationError) {
    return errorResponse(error.message, 400);
  }
  return error;
};

const parsePositiveIntParam = (raw: string | string[] | undefined, label: string): number => {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw errorResponse(`${label} tidak valid`, 400);
  }
  return parsed;
};

const parseOptionalPositiveInt = (raw: unknown, label: string): number | undefined => {
  if (raw === undefined || raw === null || raw === '') {
    return undefined;
  }
  const value = Array.isArray(raw) ? raw[0] : raw;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw errorResponse(`${label} harus berupa bilangan bulat positif`, 400);
  }
  return parsed;
};

// POST /api/v1/ai/chat (ADMIN + SUPER_ADMIN)
router.post('/chat', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const message = typeof req.body?.message === 'string' ? req.body.message : '';
    const conversationId = parseOptionalPositiveInt(req.body?.conversationId, 'conversationId');

    const result = await sendChatMessage({
      penggunaId: req.user!.id,
      callerRole: req.user!.role,
      message,
      conversationId,
    });

    res.status(200).json(successResponse(result));
  } catch (error) {
    next(mapAiRouteError(error));
  }
});

// GET /api/v1/ai/conversations (ADMIN + SUPER_ADMIN, strictly scoped to caller)
router.get('/conversations', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const limit = parseOptionalPositiveInt(req.query.limit, 'limit');
    const conversations = await listConversations(req.user!.id, limit);

    res.status(200).json(successResponse(conversations));
  } catch (error) {
    next(mapAiRouteError(error));
  }
});

// GET /api/v1/ai/conversations/:id (ADMIN + SUPER_ADMIN, strictly scoped to caller)
router.get('/conversations/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const conversationId = parsePositiveIntParam(req.params.id, 'ID percakapan AI');
    const conversation = await getConversationById(req.user!.id, conversationId);

    res.status(200).json(successResponse(conversation));
  } catch (error) {
    next(mapAiRouteError(error));
  }
});

// POST /api/v1/ai/reindex (SUPER_ADMIN only)
router.post(
  '/reindex',
  authorizeRoles('SUPER_ADMIN'),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const result = await reindexAll();

      await logManualAction(
        req.user!.id,
        'AiDocument',
        AksiLog.UBAH,
        'Reindex Basis Pengetahuan AI',
        `Memproses ${result.documentsProcessed} dokumen (${result.chunksCreated} chunk) oleh ${req.user!.email}`,
        undefined,
        undefined,
        result
      );

      res.status(200).json(
        successResponse(result, 'Reindex basis pengetahuan AI berhasil dijalankan')
      );
    } catch (error) {
      next(mapAiRouteError(error));
    }
  }
);

// POST /api/v1/ai/documents (SUPER_ADMIN only)
router.post(
  '/documents',
  authorizeRoles('SUPER_ADMIN'),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
      const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';
      const rawSourceType =
        typeof req.body?.sourceType === 'string'
          ? req.body.sourceType.trim().toUpperCase()
          : 'MANUAL';
      const rawRoleScope =
        typeof req.body?.roleScope === 'string'
          ? req.body.roleScope.trim().toUpperCase()
          : 'ALL_ADMIN';
      const sourceRef =
        typeof req.body?.sourceRef === 'string' && req.body.sourceRef.trim().length > 0
          ? req.body.sourceRef.trim()
          : null;
      const rejectOnPii =
        typeof req.body?.rejectOnPii === 'boolean' ? req.body.rejectOnPii : true;

      if (!title) {
        throw errorResponse('Judul dokumen AI wajib diisi.', 400);
      }
      if (!content) {
        throw errorResponse('Konten dokumen AI wajib diisi.', 400);
      }
      if (!VALID_MANUAL_SOURCE_TYPES.has(rawSourceType as ManualAiSourceType)) {
        throw errorResponse('sourceType dokumen AI harus salah satu dari SOP, FAQ, atau MANUAL.', 400);
      }
      if (!VALID_ROLE_SCOPES.has(rawRoleScope as AiRoleScope)) {
        throw errorResponse('roleScope dokumen AI harus ALL_ADMIN atau SUPER_ADMIN.', 400);
      }

      const result = await createAndIngestDocument({
        title,
        sourceType: rawSourceType as ManualAiSourceType,
        content,
        roleScope: rawRoleScope as AiRoleScope,
        sourceRef,
        createdBy: req.user!.id,
        rejectOnPii,
      });

      await logManualAction(
        req.user!.id,
        'AiDocument',
        AksiLog.TAMBAH,
        result.document.title,
        `Menambahkan dokumen AI (${result.document.sourceType}, scope ${result.document.roleScope}, ${result.indexing.chunksCreated} chunk)`,
        result.document.id,
        undefined,
        {
          documentId: result.document.id,
          title: result.document.title,
          sourceType: result.document.sourceType,
          roleScope: result.document.roleScope,
          chunksCreated: result.indexing.chunksCreated,
          piiRedactedChunks: result.indexing.piiRedactedChunks,
        }
      );

      res.status(201).json(
        successResponse(result, 'Dokumen AI berhasil ditambahkan dan diindeks')
      );
    } catch (error) {
      next(mapAiRouteError(error));
    }
  }
);

export default router;
