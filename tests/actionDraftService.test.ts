import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ActionDraftServiceError,
  ActionDraftUnsupportedIntentError,
  ActionDraftValidationError,
  createActionDraftService,
  detectWriteIntent,
  extractExplicitAmount,
  formatIndonesianDateLabel,
  formatIsoDate,
  formatRupiah,
  isWriteIntent,
  parseIndonesianAmountToken,
  type ActionDraftPrismaClient,
  type JenisTransaksiReadRecord,
  type NormalizedOrderPayload,
  type ProdukReadRecord,
} from '../src/services/ai/actionDraftService';

afterEach(() => {
  vi.clearAllMocks();
});

const SAMPLE_JENIS: JenisTransaksiReadRecord[] = [
  {
    id: 1,
    kode: 'DO1',
    namaTransaksi: 'Pendapatan Frozen',
    arah: 'PEMASUKAN',
    jenisAkun: 'Pendapatan FROZEN',
    unitBisnis: 'FROZEN',
    isBawaan: true,
    aktif: true,
  },
  {
    id: 2,
    kode: 'DO2',
    namaTransaksi: 'Pendapatan Siap Saji',
    arah: 'PEMASUKAN',
    jenisAkun: 'Pendapatan PESANAN',
    unitBisnis: 'SIAP_SAJI',
    isBawaan: true,
    aktif: true,
  },
  {
    id: 3,
    kode: 'MT1',
    namaTransaksi: 'Pembayaran Cicilan Hutang',
    arah: 'PENGELUARAN',
    jenisAkun: 'Hutang Usaha',
    unitBisnis: null,
    isBawaan: true,
    aktif: true,
  },
  {
    id: 4,
    kode: 'BL1',
    namaTransaksi: 'Pembelian Bahan Baku',
    arah: 'PENGELUARAN',
    jenisAkun: 'HPP Bahan Baku',
    unitBisnis: null,
    isBawaan: false,
    aktif: true,
  },
];

const SAMPLE_PRODUK: ProdukReadRecord[] = [
  {
    id: 10,
    kode: 'PRD-001',
    namaBarang: 'Nugget Ayam 500g',
    satuan: 'pack',
    hargaDefault: 45000,
    aktif: true,
  },
  {
    id: 11,
    kode: 'PRD-002',
    namaBarang: 'Siomay Ayam',
    satuan: 'pack',
    hargaDefault: 32000,
    aktif: true,
  },
  {
    id: 12,
    kode: 'PRD-003',
    namaBarang: 'Bento Ayam Bakar',
    satuan: 'porsi',
    hargaDefault: 35000,
    aktif: true,
  },
];

function createSpyPrismaWithMutationTraps(
  jenisList: JenisTransaksiReadRecord[] = SAMPLE_JENIS,
  produkList: ProdukReadRecord[] = SAMPLE_PRODUK
) {
  const transaksi = {
    create: vi.fn(),
    update: vi.fn(),
    upsert: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
  };
  const pesananPelanggan = {
    create: vi.fn(),
    update: vi.fn(),
    upsert: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
  };
  const itemPesananPelanggan = {
    create: vi.fn(),
    createMany: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };
  const $transaction = vi.fn();
  const $executeRaw = vi.fn();
  const $executeRawUnsafe = vi.fn();

  const prisma = {
    jenisTransaksi: {
      findMany: vi.fn().mockResolvedValue(jenisList),
    },
    produk: {
      findMany: vi.fn().mockResolvedValue(produkList),
    },
    transaksi,
    pesananPelanggan,
    itemPesananPelanggan,
    $transaction,
    $executeRaw,
    $executeRawUnsafe,
  };

  return {
    prisma,
    assertZeroMutations() {
      expect(transaksi.create).not.toHaveBeenCalled();
      expect(transaksi.update).not.toHaveBeenCalled();
      expect(transaksi.upsert).not.toHaveBeenCalled();
      expect(transaksi.delete).not.toHaveBeenCalled();
      expect(transaksi.deleteMany).not.toHaveBeenCalled();
      expect(pesananPelanggan.create).not.toHaveBeenCalled();
      expect(pesananPelanggan.update).not.toHaveBeenCalled();
      expect(pesananPelanggan.upsert).not.toHaveBeenCalled();
      expect(pesananPelanggan.delete).not.toHaveBeenCalled();
      expect(pesananPelanggan.deleteMany).not.toHaveBeenCalled();
      expect(itemPesananPelanggan.create).not.toHaveBeenCalled();
      expect(itemPesananPelanggan.createMany).not.toHaveBeenCalled();
      expect(itemPesananPelanggan.update).not.toHaveBeenCalled();
      expect(itemPesananPelanggan.delete).not.toHaveBeenCalled();
      expect($transaction).not.toHaveBeenCalled();
      expect($executeRaw).not.toHaveBeenCalled();
      expect($executeRawUnsafe).not.toHaveBeenCalled();
    },
  };
}

