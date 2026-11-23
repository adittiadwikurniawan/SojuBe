import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { PutObjectCommand } from '@aws-sdk/client-s3';

const mockS3Send = vi.hoisted(() => vi.fn());
const mockPrisma = vi.hoisted(() => ({
  produk: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
}));
const mockLogManualAction = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-s3', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-s3')>();
  class MockS3Client {
    public readonly config: unknown;
    constructor(config: unknown) {
      this.config = config;
    }
    send = mockS3Send;
  }
  return {
    ...actual,
    S3Client: MockS3Client,
  };
});

vi.mock('../src/utils/database', () => ({
  default: mockPrisma,
}));

vi.mock('../src/middleware/auth', () => ({
  authenticate: (req: any, _res: Response, next: NextFunction) => {
    req.user = { id: 1, email: 'superadmin@soju.test', role: 'SUPER_ADMIN' };
    next();
  },
  authorizeRoles: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}));

vi.mock('../src/services/auditLogService', () => ({
  logManualAction: mockLogManualAction,
}));

import {
  MAX_IMAGE_SIZE_BYTES,
  StorageValidationError,
  buildPublicObjectUrl,
  getS3Config,
  isS3Configured,
  parseImageDataUri,
  resetS3FallbackWarning,
  uploadProductImage,
  validateImageBuffer,
} from '../src/services/storageService';
import productsRouter from '../src/routes/products';
import productsPublicRouter from '../src/routes/productsPublic';

const SAMPLE_PNG_BYTES = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const SAMPLE_PNG_DATA_URI = `data:image/png;base64,${SAMPLE_PNG_BYTES.toString('base64')}`;

const S3_ENV_KEYS = [
  'S3_ENDPOINT',
  'S3_REGION',
  'S3_BUCKET',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
  'S3_PUBLIC_BASE_URL',
  'S3_FORCE_PATH_STYLE',
] as const;

const clearS3Env = () => {
  for (const key of S3_ENV_KEYS) {
    delete process.env[key];
  }
};

const setMinioEnv = () => {
  process.env.S3_ENDPOINT = 'http://localhost:9000';
  process.env.S3_REGION = 'us-east-1';
  process.env.S3_BUCKET = 'soju-media';
  process.env.S3_ACCESS_KEY_ID = 'minioadmin';
  process.env.S3_SECRET_ACCESS_KEY = 'minioadmin123';
  process.env.S3_PUBLIC_BASE_URL = 'http://localhost:9000/soju-media';
  process.env.S3_FORCE_PATH_STYLE = 'true';
};

const createTestApp = () => {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/v1/products', productsRouter);
  app.use('/api/public/products', productsPublicRouter);
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    res.status(err.status || 500).json({
      success: false,
      message: err.message || 'Internal Server Error',
    });
  });
  return app;
};

