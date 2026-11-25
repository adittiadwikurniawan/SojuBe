import {
  AiDocumentSourceType,
  AiRoleScope,
  ArahTransaksi,
  Prisma,
} from '@prisma/client';
import { randomUUID } from 'crypto';
import prisma from '../utils/database';
import { errorResponse } from '../utils/response';

type ChatRole = 'USER' | 'ASSISTANT';

interface HistoryMessage {
  role: ChatRole;
  content: string;
}

interface OperationalProduct {
  id: number;
  kode: string;
  namaBarang: string;
  varian: string | null;
  satuan: string;
  hargaDefault: number;
  deskripsi: string | null;
}

interface OperationalTransactionType {
  id: number;
  namaTransaksi: string;
  arah: ArahTransaksi;
  isBawaan: boolean;
  unitBisnis: string | null;
}

interface OperationalContext {
  products: OperationalProduct[];
  transactionTypes: OperationalTransactionType[];
  salesLast7Days: number;
  expensesLast7Days: number;
  recentTransactions: Array<Record<string, unknown>>;
  recentOrders: Array<Record<string, unknown>>;
}

interface DocumentCitation {
  id: string;
  documentId: number;
  chunkId: number;
  chunkIndex: number;
  title: string;
  sourceType: AiDocumentSourceType;
  sourceRef: string | null;
  roleScope: AiRoleScope;
  snippet: string;
  score: number;
}

interface SqlCitation {
  id: string;
  sourceType: 'SQL_TOOL';
  toolName: string;
  label: string;
  querySummary: string;
  executedAt: string;
}

export type AiCitation = DocumentCitation | SqlCitation;

export interface AiActionDraft {
  id: string;
  type: 'CREATE_TRANSACTION';
  intent: 'PENJUALAN' | 'PEMBELIAN' | 'TRANSAKSI';
  requiresConfirmation: true;
  endpoint: '/api/v1/transactions';
  method: 'POST';
  title: string;
  sheet: 'Transaksi';
  summaryRows: Array<{ label: string; value: string }>;
  total: string;
  totalAmount: number;
  sourceBadge: 'AI';
  badge: string;
  dateLabel: string;
  shiftLabel: string;
  totalLabel: string;
  breakdownTitle: string;
  items: Array<{
    produkId: number | null;
    nama: string;
    jumlah: number;
    satuan: string;
    hargaSatuan: number;
    subtotal: number;
    metode: 'QRIS' | 'CASH';
  }>;
  confirmLabel: string;
  correctLabel: string;
  note: string;
  payload: Record<string, unknown>;
  isReadyToConfirm: boolean;
  missingFields: string[];
}

export interface AiReply {
  reply: string;
  routePath: 'SQL_TOOL' | 'VECTOR_RAG' | 'ACTION_DRAFT' | 'REFUSAL';
  citations: AiCitation[];
  actions: AiActionDraft[];
}

interface GeminiContent {
  role: 'user' | 'model';
  parts: Array<{ text: string }>;
}

interface GeminiRequest {
  contents: GeminiContent[];
  generationConfig: {
    temperature: number;
    maxOutputTokens: number;
    responseMimeType: string;
  };
}

interface GeminiModel {
  generateContent(
    request: GeminiRequest,
  ): Promise<{ response: { text(): string } }>;
}

interface GeminiSdk {
  GoogleGenerativeAI: new (apiKey: string) => {
    getGenerativeModel(options: {
      model: string;
      systemInstruction: string;
    }): GeminiModel;
  };
}

interface AddDraftItem {
  name?: unknown;
  quantity?: unknown;
  unit?: unknown;
  unitPrice?: unknown;
  productId?: unknown;
}

interface AddDraftResponse {
  reply?: unknown;
  direction?: unknown;
  transactionTypeId?: unknown;
  transactionTypeName?: unknown;
  paymentMethod?: unknown;
  date?: unknown;
  note?: unknown;
  items?: unknown;
}

