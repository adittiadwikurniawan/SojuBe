import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { authenticate, authorizeRoles, AuthRequest } from '../middleware/auth';
import { successResponse, errorResponse } from '../utils/response';
import prisma from '../utils/database';
import { logManualAction } from '../services/auditLogService';
import {
  MAX_IMAGE_SIZE_BYTES,
  isS3Configured,
  parseImageDataUri,
  uploadProductImage,
  validateImageBuffer,
  warnS3FallbackOnce,
  ParsedImage,
} from '../services/storageService';
import { AksiLog } from '@prisma/client';

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_SIZE_BYTES },
});

const optionalImageUpload = (req: Request, res: Response, next: NextFunction) => {
  if (!req.is('multipart/form-data')) {
    return next();
  }
  upload.single('gambar')(req, res, (err: unknown) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return next(errorResponse('Ukuran gambar maksimal 5 MB', 400));
      }
      return next(errorResponse(err.message || 'Upload gambar tidak valid', 400));
    }
    return next(err);
  });
};

const extractIncomingImage = (req: Request, gambar: unknown): { image: ParsedImage | null; fileName?: string } => {
  if (req.file) {
    const validated = validateImageBuffer(req.file.buffer, req.file.mimetype);
    return { image: validated, fileName: req.file.originalname };
  }
  return { image: parseImageDataUri(gambar) };
};

const cleanImageName = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const name = value.trim().replace(/[\\/]/g, '').slice(0, 255);
  return name || null;
};

const withoutImageData = <T extends { gambarData?: Uint8Array | null; gambarMime?: string | null }>(product: T) => {
  const { gambarData: _data, gambarMime: _mime, ...safeProduct } = product;
  return safeProduct;
};

const PRODUCT_SAFE_SELECT = {
  id: true,
  kode: true,
  namaBarang: true,
  varian: true,
  satuan: true,
  hargaDefault: true,
  gambar: true,
  gambarUrl: true,
  gambarNama: true,
  deskripsi: true,
  aktif: true,
  dibuatPada: true,
} as const;

// All routes require authentication
router.use(authenticate, authorizeRoles('SUPER_ADMIN'));

// GET /products
router.get('/', async (req: AuthRequest, res: Response, next) => {
  try {
    const { search, is_active, aktif } = req.query;
    
    const where: any = {};
    if (search) {
      where.OR = [
        { namaBarang: { contains: search as string } },
        { varian: { contains: search as string } },
        { kode: { contains: search as string } },
      ];
    }
    if (aktif !== undefined) {
      where.aktif = aktif === 'true';
    } else if (is_active !== undefined) {
      where.aktif = is_active === 'true';
    }

    const products = await prisma.produk.findMany({
      where,
      orderBy: { dibuatPada: 'desc' },
      select: PRODUCT_SAFE_SELECT,
    });

    res.json(successResponse(products));
  } catch (error) {
    next(error);
  }
});

// GET /products/:id
router.get('/:id', async (req: AuthRequest, res: Response, next) => {
  try {
    const product = await prisma.produk.findUnique({
      where: { id: parseInt(String(req.params.id)) },
      select: PRODUCT_SAFE_SELECT,
    });

    if (!product) {
      throw errorResponse('Product not found', 404);
    }

    res.json(successResponse(product));
  } catch (error) {
    next(error);
  }
});

// Mengirim gambar langsung dari kolom BLOB.
router.get('/:id/image', async (req: Request, res: Response, next) => {
  try {
    const product = await prisma.produk.findUnique({
      where: { id: parseInt(String(req.params.id)) },
      select: { gambarData: true, gambarMime: true, gambar: true },
    });
    if (!product?.gambarData || !product.gambarMime) throw errorResponse('Gambar tidak ditemukan', 404);
    res.type(product.gambarMime).set('Cache-Control', 'no-cache, must-revalidate').send(Buffer.from(product.gambarData));
  } catch (error) {
    next(error);
  }
});

// POST /products
router.post('/', optionalImageUpload, async (req: AuthRequest, res: Response, next) => {
  try {
    const {
      kode,
      kode_produk,
      nama_barang,
      namaBarang,
      varian,
      satuan,
      harga_default,
      hargaDefault,
      gambar,
      gambarUrl,
      gambarNama,
      deskripsi,
    } = req.body;

    const finalKode = kode || kode_produk || `PRD${Date.now()}`;
    const finalNama = namaBarang || nama_barang;
    const { image, fileName } = extractIncomingImage(req, gambar);
    const s3Enabled = isS3Configured();

    if (!finalNama) {
      throw errorResponse('namaBarang (nama_barang) is required');
    }

    const plainGambar = !image && typeof gambar === 'string' && gambar ? gambar : null;
    const plainGambarUrl =
      !image && typeof gambarUrl === 'string' && gambarUrl
        ? gambarUrl
        : plainGambar && /^https?:\/\//i.test(plainGambar)
          ? plainGambar
          : null;

    if (image && !s3Enabled) {
      warnS3FallbackOnce();
    }

    const product = await prisma.produk.create({
      data: {
        kode: finalKode,
        namaBarang: finalNama,
        varian,
        satuan: satuan || 'pcs',
        hargaDefault: (hargaDefault ?? harga_default) || 0,
        gambar: image ? null : plainGambar ?? plainGambarUrl,
        gambarUrl: image ? null : plainGambarUrl,
        gambarNama: image ? cleanImageName(gambarNama ?? fileName) : null,
        ...(image && !s3Enabled ? { gambarData: image.data, gambarMime: image.mime } : {}),
        deskripsi,
        aktif: true,
      }
    });

    if (image) {
      if (s3Enabled) {
        const uploaded = await uploadProductImage({
          productId: product.id,
          data: image.data,
          mime: image.mime,
        });
        await prisma.produk.update({
          where: { id: product.id },
          data: {
            gambarUrl: uploaded.url,
            gambar: uploaded.url,
            gambarData: null,
            gambarMime: null,
          },
        });
        product.gambarUrl = uploaded.url;
        product.gambar = uploaded.url;
        product.gambarData = null;
        product.gambarMime = null;
      } else {
        const imagePath = `/api/public/products/${product.id}/image?v=${Date.now()}`;
        await prisma.produk.update({ where: { id: product.id }, data: { gambar: imagePath, gambarUrl: null } });
        product.gambar = imagePath;
        product.gambarUrl = null;
      }
    }
    await logManualAction(
      req.user!.id,
      'produk',
      AksiLog.TAMBAH,
      product.namaBarang,
      `Product created: ${product.namaBarang}`,
      product.id,
      undefined,
      withoutImageData(product)
    );
    res.json(successResponse(withoutImageData(product)));
  } catch (error) {
    next(error);
  }
});

