import type { ArahTransaksi, StatusPesananPelanggan, SumberInput } from '@prisma/client';
import { detectWriteIntent, type DetectedWriteIntent } from './actionDraftService';
import type { SalesSummaryPeriode, SqlToolName } from './sqlToolsService';

export type IntentRoutePath = 'ACTION_DRAFT' | 'SQL_TOOL' | 'VECTOR_RAG';

export interface PlannedSqlToolCall {
  toolName: SqlToolName;
  params: Record<string, unknown>;
}

export interface IntentClassification {
  routePath: IntentRoutePath;
  reason: string;
  matchedRule: string;
  writeIntent: DetectedWriteIntent | null;
  sqlPlan: PlannedSqlToolCall[];
  includeVectorContext: boolean;
}

const KNOWLEDGE_POLICY_HINT_REGEX =
  /\b(sop|prosedur|kebijakan|aturan|panduan|faq|manual|tata\s+cara|langkah|syarat|ketentuan|jam\s+operasional|jam\s+buka|jam\s+tutup|retur|refund|komplain|deskripsi|komposisi|bahan|resep|penyimpanan|pengiriman|konten\s+cms|cms|profil\s+toko|tentang\s+soju)\b/i;

const HOW_TO_KNOWLEDGE_REGEX =
  /^\s*(bagaimana\s+(?:cara|prosedur|sop|aturan)|apa\s+(?:itu|sop|aturan|kebijakan|syarat)|jelaskan\s+(?:sop|prosedur|cara|aturan|kebijakan|produk)|sebutkan\s+(?:sop|aturan|kebijakan|langkah))\b/i;

const NUMERIC_QUERY_TRIGGER_REGEX =
  /\b(berapa|total|jumlah|rekap|ringkasan|laporan|omzet|omset|pendapatan|pemasukan|pengeluaran|laba|profit|rugi|saldo|arus\s+kas|cashflow|rata[\s-]?rata|statistik|stat|daftar|list|riwayat|terakhir|terbaru|recent|summary|stats|revenue|sales)\b/i;

const SALES_SUMMARY_REGEX =
  /\b(omzet|omset|pendapatan|pemasukan|pengeluaran|laba(?:\s+bersih)?|profit|rugi|saldo\s+kas|arus\s+kas|cashflow|penjualan|keuangan|transaksi|revenue|sales(?:\s+summary)?)\b/i;

const RECENT_TRANSACTIONS_REGEX =
  /\b(transaksi\s+(?:terakhir|terbaru|terkini|hari\s+ini)|riwayat\s+transaksi|daftar\s+transaksi|list\s+transaksi|mutasi(?:\s+kas|\s+transaksi)?|recent\s+transactions?|\d+\s+transaksi\s+(?:terakhir|terbaru))\b/i;

const CUSTOMER_ORDERS_REGEX =
  /\b(pesanan(?:\s+pelanggan|\s+masuk|\s+aktif|\s+terbaru|\s+menunggu|\s+diproses|\s+selesai|\s+dibatalkan)?|status\s+pesanan|rekap\s+pesanan|daftar\s+pesanan|jumlah\s+pesanan|total\s+pesanan|berapa\s+pesanan|order(?:\s+pelanggan|\s+masuk|\s+terbaru)?|customer\s+orders?|menunggu\s+konfirmasi)\b/i;

const PRODUCT_STATS_REGEX =
  /\b((?:jumlah|total|berapa|statistik|stat|daftar|list|rekap)\s+(?:produk|menu|barang|katalog)|produk\s+(?:aktif|nonaktif|terdaftar)|katalog\s+produk|harga\s+(?:rata[\s-]?rata|minimum|terendah|termurah|maksimum|tertinggi|termahal)|product\s+(?:stats?|catalog))\b/i;

function extractSalesPeriode(query: string): SalesSummaryPeriode {
  if (/\b(hari\s+ini|today|harian)\b/i.test(query)) {
    return 'today';
  }
  if (/\b(7\s*hari|seminggu|minggu\s+ini|pekan\s+ini|last\s*7\s*days?)\b/i.test(query)) {
    return '7d';
  }
  if (/\b(90\s*hari|3\s*bulan|kuartal|triwulan|last\s*90\s*days?)\b/i.test(query)) {
    return '90d';
  }
  if (/\b(30\s*hari|sebulan|bulan\s+ini|bulanan|last\s*30\s*days?)\b/i.test(query)) {
    return '30d';
  }
  if (/\b(semua|keseluruhan|seluruh|all\s*time|sepanjang\s+waktu)\b/i.test(query)) {
    return 'all';
  }
  return '30d';
}

