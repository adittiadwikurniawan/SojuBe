import { Router, Response } from 'express';
import { randomInt } from 'crypto';
import { Prisma } from '@prisma/client';
import prisma from '../utils/database';
import { CustomerRequest, authenticateCustomer } from '../middleware/customerAuth';
import { errorResponse, successResponse } from '../utils/response';
import {
  CustomerAuthServiceError,
  changeCustomerPassword,
  loginCustomer,
  publicCustomer,
  registerCustomer,
  requestCustomerPasswordReset,
  resendCustomerVerification,
  resetCustomerPassword,
  verifyCustomerEmail,
} from '../services/customerAuthService';

const router = Router();

const mapServiceError = (error: unknown) => {
  if (error instanceof CustomerAuthServiceError) {
    return errorResponse(error.message, error.status);
  }
  return error;
};

function varianValid(raw: string | null, value: string) {
  if (!value) return true;
  return (raw || '').split(',').map((item) => item.trim().toLowerCase()).includes(value.trim().toLowerCase());
}

function cartFromJson(value: Prisma.JsonValue | null): Array<{ productId: number; varian: string; jumlah: number; catatan: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const row = entry as Record<string, Prisma.JsonValue>;
    const productId = Number(row.productId);
    const jumlah = Number(row.jumlah);
    if (!Number.isInteger(productId) || productId < 1 || !Number.isInteger(jumlah) || jumlah < 1 || jumlah > 99) return [];
    return [{ productId, varian: typeof row.varian === 'string' ? row.varian.trim() : '', jumlah, catatan: typeof row.catatan === 'string' ? row.catatan.trim().slice(0, 255) : '' }];
  });
}

async function validCartItems(input: unknown) {
  if (!Array.isArray(input)) throw errorResponse('Isi keranjang tidak valid');
  const productsById = new Map<number, { id: number; namaBarang: string; varian: string | null; satuan: string; hargaDefault: Prisma.Decimal; gambar: string | null }>();
  const ids = [...new Set(input.map((item: any) => Number(item?.productId)).filter((id: number) => Number.isInteger(id) && id > 0))];
  const products = ids.length ? await prisma.produk.findMany({
    where: { id: { in: ids }, aktif: true },
    select: { id: true, namaBarang: true, varian: true, satuan: true, hargaDefault: true, gambar: true },
  }) : [];
  for (const product of products) productsById.set(product.id, product);

  const normalized = input.map((raw: any) => {
    const productId = Number(raw?.productId);
    const product = productsById.get(productId);
    const jumlah = Number(raw?.jumlah);
    const varian = typeof raw?.varian === 'string' ? raw.varian.trim() : '';
    const catatan = typeof raw?.catatan === 'string' ? raw.catatan.trim().slice(0, 255) : '';
    if (!product) throw errorResponse(`Produk ${productId || ''} tidak tersedia`, 400);
    if (!Number.isInteger(jumlah) || jumlah < 1 || jumlah > 99) throw errorResponse('Jumlah setiap menu harus antara 1 dan 99');
    if (!varianValid(product.varian, varian)) throw errorResponse(`Varian untuk ${product.namaBarang} sudah tidak tersedia`);
    return { product, productId, varian, jumlah, catatan };
  });

  return normalized;
}

// POST /api/customer/auth/daftar
router.post('/auth/daftar', async (req, res, next) => {
  try {
    const result = await registerCustomer({
      nama: typeof req.body?.nama === 'string' ? req.body.nama : '',
      email: typeof req.body?.email === 'string' ? req.body.email : '',
      noTelepon: typeof req.body?.noTelepon === 'string' ? req.body.noTelepon : '',
      alamat: typeof req.body?.alamat === 'string' ? req.body.alamat : '',
      password: typeof req.body?.password === 'string' ? req.body.password : '',
      promosiDiizinkan: req.body?.promosiDiizinkan === true,
    });
    res.status(201).json(successResponse(result));
  } catch (error) {
    next(mapServiceError(error));
  }
});

// POST /api/customer/auth/masuk
router.post('/auth/masuk', async (req, res, next) => {
  try {
    const result = await loginCustomer({
      email: typeof req.body?.email === 'string' ? req.body.email : '',
      password: typeof req.body?.password === 'string' ? req.body.password : '',
    });
    res.json(successResponse(result));
  } catch (error) {
    next(mapServiceError(error));
  }
});