const sevenDaysAgo = (): Date =>
  new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
const thirtyDaysAgo = (): Date =>
  new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

function numberValue(value: Prisma.Decimal | number | null): number {
  return value === null ? 0 : Number(value);
}

export async function loadOperationalContext(): Promise<OperationalContext> {
  const [products, transactionTypes, sales, expenses, transactions, orders] =
    await Promise.all([
      prisma.produk.findMany({
        where: { aktif: true },
        orderBy: { namaBarang: 'asc' },
        take: 100,
        select: {
          id: true,
          kode: true,
          namaBarang: true,
          varian: true,
          satuan: true,
          hargaDefault: true,
          deskripsi: true,
        },
      }),
      prisma.jenisTransaksi.findMany({
        where: { aktif: true },
        orderBy: [{ isBawaan: 'desc' }, { namaTransaksi: 'asc' }],
        select: {
          id: true,
          namaTransaksi: true,
          arah: true,
          isBawaan: true,
          unitBisnis: true,
        },
      }),
      prisma.transaksi.aggregate({
        where: {
          tanggal: { gte: sevenDaysAgo() },
          jenisTransaksi: { arah: 'PEMASUKAN' },
        },
        _sum: { nominal: true },
      }),
      prisma.transaksi.aggregate({
        where: {
          tanggal: { gte: sevenDaysAgo() },
          jenisTransaksi: { arah: 'PENGELUARAN' },
        },
        _sum: { nominal: true },
      }),
      prisma.transaksi.findMany({
        where: { tanggal: { gte: thirtyDaysAgo() } },
        orderBy: [{ tanggal: 'desc' }, { dibuatPada: 'desc' }],
        take: 20,
        select: {
          kode: true,
          tanggal: true,
          namaTransaksi: true,
          detail: true,
          nominal: true,
          jenisTransaksi: { select: { arah: true } },
        },
      }),
      prisma.pesananPelanggan.findMany({
        orderBy: { dibuatPada: 'desc' },
        take: 10,
        select: {
          kode: true,
          status: true,
          total: true,
          dibuatPada: true,
          item: {
            select: { namaProduk: true, varian: true, jumlah: true, subtotal: true },
          },
        },
      }),
    ]);

  return {
    products: products.map((product) => ({
      ...product,
      hargaDefault: numberValue(product.hargaDefault),
    })),
    transactionTypes,
    salesLast7Days: numberValue(sales._sum.nominal),
    expensesLast7Days: numberValue(expenses._sum.nominal),
    recentTransactions: transactions.map((transaction) => ({
      kode: transaction.kode,
      tanggal: transaction.tanggal.toISOString().slice(0, 10),
      jenis: transaction.namaTransaksi,
      arah: transaction.jenisTransaksi.arah,
      detail: transaction.detail,
      nominal: numberValue(transaction.nominal),
    })),
    recentOrders: orders.map((order) => ({
      kode: order.kode,
      status: order.status,
      total: numberValue(order.total),
      dibuatPada: order.dibuatPada.toISOString(),
      item: order.item.map((item) => ({
        namaProduk: item.namaProduk,
        varian: item.varian,
        jumlah: item.jumlah,
        subtotal: numberValue(item.subtotal),
      })),
    })),
  };
}

function queryTokens(text: string): Set<string> {
  return new Set(
    text
      .toLocaleLowerCase('id-ID')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .match(/[a-z0-9]{3,}/g) ?? [],
  );
}

