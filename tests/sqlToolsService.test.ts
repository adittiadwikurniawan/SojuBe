import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ArahTransaksi, StatusPesananPelanggan, SumberInput } from '@prisma/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ALLOWED_SQL_TOOLS,
  MAX_RECENT_TRANSACTIONS_LIMIT,
  SqlToolNotAllowedError,
  SqlToolsServiceError,
  SqlToolValidationError,
  createSqlToolsService,
  isAllowedSqlTool,
  type SqlToolsPrismaClient,
} from '../src/services/ai/sqlToolsService';

interface FixtureTransaction {
  id: number;
  kode: string;
  tanggal: Date;
  dibuatPada: Date;
  unitBisnis: string | null;
  jenisTransaksiId: number;
  namaTransaksi: string;
  detail: string | null;
  jenisKas: string | null;
  nominal: string; // simulates Prisma Decimal serialization
  sumberInput: SumberInput;
  jenisTransaksi: {
    kode: string;
    namaTransaksi: string;
    arah: ArahTransaksi;
  };
}

interface FixtureOrder {
  id: number;
  kode: string;
  pelangganId: number;
  namaPenerima: string;
  emailPenerima: string;
  noTelepon: string;
  alamat: string;
  total: string;
  status: StatusPesananPelanggan;
  dibuatPada: Date;
}

interface FixtureProduct {
  id: number;
  kode: string;
  namaBarang: string;
  satuan: string;
  hargaDefault: string;
  varian: string | null;
  aktif: boolean;
  gambarData: Buffer;
}

