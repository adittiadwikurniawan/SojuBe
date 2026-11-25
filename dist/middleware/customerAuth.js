"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.authenticateCustomer = void 0;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const database_1 = __importDefault(require("../utils/database"));
const response_1 = require("../utils/response");
const authenticateCustomer = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer '))
        return next((0, response_1.errorResponse)('Login customer diperlukan', 401));
    const secret = process.env.JWT_SECRET;
    if (!secret)
        return next(new Error('JWT_SECRET belum diatur di environment'));
    try {
        const decoded = jsonwebtoken_1.default.verify(authHeader.slice(7), secret);
        if (decoded.type !== 'customer')
            return next((0, response_1.errorResponse)('Token bukan milik customer', 401));
        const customer = await database_1.default.pelanggan.findUnique({
            where: { id: decoded.id },
            select: { id: true, email: true, aktif: true },
        });
        if (!customer?.aktif)
            return next((0, response_1.errorResponse)('Akun customer tidak ditemukan atau nonaktif', 401));
        req.customer = { id: customer.id, email: customer.email };
        return next();
    }
    catch (error) {
        if (error instanceof jsonwebtoken_1.default.JsonWebTokenError)
            return next((0, response_1.errorResponse)('Sesi customer tidak valid', 401));
        return next(error);
    }
};
exports.authenticateCustomer = authenticateCustomer;