export async function reindexKnowledge(): Promise<{
  documentsProcessed: number;
  chunksCreated: number;
  piiRedactedChunks: number;
  sources: { documents: number; products: number; cms: number };
}> {
  const [documents, products, cms] = await Promise.all([
    prisma.aiKnowledgeDocument.findMany({
      where: { aktif: true },
      select: {
        id: true,
        title: true,
        sourceType: true,
        sourceRef: true,
        roleScope: true,
        content: true,
      },
    }),
    prisma.produk.findMany({
      where: { aktif: true },
      orderBy: { id: 'asc' },
      take: 500,
      select: {
        id: true,
        kode: true,
        namaBarang: true,
        varian: true,
        satuan: true,
        hargaDefault: true,
        deskripsi: true,
      },
    }),
    prisma.cmsContent.findMany({
      where: { aktif: true },
      orderBy: { key: 'asc' },
      take: 500,
      select: { key: true, judul: true, subJudul: true, konten: true },
    }),
  ]);

  const chunks: Prisma.AiKnowledgeChunkCreateManyInput[] = [];
  for (const document of documents) {
    for (const [chunkIndex, content] of splitIntoChunks(document.content).entries()) {
      chunks.push({
        documentId: document.id,
        sourceType: document.sourceType,
        sourceRef: document.sourceRef,
        title: document.title,
        roleScope: document.roleScope,
        chunkIndex,
        content,
      });
    }
  }
  for (const product of products) {
    const text = [
      `Produk ${product.namaBarang} (${product.kode})`,
      `Harga default: Rp ${numberValue(product.hargaDefault)}`,
      `Varian: ${product.varian ?? '-'}`,
      `Satuan: ${product.satuan}`,
      product.deskripsi ?? '',
    ].join('\n');
    for (const [chunkIndex, content] of splitIntoChunks(text).entries()) {
      chunks.push({
        sourceType: AiDocumentSourceType.PRODUK,
        sourceRef: String(product.id),
        title: product.namaBarang,
        roleScope: AiRoleScope.ALL_ADMIN,
        chunkIndex,
        content,
      });
    }
  }
  for (const item of cms) {
    const text = [item.judul, item.subJudul ?? '', item.konten ?? ''].join('\n');
    for (const [chunkIndex, content] of splitIntoChunks(text).entries()) {
      chunks.push({
        sourceType: AiDocumentSourceType.CMS,
        sourceRef: item.key,
        title: item.judul,
        roleScope: AiRoleScope.ALL_ADMIN,
        chunkIndex,
        content,
      });
    }
  }

  await prisma.$transaction(async (tx) => {
    await tx.aiKnowledgeChunk.deleteMany();
    if (chunks.length > 0) {
      await tx.aiKnowledgeChunk.createMany({ data: chunks });
    }
  });

  return {
    documentsProcessed: documents.length + products.length + cms.length,
    chunksCreated: chunks.length,
    piiRedactedChunks: 0,
    sources: {
      documents: documents.length,
      products: products.length,
      cms: cms.length,
    },
  };
}

export async function createKnowledgeDocument(input: {
  title: string;
  content: string;
  sourceType: 'SOP' | 'FAQ' | 'MANUAL';
  roleScope: 'ALL_ADMIN' | 'SUPER_ADMIN';
  sourceRef: string | null;
  createdBy: number;
  rejectOnPii: boolean;
}) {
  const hasPii = containsPii(input.content);
  if (hasPii && input.rejectOnPii) {
    throw errorResponse(
      'Dokumen memuat email, nomor telepon, atau NIK. Hapus data pribadi atau nonaktifkan opsi penolakan agar data disamarkan.',
      400,
    );
  }

  const content = redactPii(input.content);
  const document = await prisma.aiKnowledgeDocument.create({
    data: {
      title: input.title,
      content,
      sourceType: input.sourceType,
      roleScope: input.roleScope,
      sourceRef: input.sourceRef,
      dibuatOleh: input.createdBy,
    },
  });
  const chunks = splitIntoChunks(content).map((chunk, chunkIndex) => ({
    documentId: document.id,
    sourceType: document.sourceType,
    sourceRef: document.sourceRef,
    title: document.title,
    roleScope: document.roleScope,
    chunkIndex,
    content: chunk,
  }));
  if (chunks.length > 0) {
    await prisma.aiKnowledgeChunk.createMany({ data: chunks });
  }

  return {
    document,
    indexing: {
      documentId: document.id,
      chunksCreated: chunks.length,
      piiRedactedChunks: hasPii ? chunks.length : 0,
      roleScope: document.roleScope,
    },
  };
}