function createSeededFixtureEnvironment() {
  const transaksiFixtures: FixtureTransaction[] = [
    {
      id: 1,
      kode: 'PF001-10001',
      tanggal: new Date('2026-11-18T00:00:00.000Z'),
      dibuatPada: new Date('2026-11-18T09:00:00.000Z'),
      unitBisnis: 'Frozen',
      jenisTransaksiId: 1,
      namaTransaksi: 'Pendapatan Frozen',
      detail: 'Penjualan 10 pack sosis frozen',
      jenisKas: 'Kas Tunai',
      nominal: '250000.50',
      sumberInput: 'MANUAL',
      jenisTransaksi: { kode: 'PF', namaTransaksi: 'Pendapatan Frozen', arah: 'PEMASUKAN' },
    },
    {
      id: 2,
      kode: 'PS001-10002',
      tanggal: new Date('2026-11-20T00:00:00.000Z'),
      dibuatPada: new Date('2026-11-20T14:30:00.000Z'),
      unitBisnis: 'Siap Saji',
      jenisTransaksiId: 2,
      namaTransaksi: 'Pendapatan Siap Saji',
      detail: 'Order katering via budi@contoh.id / 081234567890',
      jenisKas: 'Transfer BCA',
      nominal: '175000.25',
      sumberInput: 'AI',
      jenisTransaksi: { kode: 'PS', namaTransaksi: 'Pendapatan Siap Saji', arah: 'PEMASUKAN' },
    },
    {
      id: 3,
      kode: 'BB001-10003',
      tanggal: new Date('2026-11-21T00:00:00.000Z'),
      dibuatPada: new Date('2026-11-21T08:15:00.000Z'),
      unitBisnis: 'Frozen',
      jenisTransaksiId: 3,
      namaTransaksi: 'Pembelian Bahan Baku',
      detail: 'Belanja daging & bumbu dapur',
      jenisKas: 'Kas Tunai',
      nominal: '120000.00',
      sumberInput: 'MANUAL',
      jenisTransaksi: { kode: 'BB', namaTransaksi: 'Pembelian Bahan Baku', arah: 'PENGELUARAN' },
    },
    {
      id: 4,
      kode: 'OP001-10004',
      tanggal: new Date('2026-11-10T00:00:00.000Z'),
      dibuatPada: new Date('2026-11-10T11:00:00.000Z'),
      unitBisnis: 'Siap Saji',
      jenisTransaksiId: 4,
      namaTransaksi: 'Biaya Operasional',
      detail: 'Gas LPG dan kemasan',
      jenisKas: 'Kas Tunai',
      nominal: '45000.75',
      sumberInput: 'MANUAL',
      jenisTransaksi: { kode: 'OP', namaTransaksi: 'Biaya Operasional', arah: 'PENGELUARAN' },
    },
  ];

  const orderFixtures: FixtureOrder[] = [
    {
      id: 11,
      kode: 'ORD-20261120-001',
      pelangganId: 101,
      namaPenerima: 'Siti Rahma',
      emailPenerima: 'siti.rahma@example.com',
      noTelepon: '081299990001',
      alamat: 'Jl. Melati No. 12, Jakarta',
      total: '90000.00',
      status: 'MENUNGGU_KONFIRMASI',
      dibuatPada: new Date('2026-11-20T10:00:00.000Z'),
    },
    {
      id: 12,
      kode: 'ORD-20261121-002',
      pelangganId: 102,
      namaPenerima: 'Andi Wijaya',
      emailPenerima: 'andi.wijaya@example.com',
      noTelepon: '081299990002',
      alamat: 'Jl. Kenanga No. 8, Bandung',
      total: '150000.50',
      status: 'DIPROSES',
      dibuatPada: new Date('2026-11-21T11:00:00.000Z'),
    },
    {
      id: 13,
      kode: 'ORD-20261122-003',
      pelangganId: 103,
      namaPenerima: 'Dewi Lestari',
      emailPenerima: 'dewi.lestari@example.com',
      noTelepon: '081299990003',
      alamat: 'Jl. Mawar No. 3, Surabaya',
      total: '210000.00',
      status: 'SELESAI',
      dibuatPada: new Date('2026-11-22T12:00:00.000Z'),
    },
    {
      id: 14,
      kode: 'ORD-20261122-004',
      pelangganId: 104,
      namaPenerima: 'Rizky Pratama',
      emailPenerima: 'rizky@example.com',
      noTelepon: '081299990004',
      alamat: 'Jl. Anggrek No. 7, Depok',
      total: '125000.25',
      status: 'SELESAI',
      dibuatPada: new Date('2026-11-22T16:00:00.000Z'),
    },
    {
      id: 15,
      kode: 'ORD-20261119-005',
      pelangganId: 105,
      namaPenerima: 'Batal Customer',
      emailPenerima: 'batal@example.com',
      noTelepon: '081299990005',
      alamat: 'Jl. Kamboja No. 1, Bekasi',
      total: '60000.00',
      status: 'DIBATALKAN',
      dibuatPada: new Date('2026-11-19T15:00:00.000Z'),
    },
  ];

  const productFixtures: FixtureProduct[] = [
    {
      id: 1,
      kode: 'SJU-001',
      namaBarang: 'Sosis Bakar Original',
      satuan: 'pcs',
      hargaDefault: '15000.00',
      varian: 'Original, Pedas',
      aktif: true,
      gambarData: Buffer.from('fake-blob-1'),
    },
    {
      id: 2,
      kode: 'SJU-002',
      namaBarang: 'Sosis Frozen Pack',
      satuan: 'pack',
      hargaDefault: '45000.00',
      varian: null,
      aktif: true,
      gambarData: Buffer.from('fake-blob-2'),
    },
    {
      id: 3,
      kode: 'SJU-003',
      namaBarang: 'Bakso Keju Melt',
      satuan: 'pcs',
      hargaDefault: '21000.00',
      varian: 'Keju, Mozzarella',
      aktif: true,
      gambarData: Buffer.from('fake-blob-3'),
    },
    {
      id: 4,
      kode: 'SJU-004',
      namaBarang: 'Menu Lama Nonaktif',
      satuan: 'box',
      hargaDefault: '99000.00',
      varian: 'Lama',
      aktif: false,
      gambarData: Buffer.from('fake-blob-4'),
    },
  ];

  function matchesTransaksiWhere(row: FixtureTransaction, where: Record<string, any> = {}): boolean {
    if (where.unitBisnis && row.unitBisnis !== where.unitBisnis) return false;
    if (where.jenisTransaksiId && row.jenisTransaksiId !== where.jenisTransaksiId) return false;
    if (where.sumberInput && row.sumberInput !== where.sumberInput) return false;
    if (where.jenisTransaksi?.arah && row.jenisTransaksi.arah !== where.jenisTransaksi.arah) {
      return false;
    }
    if (where.tanggal) {
      const ts = row.tanggal.getTime();
      if (where.tanggal.gte && ts < (where.tanggal.gte as Date).getTime()) return false;
      if (where.tanggal.lte && ts > (where.tanggal.lte as Date).getTime()) return false;
    }
    return true;
  }

  function matchesOrderWhere(row: FixtureOrder, where: Record<string, any> = {}): boolean {
    if (where.status && row.status !== where.status) return false;
    if (where.dibuatPada) {
      const ts = row.dibuatPada.getTime();
      if (where.dibuatPada.gte && ts < (where.dibuatPada.gte as Date).getTime()) return false;
      if (where.dibuatPada.lte && ts > (where.dibuatPada.lte as Date).getTime()) return false;
    }
    return true;
  }

  // Forbidden write/raw/PII spies — asserted to NEVER be called
  const forbiddenSpies = {
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
    $queryRawUnsafe: vi.fn(),
    $executeRawUnsafe: vi.fn(),
    transaksiCreate: vi.fn(),
    transaksiUpdate: vi.fn(),
    transaksiDelete: vi.fn(),
    pesananFindMany: vi.fn(),
    pesananUpdate: vi.fn(),
    pelangganFindMany: vi.fn(),
    produkCreate: vi.fn(),
    produkUpdate: vi.fn(),
    produkDelete: vi.fn(),
  };

  const prismaMock = {
    $queryRaw: forbiddenSpies.$queryRaw,
    $executeRaw: forbiddenSpies.$executeRaw,
    $queryRawUnsafe: forbiddenSpies.$queryRawUnsafe,
    $executeRawUnsafe: forbiddenSpies.$executeRawUnsafe,
    pelanggan: {
      findMany: forbiddenSpies.pelangganFindMany,
    },
    transaksi: {
      create: forbiddenSpies.transaksiCreate,
      update: forbiddenSpies.transaksiUpdate,
      delete: forbiddenSpies.transaksiDelete,
      aggregate: vi.fn().mockImplementation(async (args: Record<string, any>) => {
        const filtered = transaksiFixtures.filter((row) => matchesTransaksiWhere(row, args.where));
        const sum = filtered.reduce((acc, row) => acc + Number(row.nominal), 0);
        return {
          _sum: { nominal: filtered.length > 0 ? sum.toFixed(2) : null },
          _count: { _all: filtered.length },
        };
      }),
      findMany: vi.fn().mockImplementation(async (args: Record<string, any>) => {
        const filtered = transaksiFixtures
          .filter((row) => matchesTransaksiWhere(row, args.where))
          .sort((a, b) => {
            const byDate = b.tanggal.getTime() - a.tanggal.getTime();
            if (byDate !== 0) return byDate;
            const byCreated = b.dibuatPada.getTime() - a.dibuatPada.getTime();
            if (byCreated !== 0) return byCreated;
            return b.id - a.id;
          });
        const take = typeof args.take === 'number' ? args.take : filtered.length;
        return filtered.slice(0, take).map((row) => ({
          id: row.id,
          kode: row.kode,
          tanggal: row.tanggal,
          unitBisnis: row.unitBisnis,
          namaTransaksi: row.namaTransaksi,
          detail: row.detail,
          jenisKas: row.jenisKas,
          nominal: row.nominal,
          sumberInput: row.sumberInput,
          jenisTransaksi: row.jenisTransaksi,
        }));
      }),
    },
    pesananPelanggan: {
      findMany: forbiddenSpies.pesananFindMany,
      update: forbiddenSpies.pesananUpdate,
      groupBy: vi.fn().mockImplementation(async (args: Record<string, any>) => {
        const filtered = orderFixtures.filter((row) => matchesOrderWhere(row, args.where));
        const map = new Map<StatusPesananPelanggan, { count: number; total: number }>();
        for (const row of filtered) {
          const current = map.get(row.status) ?? { count: 0, total: 0 };
          current.count += 1;
          current.total += Number(row.total);
          map.set(row.status, current);
        }
        return Array.from(map.entries()).map(([status, agg]) => ({
          status,
          _count: { _all: agg.count },
          _sum: { total: agg.total.toFixed(2) },
        }));
      }),
    },
    produk: {
      create: forbiddenSpies.produkCreate,
      update: forbiddenSpies.produkUpdate,
      delete: forbiddenSpies.produkDelete,
      count: vi.fn().mockImplementation(async (args?: Record<string, any>) => {
        if (args?.where?.aktif !== undefined) {
          return productFixtures.filter((p) => p.aktif === args.where.aktif).length;
        }
        return productFixtures.length;
      }),
      aggregate: vi.fn().mockImplementation(async (args: Record<string, any>) => {
        const filtered =
          args?.where?.aktif !== undefined
            ? productFixtures.filter((p) => p.aktif === args.where.aktif)
            : productFixtures;
        const prices = filtered.map((p) => Number(p.hargaDefault));
        const avg = prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : null;
        return {
          _count: { _all: filtered.length },
          _avg: { hargaDefault: avg !== null ? avg.toFixed(2) : null },
          _min: { hargaDefault: prices.length ? Math.min(...prices).toFixed(2) : null },
          _max: { hargaDefault: prices.length ? Math.max(...prices).toFixed(2) : null },
        };
      }),
      findMany: vi.fn().mockImplementation(async (args: Record<string, any>) => {
        const filtered =
          args?.where?.aktif !== undefined
            ? productFixtures.filter((p) => p.aktif === args.where.aktif)
            : productFixtures;
        return [...filtered]
          .sort((a, b) => Number(a.hargaDefault) - Number(b.hargaDefault) || a.id - b.id)
          .slice(0, args?.take ?? filtered.length)
          .map((p) => ({
            id: p.id,
            kode: p.kode,
            namaBarang: p.namaBarang,
            satuan: p.satuan,
            hargaDefault: p.hargaDefault,
            varian: p.varian,
          }));
      }),
    },
  };

  const service = createSqlToolsService({
    prisma: prismaMock as unknown as SqlToolsPrismaClient,
  });

  function assertNoForbiddenCalls() {
    for (const [name, spy] of Object.entries(forbiddenSpies)) {
      expect(spy, `Forbidden Prisma method "${name}" must never be called`).not.toHaveBeenCalled();
    }
  }

  return { service, prismaMock, assertNoForbiddenCalls };
}