function extractRecentTransactionsLimit(query: string): number {
  const match = /\b(\d{1,2})\s+(?:transaksi|mutasi|entri|data)\b/i.exec(query)
    ?? /\b(?:terakhir|terbaru|limit)\s+(\d{1,2})\b/i.exec(query);
  if (!match) {
    return 10;
  }
  const parsed = Number.parseInt(match[1], 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 10;
  }
  return Math.min(parsed, 50);
}

function extractTransactionArah(query: string): ArahTransaksi | undefined {
  const hasIncome = /\b(pemasukan|penjualan|omzet|omset|masuk)\b/i.test(query);
  const hasExpense = /\b(pengeluaran|pembelian|belanja|keluar|biaya)\b/i.test(query);
  if (hasIncome && !hasExpense) {
    return 'PEMASUKAN';
  }
  if (hasExpense && !hasIncome) {
    return 'PENGELUARAN';
  }
  return undefined;
}

function extractSumberInput(query: string): SumberInput | undefined {
  if (/\b(sumber\s+ai|dari\s+ai|input\s+ai)\b/i.test(query)) {
    return 'AI';
  }
  if (/\b(sumber\s+manual|input\s+manual)\b/i.test(query)) {
    return 'MANUAL';
  }
  return undefined;
}

function extractOrderStatusFilter(query: string): StatusPesananPelanggan | undefined {
  if (/\b(menunggu\s+konfirmasi|pending|belum\s+dikonfirmasi)\b/i.test(query)) {
    return 'MENUNGGU_KONFIRMASI';
  }
  if (/\b(diproses|sedang\s+diproses|proses)\b/i.test(query)) {
    return 'DIPROSES';
  }
  if (/\b(selesai|completed|rampung)\b/i.test(query)) {
    return 'SELESAI';
  }
  if (/\b(dibatalkan|batal|cancelled|canceled)\b/i.test(query)) {
    return 'DIBATALKAN';
  }
  return undefined;
}

function buildSqlPlan(query: string): { sqlPlan: PlannedSqlToolCall[]; matchedRules: string[] } {
  const sqlPlan: PlannedSqlToolCall[] = [];
  const matchedRules: string[] = [];

  const isRecentTx = RECENT_TRANSACTIONS_REGEX.test(query);
  const isOrders = CUSTOMER_ORDERS_REGEX.test(query);
  const isProductStats = PRODUCT_STATS_REGEX.test(query);
  const isSales = SALES_SUMMARY_REGEX.test(query);
  const hasNumericTrigger = NUMERIC_QUERY_TRIGGER_REGEX.test(query);

  if (isRecentTx) {
    const params: Record<string, unknown> = {
      limit: extractRecentTransactionsLimit(query),
    };
    const arah = extractTransactionArah(query);
    if (arah) {
      params.arah = arah;
    }
    const sumberInput = extractSumberInput(query);
    if (sumberInput) {
      params.sumberInput = sumberInput;
    }
    sqlPlan.push({ toolName: 'getRecentTransactions', params });
    matchedRules.push('sql:recent_transactions');
  }

  if (isOrders && hasNumericTrigger) {
    const statusFilter = extractOrderStatusFilter(query);
    sqlPlan.push({
      toolName: 'getCustomerOrdersSummary',
      params: statusFilter ? { statusFilter } : {},
    });
    matchedRules.push('sql:customer_orders_summary');
  }

  if (isProductStats) {
    sqlPlan.push({
      toolName: 'getProductStats',
      params: {},
    });
    matchedRules.push('sql:product_stats');
  }

  // Sales/finance summary: route when numeric/aggregation signal or explicit finance term (omzet/laba/pendapatan/cashflow) is present
  const explicitFinanceMetric =
    /\b(omzet|omset|laba(?:\s+bersih)?|profit|rugi|saldo\s+kas|arus\s+kas|cashflow|pendapatan|pemasukan|pengeluaran)\b/i.test(
      query
    );

  if (
    isSales &&
    (explicitFinanceMetric || (hasNumericTrigger && !isRecentTx))
  ) {
    sqlPlan.push({
      toolName: 'getSalesSummary',
      params: { periode: extractSalesPeriode(query) },
    });
    matchedRules.push('sql:sales_summary');
  }

  return { sqlPlan, matchedRules };
}