describe('actionDraftService formatting & parsing helpers', () => {
  it('formats rupiah and Indonesian dates consistently', () => {
    expect(formatRupiah(240000)).toBe('Rp 240.000');
    expect(formatRupiah(1500000)).toBe('Rp 1.500.000');
    expect(formatRupiah(0)).toBe('Rp 0');

    const date = new Date(2026, 10, 23, 13, 30, 0);
    expect(formatIsoDate(date)).toBe('2026-11-23');
    expect(formatIndonesianDateLabel(date)).toBe('23 Nov 2026');
  });

  it('parses Indonesian amount formats (Rp, rb, ribu, k, jt, juta, dotted thousands)', () => {
    expect(parseIndonesianAmountToken('Rp 240.000')).toBe(240000);
    expect(parseIndonesianAmountToken('240rb')).toBe(240000);
    expect(parseIndonesianAmountToken('240 ribu')).toBe(240000);
    expect(parseIndonesianAmountToken('250k')).toBe(250000);
    expect(parseIndonesianAmountToken('1,5jt')).toBe(1500000);
    expect(parseIndonesianAmountToken('1.5 juta')).toBe(1500000);
    expect(parseIndonesianAmountToken('320.000')).toBe(320000);
    expect(parseIndonesianAmountToken('92000')).toBe(92000);

    expect(extractExplicitAmount('penjualan 2 nugget 500g ke Bu Siti Rp 240.000')).toBe(240000);
    expect(extractExplicitAmount('beli ayam 10kg 320rb tanggal 2026-11-20')).toBe(320000);
    expect(extractExplicitAmount('bayar listrik 1,5jt via transfer')).toBe(1500000);
  });
});

describe('detectWriteIntent & isWriteIntent', () => {
  it('classifies /add jual, /add beli, buat transaksi, and buat pesanan deterministically', () => {
    expect(detectWriteIntent('/add jual 2 nugget ke Bu Siti 240rb')).toMatchObject({
      type: 'CREATE_TRANSACTION',
      intent: 'PENJUALAN',
      arah: 'PEMASUKAN',
      sheet: 'Transaksi',
    });

    expect(detectWriteIntent('/add beli daging ayam 10kg 320.000 dari Pak Hadi')).toMatchObject({
      type: 'CREATE_TRANSACTION',
      intent: 'PEMBELIAN',
      arah: 'PENGELUARAN',
      sheet: 'Transaksi',
    });

    expect(detectWriteIntent('buat transaksi pemasukan 150rb QRIS')).toMatchObject({
      type: 'CREATE_TRANSACTION',
      intent: 'TRANSAKSI',
      arah: 'PEMASUKAN',
      sheet: 'Transaksi',
    });

    expect(detectWriteIntent('buat transaksi pengeluaran bayar listrik 450rb')).toMatchObject({
      type: 'CREATE_TRANSACTION',
      intent: 'PEMBELIAN',
      arah: 'PENGELUARAN',
      sheet: 'Transaksi',
    });

    expect(detectWriteIntent('buat pesanan 2 Nugget Ayam 500g untuk Bu Ani')).toMatchObject({
      type: 'CREATE_ORDER',
      intent: 'PESANAN',
      arah: 'PEMASUKAN',
      sheet: 'Order',
    });

    expect(detectWriteIntent('/add order 1 Siomay Ayam via GrabFood')).toMatchObject({
      type: 'CREATE_ORDER',
      intent: 'PESANAN',
      arah: 'PEMASUKAN',
      sheet: 'Order',
    });
  });

  it('returns null/false for non-write analytical or SOP queries', () => {
    expect(detectWriteIntent('Berapa total omzet penjualan 7 hari terakhir?')).toBeNull();
    expect(isWriteIntent('Apa SOP pengiriman frozen food SOJU?')).toBe(false);
    expect(isWriteIntent('   ')).toBe(false);
  });
});

