import { Router, Response } from 'express';
import { authenticate, authorizeRoles, AuthRequest } from '../middleware/auth';
import prisma from '../utils/database';
import { errorResponse, successResponse } from '../utils/response';

const router = Router();
router.use(authenticate, authorizeRoles('ADMIN', 'SUPER_ADMIN'));

router.get('/', async (req: AuthRequest, res: Response, next) => {
  try {
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const validStatuses = ['MENUNGGU_KONFIRMASI', 'DIPROSES', 'SELESAI', 'DIBATALKAN'];
    if (status && !validStatuses.includes(status)) throw errorResponse('Status pesanan tidak valid');
    const pesanan = await prisma.pesananPelanggan.findMany({
      where: status ? { status: status as any } : undefined,
      include: { pelanggan: { select: { id: true, nama: true, email: true, noTelepon: true } }, item: true },
      orderBy: { dibuatPada: 'desc' },
      take: 200,
    });
    res.json(successResponse(pesanan));
  } catch (error) { next(error); }
});

router.patch('/:id/status', async (req: AuthRequest, res: Response, next) => {
  try {
    const id = Number(req.params.id);
    const status = req.body?.status;
    const validStatuses = ['MENUNGGU_KONFIRMASI', 'DIPROSES', 'SELESAI', 'DIBATALKAN'];
    if (!Number.isInteger(id) || id < 1 || !validStatuses.includes(status)) throw errorResponse('ID atau status pesanan tidak valid');
    const exists = await prisma.pesananPelanggan.findUnique({ where: { id }, select: { id: true } });
    if (!exists) throw errorResponse('Pesanan tidak ditemukan', 404);
    const updated = await prisma.pesananPelanggan.update({
      where: { id },
      data: { status },
      include: { pelanggan: { select: { id: true, nama: true, email: true, noTelepon: true } }, item: true },
    });
    res.json(successResponse(updated, 'Status pesanan diperbarui'));
  } catch (error) { next(error); }
});

export default router;
