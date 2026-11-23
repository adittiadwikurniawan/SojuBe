import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import type { PeranPengguna } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface MockPengguna {
  id: number;
  nama: string;
  email: string;
  passwordHash: string;
  peran: PeranPengguna;
  aktif: boolean;
  terakhirMasukPada: Date | null;
  dibuatOleh: number | null;
  dibuatPada: Date;
  diubahPada: Date;
}

interface MockPelanggan {
  id: number;
  nama: string;
  email: string;
  telepon: string | null;
  alamat: string | null;
  passwordHash: string;
  aktif: boolean;
  promosiDiizinkan: boolean;
  emailTerverifikasiPada: Date | null;
  dibuatPada: Date;
}

const { users, customers, resetStore, mockPrisma } = vi.hoisted(() => {
  const users: MockPengguna[] = [];
  const customers: MockPelanggan[] = [];

  const applySelect = <T extends Record<string, any>>(
    row: T,
    select?: Record<string, boolean>
  ): Partial<T> => {
    if (!select) return { ...row };
    const selected: Record<string, any> = {};
    for (const [key, include] of Object.entries(select)) {
      if (include) {
        selected[key] = row[key];
      }
    }
    return selected as Partial<T>;
  };

  const mockPrisma = {
    pengguna: {
      findUnique: vi.fn(async ({ where, select }: any) => {
        const found = users.find((u) => {
          if (where.id !== undefined) return u.id === where.id;
          if (where.email !== undefined) return u.email === where.email;
          return false;
        });
        return found ? applySelect(found, select) : null;
      }),
      findMany: vi.fn(async ({ select }: any = {}) =>
        users.map((u) => applySelect(u, select))
      ),
      update: vi.fn(async ({ where, data, select }: any) => {
        const found = users.find((u) => u.id === where.id);
        if (!found) throw new Error('Pengguna tidak ditemukan');
        Object.assign(found, data);
        return applySelect(found, select);
      }),
    },
    pelanggan: {
      findUnique: vi.fn(async ({ where, select }: any) => {
        const found = customers.find((c) => {
          if (where.id !== undefined) return c.id === where.id;
          if (where.email !== undefined) return c.email === where.email;
          return false;
        });
        return found ? applySelect(found, select) : null;
      }),
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => customers.length),
    },
    produk: {
      findMany: vi.fn(async () => [
        {
          id: 1,
          kode: 'PRD-001',
          namaBarang: 'Soju Original',
          varian: '360ml',
          satuan: 'botol',
          harga: 75000,
          gambar: null,
          gambarUrl: null,
          gambarMime: null,
          gambarNama: null,
          deskripsi: 'Produk uji',
          aktif: true,
          dibuatPada: new Date('2026-01-01T00:00:00Z'),
        },
      ]),
    },
    jenisTransaksi: {
      findMany: vi.fn(async () => [
        { id: 1, nama: 'Penjualan', kategori: 'PEMASUKAN' },
        { id: 2, nama: 'Pembelian', kategori: 'PENGELUARAN' },
      ]),
    },
    transaksi: {
      aggregate: vi.fn(async () => ({ _sum: { totalHarga: 0 } })),
      count: vi.fn(async () => 0),
      findMany: vi.fn(async () => []),
    },
    pesananPelanggan: {
      findMany: vi.fn(async () => []),
    },
    keranjangItem: {
      findMany: vi.fn(async () => []),
    },
    logAudit: {
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0),
    },
    cmsContent: {
      findMany: vi.fn(async () => []),
    },
    kampanyePelanggan: {
      findMany: vi.fn(async () => []),
    },
  };

  const resetStore = () => {
    users.length = 0;
    customers.length = 0;
    vi.clearAllMocks();
  };

  return { users, customers, resetStore, mockPrisma };
});

vi.mock('../src/utils/database', () => ({
  default: mockPrisma,
}));

import { app } from '../src/index';

const TEST_JWT_SECRET = 'test-rbac-jwt-secret-key';

const signAdminToken = (user: MockPengguna) =>
  jwt.sign({ id: user.id, email: user.email, role: user.peran }, TEST_JWT_SECRET, {
    expiresIn: '1h',
  });

const signCustomerToken = (customer: MockPelanggan) =>
  jwt.sign({ id: customer.id, email: customer.email, type: 'customer' }, TEST_JWT_SECRET, {
    expiresIn: '1h',
  });