function containsPii(text: string): boolean {
  return (
    /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/i.test(text) ||
    /\b\d{16}\b/.test(text) ||
    /(?<!\d)(?:\+?62|0)[\s-]?(?:\d[\s-]?){8,13}(?!\d)/.test(text)
  );
}

function redactPii(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/gi, '[EMAIL DIHAPUS]')
    .replace(/\b\d{16}\b/g, '[NIK DIHAPUS]')
    .replace(/(?<!\d)(?:\+?62|0)[\s-]?(?:\d[\s-]?){8,13}(?!\d)/g, '[TELEPON DIHAPUS]');
}

function splitIntoChunks(text: string): string[] {
  const normalized = text.trim();
  if (!normalized) return [];
  const chunks: string[] = [];
  const maxLength = 1200;
  let start = 0;
  while (start < normalized.length) {
    let end = Math.min(start + maxLength, normalized.length);
    if (end < normalized.length) {
      const boundary = normalized.lastIndexOf(' ', end);
      if (boundary > start + Math.floor(maxLength / 2)) end = boundary;
    }
    chunks.push(normalized.slice(start, end).trim());
    start = end;
  }
  return chunks.filter(Boolean);
}

async function findRelevantChunks(
  message: string,
  role: 'ADMIN' | 'SUPER_ADMIN',
) {
  const where: Prisma.AiKnowledgeChunkWhereInput =
    role === 'SUPER_ADMIN'
      ? {}
      : { roleScope: AiRoleScope.ALL_ADMIN };
  const chunks = await prisma.aiKnowledgeChunk.findMany({
    where,
    orderBy: { id: 'desc' },
    take: 500,
  });
  const tokens = queryTokens(message);
  if (tokens.size === 0) return [];

  return chunks
    .map((chunk) => {
      const text = `${chunk.title} ${chunk.content}`.toLocaleLowerCase('id-ID');
      const matched = [...tokens].filter((token) => text.includes(token)).length;
      return { chunk, score: matched / tokens.size };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || b.chunk.id - a.chunk.id)
    .slice(0, 5);
}

function isOperationalQuestion(text: string): boolean {
  return /\b(penjualan|pengeluaran|pemasukan|omzet|produk|harga|stok|pesanan|order|transaksi|kas|laba|rugi|pembelian|supplier)\b/i.test(
    text,
  );
}

function formatRupiah(value: number): string {
  return `Rp ${Math.round(value).toLocaleString('id-ID')}`;
}

function jsonForPrisma(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

async function generateGeminiText(
  apiKey: string,
  modelName: string,
  systemInstruction: string,
  contents: GeminiContent[],
  responseMimeType = 'text/plain',
): Promise<string> {
  const request: GeminiRequest = {
    contents,
    generationConfig: {
      temperature: responseMimeType === 'application/json' ? 0.1 : 0.35,
      maxOutputTokens: responseMimeType === 'application/json' ? 1200 : 1800,
      responseMimeType,
    },
  };

  let sdk: GeminiSdk;
  try {
    sdk = require('@google/generative-ai') as GeminiSdk;
  } catch (error) {
    const missingSdk =
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'MODULE_NOT_FOUND';
    if (!missingSdk) throw error;

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemInstruction }] },
          contents,
          generationConfig: request.generationConfig,
        }),
      },
    );
    const body = (await response.json()) as {
      error?: { message?: string };
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    if (!response.ok) {
      throw new Error(body.error?.message ?? `Gemini API merespons HTTP ${response.status}.`);
    }
    const text =
      body.candidates?.[0]?.content?.parts
        ?.map((part) => part.text ?? '')
        .join('')
        .trim() ?? '';
    if (!text) throw new Error('Gemini tidak mengembalikan jawaban teks.');
    return text;
  }

  const model = new sdk.GoogleGenerativeAI(apiKey).getGenerativeModel({
    model: modelName,
    systemInstruction,
  });
  const result = await model.generateContent(request);
  const text = result.response.text().trim();
  if (!text) throw new Error('Gemini tidak mengembalikan jawaban teks.');
  return text;
}

