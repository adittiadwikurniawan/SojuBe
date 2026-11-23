import type { ArahTransaksi, SumberInput } from '@prisma/client';
import defaultPrisma from '../../utils/database';
import { KODE_JENIS_BAWAAN } from '../../utils/jenisBawaan';
import { sanitizePii } from './ingestionService';

export const ACTION_DRAFT_TYPES = ['CREATE_TRANSACTION', 'CREATE_ORDER'] as const;
export type ActionDraftType = (typeof ACTION_DRAFT_TYPES)[number];

export const ACTION_DRAFT_INTENTS = [
  'PENJUALAN',
  'PEMBELIAN',
  'TRANSAKSI',
  'PESANAN',
] as const;
export type ActionDraftIntentKind = (typeof ACTION_DRAFT_INTENTS)[number];

export type ActionDraftSheet = 'Transaksi' | 'Order';
export type DraftPaymentMethod = 'QRIS' | 'TUNAI' | 'TRANSFER';

export type ActionDraftErrorCode =
  | 'ACTION_DRAFT_VALIDATION_ERROR'
  | 'ACTION_DRAFT_UNSUPPORTED_INTENT';

export class ActionDraftServiceError extends Error {
  readonly code: ActionDraftErrorCode | string;
  readonly status: number;
  readonly statusCode: number;

