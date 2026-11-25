import type { AiConversation } from '@prisma/client';
import { NextFunction, Response, Router } from 'express';
import { authenticate, authorizeRoles, AuthRequest } from '../middleware/auth';
import {
  createKnowledgeDocument,
  generateAiReply,
  loadOperationalContext,
  reindexKnowledge,
  serializeAiJson,
  serializeAiMessage,
} from '../services/aiService';
import prisma from '../utils/database';
import { errorResponse, successResponse } from '../utils/response';

const router = Router();

router.use(authenticate, authorizeRoles('ADMIN', 'SUPER_ADMIN'));

router.get('/conversations', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const rawLimit = req.query.limit;
    const parsedLimit = typeof rawLimit === 'string' ? Number(rawLimit) : 30;
    const limit =
      Number.isSafeInteger(parsedLimit) && parsedLimit > 0
        ? Math.min(parsedLimit, 100)
        : 30;
    const conversations = await prisma.aiConversation.findMany({
      where: { penggunaId: req.user!.id },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: limit,
      select: {
        id: true,
        penggunaId: true,
        title: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { messages: true } },
        messages: {
          take: 1,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          select: { content: true },
        },
      },
    });

    res.json(
      successResponse(
        conversations.map((conversation) => ({
          id: conversation.id,
          penggunaId: conversation.penggunaId,
          title: conversation.title,
          messageCount: conversation._count.messages,
          lastMessagePreview:
            conversation.messages[0]?.content.slice(0, 180) ?? null,
          createdAt: conversation.createdAt.toISOString(),
          updatedAt: conversation.updatedAt.toISOString(),
        })),
      ),
    );
  } catch (error) {
    next(error);
  }
});

router.get(
  '/conversations/:id',
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isSafeInteger(id) || id < 1) {
        throw errorResponse('ID percakapan tidak valid.', 400);
      }
      const conversation = await prisma.aiConversation.findFirst({
        where: { id, penggunaId: req.user!.id },
        include: {
          messages: {
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          },
        },
      });
      if (!conversation) {
        throw errorResponse('Percakapan tidak ditemukan.', 404);
      }
      res.json(
        successResponse({
          id: conversation.id,
          penggunaId: conversation.penggunaId,
          title: conversation.title,
          createdAt: conversation.createdAt.toISOString(),
          updatedAt: conversation.updatedAt.toISOString(),
          messages: conversation.messages.map(serializeAiMessage),
        }),
      );
    } catch (error) {
      next(error);
    }
  },
);

