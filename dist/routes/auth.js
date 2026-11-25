"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const authService_1 = require("../services/authService");
const auth_1 = require("../middleware/auth");
const response_1 = require("../utils/response");
const database_1 = __importDefault(require("../utils/database"));
const bcrypt_1 = __importDefault(require("bcrypt"));
const router = (0, express_1.Router)();
// POST /auth/login
router.post('/login', async (req, res, next) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) {
            throw (0, response_1.errorResponse)('Email and password are required');
        }
        const result = await (0, authService_1.login)({ email, password });
        res.json((0, response_1.successResponse)(result));
    }
    catch (error) {
        next(error);
    }
});
// GET /auth/me
router.get('/me', auth_1.authenticate, async (req, res, next) => {
    try {
        const user = await database_1.default.pengguna.findUnique({
            where: { id: req.user.id },
            select: {
                id: true,
                nama: true,
                email: true,
                peran: true,
                dibuatPada: true,
            }
        });
        if (!user) {
            throw (0, response_1.errorResponse)('User not found', 404);
        }
        res.json((0, response_1.successResponse)(user));
    }
    catch (error) {
        next(error);
    }
});
router.patch('/me', auth_1.authenticate, async (req, res, next) => {
    try {
        const nama = typeof req.body?.nama === 'string' ? req.body.nama.trim() : '';
        const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
        if (!nama || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
            throw (0, response_1.errorResponse)('Nama dan email valid wajib diisi');
        const duplicate = await database_1.default.pengguna.findFirst({ where: { email, id: { not: req.user.id } }, select: { id: true } });
        if (duplicate)
            throw (0, response_1.errorResponse)('Email sudah digunakan akun lain', 409);
        const user = await database_1.default.pengguna.update({ where: { id: req.user.id }, data: { nama, email }, select: { id: true, nama: true, email: true, peran: true, dibuatPada: true } });
        res.json((0, response_1.successResponse)(user, 'Profil akun diperbarui'));
    }
    catch (error) {
        next(error);
    }
});
router.post('/change-password', auth_1.authenticate, async (req, res, next) => {
    try {
        const passwordLama = typeof req.body?.passwordLama === 'string' ? req.body.passwordLama : '';
        const passwordBaru = typeof req.body?.passwordBaru === 'string' ? req.body.passwordBaru : '';
        if (passwordBaru.length < 8)
            throw (0, response_1.errorResponse)('Password baru minimal 8 karakter');
        const user = await database_1.default.pengguna.findUnique({ where: { id: req.user.id }, select: { passwordHash: true } });
        if (!user || !(await bcrypt_1.default.compare(passwordLama, user.passwordHash)))
            throw (0, response_1.errorResponse)('Password lama tidak sesuai', 401);
        await database_1.default.pengguna.update({ where: { id: req.user.id }, data: { passwordHash: await bcrypt_1.default.hash(passwordBaru, 10) } });
        res.json((0, response_1.successResponse)(null, 'Password berhasil diperbarui'));
    }
    catch (error) {
        next(error);
    }
});
exports.default = router;
