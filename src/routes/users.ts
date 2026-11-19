import { Router, Response } from 'express';
import bcrypt from 'bcrypt';
import { AksiLog } from '@prisma/client';
import { authenticate, authorizeRoles, AuthRequest } from '../middleware/auth';
import { logManualAction } from '../services/auditLogService';
import prisma from '../utils/database';
import { errorResponse, successResponse } from '../utils/response';

const router = Router();
router.use(authenticate, authorizeRoles('SUPER_ADMIN'));

router.get('/', async (_req: AuthRequest, res: Response, next) => {
  try {
    const users = await prisma.pengguna.findMany({
      select: { id: true, nama: true, email: true, peran: true, dibuatPada: true },
      orderBy: { dibuatPada: 'asc' },
    });
    res.json(successResponse(users));
  } catch (error) { next(error); }
});

router.post('/', async (req: AuthRequest, res: Response, next) => {
  try {
    const nama = typeof req.body?.nama === 'string' ? req.body.nama.trim() : '';
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const peran = req.body?.peran === 'SUPER_ADMIN' ? 'SUPER_ADMIN' : req.body?.peran === 'ADMIN' || req.body?.peran === undefined ? 'ADMIN' : null;
    if (!nama || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 12 || !peran) {
      throw errorResponse('Nama, email valid, role yang sesuai, dan password awal minimal 12 karakter wajib diisi');
    }
    const existing = await prisma.pengguna.findUnique({ where: { email }, select: { id: true } });
    if (existing) throw errorResponse('Email sudah digunakan', 409);
    const created = await prisma.pengguna.create({
      data: { nama, email, passwordHash: await bcrypt.hash(password, 10), peran },
      select: { id: true, nama: true, email: true, peran: true, dibuatPada: true },
    });
    await logManualAction(req.user!.id, 'pengguna', AksiLog.TAMBAH, created.email, `Admin baru dibuat: ${created.email}`, created.id, undefined, { nama: created.nama, email: created.email, peran: created.peran });
    res.status(201).json(successResponse(created, 'Akun Admin berhasil dibuat'));
  } catch (error) { next(error); }
});

export default router;