describe('actionDraftService.buildActionDraft', () => {
  const fixedNow = new Date(2026, 10, 23, 13, 15, 0); // 23 Nov 2026, Shift Siang

  it('builds Web DraftCard + Flutter ChatDraftCard aligned payload for /add jual with requiresConfirmation: true', async () => {
    const { prisma, assertZeroMutations } = createSpyPrismaWithMutationTraps();
    const service = createActionDraftService({
      prisma: prisma as unknown as ActionDraftPrismaClient,
    });

    const result = await service.buildActionDraft({
      prompt: '/add jual 2 pack Nugget Ayam 500g ke Bu Siti 240rb via WA QRIS',
      now: fixedNow,
    });

    expect(result.routePath).toBe('ACTION_DRAFT');
    expect(result.intent).toBe('PENJUALAN');
    expect(result.actions).toHaveLength(1);

    const draft = result.actions[0];
    expect(draft.type).toBe('CREATE_TRANSACTION');
    expect(draft.requiresConfirmation).toBe(true);
    expect(draft.endpoint).toBe('/api/v1/transactions');
    expect(draft.method).toBe('POST');

    // Web DraftCard fields
    expect(draft.title).toBe('Draft Penjualan Produk');
    expect(draft.sheet).toBe('Transaksi');
    expect(draft.total).toBe('Rp 90.000'); // 2 * 45.000 from catalog
    expect(draft.totalAmount).toBe(90000);
    expect(draft.sourceBadge).toBe('AI');
    expect(draft.summaryRows).toEqual(
      expect.arrayContaining([
        { label: 'Tanggal', value: '23 Nov 2026' },
        { label: 'Metode Kas', value: 'QRIS' },
        { label: 'Nominal', value: 'Rp 90.000' },
        { label: 'Customer', value: 'Bu Siti — WhatsApp' },
      ])
    );

    // Flutter ChatDraftCard fields
    expect(draft.badge).toBe('Belum disimpan');
    expect(draft.dateLabel).toBe('23 Nov 2026');
    expect(draft.shiftLabel).toBe('Shift Siang');
    expect(draft.totalLabel).toBe('TOTAL PEMASUKAN KASIR');
    expect(draft.breakdownTitle).toBe('Rincian Menu Terjual');
    expect(draft.confirmLabel).toBe('Simpan & Posting');
    expect(draft.correctLabel).toBe('Koreksi');
    expect(draft.note).toContain('belum masuk');
    expect(draft.items).toEqual([
      {
        produkId: 10,
        nama: 'Nugget Ayam 500g',
        jumlah: 2,
        satuan: 'pack',
        hargaSatuan: 45000,
        subtotal: 90000,
        metode: 'QRIS',
      },
    ]);

    // Normalized POST /api/v1/transactions payload
    expect(draft.payload).toMatchObject({
      tanggal: '2026-11-23',
      jenis_transaksi_id: 2,
      arah: 'PEMASUKAN',
      jenisKas: 'QRIS',
      jenis_kas: 'QRIS',
      nominal: 90000,
      sumber_input: 'AI',
      sumberInput: 'AI',
      customData: {
        draftIntent: 'PENJUALAN',
        partyName: 'Bu Siti',
        channel: 'WhatsApp',
        shift: 'Shift Siang',
      },
    });
    expect(draft.isReadyToConfirm).toBe(true);
    expect(draft.missingFields).toEqual([]);

    assertZeroMutations();
  });

  it('builds structured PENGELUARAN draft for /add beli with supplier and zero DB writes', async () => {
    const { prisma, assertZeroMutations } = createSpyPrismaWithMutationTraps();
    const service = createActionDraftService({
      prisma: prisma as unknown as ActionDraftPrismaClient,
    });

    const result = await service.buildActionDraft({
      prompt: '/add beli daging ayam 10kg Rp 320.000 tunai dari Pak Hadi tanggal 2026-11-20',
      now: fixedNow,
    });

    expect(result.routePath).toBe('ACTION_DRAFT');
    expect(result.intent).toBe('PEMBELIAN');
    expect(result.actions).toHaveLength(1);

    const draft = result.actions[0];
    expect(draft.type).toBe('CREATE_TRANSACTION');
    expect(draft.requiresConfirmation).toBe(true);
    expect(draft.title).toBe('Draft Pembelian / Pengeluaran');
    expect(draft.sheet).toBe('Transaksi');
    expect(draft.total).toBe('Rp 320.000');
    expect(draft.totalAmount).toBe(320000);
    expect(draft.totalLabel).toBe('TOTAL PENGELUARAN');

    expect(draft.summaryRows).toEqual(
      expect.arrayContaining([
        { label: 'Tanggal', value: '20 Nov 2026' },
        { label: 'Jenis Transaksi', value: 'Pembelian Bahan Baku' },
        { label: 'Metode Kas', value: 'TUNAI' },
        { label: 'Nominal', value: 'Rp 320.000' },
        { label: 'Supplier', value: 'Pak Hadi' },
      ])
    );

    expect(draft.payload).toMatchObject({
      tanggal: '2026-11-20',
      jenis_transaksi_id: 4,
      arah: 'PENGELUARAN',
      jenis_kas: 'TUNAI',
      nominal: 320000,
      sumber_input: 'AI',
      sumberInput: 'AI',
    });

    assertZeroMutations();
  });

  it('builds multi-item sales draft with @unitPrice and mixed QRIS/tunai payment methods', async () => {
    const { prisma, assertZeroMutations } = createSpyPrismaWithMutationTraps();
    const service = createActionDraftService({
      prisma: prisma as unknown as ActionDraftPrismaClient,
    });

    const result = await service.buildActionDraft({
      prompt: 'buat transaksi 30 porsi Bento Ayam Bakar @35000 QRIS, 5 gelas Es Teh @10000 tunai shift sore',
      now: fixedNow,
    });

    const draft = result.actions[0];
    expect(draft.requiresConfirmation).toBe(true);
    expect(draft.shiftLabel).toBe('Shift Sore');
    expect(draft.totalAmount).toBe(1100000);
    expect(draft.total).toBe('Rp 1.100.000');
    expect(draft.items).toEqual([
      {
        produkId: 12,
        nama: 'Bento Ayam Bakar',
        jumlah: 30,
        satuan: 'porsi',
        hargaSatuan: 35000,
        subtotal: 1050000,
        metode: 'QRIS',
      },
      {
        produkId: null,
        nama: 'Es Teh',
        jumlah: 5,
        satuan: 'gelas',
        hargaSatuan: 10000,
        subtotal: 50000,
        metode: 'CASH',
      },
    ]);

    assertZeroMutations();
  });

  it('builds CREATE_ORDER draft for buat pesanan with item rows, customer, channel, and zero DB writes', async () => {
    const { prisma, assertZeroMutations } = createSpyPrismaWithMutationTraps();
    const service = createActionDraftService({
      prisma: prisma as unknown as ActionDraftPrismaClient,
    });

    const result = await service.buildActionDraft({
      prompt: 'buat pesanan 2 Nugget Ayam 500g dan 1 Siomay Ayam untuk Bu Ani via GrabFood',
      now: fixedNow,
    });

    expect(result.routePath).toBe('ACTION_DRAFT');
    expect(result.intent).toBe('PESANAN');
    expect(result.actions).toHaveLength(1);

    const draft = result.actions[0];
    expect(draft.type).toBe('CREATE_ORDER');
    expect(draft.requiresConfirmation).toBe(true);
    expect(draft.title).toBe('Draft Pesanan Baru');
    expect(draft.sheet).toBe('Order');
    expect(draft.totalAmount).toBe(122000); // 2*45000 + 1*32000
    expect(draft.total).toBe('Rp 122.000');

    expect(draft.summaryRows).toEqual(
      expect.arrayContaining([
        { label: 'Customer', value: 'Bu Ani — GrabFood' },
        { label: 'Item 1', value: 'Nugget Ayam 500g × 2 pack' },
        { label: 'Item 2', value: 'Siomay Ayam × 1 pack' },
      ])
    );

    const orderPayload = draft.payload as NormalizedOrderPayload;
    expect(orderPayload.customerName).toBe('Bu Ani');
    expect(orderPayload.channel).toBe('GrabFood');
    expect(orderPayload.total).toBe(122000);
    expect(orderPayload.items).toHaveLength(2);
    expect(orderPayload.sumber_input).toBe('AI');
    expect(orderPayload.sumberInput).toBe('AI');

    assertZeroMutations();
  });

  it('flags missingFields cleanly when nominal or jenis_transaksi_id cannot be resolved', async () => {
    const { prisma, assertZeroMutations } = createSpyPrismaWithMutationTraps([], []);
    const service = createActionDraftService({
      prisma: prisma as unknown as ActionDraftPrismaClient,
    });

    const result = await service.buildActionDraft({
      prompt: '/add jual snack kentang',
      now: fixedNow,
    });

    const draft = result.actions[0];
    expect(draft.requiresConfirmation).toBe(true);
    expect(draft.isReadyToConfirm).toBe(false);
    expect(draft.totalAmount).toBe(0);
    expect(draft.payload.jenis_transaksi_id).toBeNull();
    expect(draft.missingFields).toEqual(['nominal', 'jenis_transaksi_id']);
    expect(result.assistantMessage).toContain('nominal');

    assertZeroMutations();
  });

  it('redacts accidental email and phone PII from detail, summaryRows, items, and customData without misparsing phone as nominal', async () => {
    const { prisma, assertZeroMutations } = createSpyPrismaWithMutationTraps();
    const service = createActionDraftService({
      prisma: prisma as unknown as ActionDraftPrismaClient,
    });

    // Direct helper check: phone number must never be parsed as a nominal
    expect(extractExplicitAmount('jual snack ke 081234567890')).toBeNull();
    expect(extractExplicitAmount('pesanan +62 812-3456-7890 budi@example.com')).toBeNull();

    // Case 1: prompt containing email + Indonesian local/international phone AND no explicit amount
    const noAmountResult = await service.buildActionDraft({
      prompt: '/add jual snack kentang ke budi@example.com 081234567890 +62 812-3456-7890',
      now: fixedNow,
    });

    const noAmountDraft = noAmountResult.actions[0];
    expect(noAmountDraft.requiresConfirmation).toBe(true);
    expect(noAmountDraft.totalAmount).toBe(0);
    expect(noAmountDraft.payload.nominal).toBe(0);
    expect(noAmountDraft.isReadyToConfirm).toBe(false);
    expect(noAmountDraft.missingFields).toContain('nominal');

    const serializedNoAmount = JSON.stringify({
      detail: noAmountDraft.payload.detail,
      summaryRows: noAmountDraft.summaryRows,
      items: noAmountDraft.items,
      customData: noAmountDraft.payload.customData,
    });
    expect(serializedNoAmount).not.toContain('budi@example.com');
    expect(serializedNoAmount).not.toContain('081234567890');
    expect(serializedNoAmount).not.toContain('812-3456-7890');
    expect(noAmountDraft.payload.detail).toContain('[REDACTED_EMAIL]');
    expect(noAmountDraft.payload.detail).toContain('[REDACTED_PHONE]');

    // Case 2: complete draft with valid amount + accidental PII in prompt
    const withAmountResult = await service.buildActionDraft({
      prompt: '/add jual 2 pack Nugget Ayam 500g ke Bu Siti budi@example.com 081234567890 via WA QRIS',
      now: fixedNow,
    });

    const withAmountDraft = withAmountResult.actions[0];
    expect(withAmountDraft.isReadyToConfirm).toBe(true);
    expect(withAmountDraft.totalAmount).toBe(90000);
    expect(withAmountDraft.payload.jenisKas).toBe('QRIS');
    expect(withAmountDraft.payload.customData).toBeTruthy();

    const serializedWithAmount = JSON.stringify({
      detail: withAmountDraft.payload.detail,
      summaryRows: withAmountDraft.summaryRows,
      items: withAmountDraft.items,
      customData: withAmountDraft.payload.customData,
    });
    expect(serializedWithAmount).not.toContain('budi@example.com');
    expect(serializedWithAmount).not.toContain('081234567890');

    assertZeroMutations();
  });

  it('parses qty x price and qty × price patterns accurately for items, totalAmount, and payload.nominal', async () => {
    const { prisma, assertZeroMutations } = createSpyPrismaWithMutationTraps();
    const service = createActionDraftService({
      prisma: prisma as unknown as ActionDraftPrismaClient,
    });

    expect(extractExplicitAmount('2 x 45rb')).toBe(90000);
    expect(extractExplicitAmount('3 × Rp 50.000')).toBe(150000);

    const singleResult = await service.buildActionDraft({
      prompt: '/add jual 2 x 45rb Nugget Ayam QRIS',
      now: fixedNow,
    });

    const singleDraft = singleResult.actions[0];
    expect(singleDraft.requiresConfirmation).toBe(true);
    expect(singleDraft.isReadyToConfirm).toBe(true);
    expect(singleDraft.totalAmount).toBe(90000);
    expect(singleDraft.total).toBe('Rp 90.000');
    expect(singleDraft.payload.nominal).toBe(90000);
    expect(singleDraft.payload.jenisKas).toBe('QRIS');
    expect(singleDraft.items).toEqual([
      {
        produkId: 10,
        nama: 'Nugget Ayam 500g',
        jumlah: 2,
        satuan: 'pack',
        hargaSatuan: 45000,
        subtotal: 90000,
        metode: 'QRIS',
      },
    ]);

    const multiResult = await service.buildActionDraft({
      prompt: 'buat transaksi 3 × Rp 50.000 Bento Ayam Bakar tunai, 2 x 32k Siomay Ayam QRIS',
      now: fixedNow,
    });

    const multiDraft = multiResult.actions[0];
    expect(multiDraft.requiresConfirmation).toBe(true);
    expect(multiDraft.isReadyToConfirm).toBe(true);
    expect(multiDraft.totalAmount).toBe(214000); // 3*50000 + 2*32000
    expect(multiDraft.total).toBe('Rp 214.000');
    expect(multiDraft.payload.nominal).toBe(214000);
    expect(multiDraft.items).toEqual([
      {
        produkId: 12,
        nama: 'Bento Ayam Bakar',
        jumlah: 3,
        satuan: 'porsi',
        hargaSatuan: 50000,
        subtotal: 150000,
        metode: 'CASH',
      },
      {
        produkId: 11,
        nama: 'Siomay Ayam',
        jumlah: 2,
        satuan: 'pack',
        hargaSatuan: 32000,
        subtotal: 64000,
        metode: 'QRIS',
      },
    ]);

    assertZeroMutations();
  });

  it('rejects empty or non-write prompts with typed ActionDraftServiceError', async () => {
    const { prisma, assertZeroMutations } = createSpyPrismaWithMutationTraps();
    const service = createActionDraftService({
      prisma: prisma as unknown as ActionDraftPrismaClient,
    });

    await expect(service.buildActionDraft({ prompt: '   ' })).rejects.toThrow(
      ActionDraftValidationError
    );

    await expect(
      service.buildActionDraft({ prompt: 'Berapa total penjualan bulan ini?' })
    ).rejects.toThrow(ActionDraftUnsupportedIntentError);

    try {
      await service.buildActionDraft({ prompt: 'Apa jam buka toko?' });
    } catch (err) {
      expect(err).toBeInstanceOf(ActionDraftServiceError);
      expect(err).toMatchObject({
        code: 'ACTION_DRAFT_UNSUPPORTED_INTENT',
        status: 400,
        statusCode: 400,
      });
    }

    assertZeroMutations();
  });
});
