/**
 * Kode JenisTransaksi bawaan yang di-seed lewat prisma/seed.ts supaya
 * order & pembayaran hutang langsung jalan tanpa setup manual. Ini CUMA
 * daftar kode acuan untuk kode kita sendiri (orders.ts, dashboard.ts) -
 * jenisnya sendiri tetap baris biasa di tabel jenis_transaksi yang full
 * CRUD oleh user (lihat isBawaan flag di schema).
 */
export const KODE_JENIS_BAWAAN = {
  PENDAPATAN_FROZEN: 'DO1',
  PENDAPATAN_SIAP_SAJI: 'DO2',
  PEMBAYARAN_CICILAN_HUTANG: 'MT1',
} as const;
