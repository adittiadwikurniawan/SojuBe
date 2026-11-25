"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_1 = require("../middleware/auth");
const database_1 = __importDefault(require("../utils/database"));
const response_1 = require("../utils/response");
const router = (0, express_1.Router)();
router.use(auth_1.authenticate, (0, auth_1.authorizeRoles)('ADMIN', 'SUPER_ADMIN'));
router.get('/', async (req, res, next) => {
    try {
        const status = typeof req.query.status === 'string' ? req.query.status : undefined;
        const validStatuses = ['MENUNGGU_KONFIRMASI', 'DIPROSES', 'SELESAI', 'DIBATALKAN'];
        if (status && !validStatuses.includes(status))
            throw (0, response_1.errorResponse)('Status pesanan tidak valid');
        const pesanan = await database_1.default.pesananPelanggan.findMany({
            where: status ? { status: status } : undefined,
            include: { pelanggan: { select: { id: true, nama: true, email: true, noTelepon: true } }, item: true },
            orderBy: { dibuatPada: 'desc' },
            take: 200,
        });
        res.json((0, response_1.successResponse)(pesanan));
    }
    catch (error) {
        next(error);
    }
});
router.patch('/:id/status', async (req, res, next) => {
    try {
        const id = Number(req.params.id);
        const status = req.body?.status;
        const validStatuses = ['MENUNGGU_KONFIRMASI', 'DIPROSES', 'SELESAI', 'DIBATALKAN'];
        if (!Number.isInteger(id) || id < 1 || !validStatuses.includes(status))
            throw (0, response_1.errorResponse)('ID atau status pesanan tidak valid');
        const exists = await database_1.default.pesananPelanggan.findUnique({ where: { id }, select: { id: true } });
        if (!exists)
            throw (0, response_1.errorResponse)('Pesanan tidak ditemukan', 404);
        const updated = await database_1.default.pesananPelanggan.update({
            where: { id },
            data: { status },
            include: { pelanggan: { select: { id: true, nama: true, email: true, noTelepon: true } }, item: true },
        });
        res.json((0, response_1.successResponse)(updated, 'Status pesanan diperbarui'));
    }
    catch (error) {
        next(error);
    }
});
exports.default = router;
