"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const bcrypt_1 = __importDefault(require("bcrypt"));
const client_1 = require("@prisma/client");
const auth_1 = require("../middleware/auth");
const auditLogService_1 = require("../services/auditLogService");
const database_1 = __importDefault(require("../utils/database"));
const response_1 = require("../utils/response");
const router = (0, express_1.Router)();
router.use(auth_1.authenticate, (0, auth_1.authorizeRoles)('SUPER_ADMIN'));
router.get('/', async (_req, res, next) => {
    try {
        const users = await database_1.default.pengguna.findMany({
            select: { id: true, nama: true, email: true, peran: true, dibuatPada: true },
            orderBy: { dibuatPada: 'asc' },
        });
        res.json((0, response_1.successResponse)(users));
    }
    catch (error) {
        next(error);
    }
});
router.post('/', async (req, res, next) => {
    try {
        const nama = typeof req.body?.nama === 'string' ? req.body.nama.trim() : '';
        const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
        const password = typeof req.body?.password === 'string' ? req.body.password : '';
        const peran = req.body?.peran === 'SUPER_ADMIN' ? 'SUPER_ADMIN' : req.body?.peran === 'ADMIN' || req.body?.peran === undefined ? 'ADMIN' : null;
        if (!nama || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 12 || !peran) {
            throw (0, response_1.errorResponse)('Nama, email valid, role yang sesuai, dan password awal minimal 12 karakter wajib diisi');
        }
        const existing = await database_1.default.pengguna.findUnique({ where: { email }, select: { id: true } });
        if (existing)
            throw (0, response_1.errorResponse)('Email sudah digunakan', 409);
        const created = await database_1.default.pengguna.create({
            data: { nama, email, passwordHash: await bcrypt_1.default.hash(password, 10), peran },
            select: { id: true, nama: true, email: true, peran: true, dibuatPada: true },
        });
        await (0, auditLogService_1.logManualAction)(req.user.id, 'pengguna', client_1.AksiLog.TAMBAH, created.email, `Admin baru dibuat: ${created.email}`, created.id, undefined, { nama: created.nama, email: created.email, peran: created.peran });
        res.status(201).json((0, response_1.successResponse)(created, 'Akun Admin berhasil dibuat'));
    }
    catch (error) {
        next(error);
    }
});
exports.default = router;
