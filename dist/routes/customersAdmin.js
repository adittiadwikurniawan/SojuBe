"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const client_1 = require("@prisma/client");
const auth_1 = require("../middleware/auth");
const auditLogService_1 = require("../services/auditLogService");
const database_1 = __importDefault(require("../utils/database"));
const response_1 = require("../utils/response");
const router = (0, express_1.Router)();
router.use(auth_1.authenticate, (0, auth_1.authorizeRoles)('SUPER_ADMIN'));
router.get('/summary', async (_req, res, next) => {
    try {
        const [total, aktif, nonaktif, promosiDiizinkan] = await Promise.all([
            database_1.default.pelanggan.count(),
            database_1.default.pelanggan.count({ where: { aktif: true } }),
            database_1.default.pelanggan.count({ where: { aktif: false } }),
            database_1.default.pelanggan.count({ where: { promosiDiizinkan: true, aktif: true } }),
        ]);
        res.json((0, response_1.successResponse)({ total, aktif, nonaktif, promosiDiizinkan }));
    }
    catch (error) {
        next(error);
    }
});
router.get('/', async (req, res, next) => {
    try {
        const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
        const status = typeof req.query.status === 'string' ? req.query.status : 'semua';
        const lamaTidakLoginHari = req.query.lamaTidakLoginHari === undefined ? undefined : Number(req.query.lamaTidakLoginHari);
        const page = Math.max(1, Number(req.query.page) || 1);
        const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));
        if (!['semua', 'aktif', 'nonaktif'].includes(status))
            throw (0, response_1.errorResponse)('Filter status akun tidak valid');
        if (lamaTidakLoginHari !== undefined && (!Number.isInteger(lamaTidakLoginHari) || lamaTidakLoginHari < 1 || lamaTidakLoginHari > 3650))
            throw (0, response_1.errorResponse)('Filter lama tidak login tidak valid');
        const where = {};
        if (status !== 'semua')
            where.aktif = status === 'aktif';
        const conditions = [];
        if (q)
            conditions.push({ OR: [
                    { nama: { contains: q } },
                    { email: { contains: q } },
                    { noTelepon: { contains: q } },
                ] });
        if (lamaTidakLoginHari !== undefined) {
            const cutoff = new Date(Date.now() - lamaTidakLoginHari * 24 * 60 * 60 * 1000);
            conditions.push({ OR: [{ terakhirMasukPada: null }, { terakhirMasukPada: { lt: cutoff } }] });
        }
        if (conditions.length)
            where.AND = conditions;
        const [customers, total] = await Promise.all([
            database_1.default.pelanggan.findMany({
                where,
                select: {
                    id: true, nama: true, email: true, noTelepon: true, aktif: true,
                    promosiDiizinkan: true, dibuatPada: true, terakhirMasukPada: true,
                    _count: { select: { pesanan: true } },
                    pesanan: { take: 1, orderBy: { dibuatPada: 'desc' }, select: { kode: true, status: true, dibuatPada: true, total: true } },
                },
                orderBy: { dibuatPada: 'desc' },
                skip: (page - 1) * limit,
                take: limit,
            }),
            database_1.default.pelanggan.count({ where }),
        ]);
        res.json((0, response_1.successResponse)({ customers, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } }));
    }
    catch (error) {
        next(error);
    }
});
router.get('/:id', async (req, res, next) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id < 1)
            throw (0, response_1.errorResponse)('ID customer tidak valid');
        const customer = await database_1.default.pelanggan.findUnique({
            where: { id },
            select: {
                id: true, nama: true, email: true, noTelepon: true, alamat: true, aktif: true,
                promosiDiizinkan: true, promosiDisetujuiPada: true, promosiBerhentiPada: true,
                dibuatPada: true, diubahPada: true, terakhirMasukPada: true,
                _count: { select: { pesanan: true } },
                pesanan: { take: 100, orderBy: { dibuatPada: 'desc' }, include: { item: true } },
            },
        });
        if (!customer)
            throw (0, response_1.errorResponse)('Customer tidak ditemukan', 404);
        res.json((0, response_1.successResponse)(customer));
    }
    catch (error) {
        next(error);
    }
});
router.patch('/:id/status', async (req, res, next) => {
    try {
        const id = Number(req.params.id);
        const aktif = req.body?.aktif;
        if (!Number.isInteger(id) || id < 1 || typeof aktif !== 'boolean')
            throw (0, response_1.errorResponse)('ID atau status akun tidak valid');
        const existing = await database_1.default.pelanggan.findUnique({ where: { id }, select: { id: true, nama: true, aktif: true } });
        if (!existing)
            throw (0, response_1.errorResponse)('Customer tidak ditemukan', 404);
        if (existing.aktif === aktif)
            return res.json((0, response_1.successResponse)(existing, 'Status akun tidak berubah'));
        const updated = await database_1.default.pelanggan.update({ where: { id }, data: { aktif }, select: { id: true, nama: true, email: true, aktif: true } });
        await (0, auditLogService_1.logManualAction)(req.user.id, 'pelanggan', client_1.AksiLog.UBAH, `Customer #${id}`, aktif ? 'Akun customer diaktifkan kembali' : 'Akun customer dinonaktifkan', id, { aktif: existing.aktif }, { aktif: updated.aktif });
        res.json((0, response_1.successResponse)(updated, aktif ? 'Akun customer diaktifkan kembali' : 'Akun customer dinonaktifkan'));
    }
    catch (error) {
        next(error);
    }
});
exports.default = router;
