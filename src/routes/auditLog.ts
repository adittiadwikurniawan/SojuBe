import { Router, Request, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { successResponse } from '../utils/response';
import prisma from '../utils/database';
import { SumberInput } from '@prisma/client';

const router = Router();

router.use(authenticate);

// GET /audit-log
router.get('/', async (req: AuthRequest, res: Response, next) => {
  try {
    const { sheet, tabelTarget, tabel, source, sumber, search, page = '1', limit = '50', days, dateFrom, dateTo } = req.query;
    
    const where: any = {};
    const finalTable = tabel || tabelTarget || sheet;
    if (finalTable && finalTable !== 'semua') {
      const normalizedTable = String(finalTable).toLowerCase();
      where.tabelTarget = { contains: normalizedTable === 'pendataan' ? 'tabel_bebas' : normalizedTable };
    }
    const finalSource = sumber || source;
    if (finalSource && finalSource !== 'semua') {
      where.sumber = String(finalSource).toUpperCase() as SumberInput;
    }
    if (search) {
      where.OR = [
        { labelRecord: { contains: search as string } },
        { detail: { contains: search as string } },
      ];
    }
    // Custom date range takes precedence over the relative days filter.
    if (dateFrom || dateTo) {
      const parseDate = (value: unknown, endOfDay = false) => {
        if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
        const date = new Date(`${value}T00:00:00.000Z`);
        if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) return null;
        if (endOfDay) date.setUTCDate(date.getUTCDate() + 1);
        return date;
      };
      const start = dateFrom ? parseDate(dateFrom) : null;
      const endExclusive = dateTo ? parseDate(dateTo, true) : null;
      if ((dateFrom && !start) || (dateTo && !endExclusive)) {
        return res.status(400).json({ success: false, message: 'Format tanggal harus YYYY-MM-DD' });
      }
      if (start && endExclusive && start >= endExclusive) {
        return res.status(400).json({ success: false, message: 'Tanggal mulai harus sama atau sebelum tanggal akhir' });
      }
      where.dibuatPada = {
        ...(start ? { gte: start } : {}),
        ...(endExclusive ? { lt: endExclusive } : {}),
      };
    }
    // Default tampil 7 hari terakhir (UI). Kirim ?days=30, ?days=90, dst
    // untuk lihat lebih lama - data lama TIDAK pernah dihapus dari DB,
    // ini murni filter tampilan. ?days=0 atau ?days=all menampilkan semua.
    const rangeDays = days === 'all' || days === '0' ? null : Number(days || 7);
    if (!dateFrom && !dateTo && rangeDays) {
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - rangeDays);
      where.dibuatPada = { gte: startDate };
    }

    const skip = (Number(page) - 1) * Number(limit);
    
    const [logs, total] = await Promise.all([
      prisma.logAudit.findMany({
        where,
        include: {
          pengguna: {
            select: {
              nama: true,
              email: true
            }
          }
        },
        orderBy: { dibuatPada: 'desc' },
        skip,
        take: Number(limit)
      }),
      prisma.logAudit.count({ where })
    ]);

    const customColumnIds = new Set<number>();
    for (const log of logs) {
      for (const snapshot of [log.dataSebelum, log.dataSesudah]) {
        if (!snapshot) continue;
        try {
          const parsed = JSON.parse(snapshot) as { customData?: Record<string, unknown> };
          for (const key of Object.keys(parsed.customData || {})) {
            const id = Number(key);
            if (Number.isInteger(id) && id > 0) customColumnIds.add(id);
          }
        } catch {
          // Older or malformed snapshots are still returned for frontend fallback formatting.
        }
      }
    }
    const customColumns = customColumnIds.size
      ? await prisma.kolomCustom.findMany({ where: { id: { in: [...customColumnIds] } }, select: { id: true, namaKolom: true } })
      : [];
    const customColumnNames = Object.fromEntries(customColumns.map((column) => [column.id, column.namaKolom]));

    const featuredProductIds = new Set<number>();
    for (const log of logs) {
      if (log.tabelTarget !== 'cms_content') continue;
      for (const snapshot of [log.dataSebelum, log.dataSesudah]) {
        if (!snapshot) continue;
        try {
          const parsed = JSON.parse(snapshot) as { key?: string; konten?: string };
          if (parsed.key !== 'produk_unggulan' || !parsed.konten) continue;
          const ids = JSON.parse(parsed.konten);
          if (Array.isArray(ids)) {
            for (const value of ids) {
              const id = Number(value);
              if (Number.isInteger(id) && id > 0) featuredProductIds.add(id);
            }
          }
        } catch {
          // Keep the original snapshot and let the frontend show a readable fallback.
        }
      }
    }
    const featuredProducts = featuredProductIds.size
      ? await prisma.produk.findMany({ where: { id: { in: [...featuredProductIds] } }, select: { id: true, namaBarang: true } })
      : [];
    const productNames = Object.fromEntries(featuredProducts.map((product) => [product.id, product.namaBarang]));

    const transformedLogs = logs.map(l => ({
      ...l,
      sheet: l.tabelTarget,
      source: l.sumber,
      action: l.aksi,
      recordLabel: l.labelRecord,
      createdAt: l.dibuatPada,
      user: l.pengguna,
      customColumnNames,
      productNames,
    }));

    res.json(successResponse({
      logs: transformedLogs,
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total,
        totalPages: Math.ceil(total / Number(limit))
      }
    }));
  } catch (error) {
    next(error);
  }
});

export default router;
