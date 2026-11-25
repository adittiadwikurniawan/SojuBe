"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.authorizeRoles = exports.authenticate = void 0;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const response_1 = require("../utils/response");
const database_1 = __importDefault(require("../utils/database"));
const authenticate = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return next((0, response_1.errorResponse)('Unauthorized - No token provided', 401));
    }
    const token = authHeader.substring(7);
    const JWT_SECRET = process.env.JWT_SECRET;
    if (!JWT_SECRET) {
        return next(new Error('JWT_SECRET belum diatur di environment'));
    }
    try {
        const decoded = jsonwebtoken_1.default.verify(token, JWT_SECRET);
        if (decoded.type === 'customer')
            return next((0, response_1.errorResponse)('Token customer tidak dapat digunakan untuk admin', 401));
        const user = await database_1.default.pengguna.findUnique({
            where: { id: decoded.id },
            select: { id: true, email: true, peran: true },
        });
        if (!user)
            return next((0, response_1.errorResponse)('Akun admin tidak ditemukan', 401));
        req.user = { id: user.id, email: user.email, role: user.peran };
        return next();
    }
    catch (error) {
        if (error instanceof jsonwebtoken_1.default.JsonWebTokenError || error instanceof jsonwebtoken_1.default.TokenExpiredError) {
            return next((0, response_1.errorResponse)('Unauthorized - Invalid token', 401));
        }
        return next(error);
    }
};
exports.authenticate = authenticate;
const authorizeRoles = (...roles) => (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
        return next((0, response_1.errorResponse)('Anda tidak memiliki akses untuk tindakan ini', 403));
    }
    return next();
};
exports.authorizeRoles = authorizeRoles;
