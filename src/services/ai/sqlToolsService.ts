import type { ArahTransaksi, Prisma, StatusPesananPelanggan, SumberInput } from '@prisma/client';
import defaultPrisma from '../../utils/database';
import { sanitizePii } from './ingestionService';

export const ALLOWED_SQL_TOOLS = [
  'getSalesSummary',
  'getRecentTransactions',
  'getCustomerOrdersSummary',
  'getProductCatalogStats',
  'getProductStats',
] as const;

export type SqlToolName = (typeof ALLOWED_SQL_TOOLS)[number];

export const VALID_ORDER_STATUSES: readonly StatusPesananPelanggan[] = [
  'MENUNGGU_KONFIRMASI',
  'DIPROSES',
  'SELESAI',
  'DIBATALKAN',
] as const;

export const VALID_TRANSACTION_DIRECTIONS: readonly ArahTransaksi[] = [
  'PEMASUKAN',
  'PENGELUARAN',
] as const;

export const VALID_INPUT_SOURCES: readonly SumberInput[] = ['MANUAL', 'AI'] as const;

export const DEFAULT_RECENT_TRANSACTIONS_LIMIT = 10;
export const MAX_RECENT_TRANSACTIONS_LIMIT = 50;
export const MAX_PRODUCT_CATALOG_LIST = 50;

export type SqlToolsErrorCode = 'SQL_TOOL_NOT_ALLOWED' | 'SQL_TOOL_VALIDATION_ERROR';

export class SqlToolsServiceError extends Error {
  readonly code: string;
  readonly status: number;
  readonly statusCode: number;

