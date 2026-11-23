import { Router, Response } from 'express';
import { authenticate, authorizeRoles, AuthRequest } from '../middleware/auth';
import { errorResponse, successResponse } from '../utils/response';
import {
  UserServiceError,
  createUser,
  listUsers,
  softDisableUser,
  triggerUserPasswordReset,
  updateUser,
  updateUserStatus,
} from '../services/userService';

const router = Router();
router.use(authenticate, authorizeRoles('SUPER_ADMIN'));

const mapServiceError = (error: unknown) => {
  if (error instanceof UserServiceError) {
    return errorResponse(error.message, error.status);
  }
  return error;
};

const parseIdParam = (raw: string | string[] | undefined): number => {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw errorResponse('ID pengguna tidak valid', 400);
  }
  return parsed;
};

// GET /api/v1/users?search=&peran=&aktif=
router.get('/', async (req: AuthRequest, res: Response, next) => {
  try {
    const search = typeof req.query.search === 'string' ? req.query.search : undefined;
    const peran = typeof req.query.peran === 'string' ? req.query.peran : undefined;
    const aktif = typeof req.query.aktif === 'string' ? req.query.aktif : undefined;

    const users = await listUsers({ search, peran, aktif });
    res.json(successResponse(users));
  } catch (error) {
    next(mapServiceError(error));
  }
});

// POST /api/v1/users
router.post('/', async (req: AuthRequest, res: Response, next) => {
  try {
    const nama = typeof req.body?.nama === 'string' ? req.body.nama : '';
    const email = typeof req.body?.email === 'string' ? req.body.email : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : undefined;
    const peran = typeof req.body?.peran === 'string' ? req.body.peran : undefined;
    const sendInvite =
      req.body?.sendInvite === true || req.body?.kirimUndangan === true;

    const result = await createUser({
      actorId: req.user!.id,
      actorName: req.user!.email,
      nama,
      email,
      password,
      peran,
      sendInvite,
    });

    res.status(201).json(
      successResponse(
        result.user,
        result.inviteSent
          ? 'Akun Admin berhasil dibuat dan email undangan telah dikirim'
          : 'Akun Admin berhasil dibuat'
      )
    );
  } catch (error) {
    next(mapServiceError(error));
  }
});

// PATCH /api/v1/users/:id
router.patch('/:id', async (req: AuthRequest, res: Response, next) => {
  try {
    const targetId = parseIdParam(req.params.id);
    const updated = await updateUser({
      actorId: req.user!.id,
      targetId,
      nama: req.body?.nama,
      email: req.body?.email,
      peran: req.body?.peran,
    });

    res.json(successResponse(updated, 'Data akun admin berhasil diperbarui'));
  } catch (error) {
    next(mapServiceError(error));
  }
});

// PATCH /api/v1/users/:id/status
router.patch('/:id/status', async (req: AuthRequest, res: Response, next) => {
  try {
    const targetId = parseIdParam(req.params.id);
    const updated = await updateUserStatus({
      actorId: req.user!.id,
      targetId,
      aktif: req.body?.aktif,
    });

    res.json(
      successResponse(
        updated,
        updated.aktif ? 'Akun admin berhasil diaktifkan' : 'Akun admin berhasil dinonaktifkan'
      )
    );
  } catch (error) {
    next(mapServiceError(error));
  }
});

// POST /api/v1/users/:id/reset-password
router.post('/:id/reset-password', async (req: AuthRequest, res: Response, next) => {
  try {
    const targetId = parseIdParam(req.params.id);
    const result = await triggerUserPasswordReset({
      actorId: req.user!.id,
      targetId,
    });

    res.status(200).json(
      successResponse(
        { userId: result.userId, email: result.email },
        result.message
      )
    );
  } catch (error) {
    next(mapServiceError(error));
  }
});

// DELETE /api/v1/users/:id (soft-disable)
router.delete('/:id', async (req: AuthRequest, res: Response, next) => {
  try {
    const targetId = parseIdParam(req.params.id);
    const updated = await softDisableUser({
      actorId: req.user!.id,
      targetId,
    });

    res.json(successResponse(updated, 'Akun admin berhasil dinonaktifkan'));
  } catch (error) {
    next(mapServiceError(error));
  }
});

export default router;