describe('Auth & Role-Boundary Gating Integration (TASK-009)', () => {
  const originalJwtSecret = process.env.JWT_SECRET;
  let superAdmin: MockPengguna;
  let admin: MockPengguna;
  let inactiveAdmin: MockPengguna;
  let customer: MockPelanggan;

  beforeEach(async () => {
    process.env.JWT_SECRET = TEST_JWT_SECRET;
    resetStore();

    const passwordHash = await bcrypt.hash('PasswordKuat123!', 4);
    const now = new Date('2026-01-10T08:00:00Z');

    superAdmin = {
      id: 1,
      nama: 'Super Admin Utama',
      email: 'superadmin@soju.test',
      passwordHash,
      peran: 'SUPER_ADMIN',
      aktif: true,
      terakhirMasukPada: null,
      dibuatOleh: null,
      dibuatPada: now,
      diubahPada: now,
    };

    admin = {
      id: 2,
      nama: 'Admin Operasional',
      email: 'admin@soju.test',
      passwordHash,
      peran: 'ADMIN',
      aktif: true,
      terakhirMasukPada: null,
      dibuatOleh: 1,
      dibuatPada: now,
      diubahPada: now,
    };

    inactiveAdmin = {
      id: 3,
      nama: 'Admin Nonaktif',
      email: 'nonaktif@soju.test',
      passwordHash,
      peran: 'ADMIN',
      aktif: false,
      terakhirMasukPada: null,
      dibuatOleh: 1,
      dibuatPada: now,
      diubahPada: now,
    };

    customer = {
      id: 101,
      nama: 'Pelanggan Uji',
      email: 'customer@soju.test',
      telepon: '081234567890',
      alamat: 'Jl. Uji Coba No. 1',
      passwordHash,
      aktif: true,
      promosiDiizinkan: true,
      emailTerverifikasiPada: now,
      dibuatPada: now,
    };

    users.push(superAdmin, admin, inactiveAdmin);
    customers.push(customer);
  });

  afterEach(() => {
    if (originalJwtSecret === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = originalJwtSecret;
    }
    vi.clearAllMocks();
  });

  describe('ADMIN operational access vs SUPER_ADMIN-only gating', () => {
    const sharedOperationalEndpoints = [
      '/api/v1/products',
      '/api/v1/dashboard/summary',
      '/api/v1/transactions',
      '/api/v1/customer-orders',
      '/api/v1/audit-log',
    ];

    const superAdminOnlyEndpoints = [
      '/api/v1/users',
      '/api/v1/cms/content',
      '/api/v1/customers',
      '/api/v1/customer-campaigns',
    ];

    it.each(sharedOperationalEndpoints)(
      'allows ADMIN on shared operational route %s (200)',
      async (path) => {
        const res = await request(app)
          .get(path)
          .set('Authorization', `Bearer ${signAdminToken(admin)}`);

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
      }
    );

    it.each(superAdminOnlyEndpoints)(
      'rejects ADMIN with 403 on SUPER_ADMIN-only route %s',
      async (path) => {
        const res = await request(app)
          .get(path)
          .set('Authorization', `Bearer ${signAdminToken(admin)}`);

        expect(res.status).toBe(403);
        expect(res.body.success).toBe(false);
      }
    );

    it.each([...sharedOperationalEndpoints, ...superAdminOnlyEndpoints])(
      'allows SUPER_ADMIN on route %s (200)',
      async (path) => {
        const res = await request(app)
          .get(path)
          .set('Authorization', `Bearer ${signAdminToken(superAdmin)}`);

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
      }
    );
  });

  describe('Cross-token isolation between /api/v1/* and /api/customer/*', () => {
    const adminApiEndpoints = [
      '/api/v1/products',
      '/api/v1/dashboard/summary',
      '/api/v1/transactions',
      '/api/v1/customer-orders',
      '/api/v1/audit-log',
      '/api/v1/users',
      '/api/v1/cms/content',
      '/api/v1/customers',
      '/api/v1/customer-campaigns',
    ];

    const customerProtectedEndpoints = [
      '/api/customer/profil',
      '/api/customer/keranjang',
      '/api/customer/pesanan',
    ];

    it.each(adminApiEndpoints)(
      'rejects CUSTOMER JWT with 401 on admin route %s',
      async (path) => {
        const res = await request(app)
          .get(path)
          .set('Authorization', `Bearer ${signCustomerToken(customer)}`);

        expect(res.status).toBe(401);
        expect(res.body.success).toBe(false);
      }
    );

    it.each(customerProtectedEndpoints)(
      'rejects ADMIN JWT with 401 on customer route %s',
      async (path) => {
        const res = await request(app)
          .get(path)
          .set('Authorization', `Bearer ${signAdminToken(admin)}`);

        expect(res.status).toBe(401);
        expect(res.body.success).toBe(false);
      }
    );

    it.each(customerProtectedEndpoints)(
      'rejects SUPER_ADMIN JWT with 401 on customer route %s',
      async (path) => {
        const res = await request(app)
          .get(path)
          .set('Authorization', `Bearer ${signAdminToken(superAdmin)}`);

        expect(res.status).toBe(401);
        expect(res.body.success).toBe(false);
      }
    );

    it('allows CUSTOMER JWT on /api/customer/profil (200)', async () => {
      const res = await request(app)
        .get('/api/customer/profil')
        .set('Authorization', `Bearer ${signCustomerToken(customer)}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.email).toBe(customer.email);
    });
  });

  describe('Inactive admin (aktif = false) enforcement', () => {
    it('rejects inactive admin JWT with 403 on protected admin routes', async () => {
      const token = signAdminToken(inactiveAdmin);

      const productsRes = await request(app)
        .get('/api/v1/products')
        .set('Authorization', `Bearer ${token}`);
      expect(productsRes.status).toBe(403);
      expect(productsRes.body.success).toBe(false);

      const dashboardRes = await request(app)
        .get('/api/v1/dashboard/summary')
        .set('Authorization', `Bearer ${token}`);
      expect(dashboardRes.status).toBe(403);
      expect(dashboardRes.body.success).toBe(false);
    });

    it('rejects inactive admin login with 403 on POST /api/v1/auth/login', async () => {
      const res = await request(app).post('/api/v1/auth/login').send({
        email: inactiveAdmin.email,
        password: 'PasswordKuat123!',
      });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });
  });
});
