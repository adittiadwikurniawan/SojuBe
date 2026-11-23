import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import prisma from '../utils/database';
import { consumeToken, issueToken, TokenServiceError } from './tokenService';
import { sendPasswordResetEmail, sendVerificationEmail } from './emailService';

export type CustomerAuthErrorCode =
  | 'INVALID_INPUT'
  | 'EMAIL_ALREADY_EXISTS'
  | 'INVALID_CREDENTIALS'
  | 'ACCOUNT_DISABLED'
  | 'INVALID_TOKEN'
  | 'INVALID_PASSWORD'
  | 'CUSTOMER_NOT_FOUND';

export class CustomerAuthServiceError extends Error {
  public readonly code: CustomerAuthErrorCode;
  public readonly status: number;

  constructor(code: CustomerAuthErrorCode, message: string, status: number) {
    super(message);
    this.name = 'CustomerAuthServiceError';
    this.code = code;
    this.status = status;
  }
}

export const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const GENERIC_CUSTOMER_FORGOT_PASSWORD_MESSAGE =
  'Jika email terdaftar dan aktif, tautan reset password telah dikirim ke email Anda.';

export const GENERIC_RESEND_VERIFICATION_MESSAGE =
  'Jika email terdaftar dan belum terverifikasi, tautan verifikasi baru telah dikirim ke email Anda.';

export const CUSTOMER_VERIFY_EMAIL_SUCCESS_MESSAGE =
  'Email berhasil diverifikasi.';

export const CUSTOMER_RESET_PASSWORD_SUCCESS_MESSAGE =
  'Password berhasil diatur ulang. Silakan masuk dengan password baru Anda.';

export const CUSTOMER_CHANGE_PASSWORD_SUCCESS_MESSAGE =
  'Password berhasil diperbarui.';

export interface PublicCustomerRecord {
  id: number;
  nama: string;
  email: string;
  noTelepon: string;
  alamat: string;
  dibuatPada: Date;
  emailTerverifikasiPada: Date | null;
  terakhirMasukPada: Date | null;
  promosiDiizinkan: boolean;
  promosiDisetujuiPada: Date | null;
  promosiBerhentiPada: Date | null;
}

export const publicCustomer = (customer: PublicCustomerRecord) => ({
  id: customer.id,
  nama: customer.nama,
  email: customer.email,
  noTelepon: customer.noTelepon,
  alamat: customer.alamat,
  dibuatPada: customer.dibuatPada,
  emailTerverifikasiPada: customer.emailTerverifikasiPada ?? null,
  terakhirMasukPada: customer.terakhirMasukPada,
  promosiDiizinkan: customer.promosiDiizinkan,
  promosiDisetujuiPada: customer.promosiDisetujuiPada,
  promosiBerhentiPada: customer.promosiBerhentiPada,
});

export const signCustomerToken = (id: number, email: string): string => {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET belum diatur di environment');
  }
  return jwt.sign({ id, email, type: 'customer' }, secret, { expiresIn: '30d' });
};

export interface RegisterCustomerParams {
  nama: string;
  email: string;
  noTelepon: string;
  alamat: string;
  password: string;
  promosiDiizinkan?: boolean;
}

export interface LoginCustomerParams {
  email: string;
  password: string;
}

export interface ResetCustomerPasswordParams {
  token: string;
  passwordBaru: string;
}

export interface ChangeCustomerPasswordParams {
  customerId: number;
  passwordLama: string;
  passwordBaru: string;
}