/**
 * Deterministic rule-first intent router (AD-07).
 *
 * Guarantees without LLM bypass:
 * 1. Write intents (/add, catat/buat/tambah transaksi/penjualan/pembelian/pesanan) -> ACTION_DRAFT
 * 2. Numeric/operational intents (omzet, total, penjualan, pesanan, laba, daftar transaksi, stats produk) -> SQL_TOOL
 * 3. Knowledge / SOP / FAQ / product info / CMS policy intents -> VECTOR_RAG
 */
export function classifyIntent(query: string): IntentClassification {
  const normalized = typeof query === 'string' ? query.trim() : '';

  if (!normalized) {
    return {
      routePath: 'VECTOR_RAG',
      reason: 'Query kosong diarahkan ke jalur pengetahuan default untuk validasi lebih lanjut.',
      matchedRule: 'default:empty',
      writeIntent: null,
      sqlPlan: [],
      includeVectorContext: false,
    };
  }

  // Priority 1: Deterministic write intent -> Path C (Action Draft, zero auto-commit)
  const writeIntent = detectWriteIntent(normalized);
  if (writeIntent) {
    return {
      routePath: 'ACTION_DRAFT',
      reason: `Terdeteksi intent pencatatan (${writeIntent.intent}) melalui pemicu "${writeIntent.matchedTrigger}".`,
      matchedRule: `write:${writeIntent.intent.toLowerCase()}`,
      writeIntent,
      sqlPlan: [],
      includeVectorContext: false,
    };
  }

  const hasKnowledgePolicyHint =
    KNOWLEDGE_POLICY_HINT_REGEX.test(normalized) || HOW_TO_KNOWLEDGE_REGEX.test(normalized);
  const hasNumericTrigger = NUMERIC_QUERY_TRIGGER_REGEX.test(normalized);

  // If the query is strictly a SOP/policy/how-to question with no numeric/operational aggregation trigger,
  // route directly to VECTOR_RAG so policy questions mentioning "transaksi" or "pesanan" stay on Path B.
  if (hasKnowledgePolicyHint && !hasNumericTrigger) {
    return {
      routePath: 'VECTOR_RAG',
      reason: 'Pertanyaan berfokus pada SOP, kebijakan, FAQ, atau pengetahuan produk/CMS.',
      matchedRule: 'knowledge:policy_or_sop',
      writeIntent: null,
      sqlPlan: [],
      includeVectorContext: false,
    };
  }

  // Priority 2: Deterministic numeric/operational intent -> Path A (SQL/Prisma Tools)
  const { sqlPlan, matchedRules } = buildSqlPlan(normalized);
  if (sqlPlan.length > 0) {
    return {
      routePath: 'SQL_TOOL',
      reason: `Terdeteksi pertanyaan operasional/numerik yang membutuhkan data SQL read-only (${sqlPlan
        .map((step) => step.toolName)
        .join(', ')}).`,
      matchedRule: matchedRules.join('+'),
      writeIntent: null,
      sqlPlan,
      includeVectorContext: hasKnowledgePolicyHint,
    };
  }

  // Priority 3: Default knowledge retrieval -> Path B (Vector RAG)
  return {
    routePath: 'VECTOR_RAG',
    reason: 'Pertanyaan pengetahuan umum/dokumen diarahkan ke pencarian vektor berbasis basis pengetahuan SOJU.',
    matchedRule: hasKnowledgePolicyHint ? 'knowledge:policy_or_sop' : 'knowledge:default_vector_rag',
    writeIntent: null,
    sqlPlan: [],
    includeVectorContext: false,
  };
}

export const routeIntent = classifyIntent;

export default {
  classifyIntent,
  routeIntent,
};
