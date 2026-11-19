import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../utils/database';
import { errorResponse } from '../utils/response';

export interface CustomerRequest extends Request {
  customer?: { id: number; email: string };
}

export const authenticateCustomer = async (req: CustomerRequest, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return next(errorResponse('Login customer diperlukan', 401));
  const secret = process.env.JWT_SECRET;
  if (!secret) return next(new Error('JWT_SECRET belum diatur di environment'));

  try {
    const decoded = jwt.verify(authHeader.slice(7), secret) as { id: number; email: string; type?: string };
    if (decoded.type !== 'customer') return next(errorResponse('Token bukan milik customer', 401));
    const customer = await prisma.pelanggan.findUnique({
      where: { id: decoded.id },
      select: { id: true, email: true, aktif: true },
    });
    if (!customer?.aktif) return next(errorResponse('Akun customer tidak ditemukan atau nonaktif', 401));
    req.customer = { id: customer.id, email: customer.email };
    return next();
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError) return next(errorResponse('Sesi customer tidak valid', 401));
    return next(error);
  }
};
