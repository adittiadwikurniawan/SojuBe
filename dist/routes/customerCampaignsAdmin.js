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
const segmentNames = Object.values(client_1.SegmenKampanyePelanggan);
router.use(auth_1.authenticate, (0, auth_1.authorizeRoles)('SUPER_ADMIN'));
function campaignWhere(segmen, hariTidakMemesan) {
    const where = { aktif: true, promosiDiizinkan: true };
    if (segmen === 'BELUM_PERNAH_MEMESAN')
        where.pesanan = { none: {} };
    if (segmen === 'TIDAK_MEMESAN_LAGI') {
        const cutoff = new Date(Date.now() - Number(hariTidakMemesan) * 24 * 60 * 60 * 1000);
        where.AND = [
            { pesanan: { some: { status: 'SELESAI' } } },
            { pesanan: { none: { status: 'SELESAI', dibuatPada: { gte: cutoff } } } },
        ];
    }
    return where;
}
function parseSegment(segmen, hariValue) {
    if (typeof segmen !== 'string' || !segmentNames.includes(segmen))
        throw (0, response_1.errorResponse)('Segmen kampanye tidak valid');
    const hari = hariValue === undefined || hariValue === null || hariValue === '' ? undefined : Number(hariValue);
    if (segmen === 'TIDAK_MEMESAN_LAGI' && (!Number.isInteger(hari) || Number(hari) < 1 || Number(hari) > 3650))
        throw (0, response_1.errorResponse)('Jumlah hari tidak memesan harus antara 1 dan 3650');
    return { segmen: segmen, hariTidakMemesan: segmen === 'TIDAK_MEMESAN_LAGI' ? Number(hari) : null };
}
router.get('/preview', async (req, res, next) => {
    try {
        const { segmen, hariTidakMemesan } = parseSegment(req.query.segmen, req.query.hariTidakMemesan);
        const where = campaignWhere(segmen, hariTidakMemesan ?? undefined);
        const [total, customers] = await Promise.all([
            database_1.default.pelanggan.count({ where }),
            database_1.default.pelanggan.findMany({
                where,
                select: { id: true, nama: true, email: true, terakhirMasukPada: true, pesanan: { take: 1, orderBy: { dibuatPada: 'desc' }, select: { dibuatPada: true, status: true } } },
                orderBy: { nama: 'asc' },
                take: 100,
            }),
        ]);
        res.json((0, response_1.successResponse)({ total, customers, previewDibatasi: total > customers.length }));
    }
    catch (error) {
        next(error);
    }
});
router.get('/', async (_req, res, next) => {
    try {
        const campaigns = await database_1.default.kampanyePelanggan.findMany({
            include: { pengguna: { select: { id: true, nama: true } } },
            orderBy: { diubahPada: 'desc' },
        });
        res.json((0, response_1.successResponse)(campaigns));
    }
    catch (error) {
        next(error);
    }
});
router.post('/', async (req, res, next) => {
    try {
        const judul = typeof req.body?.judul === 'string' ? req.body.judul.trim() : '';
        const subjek = typeof req.body?.subjek === 'string' ? req.body.subjek.trim() : '';
        const isi = typeof req.body?.isi === 'string' ? req.body.isi.trim() : '';
        const { segmen, hariTidakMemesan } = parseSegment(req.body?.segmen, req.body?.hariTidakMemesan);
        if (!judul || !subjek || !isi)
            throw (0, response_1.errorResponse)('Judul, subjek, dan isi kampanye wajib diisi');
        const campaign = await database_1.default.kampanyePelanggan.create({
            data: { judul, subjek, isi, segmen, hariTidakMemesan, dibuatOleh: req.user.id },
        });
        await (0, auditLogService_1.logManualAction)(req.user.id, 'kampanye_pelanggan', client_1.AksiLog.TAMBAH, judul, 'Draft kampanye CRM dibuat', campaign.id);
        res.status(201).json((0, response_1.successResponse)(campaign, 'Draft kampanye disimpan. Email belum dikirim.'));
    }
    catch (error) {
        next(error);
    }
});
router.put('/:id', async (req, res, next) => {
    try {
        const id = Number(req.params.id);
        const judul = typeof req.body?.judul === 'string' ? req.body.judul.trim() : '';
        const subjek = typeof req.body?.subjek === 'string' ? req.body.subjek.trim() : '';
        const isi = typeof req.body?.isi === 'string' ? req.body.isi.trim() : '';
        const { segmen, hariTidakMemesan } = parseSegment(req.body?.segmen, req.body?.hariTidakMemesan);
        if (!Number.isInteger(id) || id < 1 || !judul || !subjek || !isi)
            throw (0, response_1.errorResponse)('Data draft kampanye tidak valid');
        const existing = await database_1.default.kampanyePelanggan.findUnique({ where: { id } });
        if (!existing)
            throw (0, response_1.errorResponse)('Draft kampanye tidak ditemukan', 404);
        const updated = await database_1.default.kampanyePelanggan.update({ where: { id }, data: { judul, subjek, isi, segmen, hariTidakMemesan } });
        await (0, auditLogService_1.logManualAction)(req.user.id, 'kampanye_pelanggan', client_1.AksiLog.UBAH, updated.judul, 'Draft kampanye CRM diperbarui', id, { judul: existing.judul, subjek: existing.subjek, segmen: existing.segmen }, { judul, subjek, segmen });
        res.json((0, response_1.successResponse)(updated, 'Draft kampanye diperbarui. Email belum dikirim.'));
    }
    catch (error) {
        next(error);
    }
});
router.delete('/:id', async (req, res, next) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id < 1)
            throw (0, response_1.errorResponse)('ID draft tidak valid');
        const existing = await database_1.default.kampanyePelanggan.findUnique({ where: { id }, select: { id: true, judul: true } });
        if (!existing)
            throw (0, response_1.errorResponse)('Draft kampanye tidak ditemukan', 404);
        await database_1.default.kampanyePelanggan.delete({ where: { id } });
        await (0, auditLogService_1.logManualAction)(req.user.id, 'kampanye_pelanggan', client_1.AksiLog.HAPUS, existing.judul, 'Draft kampanye CRM dihapus', id);
        res.json((0, response_1.successResponse)({ id }, 'Draft kampanye dihapus'));
    }
    catch (error) {
        next(error);
    }
});
exports.default = router;
