import { Router, Response } from 'express';
import { AksiLog } from '@prisma/client';
import { authenticate, authorizeRoles, AuthRequest } from '../middleware/auth';
import { logManualAction } from '../services/auditLogService';
import prisma from '../utils/database';
import { errorResponse, successResponse } from '../utils/response';

const router = Router();
router.use(authenticate, authorizeRoles('SUPER_ADMIN'));

router.get('/summary', async (_req: AuthRequest, res: Response, next) => {
  try {
    const [total, aktif, nonaktif, promosiDiizinkan] = await Promise.all([
      prisma.pelanggan.count(),
      prisma.pelanggan.count({ where: { aktif: true } }),
      prisma.pelanggan.count({ where: { aktif: false } }),
      prisma.pelanggan.count({ where: { promosiDiizinkan: true, aktif: true } }),
    ]);
    res.json(successResponse({ total, aktif, nonaktif, promosiDiizinkan }));
  } catch (error) { next(error); }
});

router.get('/', async (req: AuthRequest, res: Response, next) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const status = typeof req.query.status === 'string' ? req.query.status : 'semua';
    const lamaTidakLoginHari = req.query.lamaTidakLoginHari === undefined ? undefined : Number(req.query.lamaTidakLoginHari);
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));
    if (!['semua', 'aktif', 'nonaktif'].includes(status)) throw errorResponse('Filter status akun tidak valid');
    if (lamaTidakLoginHari !== undefined && (!Number.isInteger(lamaTidakLoginHari) || lamaTidakLoginHari < 1 || lamaTidakLoginHari > 3650)) throw errorResponse('Filter lama tidak login tidak valid');

    const where: any = {};
    if (status !== 'semua') where.aktif = status === 'aktif';
    const conditions: any[] = [];
    if (q) conditions.push({ OR: [
      { nama: { contains: q } },
      { email: { contains: q } },
      { noTelepon: { contains: q } },
    ] });
    if (lamaTidakLoginHari !== undefined) {
      const cutoff = new Date(Date.now() - lamaTidakLoginHari * 24 * 60 * 60 * 1000);
      conditions.push({ OR: [{ terakhirMasukPada: null }, { terakhirMasukPada: { lt: cutoff } }] });
    }
    if (conditions.length) where.AND = conditions;

    const [customers, total] = await Promise.all([
      prisma.pelanggan.findMany({
        where,
        select: {
          id: true, nama: true, email: true, noTelepon: true, aktif: true,
          promosiDiizinkan: true, dibuatPada: true, terakhirMasukPada: true,
          _count: { select: { pesanan: true } },
          pesanan: { take: 1, orderBy: { dibuatPada: 'desc' }, select: { kode: true, status: true, dibuatPada: true, total: true } },
        },
        orderBy: { dibuatPada: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.pelanggan.count({ where }),
    ]);
    res.json(successResponse({ customers, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } }));
  } catch (error) { next(error); }
});

router.get('/:id', async (req: AuthRequest, res: Response, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) throw errorResponse('ID customer tidak valid');
    const customer = await prisma.pelanggan.findUnique({
      where: { id },
      select: {
        id: true, nama: true, email: true, noTelepon: true, alamat: true, aktif: true,
        promosiDiizinkan: true, promosiDisetujuiPada: true, promosiBerhentiPada: true,
        dibuatPada: true, diubahPada: true, terakhirMasukPada: true,
        _count: { select: { pesanan: true } },
        pesanan: { take: 100, orderBy: { dibuatPada: 'desc' }, include: { item: true } },
      },
    });
    if (!customer) throw errorResponse('Customer tidak ditemukan', 404);
    res.json(successResponse(customer));
  } catch (error) { next(error); }
});

router.patch('/:id/status', async (req: AuthRequest, res: Response, next) => {
  try {
    const id = Number(req.params.id);
    const aktif = req.body?.aktif;
    if (!Number.isInteger(id) || id < 1 || typeof aktif !== 'boolean') throw errorResponse('ID atau status akun tidak valid');
    const existing = await prisma.pelanggan.findUnique({ where: { id }, select: { id: true, nama: true, aktif: true } });
    if (!existing) throw errorResponse('Customer tidak ditemukan', 404);
    if (existing.aktif === aktif) return res.json(successResponse(existing, 'Status akun tidak berubah'));
    const updated = await prisma.pelanggan.update({ where: { id }, data: { aktif }, select: { id: true, nama: true, email: true, aktif: true } });
    await logManualAction(
      req.user!.id, 'pelanggan', AksiLog.UBAH, `Customer #${id}`,
      aktif ? 'Akun customer diaktifkan kembali' : 'Akun customer dinonaktifkan',
      id, { aktif: existing.aktif }, { aktif: updated.aktif },
    );
    res.json(successResponse(updated, aktif ? 'Akun customer diaktifkan kembali' : 'Akun customer dinonaktifkan'));
  } catch (error) { next(error); }
});

export default router;