function buildSystemInstruction(): string {
  return [
    'Anda adalah Asisten AI operasional SOJU. Jawab selalu dalam Bahasa Indonesia yang jelas dan ringkas.',
    'Gunakan hanya konteks operasional/database dan potongan pengetahuan yang diberikan. Jangan mengarang angka, stok, harga, status, atau isi SOP; jika data tidak tersedia, nyatakan bahwa data tidak tersedia.',
    'Data pesanan telah disamarkan dan tidak berisi identitas pribadi. Jangan meminta atau mengungkap data pribadi pelanggan.',
    'Saat menyebut data operasional, cantumkan sitasi [SQL-1]. Saat menggunakan dokumen pengetahuan, cantumkan sitasi sesuai ID [D1], [D2], dan seterusnya.',
    'Konteks adalah data nyata dari database saat permintaan diterima; ringkasan penjualan/pengeluaran memakai 7 hari terakhir dan daftar transaksi memakai 30 hari terakhir.',
    'Jangan pernah menyimpan transaksi sendiri. Semua tindakan transaksi hanya berupa draf yang harus dikonfirmasi manual oleh admin.',
  ].join('\n');
}

function buildPromptContext(
  context: OperationalContext,
  selectedChunks: Array<{ chunk: Awaited<ReturnType<typeof findRelevantChunks>>[number]['chunk']; score: number }>,
): string {
  return [
    'KONTEKS OPERASIONAL TERKINI (JSON):',
    JSON.stringify(context),
    '',
    'POTONGAN PENGETAHUAN YANG COCOK:',
    JSON.stringify(
      selectedChunks.map(({ chunk }, index) => ({
        citation: `[D${index + 1}]`,
        title: chunk.title,
        sourceType: chunk.sourceType,
        sourceRef: chunk.sourceRef,
        content: chunk.content,
      })),
    ),
    'Data operasi dapat dirujuk dengan [SQL-1].',
  ].join('\n');
}

function buildCitations(
  selectedChunks: Array<{ chunk: Awaited<ReturnType<typeof findRelevantChunks>>[number]['chunk']; score: number }>,
  includeSql: boolean,
): AiCitation[] {
  const documents: DocumentCitation[] = selectedChunks.map(
    ({ chunk, score }, index) => ({
      id: `D${index + 1}`,
      documentId: chunk.documentId ?? (Number(chunk.sourceRef) || chunk.id),
      chunkId: chunk.id,
      chunkIndex: chunk.chunkIndex,
      title: chunk.title,
      sourceType: chunk.sourceType,
      sourceRef: chunk.sourceRef,
      roleScope: chunk.roleScope,
      snippet: chunk.content.slice(0, 360),
      score: Math.min(1, score),
    }),
  );
  if (!includeSql) return documents;
  return [
    {
      id: 'SQL-1',
      sourceType: 'SQL_TOOL',
      toolName: 'load_operational_context',
      label: 'Ringkasan data operasional SOJU',
      querySummary:
        'Produk aktif, transaksi 7 hari terakhir, transaksi 30 hari terakhir, dan 10 pesanan terbaru diambil langsung dari database.',
      executedAt: new Date().toISOString(),
    },
    ...documents,
  ];
}