export const registerCustomer = async (params: RegisterCustomerParams) => {
  const nama = typeof params.nama === 'string' ? params.nama.trim() : '';
  const email = typeof params.email === 'string' ? params.email.trim().toLowerCase() : '';
  const noTelepon = typeof params.noTelepon === 'string' ? params.noTelepon.trim() : '';
  const alamat = typeof params.alamat === 'string' ? params.alamat.trim() : '';
  const password = typeof params.password === 'string' ? params.password : '';
  const promosiDiizinkan = params.promosiDiizinkan === true;

  if (!nama || !email || !noTelepon || !alamat || password.length < 8) {
    throw new CustomerAuthServiceError(
      'INVALID_INPUT',
      'Nama, email, nomor telepon, alamat, dan password minimal 8 karakter wajib diisi',
      400
    );
  }

  if (!EMAIL_REGEX.test(email)) {
    throw new CustomerAuthServiceError('INVALID_INPUT', 'Format email tidak valid', 400);
  }

  const existing = await prisma.pelanggan.findUnique({
    where: { email },
    select: { id: true },
  });

  if (existing) {
    throw new CustomerAuthServiceError('EMAIL_ALREADY_EXISTS', 'Email sudah terdaftar', 409);
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const customer = await prisma.pelanggan.create({
    data: {
      nama,
      email,
      noTelepon,
      alamat,
      passwordHash,
      keranjang: [],
      promosiDiizinkan,
      ...(promosiDiizinkan ? { promosiDisetujuiPada: new Date() } : {}),
    },
  });

  const issued = await issueToken({
    purpose: 'VERIFY_EMAIL',
    targetType: 'CUSTOMER',
    targetId: customer.id,
  });

  await sendVerificationEmail({
    to: customer.email,
    nama: customer.nama,
    token: issued.token,
    expiresInMinutes: issued.ttlMinutes,
  });

  return {
    token: signCustomerToken(customer.id, customer.email),
    customer: publicCustomer(customer),
  };
};

export const loginCustomer = async (params: LoginCustomerParams) => {
  const email = typeof params.email === 'string' ? params.email.trim().toLowerCase() : '';
  const password = typeof params.password === 'string' ? params.password : '';

  const customer = await prisma.pelanggan.findUnique({
    where: { email },
  });

  if (!customer?.aktif || !(await bcrypt.compare(password, customer.passwordHash))) {
    throw new CustomerAuthServiceError('INVALID_CREDENTIALS', 'Email atau password salah', 401);
  }

  const updated = await prisma.pelanggan.update({
    where: { id: customer.id },
    data: { terakhirMasukPada: new Date() },
  });

  return {
    token: signCustomerToken(updated.id, updated.email),
    customer: publicCustomer(updated),
  };
};

export const verifyCustomerEmail = async (rawToken: string) => {
  const token = typeof rawToken === 'string' ? rawToken.trim() : '';

  if (!token) {
    throw new CustomerAuthServiceError(
      'INVALID_TOKEN',
      'Token verifikasi email wajib diisi',
      400
    );
  }

  let consumed;
  try {
    consumed = await consumeToken({
      rawToken: token,
      purpose: 'VERIFY_EMAIL',
      targetType: 'CUSTOMER',
    });
  } catch (error) {
    if (error instanceof TokenServiceError) {
      throw new CustomerAuthServiceError('INVALID_TOKEN', error.message, 400);
    }
    throw error;
  }

  const customer = await prisma.pelanggan.findUnique({
    where: { id: consumed.targetId },
    select: { id: true, aktif: true },
  });

  if (!customer) {
    throw new CustomerAuthServiceError(
      'CUSTOMER_NOT_FOUND',
      'Akun pelanggan tidak ditemukan',
      404
    );
  }

  if (!customer.aktif) {
    throw new CustomerAuthServiceError(
      'ACCOUNT_DISABLED',
      'Akun pelanggan tidak aktif.',
      403
    );
  }

  const updated = await prisma.pelanggan.update({
    where: { id: customer.id },
    data: { emailTerverifikasiPada: new Date() },
  });

  return {
    customer: publicCustomer(updated),
    message: CUSTOMER_VERIFY_EMAIL_SUCCESS_MESSAGE,
  };
};

export const resendCustomerVerification = async (email: string) => {
  const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';

  if (!normalizedEmail || !EMAIL_REGEX.test(normalizedEmail)) {
    throw new CustomerAuthServiceError('INVALID_INPUT', 'Format email tidak valid', 400);
  }

  const customer = await prisma.pelanggan.findUnique({
    where: { email: normalizedEmail },
    select: {
      id: true,
      nama: true,
      email: true,
      aktif: true,
      emailTerverifikasiPada: true,
    },
  });

  if (customer && customer.aktif && !customer.emailTerverifikasiPada) {
    const issued = await issueToken({
      purpose: 'VERIFY_EMAIL',
      targetType: 'CUSTOMER',
      targetId: customer.id,
    });

    await sendVerificationEmail({
      to: customer.email,
      nama: customer.nama,
      token: issued.token,
      expiresInMinutes: issued.ttlMinutes,
    });
  }

  return {
    message: GENERIC_RESEND_VERIFICATION_MESSAGE,
  };
};

export const requestCustomerPasswordReset = async (email: string) => {
  const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';

  if (!normalizedEmail || !EMAIL_REGEX.test(normalizedEmail)) {
    throw new CustomerAuthServiceError('INVALID_INPUT', 'Format email tidak valid', 400);
  }

  const customer = await prisma.pelanggan.findUnique({
    where: { email: normalizedEmail },
    select: {
      id: true,
      nama: true,
      email: true,
      aktif: true,
    },
  });

  if (customer && customer.aktif) {
    const issued = await issueToken({
      purpose: 'RESET_PASSWORD',
      targetType: 'CUSTOMER',
      targetId: customer.id,
    });

    await sendPasswordResetEmail({
      to: customer.email,
      nama: customer.nama,
      token: issued.token,
      targetType: 'CUSTOMER',
      expiresInMinutes: issued.ttlMinutes,
    });
  }

  return {
    message: GENERIC_CUSTOMER_FORGOT_PASSWORD_MESSAGE,
  };
};

export const resetCustomerPassword = async (params: ResetCustomerPasswordParams) => {
  const token = typeof params.token === 'string' ? params.token.trim() : '';
  const passwordBaru = typeof params.passwordBaru === 'string' ? params.passwordBaru : '';

  if (!token) {
    throw new CustomerAuthServiceError(
      'INVALID_TOKEN',
      'Token reset password wajib diisi',
      400
    );
  }

  if (passwordBaru.length < 8) {
    throw new CustomerAuthServiceError(
      'INVALID_PASSWORD',
      'Password baru minimal 8 karakter',
      400
    );
  }

  let consumed;
  try {
    consumed = await consumeToken({
      rawToken: token,
      purpose: 'RESET_PASSWORD',
      targetType: 'CUSTOMER',
    });
  } catch (error) {
    if (error instanceof TokenServiceError) {
      throw new CustomerAuthServiceError('INVALID_TOKEN', error.message, 400);
    }
    throw error;
  }

  const customer = await prisma.pelanggan.findUnique({
    where: { id: consumed.targetId },
    select: { id: true, aktif: true },
  });

  if (!customer) {
    throw new CustomerAuthServiceError(
      'CUSTOMER_NOT_FOUND',
      'Akun pelanggan tidak ditemukan',
      404
    );
  }

  if (!customer.aktif) {
    throw new CustomerAuthServiceError(
      'ACCOUNT_DISABLED',
      'Akun pelanggan tidak aktif.',
      403
    );
  }

  const passwordHash = await bcrypt.hash(passwordBaru, 10);

  await prisma.pelanggan.update({
    where: { id: customer.id },
    data: { passwordHash },
  });

  return {
    message: CUSTOMER_RESET_PASSWORD_SUCCESS_MESSAGE,
  };
};

export const changeCustomerPassword = async (params: ChangeCustomerPasswordParams) => {
  const passwordLama = typeof params.passwordLama === 'string' ? params.passwordLama : '';
  const passwordBaru = typeof params.passwordBaru === 'string' ? params.passwordBaru : '';

  if (!passwordLama || !passwordBaru) {
    throw new CustomerAuthServiceError(
      'INVALID_INPUT',
      'Password lama dan password baru wajib diisi',
      400
    );
  }

  if (passwordBaru.length < 8) {
    throw new CustomerAuthServiceError(
      'INVALID_PASSWORD',
      'Password baru minimal 8 karakter',
      400
    );
  }

  const customer = await prisma.pelanggan.findUnique({
    where: { id: params.customerId },
    select: { id: true, passwordHash: true, aktif: true },
  });

  if (!customer) {
    throw new CustomerAuthServiceError(
      'CUSTOMER_NOT_FOUND',
      'Akun pelanggan tidak ditemukan',
      404
    );
  }

  if (!customer.aktif) {
    throw new CustomerAuthServiceError(
      'ACCOUNT_DISABLED',
      'Akun pelanggan tidak aktif.',
      403
    );
  }

  const isCurrentPasswordValid = await bcrypt.compare(passwordLama, customer.passwordHash);
  if (!isCurrentPasswordValid) {
    throw new CustomerAuthServiceError(
      'INVALID_CREDENTIALS',
      'Password lama tidak sesuai',
      401
    );
  }

  const passwordHash = await bcrypt.hash(passwordBaru, 10);

  await prisma.pelanggan.update({
    where: { id: customer.id },
    data: { passwordHash },
  });

  return {
    message: CUSTOMER_CHANGE_PASSWORD_SUCCESS_MESSAGE,
  };
};