// PUT /products/:id
router.put('/:id', optionalImageUpload, async (req: AuthRequest, res: Response, next) => {
  try {
    const id = parseInt(String(req.params.id));
    const {
      kode,
      kode_produk,
      nama_barang,
      namaBarang,
      varian,
      satuan,
      harga_default,
      hargaDefault,
      gambar,
      gambarUrl,
      gambarNama,
      deskripsi,
      aktif,
      is_active
    } = req.body;

    const existing = await prisma.produk.findUnique({
      where: { id },
      select: PRODUCT_SAFE_SELECT,
    });
    if (!existing) {
      throw errorResponse('Product not found', 404);
    }

    const updateData: any = {};
    if (kode || kode_produk) updateData.kode = kode || kode_produk;
    if (namaBarang || nama_barang) updateData.namaBarang = namaBarang || nama_barang;
    if (varian !== undefined) updateData.varian = varian;
    if (satuan !== undefined) updateData.satuan = satuan;
    if (hargaDefault !== undefined || harga_default !== undefined) updateData.hargaDefault = hargaDefault ?? harga_default;

    if (req.file || gambar !== undefined) {
      const { image, fileName } = extractIncomingImage(req, gambar);
      if (image) {
        if (isS3Configured()) {
          const uploaded = await uploadProductImage({
            productId: id,
            data: image.data,
            mime: image.mime,
          });
          updateData.gambarUrl = uploaded.url;
          updateData.gambar = uploaded.url;
          updateData.gambarData = null;
          updateData.gambarMime = null;
          updateData.gambarNama = cleanImageName(gambarNama ?? fileName);
        } else {
          warnS3FallbackOnce();
          updateData.gambar = `/api/public/products/${id}/image?v=${Date.now()}`;
          updateData.gambarUrl = null;
          updateData.gambarData = image.data;
          updateData.gambarMime = image.mime;
          updateData.gambarNama = cleanImageName(gambarNama ?? fileName);
        }
      } else if (gambar === '') {
        updateData.gambar = null;
        updateData.gambarUrl = null;
        updateData.gambarData = null;
        updateData.gambarMime = null;
        updateData.gambarNama = null;
      } else if (gambar !== undefined) {
        updateData.gambar = gambar;
        if (typeof gambar === 'string' && /^https?:\/\//i.test(gambar)) {
          updateData.gambarUrl = gambar;
        }
      }
    } else if (gambarUrl !== undefined) {
      updateData.gambarUrl = gambarUrl || null;
      if (gambarUrl) {
        updateData.gambar = gambarUrl;
      }
    }

    if (gambarNama !== undefined && gambar !== undefined && gambar !== '') {
      updateData.gambarNama = cleanImageName(gambarNama);
    }
    if (deskripsi !== undefined) updateData.deskripsi = deskripsi;
    if (aktif !== undefined || is_active !== undefined) {
      const rawAktif = aktif !== undefined ? aktif : is_active;
      updateData.aktif = rawAktif === true || rawAktif === 'true';
    }

    const product = await prisma.produk.update({
      where: { id },
      data: updateData
    });

    // Log audit
    await logManualAction(
      req.user!.id,
      'produk',
      AksiLog.UBAH,
      product.namaBarang,
      `Product updated: ${product.namaBarang}`,
      product.id,
      existing,
      withoutImageData(product)
    );

    res.json(successResponse(withoutImageData(product)));
  } catch (error) {
    next(error);
  }
});

// DELETE /products/:id (soft delete)
router.delete('/:id', async (req: AuthRequest, res: Response, next) => {
  try {
    const id = parseInt(String(req.params.id));
    
    const product = await prisma.produk.update({
      where: { id },
      data: { aktif: false }
    });

    // Log audit
    await logManualAction(
      req.user!.id,
      'produk',
      AksiLog.HAPUS,
      product.namaBarang,
      `Product soft deleted: ${product.namaBarang}`,
      product.id
    );

    res.json(successResponse({ message: 'Product deleted successfully' }));
  } catch (error) {
    next(error);
  }
});

export default router;