describe('storageService unit tests', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    clearS3Env();
    resetS3FallbackWarning();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('detects S3 configuration presence and parses MinIO path-style settings', () => {
    expect(isS3Configured()).toBe(false);
    expect(getS3Config()).toBeNull();

    setMinioEnv();
    expect(isS3Configured()).toBe(true);
    const config = getS3Config();
    expect(config).toEqual({
      endpoint: 'http://localhost:9000',
      region: 'us-east-1',
      bucket: 'soju-media',
      accessKeyId: 'minioadmin',
      secretAccessKey: 'minioadmin123',
      publicBaseUrl: 'http://localhost:9000/soju-media',
      forcePathStyle: true,
    });
  });

  it('validates allowed image MIME types and rejects unsupported MIME or oversized buffers', () => {
    expect(validateImageBuffer(SAMPLE_PNG_BYTES, 'image/jpeg').mime).toBe('image/jpeg');
    expect(validateImageBuffer(SAMPLE_PNG_BYTES, 'image/png').mime).toBe('image/png');
    expect(validateImageBuffer(SAMPLE_PNG_BYTES, 'image/webp').mime).toBe('image/webp');
    expect(validateImageBuffer(SAMPLE_PNG_BYTES, 'image/gif').mime).toBe('image/gif');

    expect(() => validateImageBuffer(SAMPLE_PNG_BYTES, 'application/pdf')).toThrow(StorageValidationError);
    expect(() => validateImageBuffer(SAMPLE_PNG_BYTES, 'image/svg+xml')).toThrow(StorageValidationError);
    expect(() => validateImageBuffer(Buffer.alloc(0), 'image/png')).toThrow(StorageValidationError);
    expect(() => validateImageBuffer(Buffer.alloc(MAX_IMAGE_SIZE_BYTES + 1), 'image/png')).toThrow(
      'Ukuran gambar maksimal 5 MB'
    );
  });

  it('parses valid data URIs and rejects invalid MIME data URIs', () => {
    const parsed = parseImageDataUri(SAMPLE_PNG_DATA_URI);
    expect(parsed).not.toBeNull();
    expect(parsed?.mime).toBe('image/png');
    expect(parsed?.data.equals(SAMPLE_PNG_BYTES)).toBe(true);

    expect(parseImageDataUri('https://cdn.example.com/menu.png')).toBeNull();
    expect(() => parseImageDataUri('data:image/svg+xml;base64,PHN2Zz4=')).toThrow(StorageValidationError);
    expect(() => parseImageDataUri('data:application/pdf;base64,JVBERi0=')).toThrow(StorageValidationError);
  });

  it('uploads validated product image via mocked S3Client and returns public URL', async () => {
    setMinioEnv();
    mockS3Send.mockResolvedValueOnce({ ETag: '"abc123"' });

    const result = await uploadProductImage({
      productId: 42,
      data: SAMPLE_PNG_BYTES,
      mime: 'image/png',
      timestamp: 1700000000000,
    });

    expect(mockS3Send).toHaveBeenCalledTimes(1);
    const command = mockS3Send.mock.calls[0][0];
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect(command.input).toEqual({
      Bucket: 'soju-media',
      Key: 'products/42-1700000000000.png',
      Body: SAMPLE_PNG_BYTES,
      ContentType: 'image/png',
    });
    expect(result).toEqual({
      key: 'products/42-1700000000000.png',
      url: 'http://localhost:9000/soju-media/products/42-1700000000000.png',
      mime: 'image/png',
      size: SAMPLE_PNG_BYTES.length,
    });
  });

  it('builds public URLs cleanly for Cloudflare R2, Supabase, and path-style MinIO', () => {
    expect(
      buildPublicObjectUrl(
        {
          endpoint: 'https://account.r2.cloudflarestorage.com',
          region: 'auto',
          bucket: 'soju-r2',
          accessKeyId: 'k',
          secretAccessKey: 's',
          publicBaseUrl: 'https://media.sojufnb.id/',
          forcePathStyle: false,
        },
        'products/10-123.webp'
      )
    ).toBe('https://media.sojufnb.id/products/10-123.webp');

    expect(
      buildPublicObjectUrl(
        {
          endpoint: 'http://localhost:9000/',
          region: 'us-east-1',
          bucket: 'soju-media',
          accessKeyId: 'k',
          secretAccessKey: 's',
          forcePathStyle: true,
        },
        'products/10-123.jpg'
      )
    ).toBe('http://localhost:9000/soju-media/products/10-123.jpg');
  });
});