router.post('/chat', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!process.env.GEMINI_API_KEY?.trim()) {
      throw errorResponse(
        'GEMINI_API_KEY belum diatur pada environment backend.',
        500,
      );
    }
    const message =
      typeof req.body?.message === 'string' ? req.body.message.trim() : '';
    if (!message) throw errorResponse('Pesan wajib diisi.', 400);
    if (message.length > 8000) {
      throw errorResponse('Pesan terlalu panjang (maksimal 8.000 karakter).', 400);
    }

    const rawConversationId = req.body?.conversationId;
    let conversation: AiConversation;
    if (rawConversationId === undefined || rawConversationId === null) {
      conversation = await prisma.aiConversation.create({
        data: {
          penggunaId: req.user!.id,
          title: (message.replace(/^\/\w+\s*/, '').trim() || 'Percakapan baru')
            .slice(0, 180),
        },
      });
    } else {
      const conversationId = Number(rawConversationId);
      if (!Number.isSafeInteger(conversationId) || conversationId < 1) {
        throw errorResponse('ID percakapan tidak valid.', 400);
      }
      const existing = await prisma.aiConversation.findFirst({
        where: { id: conversationId, penggunaId: req.user!.id },
      });
      if (!existing) throw errorResponse('Percakapan tidak ditemukan.', 404);
      conversation = existing;
    }

    const previousMessages = await prisma.aiMessage.findMany({
      where: { conversationId: conversation.id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 20,
      select: { role: true, content: true },
    });
    const userMessage = await prisma.$transaction(async (tx) => {
      const saved = await tx.aiMessage.create({
        data: {
          conversationId: conversation.id,
          role: 'USER',
          content: message,
          citations: [],
          actions: [],
        },
      });
      await tx.aiConversation.update({
        where: { id: conversation.id },
        data: { updatedAt: new Date() },
      });
      return saved;
    });

    const context = await loadOperationalContext();
    const aiReply = await generateAiReply({
      message,
      history: previousMessages.reverse(),
      context,
      role: req.user!.role,
    });
    const assistantMessage = await prisma.$transaction(async (tx) => {
      const saved = await tx.aiMessage.create({
        data: {
          conversationId: conversation.id,
          role: 'ASSISTANT',
          content: aiReply.reply,
          routePath: aiReply.routePath,
          citations: serializeAiJson(aiReply.citations),
          actions: serializeAiJson(aiReply.actions),
        },
      });
      await tx.aiConversation.update({
        where: { id: conversation.id },
        data: { updatedAt: new Date() },
      });
      return saved;
    });

    res.json(
      successResponse({
        conversationId: conversation.id,
        title: conversation.title,
        routePath: aiReply.routePath,
        reply: aiReply.reply,
        citations: aiReply.citations,
        actions: aiReply.actions,
        userMessage: serializeAiMessage(userMessage),
        assistantMessage: serializeAiMessage(assistantMessage),
      }),
    );
  } catch (error) {
    next(error);
  }
});

router.post(
  '/reindex',
  authorizeRoles('SUPER_ADMIN'),
  async (_req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      res.json(successResponse(await reindexKnowledge()));
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  '/documents',
  authorizeRoles('SUPER_ADMIN'),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const body = req.body as Record<string, unknown> | null;
      const title = typeof body?.title === 'string' ? body.title.trim() : '';
      const content =
        typeof body?.content === 'string' ? body.content.trim() : '';
      const sourceType =
        typeof body?.sourceType === 'string' ? body.sourceType : 'SOP';
      const roleScope =
        typeof body?.roleScope === 'string' ? body.roleScope : 'ALL_ADMIN';
      const sourceRef =
        typeof body?.sourceRef === 'string' && body.sourceRef.trim()
          ? body.sourceRef.trim()
          : null;

      if (!title || title.length > 255) {
        throw errorResponse('Judul dokumen wajib diisi (maksimal 255 karakter).', 400);
      }
      if (content.length < 20 || content.length > 200000) {
        throw errorResponse(
          'Konten dokumen harus berisi 20 sampai 200.000 karakter.',
          400,
        );
      }
      if (!['SOP', 'FAQ', 'MANUAL'].includes(sourceType)) {
        throw errorResponse('Jenis dokumen tidak valid.', 400);
      }
      if (!['ALL_ADMIN', 'SUPER_ADMIN'].includes(roleScope)) {
        throw errorResponse('Cakupan akses dokumen tidak valid.', 400);
      }
      if (sourceRef && sourceRef.length > 255) {
        throw errorResponse('Referensi dokumen maksimal 255 karakter.', 400);
      }

      const result = await createKnowledgeDocument({
        title,
        content,
        sourceType: sourceType as 'SOP' | 'FAQ' | 'MANUAL',
        roleScope: roleScope as 'ALL_ADMIN' | 'SUPER_ADMIN',
        sourceRef,
        createdBy: req.user!.id,
        rejectOnPii: body?.rejectOnPii !== false,
      });
      res.status(201).json(
        successResponse({
          document: {
            id: result.document.id,
            title: result.document.title,
            sourceType: result.document.sourceType,
            sourceRef: result.document.sourceRef,
            roleScope: result.document.roleScope,
            content: result.document.content,
            aktif: result.document.aktif,
          },
          indexing: result.indexing,
        }),
      );
    } catch (error) {
      next(error);
    }
  },
);
export default router;
