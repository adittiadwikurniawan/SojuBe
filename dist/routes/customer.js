"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const bcrypt_1 = __importDefault(require("bcrypt"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const crypto_1 = require("crypto");
const client_1 = require("@prisma/client");
const database_1 = __importDefault(require("../utils/database"));
const customerAuth_1 = require("../middleware/customerAuth");
const response_1 = require("../utils/response");
const router = (0, express_1.Router)();
const publicCustomer = (customer) => ({
    id: customer.id,
    nama: customer.nama,
    email: customer.email,
    noTelepon: customer.noTelepon,
    alamat: customer.alamat,
    dibuatPada: customer.dibuatPada,
    terakhirMasukPada: customer.terakhirMasukPada,
    promosiDiizinkan: customer.promosiDiizinkan,
    promosiDisetujuiPada: customer.promosiDisetujuiPada,
    promosiBerhentiPada: customer.promosiBerhentiPada,
});
function customerToken(id, email) {
    const secret = process.env.JWT_SECRET;
    if (!secret)
        throw new Error('JWT_SECRET belum diatur di environment');
    return jsonwebtoken_1.default.sign({ id, email, type: 'customer' }, secret, { expiresIn: '30d' });
}
function varianValid(raw, value) {
    if (!value)
        return true;
    return (raw || '').split(',').map((item) => item.trim().toLowerCase()).includes(value.trim().toLowerCase());
}
function cartFromJson(value) {
    if (!Array.isArray(value))
        return [];
    return value.flatMap((entry) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry))
            return [];
        const row = entry;
        const productId = Number(row.productId);
        const jumlah = Number(row.jumlah);
        if (!Number.isInteger(productId) || productId < 1 || !Number.isInteger(jumlah) || jumlah < 1 || jumlah > 99)
            return [];
        return [{ productId, varian: typeof row.varian === 'string' ? row.varian.trim() : '', jumlah, catatan: typeof row.catatan === 'string' ? row.catatan.trim().slice(0, 255) : '' }];
    });
}
async function validCartItems(input) {
    if (!Array.isArray(input))
        throw (0, response_1.errorResponse)('Isi keranjang tidak valid');
    const productsById = new Map();
    const ids = [...new Set(input.map((item) => Number(item?.productId)).filter((id) => Number.isInteger(id) && id > 0))];
    const products = ids.length ? await database_1.default.produk.findMany({
        where: { id: { in: ids }, aktif: true },
        select: { id: true, namaBarang: true, varian: true, satuan: true, hargaDefault: true, gambar: true },
    }) : [];
    for (const product of products)
        productsById.set(product.id, product);
    const normalized = input.map((raw) => {
        const productId = Number(raw?.productId);
        const product = productsById.get(productId);
        const jumlah = Number(raw?.jumlah);
        const varian = typeof raw?.varian === 'string' ? raw.varian.trim() : '';
        const catatan = typeof raw?.catatan === 'string' ? raw.catatan.trim().slice(0, 255) : '';
        if (!product)
            throw (0, response_1.errorResponse)(`Produk ${productId || ''} tidak tersedia`, 400);
        if (!Number.isInteger(jumlah) || jumlah < 1 || jumlah > 99)
            throw (0, response_1.errorResponse)('Jumlah setiap menu harus antara 1 dan 99');
        if (!varianValid(product.varian, varian))
            throw (0, response_1.errorResponse)(`Varian untuk ${product.namaBarang} sudah tidak tersedia`);
        return { product, productId, varian, jumlah, catatan };
    });
    return normalized;
}
// POST /api/customer/auth/daftar
router.post('/auth/daftar', async (req, res, next) => {
    try {
        const nama = typeof req.body?.nama === 'string' ? req.body.nama.trim() : '';
        const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
        const noTelepon = typeof req.body?.noTelepon === 'string' ? req.body.noTelepon.trim() : '';
        const alamat = typeof req.body?.alamat === 'string' ? req.body.alamat.trim() : '';
        const password = typeof req.body?.password === 'string' ? req.body.password : '';
        const promosiDiizinkan = req.body?.promosiDiizinkan === true;
        if (!nama || !email || !noTelepon || !alamat || password.length < 8) {
            throw (0, response_1.errorResponse)('Nama, email, nomor telepon, alamat, dan password minimal 8 karakter wajib diisi');
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
            throw (0, response_1.errorResponse)('Format email tidak valid');
        const existing = await database_1.default.pelanggan.findUnique({ where: { email }, select: { id: true } });
        if (existing)
            throw (0, response_1.errorResponse)('Email sudah terdaftar', 409);
        const customer = await database_1.default.pelanggan.create({
            data: {
                nama, email, noTelepon, alamat, passwordHash: await bcrypt_1.default.hash(password, 10), keranjang: [],
                promosiDiizinkan,
                ...(promosiDiizinkan ? { promosiDisetujuiPada: new Date() } : {}),
            },
        });
        res.status(201).json((0, response_1.successResponse)({ token: customerToken(customer.id, customer.email), customer: publicCustomer(customer) }));
    }
    catch (error) {
        next(error);
    }
});
// POST /api/customer/auth/masuk
router.post('/auth/masuk', async (req, res, next) => {
    try {
        const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
        const password = typeof req.body?.password === 'string' ? req.body.password : '';
        const customer = await database_1.default.pelanggan.findUnique({ where: { email } });
        if (!customer?.aktif || !(await bcrypt_1.default.compare(password, customer.passwordHash)))
            throw (0, response_1.errorResponse)('Email atau password salah', 401);
        const updated = await database_1.default.pelanggan.update({ where: { id: customer.id }, data: { terakhirMasukPada: new Date() } });
        res.json((0, response_1.successResponse)({ token: customerToken(updated.id, updated.email), customer: publicCustomer(updated) }));
    }
    catch (error) {
        next(error);
    }
});
router.use(customerAuth_1.authenticateCustomer);
// GET/PATCH /api/customer/profil
router.get('/profil', async (req, res, next) => {
    try {
        const customer = await database_1.default.pelanggan.findUnique({ where: { id: req.customer.id } });
        if (!customer)
            throw (0, response_1.errorResponse)('Akun customer tidak ditemukan', 404);
        res.json((0, response_1.successResponse)(publicCustomer(customer)));
    }
    catch (error) {
        next(error);
    }
});
router.patch('/profil', async (req, res, next) => {
    try {
        const data = {};
        for (const field of ['nama', 'email', 'noTelepon', 'alamat']) {
            if (req.body?.[field] !== undefined) {
                if (typeof req.body[field] !== 'string' || !req.body[field].trim())
                    throw (0, response_1.errorResponse)(`${field} wajib berupa teks dan tidak boleh kosong`);
                data[field] = req.body[field].trim();
            }
        }
        if (data.email) {
            data.email = data.email.toLowerCase();
            const duplicate = await database_1.default.pelanggan.findFirst({ where: { email: data.email, id: { not: req.customer.id } } });
            if (duplicate)
                throw (0, response_1.errorResponse)('Email sudah digunakan akun lain', 409);
        }
        const updateData = { ...data };
        if (req.body?.promosiDiizinkan !== undefined) {
            if (typeof req.body.promosiDiizinkan !== 'boolean')
                throw (0, response_1.errorResponse)('Pilihan promosi tidak valid');
            updateData.promosiDiizinkan = req.body.promosiDiizinkan;
            if (req.body.promosiDiizinkan) {
                updateData.promosiDisetujuiPada = new Date();
                updateData.promosiBerhentiPada = null;
            }
            else {
                updateData.promosiBerhentiPada = new Date();
            }
        }
        const customer = await database_1.default.pelanggan.update({ where: { id: req.customer.id }, data: updateData });
        res.json((0, response_1.successResponse)(publicCustomer(customer)));
    }
    catch (error) {
        next(error);
    }
});
// GET/PUT /api/customer/keranjang
router.get('/keranjang', async (req, res, next) => {
    try {
        const customer = await database_1.default.pelanggan.findUnique({ where: { id: req.customer.id }, select: { keranjang: true } });
        const cart = cartFromJson(customer?.keranjang ?? null);
        const items = await validCartItems(cart);
        res.json((0, response_1.successResponse)(items.map(({ product, productId, varian, jumlah, catatan }) => ({
            productId, nama: product.namaBarang, varian, jumlah, catatan, harga: product.hargaDefault, satuan: product.satuan, gambar: product.gambar,
        }))));
    }
    catch (error) {
        next(error);
    }
});
router.put('/keranjang', async (req, res, next) => {
    try {
        const items = await validCartItems(req.body?.items);
        const saved = items.map(({ productId, varian, jumlah, catatan }) => ({ productId, varian, jumlah, catatan }));
        await database_1.default.pelanggan.update({ where: { id: req.customer.id }, data: { keranjang: saved } });
        res.json((0, response_1.successResponse)({ jumlahItem: saved.reduce((sum, item) => sum + item.jumlah, 0) }));
    }
    catch (error) {
        next(error);
    }
});
// GET /api/customer/pesanan
router.get('/pesanan', async (req, res, next) => {
    try {
        const pesanan = await database_1.default.pesananPelanggan.findMany({
            where: { pelangganId: req.customer.id },
            include: { item: true },
            orderBy: { dibuatPada: 'desc' },
        });
        res.json((0, response_1.successResponse)(pesanan));
    }
    catch (error) {
        next(error);
    }
});
router.get('/pesanan/:id', async (req, res, next) => {
    try {
        const id = Number(req.params.id);
        const pesanan = await database_1.default.pesananPelanggan.findFirst({
            where: { id, pelangganId: req.customer.id },
            include: { item: true },
        });
        if (!pesanan)
            throw (0, response_1.errorResponse)('Pesanan tidak ditemukan', 404);
        res.json((0, response_1.successResponse)(pesanan));
    }
    catch (error) {
        next(error);
    }
});
// POST /api/customer/checkout; price and product details are read from DB, never trusted from browser.
router.post('/checkout', async (req, res, next) => {
    try {
        const customer = await database_1.default.pelanggan.findUnique({ where: { id: req.customer.id } });
        if (!customer)
            throw (0, response_1.errorResponse)('Akun customer tidak ditemukan', 404);
        const items = await validCartItems(cartFromJson(customer.keranjang));
        if (!items.length)
            throw (0, response_1.errorResponse)('Keranjang masih kosong');
        const total = items.reduce((sum, item) => sum.add(item.product.hargaDefault.mul(item.jumlah)), new client_1.Prisma.Decimal(0));
        const kode = `PSN-${Date.now()}-${String((0, crypto_1.randomInt)(0, 1_000_000)).padStart(6, '0')}`;
        const pesanan = await database_1.default.$transaction(async (tx) => {
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
        res.status(201).json((0, response_1.successResponse)(pesanan, 'Pesanan berhasil dibuat'));
    }
    catch (error) {
        next(error);
    }
});
exports.default = router;