function getGeminiConfiguration(): { apiKey: string; model: string } {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw errorResponse(
      'GEMINI_API_KEY belum diatur pada environment backend.',
      500,
    );
  }
  return {
    apiKey,
    model: process.env.GEMINI_MODEL?.trim() || 'gemini-2.5-flash',
  };
}

function buildGeminiContents(
  history: HistoryMessage[],
  prompt: string,
): GeminiContent[] {
  const contents: GeminiContent[] = [];
  for (const message of history) {
    const role = message.role === 'USER' ? 'user' : 'model';
    const previous = contents[contents.length - 1];
    if (!previous && role === 'model') continue;
    if (previous?.role === role) {
      previous.parts[0].text += `\n\n${message.content}`;
    } else {
      contents.push({ role, parts: [{ text: message.content }] });
    }
  }

  const previous = contents[contents.length - 1];
  if (previous?.role === 'user') {
    previous.parts[0].text += `\n\n${prompt}`;
  } else {
    contents.push({ role: 'user', parts: [{ text: prompt }] });
  }
  return contents;
}

export async function generateAiReply(params: {
  message: string;
  history: HistoryMessage[];
  context: OperationalContext;
  role: 'ADMIN' | 'SUPER_ADMIN';
}): Promise<AiReply> {
  const { apiKey, model } = getGeminiConfiguration();
  const selectedChunks = await findRelevantChunks(params.message, params.role);
  const operational = isOperationalQuestion(params.message);
  const citations = buildCitations(
    selectedChunks,
    operational || params.message.trim().startsWith('/add'),
  );
  const systemInstruction = buildSystemInstruction();
  const promptContext = buildPromptContext(params.context, selectedChunks);

  if (params.message.trim().toLocaleLowerCase('id-ID').startsWith('/add')) {
    const addPrompt = [
      promptContext,
      '',
      'Perintah transaksi admin:',
      params.message,
      '',
      'Keluarkan hanya JSON valid dengan bentuk:',
      '{"reply":"ringkasan Bahasa Indonesia","direction":"PEMASUKAN atau PENGELUARAN","transactionTypeId":number atau null,"transactionTypeName":"nama kategori atau string kosong","paymentMethod":"CASH atau QRIS atau null","date":"YYYY-MM-DD atau null","note":"catatan atau null","items":[{"name":"nama item","quantity":number,"unit":"satuan","unitPrice":number,"productId":number atau null}]}',
      'Gunakan kategori transaksi aktif yang paling sesuai dari transactionTypes pada konteks. Jangan mengarang id kategori/produk. Jika harga, jumlah, atau kategori tidak diketahui, isi 0/null agar draf meminta koreksi.',
      'Harga produk yang cocok harus mengikuti hargaDefault aktual, kecuali user secara eksplisit menuliskan harga transaksi.',
      'Aksi ini hanya draf untuk konfirmasi manual dan tidak boleh mengklaim bahwa transaksi telah disimpan.',
    ].join('\n');
    const generated = await generateGeminiText(
      apiKey,
      model,
      systemInstruction,
      buildGeminiContents(params.history, addPrompt),
      'application/json',
    );
    const draftResponse = parseAddDraftResponse(generated);
    const draft = createActionDraft(
      draftResponse,
      params.message,
      params.context,
    );
    return {
      reply:
        typeof draftResponse.reply === 'string' && draftResponse.reply.trim()
          ? draftResponse.reply.trim()
          : 'Saya sudah menyiapkan draf transaksi. Periksa rinciannya dan konfirmasi secara manual.',
      routePath: 'ACTION_DRAFT',
      citations,
      actions: [draft],
    };
  }

  const prompt = [
    promptContext,
    '',
    'PERTANYAAN ADMIN:',
    params.message,
    '',
    'Jika konteks tidak cukup untuk menjawab, jelaskan data apa yang tidak tersedia. Jangan berspekulasi.',
  ].join('\n');
  const reply = await generateGeminiText(
    apiKey,
    model,
    systemInstruction,
    buildGeminiContents(params.history, prompt),
  );
  return {
    reply,
    routePath: operational
      ? 'SQL_TOOL'
      : selectedChunks.length > 0
        ? 'VECTOR_RAG'
        : 'REFUSAL',
    citations,
    actions: [],
  };
}