// POST /api/customer/auth/verifikasi-email
router.post('/auth/verifikasi-email', async (req, res, next) => {
  try {
    const token = typeof req.body?.token === 'string' ? req.body.token : '';
    const result = await verifyCustomerEmail(token);
    res.status(200).json(successResponse(result.customer, result.message));
  } catch (error) {
    next(mapServiceError(error));
  }
});

// POST /api/customer/auth/kirim-ulang-verifikasi
router.post('/auth/kirim-ulang-verifikasi', async (req, res, next) => {
  try {
    const email = typeof req.body?.email === 'string' ? req.body.email : '';
    const result = await resendCustomerVerification(email);
    res.status(200).json(successResponse(null, result.message));
  } catch (error) {
    next(mapServiceError(error));
  }
});

// POST /api/customer/auth/lupa-password
router.post('/auth/lupa-password', async (req, res, next) => {
  try {
    const email = typeof req.body?.email === 'string' ? req.body.email : '';
    const result = await requestCustomerPasswordReset(email);
    res.status(200).json(successResponse(null, result.message));
  } catch (error) {
    next(mapServiceError(error));
  }
});

// POST /api/customer/auth/reset-password
router.post('/auth/reset-password', async (req, res, next) => {
  try {
    const token = typeof req.body?.token === 'string' ? req.body.token : '';
    const passwordBaru =
      typeof req.body?.passwordBaru === 'string'
        ? req.body.passwordBaru
        : typeof req.body?.newPassword === 'string'
          ? req.body.newPassword
          : typeof req.body?.password === 'string'
            ? req.body.password
            : '';
    const result = await resetCustomerPassword({ token, passwordBaru });
    res.status(200).json(successResponse(null, result.message));
  } catch (error) {
    next(mapServiceError(error));
  }
});

router.use(authenticateCustomer);

// POST /api/customer/ubah-password
router.post('/ubah-password', async (req: CustomerRequest, res: Response, next) => {
  try {
    const passwordLama =
      typeof req.body?.passwordLama === 'string'
        ? req.body.passwordLama
        : typeof req.body?.currentPassword === 'string'
          ? req.body.currentPassword
          : '';
    const passwordBaru =
      typeof req.body?.passwordBaru === 'string'
        ? req.body.passwordBaru
        : typeof req.body?.newPassword === 'string'
          ? req.body.newPassword
          : '';
    const result = await changeCustomerPassword({
      customerId: req.customer!.id,
      passwordLama,
      passwordBaru,
    });
    res.status(200).json(successResponse(null, result.message));
  } catch (error) {
    next(mapServiceError(error));
  }
});

// GET/PATCH /api/customer/profil
router.get('/profil', async (req: CustomerRequest, res: Response, next) => {
  try {
    const customer = await prisma.pelanggan.findUnique({ where: { id: req.customer!.id } });
    if (!customer) throw errorResponse('Akun customer tidak ditemukan', 404);
    res.json(successResponse(publicCustomer(customer)));
  } catch (error) { next(error); }
});

router.patch('/profil', async (req: CustomerRequest, res: Response, next) => {
  try {
    const data: Record<string, string> = {};
    for (const field of ['nama', 'email', 'noTelepon', 'alamat'] as const) {
      if (req.body?.[field] !== undefined) {
        if (typeof req.body[field] !== 'string' || !req.body[field].trim()) throw errorResponse(`${field} wajib berupa teks dan tidak boleh kosong`);
        data[field] = req.body[field].trim();
      }
    }
    if (data.email) {
      data.email = data.email.toLowerCase();
      const duplicate = await prisma.pelanggan.findFirst({ where: { email: data.email, id: { not: req.customer!.id } } });
      if (duplicate) throw errorResponse('Email sudah digunakan akun lain', 409);
    }
    const updateData: Prisma.PelangganUpdateInput = { ...data };
    if (req.body?.promosiDiizinkan !== undefined) {
      if (typeof req.body.promosiDiizinkan !== 'boolean') throw errorResponse('Pilihan promosi tidak valid');
      updateData.promosiDiizinkan = req.body.promosiDiizinkan;
      if (req.body.promosiDiizinkan) {
        updateData.promosiDisetujuiPada = new Date();
        updateData.promosiBerhentiPada = null;
      } else {
        updateData.promosiBerhentiPada = new Date();
      }
    }
    const customer = await prisma.pelanggan.update({ where: { id: req.customer!.id }, data: updateData });
    res.json(successResponse(publicCustomer(customer)));
  } catch (error) { next(error); }
});

