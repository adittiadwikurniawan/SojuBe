import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import app from '../src/index';
import prisma from '../src/utils/database';
import {
  createAiRateLimiter,
  createAuthRateLimiter,
  isOriginAllowed,
} from '../src/middleware/security';

describe('TASK-002: Security Middleware, CORS, Rate Limiting & /api/health', () => {
  const originalCorsOrigin = process.env.CORS_ORIGIN;
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.CORS_ORIGIN = originalCorsOrigin;
    process.env.NODE_ENV = originalNodeEnv;
    vi.restoreAllMocks();
  });

  describe('Helmet security headers', () => {
    it('attaches helmet headers with Cross-Origin-Resource-Policy set to cross-origin', async () => {
      vi.spyOn(prisma, '$queryRaw').mockResolvedValueOnce([{ 1: 1 }] as never);

      const res = await request(app).get('/api/health');

      expect(res.status).toBe(200);
      expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBeDefined();
    });
  });

  describe('Multi-origin & LAN CORS allowlist', () => {
    it('allows http://localhost:3000', async () => {
      const res = await request(app)
        .get('/health')
        .set('Origin', 'http://localhost:3000');

      expect(res.status).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000');
      expect(res.headers['access-control-allow-credentials']).toBe('true');
    });

    it('allows configured comma-separated CORS_ORIGIN entries', async () => {
      process.env.CORS_ORIGIN = 'https://admin.soju.id, https://store.soju.id/';

      const res = await request(app)
        .get('/health')
        .set('Origin', 'https://store.soju.id');

      expect(res.status).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBe('https://store.soju.id');
    });

    it('allows requests without Origin header (Flutter native / curl / K8s probes)', async () => {
      const res = await request(app).get('/health');

      expect(res.status).toBe(200);
    });

    it('allows dev LAN 192.168.x.x origins when NODE_ENV !== production', async () => {
      process.env.NODE_ENV = 'development';

      const res = await request(app)
        .get('/health')
        .set('Origin', 'http://192.168.1.10:3000');

      expect(res.status).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBe('http://192.168.1.10:3000');
    });

    it('blocks LAN 192.168.x.x origins in production unless explicitly configured', () => {
      expect(
        isOriginAllowed('http://192.168.1.10:3000', {
          corsOriginEnv: 'https://soju.id',
          nodeEnv: 'production',
        })
      ).toBe(false);
    });

    it('blocks unknown origins with 403 error envelope and no ACAO header', async () => {
      const res = await request(app)
        .get('/health')
        .set('Origin', 'https://evil.example.com');

      expect(res.status).toBe(403);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
      expect(res.body).toEqual({
        success: false,
        message: 'Origin tidak diizinkan oleh kebijakan CORS',
      });
    });
  });

  describe('Rate limiting (auth & AI)', () => {
    it('enforces 429 JSON envelope when authRateLimiter threshold is exceeded', async () => {
      const testApp = express();
      testApp.use('/auth-test', createAuthRateLimiter({ limit: 2, windowMs: 60_000 }));
      testApp.post('/auth-test', (_req, res) => {
        res.status(200).json({ success: true, data: { ok: true } });
      });

      const r1 = await request(testApp).post('/auth-test');
      const r2 = await request(testApp).post('/auth-test');
      const r3 = await request(testApp).post('/auth-test');

      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);
      expect(r3.status).toBe(429);
      expect(r3.body).toMatchObject({
        success: false,
        message: expect.any(String),
      });
    });

    it('enforces 429 JSON envelope when aiRateLimiter threshold is exceeded', async () => {
      const testApp = express();
      testApp.use('/ai-test', createAiRateLimiter({ limit: 2, windowMs: 60_000 }));
      testApp.post('/ai-test', (_req, res) => {
        res.status(200).json({ success: true, data: { ok: true } });
      });

      const r1 = await request(testApp).post('/ai-test');
      const r2 = await request(testApp).post('/ai-test');
      const r3 = await request(testApp).post('/ai-test');

      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);
      expect(r3.status).toBe(429);
      expect(r3.body).toMatchObject({
        success: false,
        message: expect.any(String),
      });
    });

    it('mounts authRateLimiter on /api/v1/auth/login (standard rate-limit headers present)', async () => {
      const res = await request(app).post('/api/v1/auth/login').send({});

      expect(res.headers['ratelimit-limit']).toBeDefined();
      expect(res.headers['ratelimit-remaining']).toBeDefined();
    });

    it('does not apply authRateLimiter to GET /api/v1/auth/me', async () => {
      const res = await request(app).get('/api/v1/auth/me');

      expect(res.headers['ratelimit-limit']).toBeUndefined();
      expect(res.headers['ratelimit-remaining']).toBeUndefined();
    });
  });

  describe('GET /api/health', () => {
    it('returns 200 with DB connected status when MySQL is reachable', async () => {
      vi.spyOn(prisma, '$queryRaw').mockResolvedValueOnce([{ 1: 1 }] as never);

      const res = await request(app).get('/api/health');

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        success: true,
        data: {
          status: 'ok',
          db: 'connected',
          timestamp: expect.any(String),
        },
      });
    });

    it('returns 503 with DB disconnected status when MySQL is unreachable', async () => {
      vi.spyOn(prisma, '$queryRaw').mockRejectedValueOnce(new Error('P1001: Can\'t reach database server'));

      const res = await request(app).get('/api/health');

      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({
        success: false,
        message: expect.any(String),
        data: {
          status: 'error',
          db: 'disconnected',
        },
      });
    });
  });
});