  constructor(
    code: ActionDraftErrorCode | string,
    message: string,
    status: number = 400
  ) {
    super(message);
    this.name = 'ActionDraftServiceError';
    this.code = code;
    this.status = status;
    this.statusCode = status;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ActionDraftValidationError extends ActionDraftServiceError {
  constructor(message: string) {
    super('ACTION_DRAFT_VALIDATION_ERROR', message, 400);
    this.name = 'ActionDraftValidationError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ActionDraftUnsupportedIntentError extends ActionDraftServiceError {
  constructor(message: string) {
    super('ACTION_DRAFT_UNSUPPORTED_INTENT', message, 400);
    this.name = 'ActionDraftUnsupportedIntentError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface ActionDraftSummaryRow {
  label: string;
  value: string;
}

export interface ActionDraftLineItem {
  produkId: number | null;
  nama: string;
  jumlah: number;
  satuan: string;
  hargaSatuan: number;
  subtotal: number;
  metode: 'QRIS' | 'CASH';
}

export interface NormalizedTransactionPayload {
  tanggal: string;
  jenis_transaksi_id: number | null;
  jenisTransaksiId: number | null;
  nama_transaksi: string;
  arah: ArahTransaksi;
  unit_bisnis: string | null;
  detail: string;
  jenisKas: DraftPaymentMethod;
  jenis_kas: DraftPaymentMethod;
  nominal: number;
  debit: string | null;
  kredit: string | null;
  sumber_input: SumberInput;
  sumberInput: SumberInput;
  customData: Record<string, unknown> | null;
  custom_data: Record<string, unknown> | null;
}

export interface NormalizedOrderPayload extends NormalizedTransactionPayload {
  customerName: string | null;
  channel: string | null;
  items: ActionDraftLineItem[];
  total: number;
}

/**
 * Structured Action Draft aligned with both:
 * - Web `DraftCardData` (title, sheet, summaryRows/rows, total, sourceBadge)
 * - Flutter `ChatDraft` / `ChatDraftCard` (badge, dateLabel, shiftLabel, totalLabel,
 *   breakdownTitle, items, confirmLabel, correctLabel, note)
 *
 * Strictly enforces `requiresConfirmation: true` (zero auto-commit).
 */
export interface ActionDraft {
  id: string;
  type: ActionDraftType;
  intent: ActionDraftIntentKind;
  requiresConfirmation: true;
  endpoint: '/api/v1/transactions';
  method: 'POST';
  // Web DraftCard fields
  title: string;
  sheet: ActionDraftSheet;
  summaryRows: ActionDraftSummaryRow[];
  total: string;
  totalAmount: number;
  sourceBadge: 'AI';
  // Flutter ChatDraftCard fields
  badge: string;
  dateLabel: string;
  shiftLabel: string;
  totalLabel: string;
  breakdownTitle: string;
  items: ActionDraftLineItem[];
  confirmLabel: string;
  correctLabel: string;
  note: string;
  // Normalized API payload for manual confirmation
  payload: NormalizedTransactionPayload | NormalizedOrderPayload;
  isReadyToConfirm: boolean;
  missingFields: string[];
}

export interface DetectedWriteIntent {
  type: ActionDraftType;
  intent: ActionDraftIntentKind;
  arah: ArahTransaksi;
  sheet: ActionDraftSheet;
  matchedTrigger: string;
  cleanedText: string;
}

export interface ActionDraftResult {
  routePath: 'ACTION_DRAFT';
  intent: ActionDraftIntentKind;
  assistantMessage: string;
  actions: ActionDraft[];
}

export interface JenisTransaksiReadRecord {
  id: number;
  kode: string;
  namaTransaksi: string;
  arah: ArahTransaksi;
  jenisAkun?: string | null;
  unitBisnis?: string | null;
  isBawaan?: boolean;
  aktif: boolean;
}

export interface ProdukReadRecord {
  id: number;
  kode: string;
  namaBarang: string;
  satuan: string;
  hargaDefault: unknown;
  aktif: boolean;
}

/**
 * Strictly read-only Prisma subset for action draft enrichment.
 * Deliberately exposes ZERO create/update/upsert/delete/$executeRaw/$transaction methods
 * on Transaksi, PesananPelanggan, or any other model.
 */
export interface ActionDraftPrismaClient {
  jenisTransaksi?: {
    findMany(args?: Record<string, unknown>): Promise<JenisTransaksiReadRecord[]>;
  };
  produk?: {
    findMany(args?: Record<string, unknown>): Promise<ProdukReadRecord[]>;
  };
}

export interface ActionDraftServiceDependencies {
  prisma?: ActionDraftPrismaClient;
}

export interface BuildActionDraftParams {
  prompt: string;
  now?: Date;
}

const INDONESIAN_MONTHS_SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'Mei',
  'Jun',
  'Jul',
  'Agu',
  'Sep',
  'Okt',
  'Nov',
  'Des',
] as const;

const EXPENSE_HINT_REGEX =
  /\b(beli|pembelian|belanja|restock|pengeluaran|biaya|beban|bayar|gaji|listrik|sewa|bahan\s+baku|supplier|pemasok|cicilan|hutang)\b/i;

const KNOWN_UNITS = [
  'porsi',
  'gelas',
  'cup',
  'pack',
  'pak',
  'pcs',
  'buah',
  'box',
  'dus',
  'kotak',
  'kg',
  'gram',
  'gr',
  'g',
  'liter',
  'ltr',
  'botol',
  'btl',
  'bungkus',
  'bks',
  'biji',
  'potong',
  'ikat',
  'ekor',
  'lusin',
  'karton',
] as const;

const KNOWN_UNITS_PATTERN = KNOWN_UNITS.join('|');
const AMOUNT_TOKEN_PATTERN =
  '(?:rp\\.?\\s*)?\\d+(?:[.,]\\d+)*(?:\\s*(?:jt|juta|rb|ribu|k))?';
const QTY_X_PRICE_PATTERN = new RegExp(
  `\\b(\\d+)\\s*(?:(${KNOWN_UNITS_PATTERN})\\s+)?[x×]\\s*(${AMOUNT_TOKEN_PATTERN})(?=\\s|$|[,;.)])`,
  'i'
);
const QTY_X_PRICE_GLOBAL_PATTERN = new RegExp(
  `\\b(\\d+)\\s*(?:(?:${KNOWN_UNITS_PATTERN})\\s+)?[x×]\\s*(${AMOUNT_TOKEN_PATTERN})(?=\\s|$|[,;.)])`,
  'gi'
);

function toFiniteNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (value && typeof value === 'object' && 'toNumber' in value && typeof (value as { toNumber: unknown }).toNumber === 'function') {
    const parsed = (value as { toNumber: () => number }).toNumber();
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

/**
 * Formats an integer/number as Indonesian Rupiah, e.g. 240000 -> "Rp 240.000".
 */
export function formatRupiah(amount: number): string {
  const safe = Number.isFinite(amount) ? Math.round(amount) : 0;
  const sign = safe < 0 ? '-' : '';
  const digits = Math.abs(safe)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${sign}Rp ${digits}`;
}

/**
 * Formats a Date into ISO date string YYYY-MM-DD (UTC-safe local date components).
 */
export function formatIsoDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Formats a Date into short Indonesian display label, e.g. "23 Nov 2026".
 */
export function formatIndonesianDateLabel(date: Date): string {
  const d = String(date.getDate()).padStart(2, '0');
  const month = INDONESIAN_MONTHS_SHORT[date.getMonth()] ?? 'Jan';
  return `${d} ${month} ${date.getFullYear()}`;
}

/**
 * Deterministically detects whether a user prompt is a write intent that must
 * route to Path C (Action Draft Builder, zero auto-commit).
 */
export function detectWriteIntent(prompt: string): DetectedWriteIntent | null {
  if (typeof prompt !== 'string') {
    return null;
  }

  const trimmed = prompt.trim();
  if (!trimmed) {
    return null;
  }

  // 1. Explicit slash commands: /add jual, /add beli, /add restock, /add order, /add pesanan, /add transaksi, /add ...
  const slashMatch = /^\/add(?:\s+(jual|penjualan|beli|pembelian|restock|pengeluaran|order|pesanan|transaksi))?\b\s*(.*)$/i.exec(
    trimmed
  );
  if (slashMatch) {
    const subcommand = (slashMatch[1] ?? '').toLowerCase();
    const rest = (slashMatch[2] ?? '').trim();

    if (subcommand === 'jual' || subcommand === 'penjualan') {
      return {
        type: 'CREATE_TRANSACTION',
        intent: 'PENJUALAN',
        arah: 'PEMASUKAN',
        sheet: 'Transaksi',
        matchedTrigger: `/add ${subcommand}`,
        cleanedText: rest,
      };
    }

    if (
      subcommand === 'beli' ||
      subcommand === 'pembelian' ||
      subcommand === 'restock' ||
      subcommand === 'pengeluaran'
    ) {
      return {
        type: 'CREATE_TRANSACTION',
        intent: 'PEMBELIAN',
        arah: 'PENGELUARAN',
        sheet: 'Transaksi',
        matchedTrigger: `/add ${subcommand}`,
        cleanedText: rest,
      };
    }

    if (subcommand === 'order' || subcommand === 'pesanan') {
      return {
        type: 'CREATE_ORDER',
        intent: 'PESANAN',
        arah: 'PEMASUKAN',
        sheet: 'Order',
        matchedTrigger: `/add ${subcommand}`,
        cleanedText: rest,
      };
    }

    const inferredExpense = EXPENSE_HINT_REGEX.test(rest);
    return {
      type: 'CREATE_TRANSACTION',
      intent: inferredExpense ? 'PEMBELIAN' : 'TRANSAKSI',
      arah: inferredExpense ? 'PENGELUARAN' : 'PEMASUKAN',
      sheet: 'Transaksi',
      matchedTrigger: subcommand ? `/add ${subcommand}` : '/add',
      cleanedText: rest,
    };
  }

  // 2. Natural-language order creation intents
  const orderRegex =
    /^(?:tolong\s+|bantu\s+|mohon\s+|coba\s+)?(?:buat(?:kan)?|tambah(?:kan)?|catat(?:kan)?|input(?:kan)?|bikin)\s+(?:draft\s+|draf\s+)?(pesanan|order)(?:\s+baru)?\b[\s:,-]*(.*)$/i;
  const orderMatch = orderRegex.exec(trimmed);
  if (orderMatch) {
    return {
      type: 'CREATE_ORDER',
      intent: 'PESANAN',
      arah: 'PEMASUKAN',
      sheet: 'Order',
      matchedTrigger: orderMatch[0].slice(0, orderMatch[0].length - (orderMatch[2]?.length ?? 0)).trim(),
      cleanedText: (orderMatch[2] ?? '').trim(),
    };
  }

  // 3. Natural-language purchase / expense intents
  const purchaseRegex =
    /^(?:tolong\s+|bantu\s+|mohon\s+|coba\s+)?(?:buat(?:kan)?|tambah(?:kan)?|catat(?:kan)?|input(?:kan)?|bikin)\s+(?:draft\s+|draf\s+)?(?:transaksi\s+)?(pembelian|pengeluaran|belanja|restock|beli)\b[\s:,-]*(.*)$/i;
  const purchaseMatch = purchaseRegex.exec(trimmed);
  if (purchaseMatch) {
    return {
      type: 'CREATE_TRANSACTION',
      intent: 'PEMBELIAN',
      arah: 'PENGELUARAN',
      sheet: 'Transaksi',
      matchedTrigger: purchaseMatch[0]
        .slice(0, purchaseMatch[0].length - (purchaseMatch[2]?.length ?? 0))
        .trim(),
      cleanedText: (purchaseMatch[2] ?? '').trim(),
    };
  }

  // 4. Natural-language sales / transaction intents
  const salesOrTxRegex =
    /^(?:tolong\s+|bantu\s+|mohon\s+|coba\s+)?(?:buat(?:kan)?|tambah(?:kan)?|catat(?:kan)?|input(?:kan)?|bikin)\s+(?:draft\s+|draf\s+)?(penjualan|pemasukan|transaksi|jual)\b[\s:,-]*(.*)$/i;
  const salesOrTxMatch = salesOrTxRegex.exec(trimmed);
  if (salesOrTxMatch) {
    const noun = (salesOrTxMatch[1] ?? '').toLowerCase();
    const rest = (salesOrTxMatch[2] ?? '').trim();

    if (noun === 'transaksi') {
      const inferredExpense = EXPENSE_HINT_REGEX.test(rest);
      return {
        type: 'CREATE_TRANSACTION',
        intent: inferredExpense ? 'PEMBELIAN' : 'TRANSAKSI',
        arah: inferredExpense ? 'PENGELUARAN' : 'PEMASUKAN',
        sheet: 'Transaksi',
        matchedTrigger: salesOrTxMatch[0]
          .slice(0, salesOrTxMatch[0].length - rest.length)
          .trim(),
        cleanedText: rest,
      };
    }

    return {
      type: 'CREATE_TRANSACTION',
      intent: 'PENJUALAN',
      arah: 'PEMASUKAN',
      sheet: 'Transaksi',
      matchedTrigger: salesOrTxMatch[0]
        .slice(0, salesOrTxMatch[0].length - rest.length)
        .trim(),
      cleanedText: rest,
    };
  }

  return null;
}

/**
 * Convenience predicate for Intent Router integration.
 */
export function isWriteIntent(prompt: string): boolean {
  return detectWriteIntent(prompt) !== null;
}

/**
 * Parses an Indonesian currency/number token into a numeric rupiah value.
 * Supports: "Rp 240.000", "240rb", "240 ribu", "240k", "1,5jt", "1.5 juta", "320.000", "240000".
 */
export function parseIndonesianAmountToken(raw: string): number | null {
  const cleaned = raw.trim().toLowerCase().replace(/^rp\.?\s*/i, '');
  if (!cleaned) {
    return null;
  }

  // Multiplier forms: 1,5jt | 1.5 juta | 240rb | 240 ribu | 240k
  const multiplierMatch = /^(\d+(?:[.,]\d+)?)\s*(jt|juta|rb|ribu|k)$/i.exec(cleaned);
  if (multiplierMatch) {
    const numStr = multiplierMatch[1].replace(',', '.');
    const base = Number(numStr);
    if (!Number.isFinite(base) || base <= 0) {
      return null;
    }
    const unit = multiplierMatch[2].toLowerCase();
    const factor = unit === 'jt' || unit === 'juta' ? 1_000_000 : 1_000;
    return Math.round(base * factor);
  }

  // Thousands-separated Indonesian format: 240.000 or 1.250.000
  if (/^\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?$/.test(cleaned)) {
    const normalized = cleaned.replace(/\./g, '').replace(',', '.');
    const parsed = Number(normalized);
    return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null;
  }

  // Plain integer >= 1000 (or explicitly prefixed with Rp)
  if (/^\d+$/.test(cleaned)) {
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null;
  }

  return null;
}

/**
 * Extracts explicit total/nominal amount from free-form text (excluding @unitPrice tokens).
 */
export function extractExplicitAmount(text: string): number | null {
  // Redact email/phone PII first so phone numbers are never misparsed as numeric amounts
  const safeText = sanitizePii(text).sanitizedText;
  // Remove @unitPrice tokens so we don't confuse unit price with total nominal
  const withoutUnitPrices = safeText.replace(
    /@\s*(?:rp\.?\s*)?\d+(?:[.,]\d+)*(?:\s*(?:jt|juta|rb|ribu|k))?/gi,
    ' '
  );
  // Remove ISO / slash dates so years like 2026 aren't misread as nominal
  const withoutDates = withoutUnitPrices
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ')
    .replace(/\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/g, ' ');

  // 0. Explicit "qty x price" / "qty × price" expressions (e.g., "2 x 45rb", "3 × Rp 50.000")
  let qtyXTotal = 0;
  for (const match of withoutDates.matchAll(QTY_X_PRICE_GLOBAL_PATTERN)) {
    const qty = Number(match[1]);
    const unitPrice = parseIndonesianAmountToken(match[2]);
    if (
      Number.isInteger(qty) &&
      qty > 0 &&
      qty <= 100_000 &&
      unitPrice !== null &&
      unitPrice > 0
    ) {
      qtyXTotal += qty * unitPrice;
    }
  }
  if (qtyXTotal > 0) {
    return qtyXTotal;
  }

  // Remove weight/volume specs like 500g, 1000ml
  const withoutMeasures = withoutDates.replace(/\b\d+\s*(?:gr|gram|g|ml|kg|ltr|liter)\b/gi, ' ');

  // 1. Explicit "Rp ..."
  const rpMatch = /\brp\.?\s*(\d+(?:[.,]\d+)*(?:\s*(?:jt|juta|rb|ribu|k))?)/i.exec(withoutMeasures);
  if (rpMatch) {
    const parsed = parseIndonesianAmountToken(rpMatch[1]);
    if (parsed !== null) {
      return parsed;
    }
  }

  // 2. Multiplier suffix: 240rb, 1,5jt, 250k
  const multMatch = /\b(\d+(?:[.,]\d+)?\s*(?:jt|juta|rb|ribu|k))\b/i.exec(withoutMeasures);
  if (multMatch) {
    const parsed = parseIndonesianAmountToken(multMatch[1]);
    if (parsed !== null) {
      return parsed;
    }
  }

  // 3. Dot-formatted thousands: 240.000, 1.500.000
  const dotThousandsMatch = /\b(\d{1,3}(?:\.\d{3})+)\b/.exec(withoutMeasures);
  if (dotThousandsMatch) {
    const parsed = parseIndonesianAmountToken(dotThousandsMatch[1]);
    if (parsed !== null) {
      return parsed;
    }
  }

  // 4. Plain large number >= 1000 (excluding 4-digit years 1900-2099 unless preceded by nominal/total/sebesar)
  const labeledNumMatch = /\b(?:nominal|total|sebesar|harga|senilai)\s*[:=]?\s*(\d{3,})\b/i.exec(
    withoutMeasures
  );
  if (labeledNumMatch) {
    const parsed = parseIndonesianAmountToken(labeledNumMatch[1]);
    if (parsed !== null) {
      return parsed;
    }
  }

  const plainNumbers = withoutMeasures.match(/\b\d{4,}\b/g) ?? [];
  for (const candidate of plainNumbers) {
    const value = Number(candidate);
    if (value >= 1900 && value <= 2099) {
      continue;
    }
    if (Number.isFinite(value) && value >= 1000) {
      return Math.round(value);
    }
  }

  return null;
}

function extractDate(text: string, now: Date): Date {
  // ISO: YYYY-MM-DD
  const isoMatch = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(text);
  if (isoMatch) {
    const year = Number(isoMatch[1]);
    const month = Number(isoMatch[2]) - 1;
    const day = Number(isoMatch[3]);
    const parsed = new Date(year, month, day);
    if (
      !Number.isNaN(parsed.getTime()) &&
      parsed.getFullYear() === year &&
      parsed.getMonth() === month &&
      parsed.getDate() === day
    ) {
      return parsed;
    }
  }

  // DD/MM/YYYY or DD-MM-YYYY
  const dmyMatch = /\b(\d{1,2})[/-](\d{1,2})[/-](\d{4})\b/.exec(text);
  if (dmyMatch) {
    const day = Number(dmyMatch[1]);
    const month = Number(dmyMatch[2]) - 1;
    const year = Number(dmyMatch[3]);
    const parsed = new Date(year, month, day);
    if (
      !Number.isNaN(parsed.getTime()) &&
      parsed.getFullYear() === year &&
      parsed.getMonth() === month &&
      parsed.getDate() === day
    ) {
      return parsed;
    }
  }

  if (/\bkemarin\b/i.test(text)) {
    const yesterday = new Date(now.getTime());
    yesterday.setDate(yesterday.getDate() - 1);
    return yesterday;
  }

  return new Date(now.getTime());
}

function extractPaymentMethod(text: string): DraftPaymentMethod {
  if (/\bqris\b/i.test(text)) {
    return 'QRIS';
  }
  if (/\b(transfer|tf|bca|bri|mandiri|bni|bank)\b/i.test(text)) {
    return 'TRANSFER';
  }
  if (/\b(tunai|cash|kas)\b/i.test(text)) {
    return 'TUNAI';
  }
  return 'TUNAI';
}

function toFlutterPaymentMethod(method: DraftPaymentMethod): 'QRIS' | 'CASH' {
  return method === 'QRIS' ? 'QRIS' : 'CASH';
}

function extractShiftLabel(text: string, now: Date): string {
  const shiftMatch = /\bshift\s+(pagi|siang|sore|malam)\b/i.exec(text);
  if (shiftMatch) {
    const word = shiftMatch[1].toLowerCase();
    return `Shift ${word.charAt(0).toUpperCase()}${word.slice(1)}`;
  }

  const hour = now.getHours();
  if (hour >= 5 && hour < 11) return 'Shift Pagi';
  if (hour >= 11 && hour < 16) return 'Shift Siang';
  if (hour >= 16 && hour < 21) return 'Shift Sore';
  return 'Shift Malam';
}

function extractUnitBisnis(text: string): string | null {
  if (/\bfrozen\b/i.test(text)) {
    return 'FROZEN';
  }
  if (/\b(siap\s+saji|matang|kafe|resto)\b/i.test(text)) {
    return 'SIAP_SAJI';
  }
  return null;
}

function extractChannel(text: string): string | null {
  const match = /\b(whatsapp|\bwa\b|grabfood|gofood|shopeefood|tokopedia|shopee|instagram|\big\b|offline|kasir|storefront)\b/i.exec(
    text
  );
  if (!match) {
    return null;
  }
  const normalized = match[1].toLowerCase();
  switch (normalized) {
    case 'wa':
    case 'whatsapp':
      return 'WhatsApp';
    case 'grabfood':
      return 'GrabFood';
    case 'gofood':
      return 'GoFood';
    case 'shopeefood':
      return 'ShopeeFood';
    case 'tokopedia':
      return 'Tokopedia';
    case 'shopee':
      return 'Shopee';
    case 'ig':
    case 'instagram':
      return 'Instagram';
    case 'offline':
    case 'kasir':
      return 'Kasir';
    case 'storefront':
      return 'Storefront';
    default:
      return match[1];
  }
}

function extractPartyName(text: string, role: 'customer' | 'supplier'): string | null {
  const patterns =
    role === 'supplier'
      ? [
          /\b(?:dari|supplier|pemasok)\s+([A-Za-z][A-Za-z0-9.\s'-]{1,40}?)(?=\s+(?:via|dengan|pakai|rp\.?|tanggal|tgl|sebesar|nominal|total|qris|tunai|cash|transfer|\d)|[,;()]|$)/i,
        ]
      : [
          /\b(?:ke|untuk|pelanggan|customer)\s+([A-Za-z][A-Za-z0-9.\s'-]{1,40}?)(?=\s+(?:via|dengan|pakai|rp\.?|tanggal|tgl|sebesar|nominal|total|qris|tunai|cash|transfer|\d)|[,;()]|$)/i,
        ];

  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match && match[1]) {
      const cleaned = match[1].trim().replace(/[-–—]+$/, '').trim();
      if (cleaned.length >= 2) {
        return cleaned;
      }
    }
  }
  return null;
}

function matchProductFromCatalog(
  itemName: string,
  catalog: ProdukReadRecord[]
): ProdukReadRecord | null {
  const lower = itemName.toLowerCase().trim();
  if (!lower || catalog.length === 0) {
    return null;
  }

  // Exact match first, then substring containment
  for (const product of catalog) {
    if (product.namaBarang.toLowerCase().trim() === lower) {
      return product;
    }
  }
  for (const product of catalog) {
    const prodLower = product.namaBarang.toLowerCase().trim();
    if (lower.includes(prodLower) || prodLower.includes(lower)) {
      return product;
    }
  }
  return null;
}

function cleanItemName(raw: string): string {
  return sanitizePii(raw)
    .sanitizedText.replace(/\[REDACTED_(?:EMAIL|PHONE)\]/g, '')
    .replace(/\b(?:via|dengan|pakai)\s+(?:qris|tunai|cash|transfer|wa|whatsapp|grabfood|gofood|shopeefood)\b/gi, '')
    .replace(/\b(?:qris|tunai|cash|transfer)\b/gi, '')
    .replace(/\bshift\s+(?:pagi|siang|sore|malam)\b/gi, '')
    .replace(/\b(?:ke|untuk|dari|supplier|pemasok|customer|pelanggan)\s+[A-Za-z][A-Za-z0-9.\s'-]{1,40}$/i, '')
    .replace(/\b(?:rp\.?\s*)?\d+(?:[.,]\d+)*\s*(?:jt|juta|rb|ribu|k)\b/gi, '')
    .replace(/\brp\.?\s*\d{1,3}(?:\.\d{3})+\b/gi, '')
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[-:,\s]+|[-:,\s]+$/g, '');
}

/**
 * Extracts structured line items from a write-intent prompt for Flutter ChatDraftCard
 * and CREATE_ORDER payload alignment.
 */
function extractLineItems(
  cleanedText: string,
  paymentMethod: DraftPaymentMethod,
  catalog: ProdukReadRecord[],
  fallbackAmount: number | null,
  fallbackLabel: string
): ActionDraftLineItem[] {
  const segments = cleanedText
    .split(/\s*(?:,|;|\+|\bdan\b)\s*/i)
    .map((s) => s.trim())
    .filter(Boolean);

  const items: ActionDraftLineItem[] = [];
  const atPriceRegex =
    /(?:@\s*|(?:^|\s)[x×]\s*)(?:rp\.?\s*)?(\d+(?:[.,]\d+)*(?:\s*(?:jt|juta|rb|ribu|k))?)/i;
  const itemPattern = new RegExp(
    `^(\\d+)\\s*(?:(${KNOWN_UNITS_PATTERN})\\s+)?(.+)$`,
    'i'
  );

  for (const segment of segments) {
    const segmentPayment = extractPaymentMethod(segment);
    const effectivePayment =
      /\b(qris|tunai|cash|transfer)\b/i.test(segment) ? segmentPayment : paymentMethod;

    // Handle explicit "qty [unit] x price" / "qty [unit] × price" patterns first
    const qtyXMatch = QTY_X_PRICE_PATTERN.exec(segment);
    if (qtyXMatch) {
      const quantity = Number(qtyXMatch[1]);
      const unitPrice = parseIndonesianAmountToken(qtyXMatch[3]);
      if (
        Number.isInteger(quantity) &&
        quantity > 0 &&
        quantity <= 100_000 &&
        unitPrice !== null &&
        unitPrice > 0
      ) {
        const rawUnit = qtyXMatch[2]?.toLowerCase() ?? null;
        const remainder = segment.replace(qtyXMatch[0], ' ').replace(/\s+/g, ' ').trim();
        const rawName = cleanItemName(remainder);
        const matchedProduct = rawName ? matchProductFromCatalog(rawName, catalog) : null;
        const resolvedName = matchedProduct?.namaBarang ?? (rawName || fallbackLabel);

        items.push({
          produkId: matchedProduct?.id ?? null,
          nama: resolvedName,
          jumlah: quantity,
          satuan: rawUnit ?? matchedProduct?.satuan ?? 'pcs',
          hargaSatuan: unitPrice,
          subtotal: quantity * unitPrice,
          metode: toFlutterPaymentMethod(effectivePayment),
        });
        continue;
      }
    }

    const atPriceMatch = atPriceRegex.exec(segment);
    const unitPriceFromPrompt = atPriceMatch
      ? parseIndonesianAmountToken(atPriceMatch[1])
      : null;
    const segmentWithoutAtPrice = atPriceMatch
      ? segment.replace(atPriceMatch[0], ' ').replace(/\s+/g, ' ').trim()
      : segment;

    const match = itemPattern.exec(segmentWithoutAtPrice);
    if (!match) {
      continue;
    }

    const quantity = Number(match[1]);
    if (!Number.isInteger(quantity) || quantity <= 0 || quantity > 100_000) {
      continue;
    }

    const rawUnit = match[2]?.toLowerCase() ?? null;
    const rawName = cleanItemName(match[3] ?? '');
    if (!rawName || /^\d+$/.test(rawName)) {
      continue;
    }

    const matchedProduct = matchProductFromCatalog(rawName, catalog);
    const catalogPrice = matchedProduct ? toFiniteNumber(matchedProduct.hargaDefault) : 0;
    const unitPrice = unitPriceFromPrompt ?? (catalogPrice > 0 ? Math.round(catalogPrice) : 0);

    items.push({
      produkId: matchedProduct?.id ?? null,
      nama: matchedProduct?.namaBarang ?? rawName,
      jumlah: quantity,
      satuan: rawUnit ?? matchedProduct?.satuan ?? 'pcs',
      hargaSatuan: unitPrice,
      subtotal: quantity * unitPrice,
      metode: toFlutterPaymentMethod(effectivePayment),
    });
  }

  // If items were parsed without @price and there is a single item with an explicit total amount,
  // distribute the explicit amount to keep item subtotal consistent.
  if (items.length === 1 && items[0].hargaSatuan === 0 && fallbackAmount && fallbackAmount > 0) {
    items[0].hargaSatuan = Math.round(fallbackAmount / items[0].jumlah);
    items[0].subtotal = fallbackAmount;
  }

  // Fallback single summary item if no line items matched, so Flutter ChatDraftCard always has >= 1 row.
  if (items.length === 0) {
    const amount = fallbackAmount ?? 0;
    items.push({
      produkId: null,
      nama: fallbackLabel,
      jumlah: 1,
      satuan: 'transaksi',
      hargaSatuan: amount,
      subtotal: amount,
      metode: toFlutterPaymentMethod(paymentMethod),
    });
  }

  return items;
}

function matchJenisTransaksi(
  detected: DetectedWriteIntent,
  unitBisnis: string | null,
  text: string,
  jenisList: JenisTransaksiReadRecord[]
): JenisTransaksiReadRecord | null {
  const active = jenisList.filter((j) => j.aktif !== false);
  if (active.length === 0) {
    return null;
  }

  const sameDirection = active.filter((j) => j.arah === detected.arah);
  const candidates = sameDirection.length > 0 ? sameDirection : active;

  // 1. Direct name match in prompt
  const lower = text.toLowerCase();
  for (const jenis of candidates) {
    if (lower.includes(jenis.namaTransaksi.toLowerCase())) {
      return jenis;
    }
  }

  // 2. Built-in code preference
  if (detected.arah === 'PEMASUKAN') {
    if (unitBisnis === 'FROZEN' || /\bfrozen\b/i.test(text)) {
      const frozen = candidates.find((j) => j.kode === KODE_JENIS_BAWAAN.PENDAPATAN_FROZEN);
      if (frozen) return frozen;
    }
    if (detected.type === 'CREATE_ORDER' || unitBisnis === 'SIAP_SAJI') {
      const siapSaji = candidates.find((j) => j.kode === KODE_JENIS_BAWAAN.PENDAPATAN_SIAP_SAJI);
      if (siapSaji) return siapSaji;
    }
    const defaultIncome =
      candidates.find((j) => j.kode === KODE_JENIS_BAWAAN.PENDAPATAN_SIAP_SAJI) ??
      candidates.find((j) => j.kode === KODE_JENIS_BAWAAN.PENDAPATAN_FROZEN);
    if (defaultIncome) return defaultIncome;
  } else {
    if (/\b(hutang|cicilan)\b/i.test(text)) {
      const debt = candidates.find((j) => j.kode === KODE_JENIS_BAWAAN.PEMBAYARAN_CICILAN_HUTANG);
      if (debt) return debt;
    }
    const purchaseType = candidates.find((j) =>
      /\b(beli|pembelian|bahan|operasional|pengeluaran)\b/i.test(j.namaTransaksi)
    );
    if (purchaseType) return purchaseType;
  }

  return candidates[0] ?? null;
}

function buildDraftTitle(detected: DetectedWriteIntent): string {
  switch (detected.intent) {
    case 'PENJUALAN':
      return 'Draft Penjualan Produk';
    case 'PEMBELIAN':
      return 'Draft Pembelian / Pengeluaran';
    case 'PESANAN':
      return 'Draft Pesanan Baru';
    case 'TRANSAKSI':
    default:
      return detected.arah === 'PENGELUARAN'
        ? 'Draft Transaksi Pengeluaran'
        : 'Draft Transaksi Pemasukan';
  }
}

function buildFallbackJenisName(detected: DetectedWriteIntent): string {
  switch (detected.intent) {
    case 'PENJUALAN':
      return 'Penjualan Produk';
    case 'PEMBELIAN':
      return 'Pembelian Bahan Baku';
    case 'PESANAN':
      return 'Pendapatan Siap Saji';
    case 'TRANSAKSI':
    default:
      return detected.arah === 'PENGELUARAN' ? 'Pengeluaran Operasional' : 'Pemasukan Operasional';
  }
}

export function createActionDraftService(deps: ActionDraftServiceDependencies = {}) {
  const prismaClient: ActionDraftPrismaClient = deps.prisma ?? (defaultPrisma as unknown as ActionDraftPrismaClient);

  async function loadReadOnlyCatalog(): Promise<{
    jenisList: JenisTransaksiReadRecord[];
    produkList: ProdukReadRecord[];
  }> {
    const [jenisList, produkList] = await Promise.all([
      prismaClient.jenisTransaksi?.findMany
        ? prismaClient.jenisTransaksi
            .findMany({
              where: { aktif: true },
              select: {
                id: true,
                kode: true,
                namaTransaksi: true,
                arah: true,
                jenisAkun: true,
                unitBisnis: true,
                isBawaan: true,
                aktif: true,
              },
            })
            .catch(() => [] as JenisTransaksiReadRecord[])
        : Promise.resolve([] as JenisTransaksiReadRecord[]),
      prismaClient.produk?.findMany
        ? prismaClient.produk
            .findMany({
              where: { aktif: true },
              select: {
                id: true,
                kode: true,
                namaBarang: true,
                satuan: true,
                hargaDefault: true,
                aktif: true,
              },
            })
            .catch(() => [] as ProdukReadRecord[])
        : Promise.resolve([] as ProdukReadRecord[]),
    ]);

    return { jenisList, produkList };
  }

  /**
   * Parses a write-intent prompt into a structured `actions[]` Draft Card payload.
   * Strictly performs ZERO database mutations (no create/update/delete).
   */
  async function buildActionDraft(params: BuildActionDraftParams): Promise<ActionDraftResult> {
    if (!params || typeof params.prompt !== 'string' || !params.prompt.trim()) {
      throw new ActionDraftValidationError('Prompt aksi wajib diisi.');
    }

    const prompt = params.prompt.trim();
    const detected = detectWriteIntent(prompt);
    if (!detected) {
      throw new ActionDraftUnsupportedIntentError(
        'Prompt tidak dikenali sebagai intent pencatatan transaksi atau pesanan.'
      );
    }

    const now = params.now ?? new Date();
    const { jenisList, produkList } = await loadReadOnlyCatalog();

    // Redact accidental customer email/phone PII before parsing amounts/items or building output fields
    const sanitizedText = sanitizePii(detected.cleanedText).sanitizedText;

    const targetDate = extractDate(sanitizedText, now);
    const tanggalIso = formatIsoDate(targetDate);
    const dateLabel = formatIndonesianDateLabel(targetDate);
    const shiftLabel = extractShiftLabel(sanitizedText, now);
    const paymentMethod = extractPaymentMethod(sanitizedText);
    const unitBisnis = extractUnitBisnis(sanitizedText);
    const channel = extractChannel(sanitizedText);
    const rawPartyName = extractPartyName(
      sanitizedText,
      detected.arah === 'PENGELUARAN' ? 'supplier' : 'customer'
    );
    const partyName = rawPartyName ? sanitizePii(rawPartyName).sanitizedText : null;

    const explicitAmount = extractExplicitAmount(sanitizedText);
    const fallbackItemLabel =
      sanitizedText.length > 0
        ? sanitizedText.slice(0, 80)
        : buildFallbackJenisName(detected);

    const items = extractLineItems(
      sanitizedText,
      paymentMethod,
      produkList,
      explicitAmount,
      fallbackItemLabel
    );

    const itemsSum = items.reduce((sum, item) => sum + item.subtotal, 0);
    const totalAmount = itemsSum > 0 ? itemsSum : (explicitAmount ?? 0);

    const matchedJenis = matchJenisTransaksi(
      detected,
      unitBisnis,
      sanitizedText,
      jenisList
    );

    const namaTransaksi = matchedJenis?.namaTransaksi ?? buildFallbackJenisName(detected);
    const resolvedUnitBisnis = unitBisnis ?? matchedJenis?.unitBisnis ?? null;
    const detailText =
      sanitizedText.length > 0
        ? sanitizedText.slice(0, 255)
        : `${namaTransaksi} (${dateLabel})`;

    const missingFields: string[] = [];
    if (totalAmount <= 0) {
      missingFields.push('nominal');
    }
    if (!matchedJenis) {
      missingFields.push('jenis_transaksi_id');
    }
    const isReadyToConfirm = missingFields.length === 0;

    const formattedTotal = formatRupiah(totalAmount);
    const title = buildDraftTitle(detected);

    const summaryRows: ActionDraftSummaryRow[] = [
      { label: 'Tanggal', value: dateLabel },
      { label: 'Jenis Transaksi', value: namaTransaksi },
      { label: 'Metode Kas', value: paymentMethod },
      { label: 'Nominal', value: formattedTotal },
      { label: 'Deskripsi', value: detailText },
    ];

    if (partyName) {
      summaryRows.push({
        label: detected.arah === 'PENGELUARAN' ? 'Supplier' : 'Customer',
        value: partyName + (channel ? ` — ${channel}` : ''),
      });
    } else if (channel) {
      summaryRows.push({ label: 'Sumber', value: channel });
    }

    if (detected.type === 'CREATE_ORDER') {
      items.forEach((item, idx) => {
        summaryRows.push({
          label: `Item ${idx + 1}`,
          value: `${item.nama} × ${item.jumlah} ${item.satuan}`,
        });
      });
    }

    const customDataPayload: Record<string, unknown> = {
      draftIntent: detected.intent,
      partyName,
      channel,
      shift: shiftLabel,
      items,
    };

    const basePayload: NormalizedTransactionPayload = {
      tanggal: tanggalIso,
      jenis_transaksi_id: matchedJenis?.id ?? null,
      jenisTransaksiId: matchedJenis?.id ?? null,
      nama_transaksi: namaTransaksi,
      arah: detected.arah,
      unit_bisnis: resolvedUnitBisnis,
      detail: detailText,
      jenisKas: paymentMethod,
      jenis_kas: paymentMethod,
      nominal: totalAmount,
      debit: detected.arah === 'PEMASUKAN' ? paymentMethod : matchedJenis?.jenisAkun ?? null,
      kredit: detected.arah === 'PEMASUKAN' ? matchedJenis?.jenisAkun ?? null : paymentMethod,
      sumber_input: 'AI',
      sumberInput: 'AI',
      customData: customDataPayload,
      custom_data: customDataPayload,
    };

    const payload: NormalizedTransactionPayload | NormalizedOrderPayload =
      detected.type === 'CREATE_ORDER'
        ? {
            ...basePayload,
            customerName: partyName,
            channel,
            items,
            total: totalAmount,
          }
        : basePayload;

    const totalLabel =
      detected.type === 'CREATE_ORDER'
        ? 'TOTAL PESANAN'
        : detected.arah === 'PENGELUARAN'
          ? 'TOTAL PENGELUARAN'
          : 'TOTAL PEMASUKAN KASIR';

    const breakdownTitle =
      detected.type === 'CREATE_ORDER'
        ? 'Rincian Item Pesanan'
        : detected.arah === 'PENGELUARAN'
          ? 'Rincian Pembelian / Pengeluaran'
          : 'Rincian Menu Terjual';

    const draft: ActionDraft = {
      id: `draft-${detected.type.toLowerCase()}-${now.getTime()}`,
      type: detected.type,
      intent: detected.intent,
      requiresConfirmation: true,
      endpoint: '/api/v1/transactions',
      method: 'POST',
      title,
      sheet: detected.sheet,
      summaryRows,
      total: formattedTotal,
      totalAmount,
      sourceBadge: 'AI',
      badge: 'Belum disimpan',
      dateLabel,
      shiftLabel,
      totalLabel,
      breakdownTitle,
      items,
      confirmLabel: 'Simpan & Posting',
      correctLabel: 'Koreksi',
      note: 'Draft belum masuk ke pembukuan. Periksa rincian lalu klik konfirmasi untuk menyimpan.',
      payload,
      isReadyToConfirm,
      missingFields,
    };

    const assistantMessage =
      missingFields.length > 0
        ? `Saya sudah menyiapkan ${title.toLowerCase()}, namun mohon lengkapi field berikut sebelum menyimpan: ${missingFields.join(', ')}. Data belum disimpan ke database sebelum Anda menekan tombol konfirmasi.`
        : `Saya sudah menyiapkan ${title.toLowerCase()} senilai ${formattedTotal}. Mohon periksa rincian draft di bawah ini — data belum disimpan ke database sampai Anda menekan tombol konfirmasi.`;

    return {
      routePath: 'ACTION_DRAFT',
      intent: detected.intent,
      assistantMessage,
      actions: [draft],
    };
  }

  return {
    detectWriteIntent,
    isWriteIntent,
    buildActionDraft,
  };
}

export const defaultActionDraftService = createActionDraftService();

export async function buildActionDraft(
  params: BuildActionDraftParams
): Promise<ActionDraftResult> {
  return defaultActionDraftService.buildActionDraft(params);
}

export default defaultActionDraftService;