// GET/PUT /api/customer/keranjang
router.get('/keranjang', async (req: CustomerRequest, res: Response, next) => {
  try {
    const customer = await prisma.pelanggan.findUnique({ where: { id: req.customer!.id }, select: { keranjang: true } });
    const cart = cartFromJson(customer?.keranjang ?? null);
    const items = await validCartItems(cart);
    res.json(successResponse(items.map(({ product, productId, varian, jumlah, catatan }) => ({
      productId, nama: product.namaBarang, varian, jumlah, catatan, harga: product.hargaDefault, satuan: product.satuan, gambar: product.gambar,
    }))));
  } catch (error) { next(error); }
});

router.put('/keranjang', async (req: CustomerRequest, res: Response, next) => {
  try {
    const items = await validCartItems(req.body?.items);
    const saved = items.map(({ productId, varian, jumlah, catatan }) => ({ productId, varian, jumlah, catatan }));
    await prisma.pelanggan.update({ where: { id: req.customer!.id }, data: { keranjang: saved as Prisma.InputJsonValue } });
    res.json(successResponse({ jumlahItem: saved.reduce((sum, item) => sum + item.jumlah, 0) }));
  } catch (error) { next(error); }
});

// GET /api/customer/pesanan
router.get('/pesanan', async (req: CustomerRequest, res: Response, next) => {
  try {
    const pesanan = await prisma.pesananPelanggan.findMany({
      where: { pelangganId: req.customer!.id },
      include: { item: true },
      orderBy: { dibuatPada: 'desc' },
    });
    res.json(successResponse(pesanan));
  } catch (error) { next(error); }
});

router.get('/pesanan/:id', async (req: CustomerRequest, res: Response, next) => {
  try {
    const id = Number(req.params.id);
    const pesanan = await prisma.pesananPelanggan.findFirst({
      where: { id, pelangganId: req.customer!.id },
      include: { item: true },
    });
    if (!pesanan) throw errorResponse('Pesanan tidak ditemukan', 404);
    res.json(successResponse(pesanan));
  } catch (error) { next(error); }
});

// POST /api/customer/checkout; price and product details are read from DB, never trusted from browser.
router.post('/checkout', async (req: CustomerRequest, res: Response, next) => {
  try {
    const customer = await prisma.pelanggan.findUnique({ where: { id: req.customer!.id } });
    if (!customer) throw errorResponse('Akun customer tidak ditemukan', 404);
    const items = await validCartItems(cartFromJson(customer.keranjang));
    if (!items.length) throw errorResponse('Keranjang masih kosong');
    const total = items.reduce((sum, item) => sum.add(item.product.hargaDefault.mul(item.jumlah)), new Prisma.Decimal(0));
    const kode = `PSN-${Date.now()}-${String(randomInt(0, 1_000_000)).padStart(6, '0')}`;
    const pesanan = await prisma.$transaction(async (tx) => {
      const created = await tx.pesananPelanggan.create({
        data: {
          kode,
          pelangganId: customer.id,
          namaPenerima: customer.nama,
          emailPenerima: customer.email,
          noTelepon: customer.noTelepon,
          alamat: typeof req.body?.alamat === 'string' && req.body.alamat.trim() ? req.body.alamat.trim() : customer.alamat,
          total,
          status: 'MENUNGGU_KONFIRMASI',
          item: { create: items.map(({ product, productId, varian, jumlah, catatan }) => ({
            produkId: productId,
            namaProduk: product.namaBarang,
            varian: varian || null,
            satuan: product.satuan,
            harga: product.hargaDefault,
            jumlah,
            catatan: catatan || null,
            subtotal: product.hargaDefault.mul(jumlah),
          })) },
        },
        include: { item: true },
      });
      await tx.pelanggan.update({ where: { id: customer.id }, data: { keranjang: [] } });
      return created;
    });
    res.status(201).json(successResponse(pesanan, 'Pesanan berhasil dibuat'));
  } catch (error) { next(error); }
});

export default router;
