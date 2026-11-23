import { Router, Request, Response } from 'express';
import {
  AuthServiceError,
  login,
  requestPasswordReset,
  resetPassword,
} from '../services/authService';
import { authenticate, AuthRequest } from '../middleware/auth';
import { successResponse, errorResponse } from '../utils/response';
import prisma from '../utils/database';
import bcrypt from 'bcrypt';

const router = Router();
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const mapServiceError = (error: unknown) => {
  if (error instanceof AuthServiceError) {
    return errorResponse(error.message, error.status);
  }
  return error;
};

// POST /auth/login
router.post('/login', async (req: Request, res: Response, next) => {
  try {
    const email = typeof req.body?.email === 'string' ? req.body.email : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';

    if (!email.trim() || !password) {
      throw errorResponse('Email dan password wajib diisi', 400);
    }

    const result = await login({ email, password });
    res.json(successResponse(result));
  } catch (error) {
    next(mapServiceError(error));
  }
});

// POST /auth/forgot-password
router.post('/forgot-password', async (req: Request, res: Response, next) => {
  try {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';

    if (!email || !EMAIL_REGEX.test(email)) {
      throw errorResponse('Format email tidak valid', 400);
    }

    const result = await requestPasswordReset(email);
    res.status(200).json(successResponse(null, result.message));
  } catch (error) {
    next(mapServiceError(error));
  }
});

// POST /auth/reset-password
router.post('/reset-password', async (req: Request, res: Response, next) => {
  try {
    const token = typeof req.body?.token === 'string' ? req.body.token : '';
    const passwordBaru =
      typeof req.body?.passwordBaru === 'string'
        ? req.body.passwordBaru
        : typeof req.body?.newPassword === 'string'
          ? req.body.newPassword
          : typeof req.body?.password === 'string'
            ? req.body.password
            : '';

    const result = await resetPassword({ token, passwordBaru });
    res.status(200).json(successResponse(null, result.message));
  } catch (error) {
    next(mapServiceError(error));
  }
});

// GET /auth/me
router.get('/me', authenticate, async (req: AuthRequest, res: Response, next) => {
  try {
    const user = await prisma.pengguna.findUnique({
      where: { id: req.user!.id },
      select: {
        id: true,
        nama: true,
        email: true,
        peran: true,
        aktif: true,
        terakhirMasukPada: true,
        dibuatPada: true,
      },
    });

    if (!user) {
      throw errorResponse('User not found', 404);
    }

    res.json(successResponse(user));
  } catch (error) {
    next(error);
  }
});

router.patch('/me', authenticate, async (req: AuthRequest, res: Response, next) => {
  try {
    const nama = typeof req.body?.nama === 'string' ? req.body.nama.trim() : '';
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    if (!nama || !EMAIL_REGEX.test(email)) throw errorResponse('Nama dan email valid wajib diisi');
    const duplicate = await prisma.pengguna.findFirst({ where: { email, id: { not: req.user!.id } }, select: { id: true } });
    if (duplicate) throw errorResponse('Email sudah digunakan akun lain', 409);
    const user = await prisma.pengguna.update({
      where: { id: req.user!.id },
      data: { nama, email },
      select: { id: true, nama: true, email: true, peran: true, aktif: true, terakhirMasukPada: true, dibuatPada: true },
    });
    res.json(successResponse(user, 'Profil akun diperbarui'));
  } catch (error) { next(error); }
});

router.post('/change-password', authenticate, async (req: AuthRequest, res: Response, next) => {
  try {
    const passwordLama = typeof req.body?.passwordLama === 'string' ? req.body.passwordLama : '';
    const passwordBaru = typeof req.body?.passwordBaru === 'string' ? req.body.passwordBaru : '';
    if (passwordBaru.length < 8) throw errorResponse('Password baru minimal 8 karakter');
    const user = await prisma.pengguna.findUnique({ where: { id: req.user!.id }, select: { passwordHash: true } });
    if (!user || !(await bcrypt.compare(passwordLama, user.passwordHash))) throw errorResponse('Password lama tidak sesuai', 401);
    await prisma.pengguna.update({ where: { id: req.user!.id }, data: { passwordHash: await bcrypt.hash(passwordBaru, 10) } });
    res.json(successResponse(null, 'Password berhasil diperbarui'));
  } catch (error) { next(error); }
});

export default router;