  constructor(code: SqlToolsErrorCode | string, message: string, status: number = 400) {
    super(message);
    this.name = 'SqlToolsServiceError';
    this.code = code;
    this.status = status;
    this.statusCode = status;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class SqlToolNotAllowedError extends SqlToolsServiceError {
  readonly toolName: string;

  constructor(toolName: string) {
    super(
      'SQL_TOOL_NOT_ALLOWED',
      `Tool SQL "${toolName}" tidak diizinkan (di luar allow-list read-only).`,
      400
    );
    this.name = 'SqlToolNotAllowedError';
    this.toolName = toolName;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class SqlToolValidationError extends SqlToolsServiceError {
  constructor(message: string) {
    super('SQL_TOOL_VALIDATION_ERROR', message, 400);
    this.name = 'SqlToolValidationError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface SqlCitation {
  id: string;
  sourceType: 'SQL_TOOL';
  toolName: SqlToolName;
  label: string;
  querySummary: string;
  executedAt: string;
}

export interface SqlToolResult<T> {
  toolName: SqlToolName;
  citationId: string;
  citation: SqlCitation;
  data: T;
}

export interface SqlToolExecutionOptions {
  citationIndex?: number;
  now?: Date;
}

export type SalesSummaryPeriode = 'today' | '7d' | '30d' | '90d' | 'all';

export interface DateRangeInput {
  startDate?: Date | string | null;
  endDate?: Date | string | null;
  periode?: SalesSummaryPeriode;
}

export interface SalesSummaryFilter extends DateRangeInput {
  unitBisnis?: string | null;
}

export interface SalesSummaryData {
  totalPemasukan: number;
  totalPengeluaran: number;
  labaBersih: number;
  jumlahTransaksiPemasukan: number;
  jumlahTransaksiPengeluaran: number;
  totalTransaksi: number;
  rataRataPemasukan: number;
  unitBisnis: string | null;
  periode: {
    startDate: string | null;
    endDate: string | null;
    label: string;
  };
}

export interface RecentTransactionsFilter {
  arah?: ArahTransaksi;
  unitBisnis?: string | null;
  jenisTransaksiId?: number;
  sumberInput?: SumberInput;
  startDate?: Date | string | null;
  endDate?: Date | string | null;
}

export interface RecentTransactionItem {
  id: number;
  kode: string;
  tanggal: string;
  unitBisnis: string | null;
  namaTransaksi: string;
  kodeJenis: string;
  arah: ArahTransaksi;
  detail: string | null;
  jenisKas: string | null;
  nominal: number;
  sumberInput: SumberInput;
}

export interface RecentTransactionsData {
  limit: number;
  count: number;
  totalNominal: number;
  transactions: RecentTransactionItem[];
}

export interface CustomerOrdersFilter {
  status?: StatusPesananPelanggan | null;
  startDate?: Date | string | null;
  endDate?: Date | string | null;
}

export interface OrderStatusMetric {
  count: number;
  totalNilai: number;
}

export interface CustomerOrdersSummaryData {
  statusFilter: StatusPesananPelanggan | null;
  totalPesanan: number;
  totalNilaiPesanan: number;
  totalNilaiSelesai: number;
  totalNilaiAktif: number;
  byStatus: Record<StatusPesananPelanggan, OrderStatusMetric>;
  periode: {
    startDate: string | null;
    endDate: string | null;
  };
}

export interface ProductCatalogItemStat {
  id: number;
  kode: string;
  namaBarang: string;
  satuan: string;
  hargaDefault: number;
  memilikiVarian: boolean;
}

export interface ProductStatsData {
  totalProduk: number;
  produkAktif: number;
  produkNonaktif: number;
  produkDenganVarian: number;
  hargaMinimum: number;
  hargaMaksimum: number;
  hargaRataRata: number;
  satuanTersedia: string[];
  daftarProdukAktif: ProductCatalogItemStat[];
}

type DecimalLike = Prisma.Decimal | number | string | null | undefined;

interface TransaksiAggregateResult {
  _sum: { nominal: DecimalLike };
  _count: { _all: number };
}

interface TransaksiSelectRow {
  id: number;
  kode: string;
  tanggal: Date;
  unitBisnis: string | null;
  namaTransaksi: string;
  detail: string | null;
  jenisKas: string | null;
  nominal: DecimalLike;
  sumberInput: SumberInput;
  jenisTransaksi: {
    kode: string;
    namaTransaksi: string;
    arah: ArahTransaksi;
  };
}

interface PesananGroupRow {
  status: StatusPesananPelanggan;
  _count: { _all: number };
  _sum: { total: DecimalLike };
}

interface ProdukAggregateResult {
  _count: { _all: number };
  _avg: { hargaDefault: DecimalLike };
  _min: { hargaDefault: DecimalLike };
  _max: { hargaDefault: DecimalLike };
}

interface ProdukSelectRow {
  id: number;
  kode: string;
  namaBarang: string;
  satuan: string;
  hargaDefault: DecimalLike;
  varian: string | null;
}

/**
 * Strictly read-only Prisma subset.
 * Deliberately excludes all write operations (create/update/delete/upsert)
 * and raw SQL APIs ($queryRaw/$executeRaw/$queryRawUnsafe/$executeRawUnsafe),
 * as well as the Pelanggan PII table.
 */
export interface SqlToolsPrismaClient {
  transaksi: {
    aggregate(args: Record<string, unknown>): Promise<TransaksiAggregateResult>;
    findMany(args: Record<string, unknown>): Promise<TransaksiSelectRow[]>;
  };
  pesananPelanggan: {
    groupBy(args: Record<string, unknown>): Promise<PesananGroupRow[]>;
  };
  produk: {
    count(args?: Record<string, unknown>): Promise<number>;
    aggregate(args: Record<string, unknown>): Promise<ProdukAggregateResult>;
    findMany(args: Record<string, unknown>): Promise<ProdukSelectRow[]>;
  };
}

export interface SqlToolsServiceDependencies {
  prisma?: SqlToolsPrismaClient;
}

function toExactNumber(value: DecimalLike): number {
  if (value === null || value === undefined) {
    return 0;
  }
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return 0;
  }
  return Math.round((num + Number.EPSILON) * 100) / 100;
}

function formatDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function parseDateInput(
  value: Date | string,
  fieldName: string,
  boundary: 'start' | 'end' = 'start'
): Date {
  const trimmed = typeof value === 'string' ? value.trim() : null;
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(trimmed ?? value);
  if (Number.isNaN(parsed.getTime())) {
    throw new SqlToolValidationError(`Format tanggal "${fieldName}" tidak valid.`);
  }
  if (boundary === 'end' && trimmed !== null && DATE_ONLY_PATTERN.test(trimmed)) {
    parsed.setUTCHours(23, 59, 59, 999);
  }
  return parsed;
}

function resolveDateRange(
  input: DateRangeInput | undefined,
  now: Date
): {
  gte?: Date;
  lte?: Date;
  startDateIso: string | null;
  endDateIso: string | null;
  label: string;
} {
  if (input?.startDate || input?.endDate) {
    const gte = input.startDate ? parseDateInput(input.startDate, 'startDate', 'start') : undefined;
    const lte = input.endDate ? parseDateInput(input.endDate, 'endDate', 'end') : undefined;

    if (gte && lte && gte.getTime() > lte.getTime()) {
      throw new SqlToolValidationError('Tanggal mulai tidak boleh lebih besar dari tanggal selesai.');
    }

    const startDateIso = gte ? formatDateOnly(gte) : null;
    const endDateIso = lte ? formatDateOnly(lte) : null;

    return {
      gte,
      lte,
      startDateIso,
      endDateIso,
      label: `${startDateIso ?? 'awal'} s/d ${endDateIso ?? 'sekarang'}`,
    };
  }

  const periode = input?.periode ?? 'all';
  if (periode === 'all') {
    return {
      startDateIso: null,
      endDateIso: null,
      label: 'Semua waktu',
    };
  }

  const end = new Date(now.getTime());
  end.setUTCHours(23, 59, 59, 999);

  const start = new Date(now.getTime());
  start.setUTCHours(0, 0, 0, 0);

  if (periode === '7d') {
    start.setUTCDate(start.getUTCDate() - 6);
  } else if (periode === '30d') {
    start.setUTCDate(start.getUTCDate() - 29);
  } else if (periode === '90d') {
    start.setUTCDate(start.getUTCDate() - 89);
  } else if (periode !== 'today') {
    throw new SqlToolValidationError(`Periode "${String(periode)}" tidak valid.`);
  }

  return {
    gte: start,
    lte: end,
    startDateIso: formatDateOnly(start),
    endDateIso: formatDateOnly(end),
    label:
      periode === 'today'
        ? `Hari ini (${formatDateOnly(start)})`
        : `${periode} (${formatDateOnly(start)} s/d ${formatDateOnly(end)})`,
  };
}

function buildCitation(
  toolName: SqlToolName,
  label: string,
  querySummary: string,
  options?: SqlToolExecutionOptions
): SqlCitation {
  const index =
    options?.citationIndex && Number.isInteger(options.citationIndex) && options.citationIndex > 0
      ? options.citationIndex
      : 1;
  const now = options?.now ?? new Date();

  return {
    id: `[SQL-${index}]`,
    sourceType: 'SQL_TOOL',
    toolName,
    label,
    querySummary,
    executedAt: now.toISOString(),
  };
}

function clampLimit(limit?: number): number {
  if (limit === undefined || limit === null) {
    return DEFAULT_RECENT_TRANSACTIONS_LIMIT;
  }
  if (!Number.isFinite(limit) || !Number.isInteger(limit) || limit < 1) {
    throw new SqlToolValidationError('Parameter limit harus berupa bilangan bulat positif.');
  }
  return Math.min(limit, MAX_RECENT_TRANSACTIONS_LIMIT);
}

export function isAllowedSqlTool(toolName: string): toolName is SqlToolName {
  return (ALLOWED_SQL_TOOLS as readonly string[]).includes(toolName);
}

export function createSqlToolsService(deps: SqlToolsServiceDependencies = {}) {
  const prisma = (deps.prisma ?? defaultPrisma) as unknown as SqlToolsPrismaClient;

  async function getSalesSummary(
    dateRange?: SalesSummaryFilter,
    options?: SqlToolExecutionOptions
  ): Promise<SqlToolResult<SalesSummaryData>> {
    const now = options?.now ?? new Date();
    const resolvedRange = resolveDateRange(dateRange, now);
    const unitBisnis = dateRange?.unitBisnis?.trim() || null;

    const baseWhere: Record<string, unknown> = {};
    if (resolvedRange.gte || resolvedRange.lte) {
      baseWhere.tanggal = {
        ...(resolvedRange.gte ? { gte: resolvedRange.gte } : {}),
        ...(resolvedRange.lte ? { lte: resolvedRange.lte } : {}),
      };
    }
    if (unitBisnis) {
      baseWhere.unitBisnis = unitBisnis;
    }

    const [pemasukanAgg, pengeluaranAgg] = await Promise.all([
      prisma.transaksi.aggregate({
        where: {
          ...baseWhere,
          jenisTransaksi: { arah: 'PEMASUKAN' },
        },
        _sum: { nominal: true },
        _count: { _all: true },
      }),
      prisma.transaksi.aggregate({
        where: {
          ...baseWhere,
          jenisTransaksi: { arah: 'PENGELUARAN' },
        },
        _sum: { nominal: true },
        _count: { _all: true },
      }),
    ]);

    const totalPemasukan = toExactNumber(pemasukanAgg._sum.nominal);
    const totalPengeluaran = toExactNumber(pengeluaranAgg._sum.nominal);
    const labaBersih = toExactNumber(totalPemasukan - totalPengeluaran);
    const jumlahTransaksiPemasukan = pemasukanAgg._count._all;
    const jumlahTransaksiPengeluaran = pengeluaranAgg._count._all;
    const totalTransaksi = jumlahTransaksiPemasukan + jumlahTransaksiPengeluaran;
    const rataRataPemasukan =
      jumlahTransaksiPemasukan > 0
        ? toExactNumber(totalPemasukan / jumlahTransaksiPemasukan)
        : 0;

    const summaryParts = [`periode=${resolvedRange.label}`];
    if (unitBisnis) {
      summaryParts.push(`unitBisnis=${unitBisnis}`);
    }

    const citation = buildCitation(
      'getSalesSummary',
      'Ringkasan Penjualan & Arus Kas (Prisma)',
      summaryParts.join(', '),
      options
    );

    return {
      toolName: 'getSalesSummary',
      citationId: citation.id,
      citation,
      data: {
        totalPemasukan,
        totalPengeluaran,
        labaBersih,
        jumlahTransaksiPemasukan,
        jumlahTransaksiPengeluaran,
        totalTransaksi,
        rataRataPemasukan,
        unitBisnis,
        periode: {
          startDate: resolvedRange.startDateIso,
          endDate: resolvedRange.endDateIso,
          label: resolvedRange.label,
        },
      },
    };
  }

  async function getRecentTransactions(
    limit: number = DEFAULT_RECENT_TRANSACTIONS_LIMIT,
    filter?: RecentTransactionsFilter,
    options?: SqlToolExecutionOptions
  ): Promise<SqlToolResult<RecentTransactionsData>> {
    const safeLimit = clampLimit(limit);
    const where: Record<string, unknown> = {};
    const summaryParts = [`limit=${safeLimit}`];

    if (filter?.arah) {
      if (!VALID_TRANSACTION_DIRECTIONS.includes(filter.arah)) {
        throw new SqlToolValidationError(`Arah transaksi "${String(filter.arah)}" tidak valid.`);
      }
      where.jenisTransaksi = { arah: filter.arah };
      summaryParts.push(`arah=${filter.arah}`);
    }

    if (filter?.unitBisnis?.trim()) {
      const unit = filter.unitBisnis.trim();
      where.unitBisnis = unit;
      summaryParts.push(`unitBisnis=${unit}`);
    }

    if (filter?.jenisTransaksiId !== undefined) {
      if (!Number.isInteger(filter.jenisTransaksiId) || filter.jenisTransaksiId < 1) {
        throw new SqlToolValidationError('jenisTransaksiId harus berupa bilangan bulat positif.');
      }
      where.jenisTransaksiId = filter.jenisTransaksiId;
      summaryParts.push(`jenisTransaksiId=${filter.jenisTransaksiId}`);
    }

    if (filter?.sumberInput) {
      if (!VALID_INPUT_SOURCES.includes(filter.sumberInput)) {
        throw new SqlToolValidationError(`Sumber input "${String(filter.sumberInput)}" tidak valid.`);
      }
      where.sumberInput = filter.sumberInput;
      summaryParts.push(`sumberInput=${filter.sumberInput}`);
    }

    if (filter?.startDate || filter?.endDate) {
      const resolvedRange = resolveDateRange(
        { startDate: filter.startDate, endDate: filter.endDate },
        options?.now ?? new Date()
      );
      where.tanggal = {
        ...(resolvedRange.gte ? { gte: resolvedRange.gte } : {}),
        ...(resolvedRange.lte ? { lte: resolvedRange.lte } : {}),
      };
      summaryParts.push(`periode=${resolvedRange.label}`);
    }

    const rows = await prisma.transaksi.findMany({
      where,
      orderBy: [{ tanggal: 'desc' }, { dibuatPada: 'desc' }, { id: 'desc' }],
      take: safeLimit,
      select: {
        id: true,
        kode: true,
        tanggal: true,
        unitBisnis: true,
        namaTransaksi: true,
        detail: true,
        jenisKas: true,
        nominal: true,
        sumberInput: true,
        jenisTransaksi: {
          select: {
            kode: true,
            namaTransaksi: true,
            arah: true,
          },
        },
      },
    });

    const transactions: RecentTransactionItem[] = rows.map((row) => ({
      id: row.id,
      kode: row.kode,
      tanggal: formatDateOnly(row.tanggal),
      unitBisnis: row.unitBisnis,
      namaTransaksi: row.namaTransaksi,
      kodeJenis: row.jenisTransaksi.kode,
      arah: row.jenisTransaksi.arah,
      detail: row.detail ? sanitizePii(row.detail).sanitizedText : null,
      jenisKas: row.jenisKas,
      nominal: toExactNumber(row.nominal),
      sumberInput: row.sumberInput,
    }));

    const totalNominal = toExactNumber(
      transactions.reduce((sum, item) => sum + item.nominal, 0)
    );

    const citation = buildCitation(
      'getRecentTransactions',
      'Daftar Transaksi Terbaru (Prisma)',
      summaryParts.join(', '),
      options
    );

    return {
      toolName: 'getRecentTransactions',
      citationId: citation.id,
      citation,
      data: {
        limit: safeLimit,
        count: transactions.length,
        totalNominal,
        transactions,
      },
    };
  }

  async function getCustomerOrdersSummary(
    statusFilter?: StatusPesananPelanggan | CustomerOrdersFilter | null,
    options?: SqlToolExecutionOptions
  ): Promise<SqlToolResult<CustomerOrdersSummaryData>> {
    const normalizedFilter: CustomerOrdersFilter =
      typeof statusFilter === 'string'
        ? { status: statusFilter }
        : statusFilter ?? {};

    const status = normalizedFilter.status ?? null;
    if (status !== null && !VALID_ORDER_STATUSES.includes(status)) {
      throw new SqlToolValidationError(`Status pesanan "${String(status)}" tidak valid.`);
    }

    const where: Record<string, unknown> = {};
    const summaryParts: string[] = [];

    if (status) {
      where.status = status;
      summaryParts.push(`status=${status}`);
    } else {
      summaryParts.push('status=ALL');
    }

    let startDateIso: string | null = null;
    let endDateIso: string | null = null;
    if (normalizedFilter.startDate || normalizedFilter.endDate) {
      const resolvedRange = resolveDateRange(
        { startDate: normalizedFilter.startDate, endDate: normalizedFilter.endDate },
        options?.now ?? new Date()
      );
      where.dibuatPada = {
        ...(resolvedRange.gte ? { gte: resolvedRange.gte } : {}),
        ...(resolvedRange.lte ? { lte: resolvedRange.lte } : {}),
      };
      startDateIso = resolvedRange.startDateIso;
      endDateIso = resolvedRange.endDateIso;
      summaryParts.push(`periode=${resolvedRange.label}`);
    }

    // Aggregate strictly via groupBy on status + total — never reads Pelanggan or recipient PII columns.
    const grouped = await prisma.pesananPelanggan.groupBy({
      by: ['status'],
      where,
      _count: { _all: true },
      _sum: { total: true },
    });

    const byStatus: Record<StatusPesananPelanggan, OrderStatusMetric> = {
      MENUNGGU_KONFIRMASI: { count: 0, totalNilai: 0 },
      DIPROSES: { count: 0, totalNilai: 0 },
      SELESAI: { count: 0, totalNilai: 0 },
      DIBATALKAN: { count: 0, totalNilai: 0 },
    };

    let totalPesanan = 0;
    let totalNilaiPesanan = 0;

    for (const row of grouped) {
      const count = row._count._all;
      const totalNilai = toExactNumber(row._sum.total);
      byStatus[row.status] = { count, totalNilai };
      totalPesanan += count;
      totalNilaiPesanan = toExactNumber(totalNilaiPesanan + totalNilai);
    }

    const totalNilaiSelesai = byStatus.SELESAI.totalNilai;
    const totalNilaiAktif = toExactNumber(
      byStatus.MENUNGGU_KONFIRMASI.totalNilai +
        byStatus.DIPROSES.totalNilai +
        byStatus.SELESAI.totalNilai
    );

    const citation = buildCitation(
      'getCustomerOrdersSummary',
      'Ringkasan Pesanan Pelanggan Tanpa PII (Prisma)',
      summaryParts.join(', '),
      options
    );

    return {
      toolName: 'getCustomerOrdersSummary',
      citationId: citation.id,
      citation,
      data: {
        statusFilter: status,
        totalPesanan,
        totalNilaiPesanan,
        totalNilaiSelesai,
        totalNilaiAktif,
        byStatus,
        periode: {
          startDate: startDateIso,
          endDate: endDateIso,
        },
      },
    };
  }

  async function getProductStats(
    options?: SqlToolExecutionOptions
  ): Promise<SqlToolResult<ProductStatsData>> {
    const [totalProduk, activeAgg, activeProducts] = await Promise.all([
      prisma.produk.count(),
      prisma.produk.aggregate({
        where: { aktif: true },
        _count: { _all: true },
        _avg: { hargaDefault: true },
        _min: { hargaDefault: true },
        _max: { hargaDefault: true },
      }),
      prisma.produk.findMany({
        where: { aktif: true },
        orderBy: [{ hargaDefault: 'asc' }, { id: 'asc' }],
        take: MAX_PRODUCT_CATALOG_LIST,
        select: {
          id: true,
          kode: true,
          namaBarang: true,
          satuan: true,
          hargaDefault: true,
          varian: true,
        },
      }),
    ]);

    const produkAktif = activeAgg._count._all;
    const produkNonaktif = Math.max(0, totalProduk - produkAktif);
    const hargaMinimum = toExactNumber(activeAgg._min.hargaDefault);
    const hargaMaksimum = toExactNumber(activeAgg._max.hargaDefault);
    const hargaRataRata = toExactNumber(activeAgg._avg.hargaDefault);

    const satuanSet = new Set<string>();
    let produkDenganVarian = 0;

    const daftarProdukAktif: ProductCatalogItemStat[] = activeProducts.map((item) => {
      const memilikiVarian = Boolean(item.varian && item.varian.trim().length > 0);
      if (memilikiVarian) {
        produkDenganVarian += 1;
      }
      if (item.satuan.trim()) {
        satuanSet.add(item.satuan.trim());
      }
      return {
        id: item.id,
        kode: item.kode,
        namaBarang: item.namaBarang,
        satuan: item.satuan,
        hargaDefault: toExactNumber(item.hargaDefault),
        memilikiVarian,
      };
    });

    const citation = buildCitation(
      'getProductStats',
      'Statistik Katalog Produk Aktif (Prisma)',
      `aktif=true, limit=${MAX_PRODUCT_CATALOG_LIST}`,
      options
    );

    return {
      toolName: 'getProductStats',
      citationId: citation.id,
      citation,
      data: {
        totalProduk,
        produkAktif,
        produkNonaktif,
        produkDenganVarian,
        hargaMinimum,
        hargaMaksimum,
        hargaRataRata,
        satuanTersedia: Array.from(satuanSet).sort((a, b) => a.localeCompare(b)),
        daftarProdukAktif,
      },
    };
  }

  async function executeSqlTool(
    toolName: string,
    params: Record<string, unknown> = {},
    options?: SqlToolExecutionOptions
  ): Promise<SqlToolResult<unknown>> {
    if (!isAllowedSqlTool(toolName)) {
      throw new SqlToolNotAllowedError(toolName);
    }

    switch (toolName) {
      case 'getSalesSummary':
        return getSalesSummary(params as SalesSummaryFilter, options);
      case 'getRecentTransactions': {
        const { limit, ...filter } = params as { limit?: number } & RecentTransactionsFilter;
        return getRecentTransactions(limit, filter, options);
      }
      case 'getCustomerOrdersSummary': {
        const statusFilter =
          typeof params.statusFilter === 'string'
            ? (params.statusFilter as StatusPesananPelanggan)
            : (params as CustomerOrdersFilter);
        return getCustomerOrdersSummary(statusFilter, options);
      }
      case 'getProductCatalogStats':
      case 'getProductStats':
        return getProductStats(options);
    }
  }

  return {
    getSalesSummary,
    getRecentTransactions,
    getCustomerOrdersSummary,
    getProductStats,
    getProductCatalogStats: getProductStats,
    executeSqlTool,
  };
}

const defaultSqlToolsService = createSqlToolsService();

export const getSalesSummary = defaultSqlToolsService.getSalesSummary;
export const getRecentTransactions = defaultSqlToolsService.getRecentTransactions;
export const getCustomerOrdersSummary = defaultSqlToolsService.getCustomerOrdersSummary;
export const getProductStats = defaultSqlToolsService.getProductStats;
export const getProductCatalogStats = defaultSqlToolsService.getProductCatalogStats;
export const executeSqlTool = defaultSqlToolsService.executeSqlTool;

export default defaultSqlToolsService;
