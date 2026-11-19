import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { errorResponse } from '../utils/response';
import prisma from '../utils/database';

export interface AuthRequest extends Request {
  user?: { id: number; email: string; role: 'ADMIN' | 'SUPER_ADMIN' };
}

export const authenticate = async (req: AuthRequest, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return next(errorResponse('Unauthorized - No token provided', 401));
  }

  const token = authHeader.substring(7);
  const JWT_SECRET = process.env.JWT_SECRET;
  if (!JWT_SECRET) {
    return next(new Error('JWT_SECRET belum diatur di environment'));
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { id: number; email: string; type?: string };
    if (decoded.type === 'customer') return next(errorResponse('Token customer tidak dapat digunakan untuk admin', 401));
    const user = await prisma.pengguna.findUnique({
      where: { id: decoded.id },
      select: { id: true, email: true, peran: true },
    });
    if (!user) return next(errorResponse('Akun admin tidak ditemukan', 401));
    req.user = { id: user.id, email: user.email, role: user.peran };
    return next();
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError || error instanceof jwt.TokenExpiredError) {
      return next(errorResponse('Unauthorized - Invalid token', 401));
    }
    return next(error);
  }
};

export const authorizeRoles = (...roles: Array<'ADMIN' | 'SUPER_ADMIN'>) =>
  (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return next(errorResponse('Anda tidak memiliki akses untuk tindakan ini', 403));
    }
    return next();
  };