describe('product routes S3 migration & BLOB backward compatibility', () => {
  const originalEnv = { ...process.env };
  const app = createTestApp();

  beforeEach(() => {
    vi.clearAllMocks();
    clearS3Env();
    resetS3FallbackWarning();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('POST /api/v1/products uploads to S3, saves gambarUrl (mirroring gambar), and never leaks gambarData', async () => {
    setMinioEnv();
    mockS3Send.mockResolvedValueOnce({ ETag: '"s3-etag"' });
    mockPrisma.produk.create.mockResolvedValueOnce({
      id: 15,
      kode: 'PRD015',
      namaBarang: 'Topokki Original',
      varian: 'Original',
      satuan: 'porsi',
      hargaDefault: 25000,
      gambar: null,
      gambarUrl: null,
      gambarNama: 'topokki.png',
      gambarData: null,
      gambarMime: null,
      deskripsi: 'Lezat',
      aktif: true,
      dibuatPada: new Date('2026-11-23T00:00:00.000Z'),
    });
    mockPrisma.produk.update.mockResolvedValueOnce({});

    const res = await request(app).post('/api/v1/products').send({
      kode: 'PRD015',
      namaBarang: 'Topokki Original',
      hargaDefault: 25000,
      gambar: SAMPLE_PNG_DATA_URI,
      gambarNama: 'topokki.png',
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockS3Send).toHaveBeenCalledTimes(1);
    expect(res.body.data.gambarUrl).toMatch(/^http:\/\/localhost:9000\/soju-media\/products\/15-\d+\.png$/);
    expect(res.body.data.gambar).toBe(res.body.data.gambarUrl);
    expect(res.body.data.gambarData).toBeUndefined();
    expect(res.body.data.gambarMime).toBeUndefined();
    expect(mockPrisma.produk.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 15 },
        data: expect.objectContaining({
          gambarUrl: res.body.data.gambarUrl,
          gambar: res.body.data.gambarUrl,
          gambarData: null,
          gambarMime: null,
        }),
      })
    );
  });

  it('POST /api/v1/products supports multipart/form-data multer buffer upload to S3', async () => {
    setMinioEnv();
    mockS3Send.mockResolvedValueOnce({ ETag: '"multipart-etag"' });
    mockPrisma.produk.create.mockResolvedValueOnce({
      id: 16,
      kode: 'PRD016',
      namaBarang: 'Odeng Kuah',
      varian: null,
      satuan: 'pcs',
      hargaDefault: 15000,
      gambar: null,
      gambarUrl: null,
      gambarNama: 'odeng.png',
      gambarData: null,
      gambarMime: null,
      deskripsi: null,
      aktif: true,
      dibuatPada: new Date('2026-11-23T00:00:00.000Z'),
    });
    mockPrisma.produk.update.mockResolvedValueOnce({});

    const res = await request(app)
      .post('/api/v1/products')
      .field('kode', 'PRD016')
      .field('namaBarang', 'Odeng Kuah')
      .field('hargaDefault', '15000')
      .attach('gambar', SAMPLE_PNG_BYTES, { filename: 'odeng.png', contentType: 'image/png' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockS3Send).toHaveBeenCalledTimes(1);
    expect(res.body.data.gambarUrl).toMatch(/^http:\/\/localhost:9000\/soju-media\/products\/16-\d+\.png$/);
    expect(res.body.data.gambar).toBe(res.body.data.gambarUrl);
    expect(res.body.data.gambarData).toBeUndefined();
  });

  it('PUT /api/v1/products/:id uploads new image to S3 and clears legacy BLOB fields', async () => {
    setMinioEnv();
    mockS3Send.mockResolvedValueOnce({ ETag: '"put-etag"' });
    mockPrisma.produk.findUnique.mockResolvedValueOnce({
      id: 20,
      kode: 'PRD020',
      namaBarang: 'Corndog',
      varian: 'Keju',
      satuan: 'pcs',
      hargaDefault: 18000,
      gambar: '/api/public/products/20/image?v=1',
      gambarUrl: null,
      gambarNama: 'old.png',
      deskripsi: null,
      aktif: true,
      dibuatPada: new Date('2026-11-23T00:00:00.000Z'),
    });
    mockPrisma.produk.update.mockImplementationOnce(async ({ data }: any) => ({
      id: 20,
      kode: 'PRD020',
      namaBarang: 'Corndog',
      varian: 'Keju',
      satuan: 'pcs',
      hargaDefault: 18000,
      deskripsi: null,
      aktif: true,
      dibuatPada: new Date('2026-11-23T00:00:00.000Z'),
      ...data,
    }));

    const res = await request(app).put('/api/v1/products/20').send({
      gambar: SAMPLE_PNG_DATA_URI,
      gambarNama: 'corndog-new.png',
    });

    expect(res.status).toBe(200);
    expect(mockS3Send).toHaveBeenCalledTimes(1);
    expect(res.body.data.gambarUrl).toMatch(/^http:\/\/localhost:9000\/soju-media\/products\/20-\d+\.png$/);
    expect(res.body.data.gambar).toBe(res.body.data.gambarUrl);
    expect(res.body.data.gambarData).toBeUndefined();
    expect(mockPrisma.produk.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 20 },
        data: expect.objectContaining({
          gambarData: null,
          gambarMime: null,
        }),
      })
    );
  });

  it('falls back gracefully to BLOB storage when S3 env vars are absent', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockPrisma.produk.create.mockResolvedValueOnce({
      id: 21,
      kode: 'PRD021',
      namaBarang: 'Ramyeon',
      varian: null,
      satuan: 'porsi',
      hargaDefault: 22000,
      gambar: null,
      gambarUrl: null,
      gambarNama: 'ramyeon.png',
      gambarData: SAMPLE_PNG_BYTES,
      gambarMime: 'image/png',
      deskripsi: null,
      aktif: true,
      dibuatPada: new Date('2026-11-23T00:00:00.000Z'),
    });
    mockPrisma.produk.update.mockResolvedValueOnce({});

    const res = await request(app).post('/api/v1/products').send({
      kode: 'PRD021',
      namaBarang: 'Ramyeon',
      hargaDefault: 22000,
      gambar: SAMPLE_PNG_DATA_URI,
      gambarNama: 'ramyeon.png',
    });

    expect(res.status).toBe(200);
    expect(mockS3Send).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(res.body.data.gambar).toMatch(/^\/api\/public\/products\/21\/image\?v=\d+$/);
    expect(res.body.data.gambarUrl).toBeNull();
    expect(res.body.data.gambarData).toBeUndefined();
    warnSpy.mockRestore();
  });

  it('serves legacy BLOB bytes via GET /api/public/products/:id/image without regression', async () => {
    mockPrisma.produk.findUnique.mockResolvedValueOnce({
      gambarData: SAMPLE_PNG_BYTES,
      gambarMime: 'image/png',
      aktif: true,
    });

    const res = await request(app).get('/api/public/products/99/image');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/png');
    expect(Buffer.compare(res.body, SAMPLE_PNG_BYTES)).toBe(0);
  });

  it('exposes gambarUrl and omits gambarData in public and admin product listings', async () => {
    const sampleProducts = [
      {
        id: 15,
        kode: 'PRD015',
        namaBarang: 'Topokki Original',
        varian: 'Original',
        satuan: 'porsi',
        hargaDefault: 25000,
        gambar: 'http://localhost:9000/soju-media/products/15-1700.png',
        gambarUrl: 'http://localhost:9000/soju-media/products/15-1700.png',
        deskripsi: 'Lezat',
        aktif: true,
        dibuatPada: new Date('2026-11-23T00:00:00.000Z'),
      },
    ];
    mockPrisma.produk.findMany.mockResolvedValueOnce(sampleProducts);

    const publicRes = await request(app).get('/api/public/products');

    expect(publicRes.status).toBe(200);
    expect(publicRes.body.success).toBe(true);
    expect(publicRes.body.data[0].gambarUrl).toBe('http://localhost:9000/soju-media/products/15-1700.png');
    expect(publicRes.body.data[0].gambarData).toBeUndefined();
    expect(mockPrisma.produk.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          gambar: true,
          gambarUrl: true,
        }),
      })
    );

    mockPrisma.produk.findMany.mockResolvedValueOnce(sampleProducts);
    const adminRes = await request(app).get('/api/v1/products');

    expect(adminRes.status).toBe(200);
    expect(adminRes.body.success).toBe(true);
    expect(adminRes.body.data[0].gambarUrl).toBe('http://localhost:9000/soju-media/products/15-1700.png');
    expect(adminRes.body.data[0].gambarData).toBeUndefined();
  });

  it('rejects invalid MIME, non-image data URIs, and Multer upload errors with HTTP 400 without creating a DB row', async () => {
    setMinioEnv();

    const pdfRes = await request(app).post('/api/v1/products').send({
      kode: 'PRD099',
      namaBarang: 'Invalid PDF',
      hargaDefault: 10000,
      gambar: 'data:application/pdf;base64,JVBERi0=',
    });
    expect(pdfRes.status).toBe(400);
    expect(pdfRes.body.success).toBe(false);
    expect(mockPrisma.produk.create).not.toHaveBeenCalled();

    const oversizedBuffer = Buffer.alloc(MAX_IMAGE_SIZE_BYTES + 1, 1);
    const sizeRes = await request(app)
      .post('/api/v1/products')
      .field('namaBarang', 'Oversized Product')
      .attach('gambar', oversizedBuffer, { filename: 'huge.png', contentType: 'image/png' });
    expect(sizeRes.status).toBe(400);
    expect(sizeRes.body).toEqual({
      success: false,
      message: 'Ukuran gambar maksimal 5 MB',
    });
    expect(mockPrisma.produk.create).not.toHaveBeenCalled();

    const wrongFieldRes = await request(app)
      .post('/api/v1/products')
      .field('namaBarang', 'Wrong Field')
      .attach('file', SAMPLE_PNG_BYTES, { filename: 'wrong.png', contentType: 'image/png' });
    expect(wrongFieldRes.status).toBe(400);
    expect(wrongFieldRes.body.success).toBe(false);
    expect(typeof wrongFieldRes.body.message).toBe('string');
    expect(mockPrisma.produk.create).not.toHaveBeenCalled();
  });

  it('PUT /api/v1/products/:id clears stale gambarUrl when falling back to BLOB storage without S3 env', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockPrisma.produk.findUnique.mockResolvedValueOnce({
      id: 22,
      kode: 'PRD022',
      namaBarang: 'Kimbap',
      varian: 'Original',
      satuan: 'porsi',
      hargaDefault: 20000,
      gambar: 'http://localhost:9000/soju-media/products/22-old.png',
      gambarUrl: 'http://localhost:9000/soju-media/products/22-old.png',
      gambarNama: 'old.png',
      deskripsi: null,
      aktif: true,
      dibuatPada: new Date('2026-11-23T00:00:00.000Z'),
    });
    mockPrisma.produk.update.mockImplementationOnce(async ({ data }: any) => ({
      id: 22,
      kode: 'PRD022',
      namaBarang: 'Kimbap',
      varian: 'Original',
      satuan: 'porsi',
      hargaDefault: 20000,
      deskripsi: null,
      aktif: true,
      dibuatPada: new Date('2026-11-23T00:00:00.000Z'),
      ...data,
    }));

    const res = await request(app).put('/api/v1/products/22').send({
      gambar: SAMPLE_PNG_DATA_URI,
      gambarNama: 'kimbap-blob.png',
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockS3Send).not.toHaveBeenCalled();
    expect(res.body.data.gambarUrl).toBeNull();
    expect(res.body.data.gambar).toMatch(/^\/api\/public\/products\/22\/image\?v=\d+$/);
    expect(res.body.data.gambarData).toBeUndefined();
    expect(mockPrisma.produk.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 22 },
        data: expect.objectContaining({
          gambarUrl: null,
          gambarData: SAMPLE_PNG_BYTES,
          gambarMime: 'image/png',
        }),
      })
    );
    warnSpy.mockRestore();
  });
});
