import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import prisma from '../utils/database';
import { consumeToken, issueToken, TokenServiceError } from './tokenService';
import { sendPasswordResetEmail } from './emailService';

export type AuthErrorCode =
  | 'INVALID_CREDENTIALS'
  | 'ACCOUNT_DISABLED'
  | 'INVALID_TOKEN'
  | 'INVALID_PASSWORD'
  | 'USER_NOT_FOUND';

export class AuthServiceError extends Error {
  public readonly code: AuthErrorCode;
  public readonly status: number;

  constructor(code: AuthErrorCode, message: string, status: number) {
    super(message);
    this.name = 'AuthServiceError';
    this.code = code;
    this.status = status;
  }
}

export const GENERIC_FORGOT_PASSWORD_MESSAGE =
  'Jika email terdaftar dan aktif, tautan reset password telah dikirim ke email Anda.';

export const RESET_PASSWORD_SUCCESS_MESSAGE =
  'Password berhasil diatur ulang. Silakan masuk dengan password baru Anda.';

export interface LoginParams {
  email: string;
  password: string;
}

export interface ResetPasswordParams {
  token: string;
  passwordBaru: string;
}

export const login = async (params: LoginParams) => {
  const email = params.email.trim().toLowerCase();

  const user = await prisma.pengguna.findUnique({
    where: { email },
  });

  if (!user) {
    throw new AuthServiceError('INVALID_CREDENTIALS', 'Email atau password tidak valid', 401);
  }

  const isValidPassword = await bcrypt.compare(params.password, user.passwordHash);

  if (!isValidPassword) {
    throw new AuthServiceError('INVALID_CREDENTIALS', 'Email atau password tidak valid', 401);
  }

  if (!user.aktif) {
    throw new AuthServiceError(
      'ACCOUNT_DISABLED',
      'Akun admin dinonaktifkan. Hubungi Super Admin.',
      403
    );
  }

  // Dibaca saat dipanggil (bukan saat modul dimuat) supaya .env sudah ter-load.
  const JWT_SECRET = process.env.JWT_SECRET;
  if (!JWT_SECRET) {
    throw new Error('JWT_SECRET belum diatur di environment');
  }

  const terakhirMasukPada = new Date();
  await prisma.pengguna.update({
    where: { id: user.id },
    data: { terakhirMasukPada },
  });

  const token = jwt.sign(
    { id: user.id, email: user.email, type: 'admin' },
    JWT_SECRET,
    { expiresIn: '7d' }
  );

  return {
    token,
    user: {
      id: user.id,
      nama: user.nama,
      email: user.email,
      peran: user.peran,
      aktif: user.aktif,
      terakhirMasukPada,
    },
  };
};

export const requestPasswordReset = async (email: string) => {
  const normalizedEmail = email.trim().toLowerCase();

  const user = await prisma.pengguna.findUnique({
    where: { email: normalizedEmail },
    select: {
      id: true,
      nama: true,
      email: true,
      aktif: true,
    },
  });

  if (user && user.aktif) {
    const issued = await issueToken({
      purpose: 'RESET_PASSWORD',
      targetType: 'ADMIN',
      targetId: user.id,
    });

    await sendPasswordResetEmail({
      to: user.email,
      nama: user.nama,
      token: issued.token,
      targetType: 'ADMIN',
      expiresInMinutes: issued.ttlMinutes,
    });
  }

  return {
    message: GENERIC_FORGOT_PASSWORD_MESSAGE,
  };
};

export const resetPassword = async (params: ResetPasswordParams) => {
  const token = typeof params.token === 'string' ? params.token.trim() : '';
  const passwordBaru = typeof params.passwordBaru === 'string' ? params.passwordBaru : '';

  if (!token) {
    throw new AuthServiceError('INVALID_TOKEN', 'Token reset password wajib diisi', 400);
  }

  if (passwordBaru.length < 8) {
    throw new AuthServiceError('INVALID_PASSWORD', 'Password baru minimal 8 karakter', 400);
  }

  let consumed;
  try {
    consumed = await consumeToken({
      rawToken: token,
      purpose: 'RESET_PASSWORD',
      targetType: 'ADMIN',
    });
  } catch (error) {
    if (error instanceof TokenServiceError) {
      throw new AuthServiceError('INVALID_TOKEN', error.message, 400);
    }
    throw error;
  }

  const user = await prisma.pengguna.findUnique({
    where: { id: consumed.targetId },
    select: { id: true, aktif: true },
  });

  if (!user) {
    throw new AuthServiceError('USER_NOT_FOUND', 'Akun admin tidak ditemukan', 404);
  }

  if (!user.aktif) {
    throw new AuthServiceError(
      'ACCOUNT_DISABLED',
      'Akun admin dinonaktifkan. Hubungi Super Admin.',
      403
    );
  }

  const passwordHash = await hashPassword(passwordBaru);

  await prisma.pengguna.update({
    where: { id: user.id },
    data: { passwordHash },
  });

  return {
    message: RESET_PASSWORD_SUCCESS_MESSAGE,
  };
};

export const hashPassword = async (password: string): Promise<string> => {
  return await bcrypt.hash(password, 10);
};
