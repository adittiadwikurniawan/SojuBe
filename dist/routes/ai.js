"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_1 = require("../middleware/auth");
const aiService_1 = require("../services/aiService");
const database_1 = __importDefault(require("../utils/database"));
const response_1 = require("../utils/response");
const router = (0, express_1.Router)();
router.use(auth_1.authenticate, (0, auth_1.authorizeRoles)('ADMIN', 'SUPER_ADMIN'));
router.get('/conversations', async (req, res, next) => {
    try {
        const rawLimit = req.query.limit;
        const parsedLimit = typeof rawLimit === 'string' ? Number(rawLimit) : 30;
        const limit = Number.isSafeInteger(parsedLimit) && parsedLimit > 0
            ? Math.min(parsedLimit, 100)
            : 30;
        const conversations = await database_1.default.aiConversation.findMany({
            where: { penggunaId: req.user.id },
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
        res.json((0, response_1.successResponse)(conversations.map((conversation) => ({
            id: conversation.id,
            penggunaId: conversation.penggunaId,
            title: conversation.title,
            messageCount: conversation._count.messages,
            lastMessagePreview: conversation.messages[0]?.content.slice(0, 180) ?? null,
            createdAt: conversation.createdAt.toISOString(),
            updatedAt: conversation.updatedAt.toISOString(),
        }))));
    }
    catch (error) {
        next(error);
    }
});
router.get('/conversations/:id', async (req, res, next) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isSafeInteger(id) || id < 1) {
            throw (0, response_1.errorResponse)('ID percakapan tidak valid.', 400);
        }
        const conversation = await database_1.default.aiConversation.findFirst({
            where: { id, penggunaId: req.user.id },
            include: {
                messages: {
                    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
                },
            },
        });
        if (!conversation) {
            throw (0, response_1.errorResponse)('Percakapan tidak ditemukan.', 404);
        }
        res.json((0, response_1.successResponse)({
            id: conversation.id,
            penggunaId: conversation.penggunaId,
            title: conversation.title,
            createdAt: conversation.createdAt.toISOString(),
            updatedAt: conversation.updatedAt.toISOString(),
            messages: conversation.messages.map(aiService_1.serializeAiMessage),
        }));
    }
    catch (error) {
        next(error);
    }
});
router.post('/chat', async (req, res, next) => {
    try {
        if (!process.env.GEMINI_API_KEY?.trim()) {
            throw (0, response_1.errorResponse)('GEMINI_API_KEY belum diatur pada environment backend.', 500);
        }
        const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
        if (!message)
            throw (0, response_1.errorResponse)('Pesan wajib diisi.', 400);
        if (message.length > 8000) {
            throw (0, response_1.errorResponse)('Pesan terlalu panjang (maksimal 8.000 karakter).', 400);
        }
        const rawConversationId = req.body?.conversationId;
        let conversation;
        if (rawConversationId === undefined || rawConversationId === null) {
            conversation = await database_1.default.aiConversation.create({
                data: {
                    penggunaId: req.user.id,
                    title: (message.replace(/^\/\w+\s*/, '').trim() || 'Percakapan baru')
                        .slice(0, 180),
                },
            });
        }
        else {
            const conversationId = Number(rawConversationId);
            if (!Number.isSafeInteger(conversationId) || conversationId < 1) {
                throw (0, response_1.errorResponse)('ID percakapan tidak valid.', 400);
            }
            const existing = await database_1.default.aiConversation.findFirst({
                where: { id: conversationId, penggunaId: req.user.id },
            });
            if (!existing)
                throw (0, response_1.errorResponse)('Percakapan tidak ditemukan.', 404);
            conversation = existing;
        }
        const previousMessages = await database_1.default.aiMessage.findMany({
            where: { conversationId: conversation.id },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: 20,
            select: { role: true, content: true },
        });
        const userMessage = await database_1.default.$transaction(async (tx) => {
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
        const context = await (0, aiService_1.loadOperationalContext)();
        const aiReply = await (0, aiService_1.generateAiReply)({
            message,
            history: previousMessages.reverse(),
            context,
            role: req.user.role,
        });
        const assistantMessage = await database_1.default.$transaction(async (tx) => {
            const saved = await tx.aiMessage.create({
                data: {
                    conversationId: conversation.id,
                    role: 'ASSISTANT',
                    content: aiReply.reply,
                    routePath: aiReply.routePath,
                    citations: (0, aiService_1.serializeAiJson)(aiReply.citations),
                    actions: (0, aiService_1.serializeAiJson)(aiReply.actions),
                },
            });
            await tx.aiConversation.update({
                where: { id: conversation.id },
                data: { updatedAt: new Date() },
            });
            return saved;
        });
        res.json((0, response_1.successResponse)({
            conversationId: conversation.id,
            title: conversation.title,
            routePath: aiReply.routePath,
            reply: aiReply.reply,
            citations: aiReply.citations,
            actions: aiReply.actions,
            userMessage: (0, aiService_1.serializeAiMessage)(userMessage),
            assistantMessage: (0, aiService_1.serializeAiMessage)(assistantMessage),
        }));
    }
    catch (error) {
        next(error);
    }
});
router.post('/reindex', (0, auth_1.authorizeRoles)('SUPER_ADMIN'), async (_req, res, next) => {
    try {
        res.json((0, response_1.successResponse)(await (0, aiService_1.reindexKnowledge)()));
    }
    catch (error) {
        next(error);
    }
});
router.post('/documents', (0, auth_1.authorizeRoles)('SUPER_ADMIN'), async (req, res, next) => {
    try {
        const body = req.body;
        const title = typeof body?.title === 'string' ? body.title.trim() : '';
        const content = typeof body?.content === 'string' ? body.content.trim() : '';
        const sourceType = typeof body?.sourceType === 'string' ? body.sourceType : 'SOP';
        const roleScope = typeof body?.roleScope === 'string' ? body.roleScope : 'ALL_ADMIN';
        const sourceRef = typeof body?.sourceRef === 'string' && body.sourceRef.trim()
            ? body.sourceRef.trim()
            : null;
        if (!title || title.length > 255) {
            throw (0, response_1.errorResponse)('Judul dokumen wajib diisi (maksimal 255 karakter).', 400);
        }
        if (content.length < 20 || content.length > 200000) {
            throw (0, response_1.errorResponse)('Konten dokumen harus berisi 20 sampai 200.000 karakter.', 400);
        }
        if (!['SOP', 'FAQ', 'MANUAL'].includes(sourceType)) {
            throw (0, response_1.errorResponse)('Jenis dokumen tidak valid.', 400);
        }
        if (!['ALL_ADMIN', 'SUPER_ADMIN'].includes(roleScope)) {
            throw (0, response_1.errorResponse)('Cakupan akses dokumen tidak valid.', 400);
        }
        if (sourceRef && sourceRef.length > 255) {
            throw (0, response_1.errorResponse)('Referensi dokumen maksimal 255 karakter.', 400);
        }
        const result = await (0, aiService_1.createKnowledgeDocument)({
            title,
            content,
            sourceType: sourceType,
            roleScope: roleScope,
            sourceRef,
            createdBy: req.user.id,
            rejectOnPii: body?.rejectOnPii !== false,
        });
        res.status(201).json((0, response_1.successResponse)({
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
        }));
    }
    catch (error) {
        next(error);
    }
});
exports.default = router;