describe('sqlToolsService (TASK-011: Deterministic Read-Only Prisma Tools)', () => {
  const FIXED_NOW = new Date('2026-11-23T12:00:00.000Z');

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('getSalesSummary', () => {
    it('returns exact income, expense, net profit, and counts across all fixture data with [SQL-1] citation', async () => {
      const { service, assertNoForbiddenCalls } = createSeededFixtureEnvironment();

      const result = await service.getSalesSummary(undefined, { now: FIXED_NOW });

      expect(result.toolName).toBe('getSalesSummary');
      expect(result.citationId).toBe('[SQL-1]');
      expect(result.citation).toEqual({
        id: '[SQL-1]',
        sourceType: 'SQL_TOOL',
        toolName: 'getSalesSummary',
        label: 'Ringkasan Penjualan & Arus Kas (Prisma)',
        querySummary: 'periode=Semua waktu',
        executedAt: FIXED_NOW.toISOString(),
      });

      // Exact math:
      // Pemasukan = 250000.50 + 175000.25 = 425000.75 (2 tx)
      // Pengeluaran = 120000.00 + 45000.75 = 165000.75 (2 tx)
      // Laba bersih = 425000.75 - 165000.75 = 260000.00
      // Rata-rata pemasukan = 425000.75 / 2 = 212500.38
      expect(result.data).toEqual({
        totalPemasukan: 425000.75,
        totalPengeluaran: 165000.75,
        labaBersih: 260000,
        jumlahTransaksiPemasukan: 2,
        jumlahTransaksiPengeluaran: 2,
        totalTransaksi: 4,
        rataRataPemasukan: 212500.38,
        unitBisnis: null,
        periode: {
          startDate: null,
          endDate: null,
          label: 'Semua waktu',
        },
      });

      assertNoForbiddenCalls();
    });

    it('filters accurately by explicit date range and unitBisnis', async () => {
      const { service, assertNoForbiddenCalls } = createSeededFixtureEnvironment();

      const result = await service.getSalesSummary(
        {
          startDate: '2026-11-18',
          endDate: '2026-11-22',
          unitBisnis: 'Frozen',
        },
        { now: FIXED_NOW, citationIndex: 2 }
      );

      expect(result.citationId).toBe('[SQL-2]');
      expect(result.citation.querySummary).toBe('periode=2026-11-18 s/d 2026-11-22, unitBisnis=Frozen');
      // Frozen in [2026-11-18, 2026-11-22]: Pemasukan 250000.50 (1), Pengeluaran 120000.00 (1)
      expect(result.data.totalPemasukan).toBe(250000.5);
      expect(result.data.totalPengeluaran).toBe(120000);
      expect(result.data.labaBersih).toBe(130000.5);
      expect(result.data.totalTransaksi).toBe(2);
      expect(result.data.unitBisnis).toBe('Frozen');

      assertNoForbiddenCalls();
    });

    it('supports periode="7d" relative to now and handles zero-match ranges cleanly', async () => {
      const { service } = createSeededFixtureEnvironment();

      // 7d ending 2026-11-23 => 2026-11-17..2026-11-23 excludes id=4 (2026-11-10)
      const sevenDays = await service.getSalesSummary({ periode: '7d' }, { now: FIXED_NOW });
      expect(sevenDays.data.totalPemasukan).toBe(425000.75);
      expect(sevenDays.data.totalPengeluaran).toBe(120000);
      expect(sevenDays.data.labaBersih).toBe(305000.75);
      expect(sevenDays.data.totalTransaksi).toBe(3);

      const empty = await service.getSalesSummary(
        { startDate: '2025-01-01', endDate: '2025-01-31' },
        { now: FIXED_NOW }
      );
      expect(empty.data.totalPemasukan).toBe(0);
      expect(empty.data.totalPengeluaran).toBe(0);
      expect(empty.data.labaBersih).toBe(0);
      expect(empty.data.rataRataPemasukan).toBe(0);
      expect(empty.data.totalTransaksi).toBe(0);
    });

    it('throws SqlToolValidationError (status 400) for inverted or malformed date ranges', async () => {
      const { service } = createSeededFixtureEnvironment();

      try {
        await service.getSalesSummary({ startDate: '2026-11-25', endDate: '2026-11-20' });
        expect.unreachable('Expected SqlToolValidationError');
      } catch (error) {
        expect(error).toBeInstanceOf(SqlToolsServiceError);
        expect(error).toBeInstanceOf(SqlToolValidationError);
        expect((error as SqlToolsServiceError).status).toBe(400);
        expect((error as SqlToolsServiceError).statusCode).toBe(400);
      }

      await expect(
        service.getSalesSummary({ startDate: 'not-a-date' })
      ).rejects.toThrow(SqlToolValidationError);
    });
  });

  describe('getRecentTransactions', () => {
    it('returns exact ordered recent transactions, clamps limit, and redacts accidental PII in detail', async () => {
      const { service, prismaMock, assertNoForbiddenCalls } = createSeededFixtureEnvironment();

      const result = await service.getRecentTransactions(
        999, // must clamp to MAX_RECENT_TRANSACTIONS_LIMIT
        { arah: 'PEMASUKAN' },
        { now: FIXED_NOW }
      );

      expect(result.citationId).toBe('[SQL-1]');
      expect(result.data.limit).toBe(MAX_RECENT_TRANSACTIONS_LIMIT);
      expect(result.data.count).toBe(2);
      expect(result.data.totalNominal).toBe(425000.75);
      expect(result.data.transactions.map((t) => t.kode)).toEqual([
        'PS001-10002',
        'PF001-10001',
      ]);

      // PII in detail must be redacted
      const aiTx = result.data.transactions[0];
      expect(aiTx.detail).not.toContain('budi@contoh.id');
      expect(aiTx.detail).not.toContain('081234567890');
      expect(aiTx.detail).toContain('[REDACTED_EMAIL]');
      expect(aiTx.detail).toContain('[REDACTED_PHONE]');

      const callArgs = prismaMock.transaksi.findMany.mock.calls[0][0] as { take: number };
      expect(callArgs.take).toBe(MAX_RECENT_TRANSACTIONS_LIMIT);

      assertNoForbiddenCalls();
    });

    it('rejects invalid limit and invalid filter enum values', async () => {
      const { service } = createSeededFixtureEnvironment();

      await expect(service.getRecentTransactions(0)).rejects.toThrow(SqlToolValidationError);
      await expect(service.getRecentTransactions(-5)).rejects.toThrow(SqlToolValidationError);
      await expect(service.getRecentTransactions(2.5)).rejects.toThrow(SqlToolValidationError);
      await expect(
        service.getRecentTransactions(5, { arah: 'INVALID' as ArahTransaksi })
      ).rejects.toThrow(SqlToolValidationError);
    });
  });

  describe('getCustomerOrdersSummary', () => {
    it('returns exact aggregated counts and totals per status without touching or leaking customer PII', async () => {
      const { service, assertNoForbiddenCalls } = createSeededFixtureEnvironment();

      const result = await service.getCustomerOrdersSummary(undefined, { now: FIXED_NOW });

      expect(result.toolName).toBe('getCustomerOrdersSummary');
      expect(result.citationId).toBe('[SQL-1]');
      expect(result.data.statusFilter).toBeNull();
      expect(result.data.totalPesanan).toBe(5);
      // 90000 + 150000.50 + 210000 + 125000.25 + 60000 = 635000.75
      expect(result.data.totalNilaiPesanan).toBe(635000.75);
      // SELESAI: 210000 + 125000.25 = 335000.25
      expect(result.data.totalNilaiSelesai).toBe(335000.25);
      // Active (excluding DIBATALKAN 60000): 575000.75
      expect(result.data.totalNilaiAktif).toBe(575000.75);
      expect(result.data.byStatus).toEqual({
        MENUNGGU_KONFIRMASI: { count: 1, totalNilai: 90000 },
        DIPROSES: { count: 1, totalNilai: 150000.5 },
        SELESAI: { count: 2, totalNilai: 335000.25 },
        DIBATALKAN: { count: 1, totalNilai: 60000 },
      });

      // Ensure zero customer PII appears anywhere in serialized response
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain('Siti Rahma');
      expect(serialized).not.toContain('siti.rahma@example.com');
      expect(serialized).not.toContain('081299990001');
      expect(serialized).not.toContain('Jl. Melati');
      expect(serialized).not.toContain('Dewi Lestari');

      assertNoForbiddenCalls();
    });

    it('supports filtering by a specific StatusPesananPelanggan string or filter object', async () => {
      const { service, assertNoForbiddenCalls } = createSeededFixtureEnvironment();

      const selesaiOnly = await service.getCustomerOrdersSummary('SELESAI', { now: FIXED_NOW });
      expect(selesaiOnly.data.statusFilter).toBe('SELESAI');
      expect(selesaiOnly.data.totalPesanan).toBe(2);
      expect(selesaiOnly.data.totalNilaiPesanan).toBe(335000.25);
      expect(selesaiOnly.data.byStatus.MENUNGGU_KONFIRMASI).toEqual({ count: 0, totalNilai: 0 });
      expect(selesaiOnly.data.byStatus.SELESAI).toEqual({ count: 2, totalNilai: 335000.25 });

      await expect(
        service.getCustomerOrdersSummary('UNKNOWN_STATUS' as StatusPesananPelanggan)
      ).rejects.toThrow(SqlToolValidationError);

      assertNoForbiddenCalls();
    });

    it('treats date-only endDate strings as inclusive end-of-day UTC for dibuatPada DateTime filtering', async () => {
      const { service, assertNoForbiddenCalls } = createSeededFixtureEnvironment();

      // Fixture orders 13 (2026-11-22T12:00:00Z, 210000) and 14 (2026-11-22T16:00:00Z, 125000.25)
      const sameDay = await service.getCustomerOrdersSummary(
        { startDate: '2026-11-22', endDate: '2026-11-22' },
        { now: FIXED_NOW }
      );

      expect(sameDay.citationId).toBe('[SQL-1]');
      expect(sameDay.data.totalPesanan).toBe(2);
      expect(sameDay.data.totalNilaiPesanan).toBe(335000.25);
      expect(sameDay.data.byStatus.SELESAI).toEqual({ count: 2, totalNilai: 335000.25 });
      expect(sameDay.data.periode).toEqual({
        startDate: '2026-11-22',
        endDate: '2026-11-22',
      });

      assertNoForbiddenCalls();
    });
  });

  describe('getProductStats / getProductCatalogStats', () => {
    it('returns exact catalog counts, price min/max/avg, units, and active product list without selecting gambarData', async () => {
      const { service, prismaMock, assertNoForbiddenCalls } = createSeededFixtureEnvironment();

      const result = await service.getProductStats({ now: FIXED_NOW });

      expect(result.toolName).toBe('getProductStats');
      expect(result.citationId).toBe('[SQL-1]');
      // 4 total, 3 active (15000, 21000, 45000), 1 inactive (99000)
      // avg active = (15000 + 21000 + 45000) / 3 = 27000
      expect(result.data).toEqual({
        totalProduk: 4,
        produkAktif: 3,
        produkNonaktif: 1,
        produkDenganVarian: 2,
        hargaMinimum: 15000,
        hargaMaksimum: 45000,
        hargaRataRata: 27000,
        satuanTersedia: ['pack', 'pcs'],
        daftarProdukAktif: [
          {
            id: 1,
            kode: 'SJU-001',
            namaBarang: 'Sosis Bakar Original',
            satuan: 'pcs',
            hargaDefault: 15000,
            memilikiVarian: true,
          },
          {
            id: 3,
            kode: 'SJU-003',
            namaBarang: 'Bakso Keju Melt',
            satuan: 'pcs',
            hargaDefault: 21000,
            memilikiVarian: true,
          },
          {
            id: 2,
            kode: 'SJU-002',
            namaBarang: 'Sosis Frozen Pack',
            satuan: 'pack',
            hargaDefault: 45000,
            memilikiVarian: false,
          },
        ],
      });

      // Verify gambarData BLOB is never selected
      const findManyArgs = prismaMock.produk.findMany.mock.calls[0][0] as {
        select: Record<string, boolean>;
      };
      expect(findManyArgs.select.gambarData).toBeUndefined();

      // Alias matches getProductStats
      const aliasResult = await service.getProductCatalogStats({ now: FIXED_NOW });
      expect(aliasResult.data.produkAktif).toBe(3);

      assertNoForbiddenCalls();
    });
  });

  describe('Allow-list executor & static no-raw-SQL / read-only guardrails', () => {
    it('dispatches only allow-listed tools and rejects unknown or mutating tool names', async () => {
      const { service, assertNoForbiddenCalls } = createSeededFixtureEnvironment();

      expect(ALLOWED_SQL_TOOLS).toEqual([
        'getSalesSummary',
        'getRecentTransactions',
        'getCustomerOrdersSummary',
        'getProductCatalogStats',
        'getProductStats',
      ]);
      expect(isAllowedSqlTool('getSalesSummary')).toBe(true);
      expect(isAllowedSqlTool('getProductCatalogStats')).toBe(true);
      expect(isAllowedSqlTool('getProductStats')).toBe(true);
      expect(isAllowedSqlTool('deleteAllTransactions')).toBe(false);

      const viaExecutor = await service.executeSqlTool(
        'getCustomerOrdersSummary',
        { statusFilter: 'DIPROSES' },
        { now: FIXED_NOW }
      );
      expect(viaExecutor.citationId).toBe('[SQL-1]');
      expect((viaExecutor.data as { totalPesanan: number }).totalPesanan).toBe(1);

      const viaCatalogAlias = await service.executeSqlTool(
        'getProductCatalogStats',
        {},
        { now: FIXED_NOW }
      );
      expect(viaCatalogAlias.citationId).toBe('[SQL-1]');
      expect(viaCatalogAlias.data).toMatchObject({
        totalProduk: 4,
        produkAktif: 3,
        produkNonaktif: 1,
        hargaMinimum: 15000,
        hargaMaksimum: 45000,
        hargaRataRata: 27000,
      });

      try {
        await service.executeSqlTool('dropTable');
        expect.unreachable('Expected SqlToolNotAllowedError');
      } catch (error) {
        expect(error).toBeInstanceOf(SqlToolsServiceError);
        expect(error).toBeInstanceOf(SqlToolNotAllowedError);
        expect((error as SqlToolsServiceError).status).toBe(400);
        expect((error as SqlToolsServiceError).statusCode).toBe(400);
      }

      await expect(service.executeSqlTool('createTransaction')).rejects.toThrow(
        SqlToolNotAllowedError
      );

      assertNoForbiddenCalls();
    });

    it('contains zero raw SQL APIs or Prisma write operations in sqlToolsService.ts source', () => {
      const sourcePath = resolve(__dirname, '../src/services/ai/sqlToolsService.ts');
      const source = readFileSync(sourcePath, 'utf8');

      // Strip comments so JSDoc mentions do not produce false positives
      const codeOnly = source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');

      expect(codeOnly).not.toMatch(/\$queryRaw|\$executeRaw/);
      expect(codeOnly).not.toMatch(
        /prisma\.[a-zA-Z0-9_]+\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/
      );
      expect(codeOnly).not.toMatch(/prisma\.pelanggan\b/);
    });
  });
});
