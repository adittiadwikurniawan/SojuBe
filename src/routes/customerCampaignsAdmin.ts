import { Router, Response } from 'express';
import { SegmenKampanyePelanggan, AksiLog } from '@prisma/client';
import { authenticate, authorizeRoles, AuthRequest } from '../middleware/auth';
import { logManualAction } from '../services/auditLogService';
import prisma from '../utils/database';
import { errorResponse, successResponse } from '../utils/response';

const router = Router();
const segmentNames = Object.values(SegmenKampanyePelanggan);
router.use(authenticate, authorizeRoles('SUPER_ADMIN'));

function campaignWhere(segmen: SegmenKampanyePelanggan, hariTidakMemesan?: number) {
  const where: any = { aktif: true, promosiDiizinkan: true };
  if (segmen === 'BELUM_PERNAH_MEMESAN') where.pesanan = { none: {} };
  if (segmen === 'TIDAK_MEMESAN_LAGI') {
    const cutoff = new Date(Date.now() - Number(hariTidakMemesan) * 24 * 60 * 60 * 1000);
    where.AND = [
      { pesanan: { some: { status: 'SELESAI' } } },
      { pesanan: { none: { status: 'SELESAI', dibuatPada: { gte: cutoff } } } },
    ];
  }
  return where;
}

function parseSegment(segmen: unknown, hariValue: unknown) {
  if (typeof segmen !== 'string' || !segmentNames.includes(segmen as SegmenKampanyePelanggan)) throw errorResponse('Segmen kampanye tidak valid');
  const hari = hariValue === undefined || hariValue === null || hariValue === '' ? undefined : Number(hariValue);
  if (segmen === 'TIDAK_MEMESAN_LAGI' && (!Number.isInteger(hari) || Number(hari) < 1 || Number(hari) > 3650)) throw errorResponse('Jumlah hari tidak memesan harus antara 1 dan 3650');
  return { segmen: segmen as SegmenKampanyePelanggan, hariTidakMemesan: segmen === 'TIDAK_MEMESAN_LAGI' ? Number(hari) : null };
}

router.get('/preview', async (req: AuthRequest, res: Response, next) => {
  try {
    const { segmen, hariTidakMemesan } = parseSegment(req.query.segmen, req.query.hariTidakMemesan);
    const where = campaignWhere(segmen, hariTidakMemesan ?? undefined);
    const [total, customers] = await Promise.all([
      prisma.pelanggan.count({ where }),
      prisma.pelanggan.findMany({
        where,
        select: { id: true, nama: true, email: true, terakhirMasukPada: true, pesanan: { take: 1, orderBy: { dibuatPada: 'desc' }, select: { dibuatPada: true, status: true } } },
        orderBy: { nama: 'asc' },
        take: 100,
      }),
    ]);
    res.json(successResponse({ total, customers, previewDibatasi: total > customers.length }));
  } catch (error) { next(error); }
});

router.get('/', async (_req: AuthRequest, res: Response, next) => {
  try {
    const campaigns = await prisma.kampanyePelanggan.findMany({
      include: { pengguna: { select: { id: true, nama: true } } },
      orderBy: { diubahPada: 'desc' },
    });
    res.json(successResponse(campaigns));
  } catch (error) { next(error); }
});

router.post('/', async (req: AuthRequest, res: Response, next) => {
  try {
    const judul = typeof req.body?.judul === 'string' ? req.body.judul.trim() : '';
    const subjek = typeof req.body?.subjek === 'string' ? req.body.subjek.trim() : '';
    const isi = typeof req.body?.isi === 'string' ? req.body.isi.trim() : '';
    const { segmen, hariTidakMemesan } = parseSegment(req.body?.segmen, req.body?.hariTidakMemesan);
    if (!judul || !subjek || !isi) throw errorResponse('Judul, subjek, dan isi kampanye wajib diisi');
    const campaign = await prisma.kampanyePelanggan.create({
      data: { judul, subjek, isi, segmen, hariTidakMemesan, dibuatOleh: req.user!.id },
    });
    await logManualAction(req.user!.id, 'kampanye_pelanggan', AksiLog.TAMBAH, judul, 'Draft kampanye CRM dibuat', campaign.id);
    res.status(201).json(successResponse(campaign, 'Draft kampanye disimpan. Email belum dikirim.'));
  } catch (error) { next(error); }
});

router.put('/:id', async (req: AuthRequest, res: Response, next) => {
  try {
    const id = Number(req.params.id);
    const judul = typeof req.body?.judul === 'string' ? req.body.judul.trim() : '';
    const subjek = typeof req.body?.subjek === 'string' ? req.body.subjek.trim() : '';
    const isi = typeof req.body?.isi === 'string' ? req.body.isi.trim() : '';
    const { segmen, hariTidakMemesan } = parseSegment(req.body?.segmen, req.body?.hariTidakMemesan);
    if (!Number.isInteger(id) || id < 1 || !judul || !subjek || !isi) throw errorResponse('Data draft kampanye tidak valid');
    const existing = await prisma.kampanyePelanggan.findUnique({ where: { id } });
    if (!existing) throw errorResponse('Draft kampanye tidak ditemukan', 404);
    const updated = await prisma.kampanyePelanggan.update({ where: { id }, data: { judul, subjek, isi, segmen, hariTidakMemesan } });
    await logManualAction(req.user!.id, 'kampanye_pelanggan', AksiLog.UBAH, updated.judul, 'Draft kampanye CRM diperbarui', id, { judul: existing.judul, subjek: existing.subjek, segmen: existing.segmen }, { judul, subjek, segmen });
    res.json(successResponse(updated, 'Draft kampanye diperbarui. Email belum dikirim.'));
  } catch (error) { next(error); }
});

router.delete('/:id', async (req: AuthRequest, res: Response, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) throw errorResponse('ID draft tidak valid');
    const existing = await prisma.kampanyePelanggan.findUnique({ where: { id }, select: { id: true, judul: true } });
    if (!existing) throw errorResponse('Draft kampanye tidak ditemukan', 404);
    await prisma.kampanyePelanggan.delete({ where: { id } });
    await logManualAction(req.user!.id, 'kampanye_pelanggan', AksiLog.HAPUS, existing.judul, 'Draft kampanye CRM dihapus', id);
    res.json(successResponse({ id }, 'Draft kampanye dihapus'));
  } catch (error) { next(error); }
});

export default router;