function parseAddDraftResponse(text: string): AddDraftResponse {
  const clean = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  const parsed: unknown = JSON.parse(clean);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Gemini mengembalikan format draf transaksi yang tidak valid.');
  }
  return parsed as AddDraftResponse;
}

function createActionDraft(
  response: AddDraftResponse,
  message: string,
  context: OperationalContext,
): AiActionDraft {
  const requestedDirection =
    typeof response.direction === 'string'
      ? response.direction.toUpperCase()
      : '';
  const inferredDirection =
    /\b(jual|penjualan|pemasukan)\b/i.test(message) ? 'PEMASUKAN' : '';
  const direction =
    requestedDirection === 'PEMASUKAN' ||
    requestedDirection === 'PENJUALAN'
      ? 'PEMASUKAN'
      : requestedDirection === 'PENGELUARAN' ||
          requestedDirection === 'PEMBELIAN'
        ? 'PENGELUARAN'
        : inferredDirection || 'PENGELUARAN';
  const typeCandidates = context.transactionTypes.filter(
    (type) => type.arah === direction,
  );
  const requestedTypeId =
    typeof response.transactionTypeId === 'number'
      ? response.transactionTypeId
      : null;
  const requestedTypeName =
    typeof response.transactionTypeName === 'string'
      ? response.transactionTypeName.trim().toLocaleLowerCase('id-ID')
      : '';
  const transactionType =
    typeCandidates.find((type) => type.id === requestedTypeId) ??
    typeCandidates.find(
      (type) =>
        requestedTypeName &&
        type.namaTransaksi.toLocaleLowerCase('id-ID') === requestedTypeName,
    ) ??
    (direction === 'PEMASUKAN'
      ? typeCandidates.find((type) => type.isBawaan) ?? typeCandidates[0]
      : undefined);

  const responseItems = Array.isArray(response.items)
    ? (response.items as AddDraftItem[])
    : [];
  const parsedItems = responseItems
    .map((item) => {
      const name = typeof item.name === 'string' ? item.name.trim() : '';
      const quantity =
        typeof item.quantity === 'number' && Number.isFinite(item.quantity)
          ? Math.max(0, item.quantity)
          : 0;
      const requestedProductId =
        typeof item.productId === 'number' ? item.productId : null;
      const product =
        context.products.find((candidate) => candidate.id === requestedProductId) ??
        context.products.find(
          (candidate) =>
            name &&
            candidate.namaBarang.toLocaleLowerCase('id-ID') ===
              name.toLocaleLowerCase('id-ID'),
        );
      const unitPrice =
        typeof item.unitPrice === 'number' && Number.isFinite(item.unitPrice)
          ? Math.max(0, item.unitPrice)
          : 0;
      const method =
        typeof response.paymentMethod === 'string' &&
        response.paymentMethod.toUpperCase() === 'QRIS'
          ? 'QRIS'
          : 'CASH';
      return {
        produkId: product?.id ?? null,
        nama: name || product?.namaBarang || 'Item transaksi',
        jumlah: quantity,
        satuan:
          (typeof item.unit === 'string' && item.unit.trim()) ||
          product?.satuan ||
          '',
        hargaSatuan: unitPrice || product?.hargaDefault || 0,
        subtotal: quantity * (unitPrice || product?.hargaDefault || 0),
        metode: method as 'QRIS' | 'CASH',
      };
    })
    .filter((item) => item.nama !== 'Item transaksi' || item.jumlah > 0);

  const totalAmount = parsedItems.reduce(
    (total, item) => total + item.subtotal,
    0,
  );
  const missingFields: string[] = [];
  if (!typeCandidates.length || !transactionType) {
    missingFields.push('Jenis transaksi');
  }
  if (parsedItems.length === 0) missingFields.push('Rincian item');
  if (parsedItems.some((item) => item.jumlah <= 0)) {
    missingFields.push('Jumlah item');
  }
  if (parsedItems.some((item) => item.hargaSatuan <= 0)) {
    missingFields.push('Harga item');
  }
  if (totalAmount <= 0) missingFields.push('Total transaksi');

  const rawDate = typeof response.date === 'string' ? response.date : '';
  const date =
    /^\d{4}-\d{2}-\d{2}$/.test(rawDate) &&
    !Number.isNaN(new Date(`${rawDate}T00:00:00`).getTime())
      ? rawDate
      : new Date().toISOString().slice(0, 10);
  const dateLabel = new Date(`${date}T00:00:00`).toLocaleDateString('id-ID');
  const isSale = direction === 'PEMASUKAN';
  const method =
    parsedItems[0]?.metode ??
    (typeof response.paymentMethod === 'string' &&
    response.paymentMethod.toUpperCase() === 'QRIS'
      ? 'QRIS'
      : 'CASH');
  const title = isSale ? 'Draf Penjualan' : 'Draf Pengeluaran';
  const detail = parsedItems
    .map((item) => `${item.nama} x ${item.jumlah} ${item.satuan}`.trim())
    .join('; ')
    .slice(0, 255);
  const note =
    typeof response.note === 'string' && response.note.trim()
      ? response.note.trim()
      : 'Periksa kategori, rincian, dan metode pembayaran sebelum konfirmasi.';
  const payload: Record<string, unknown> = {
    tanggal: date,
    detail,
    nominal: totalAmount,
    jenisKas: method,
    sumberInput: 'AI',
    sumber_input: 'AI',
  };
  if (transactionType) {
    payload.jenis_transaksi_id = transactionType.id;
    if (transactionType.unitBisnis) {
      payload.unit_bisnis = transactionType.unitBisnis;
    }
  }

  return {
    id: randomUUID(),
    type: 'CREATE_TRANSACTION',
    intent: isSale ? 'PENJUALAN' : 'PEMBELIAN',
    requiresConfirmation: true,
    endpoint: '/api/v1/transactions',
    method: 'POST',
    title,
    sheet: 'Transaksi',
    summaryRows: [
      { label: 'Kategori', value: transactionType?.namaTransaksi ?? 'Belum dipilih' },
      { label: 'Tanggal', value: dateLabel },
      { label: 'Metode pembayaran', value: method },
    ],
    total: formatRupiah(totalAmount),
    totalAmount,
    sourceBadge: 'AI',
    badge: isSale ? 'Penjualan' : 'Pengeluaran',
    dateLabel,
    shiftLabel: 'Operasional',
    totalLabel: isSale ? 'Total Penjualan' : 'Total Pengeluaran',
    breakdownTitle: 'Rincian Item',
    items: parsedItems,
    confirmLabel: 'Simpan Transaksi',
    correctLabel: 'Koreksi',
    note,
    payload,
    isReadyToConfirm: missingFields.length === 0,
    missingFields,
  };
}

export function serializeAiMessage<T extends {
  id: number;
  conversationId: number;
  role: ChatRole;
  content: string;
  routePath: string | null;
  citations: Prisma.JsonValue;
  actions: Prisma.JsonValue;
  createdAt: Date;
}>(message: T) {
  return {
    id: message.id,
    conversationId: message.conversationId,
    role: message.role,
    content: message.content,
    routePath: message.routePath,
    citations: Array.isArray(message.citations) ? message.citations : [],
    actions: Array.isArray(message.actions) ? message.actions : [],
    createdAt: message.createdAt.toISOString(),
  };
}

export const serializeAiJson = jsonForPrisma;
