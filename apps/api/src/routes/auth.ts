import bcrypt from 'bcryptjs';
import type { FastifyInstance } from 'fastify';

import { changePasswordSchema, loginSchema } from '@x-router/contracts';

import { getConfig } from '../config';
import { getPool } from '../db/client';
import { adminId, requireAdmin } from '../lib/admin-auth';

interface UserRow {
  id: string;
  username: string;
  password_hash: string;
}

const COOKIE_NAME = 'xrouter_session';

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/api/auth/login',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const parsed = loginSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: { code: 'invalid_request', message: '用户名或密码格式无效。' } });
      }
      const result = await getPool().query<UserRow>(
        'SELECT id, username, password_hash FROM platform_users WHERE username = $1',
        [parsed.data.username],
      );
      const user = result.rows[0];
      const valid = user ? await bcrypt.compare(parsed.data.password, user.password_hash) : false;
      if (!user || !valid) {
        return reply
          .code(401)
          .send({ error: { code: 'invalid_credentials', message: '用户名或密码错误。' } });
      }

      const token = await reply.jwtSign(
        { sub: user.id, username: user.username },
        { expiresIn: '7d' },
      );
      reply.setCookie(COOKIE_NAME, token, {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: getConfig().NODE_ENV === 'production',
        maxAge: 7 * 24 * 60 * 60,
      });
      await getPool().query('UPDATE platform_users SET last_login_at = now() WHERE id = $1', [
        user.id,
      ]);
      return { user: { id: user.id, username: user.username } };
    },
  );

  app.post('/api/auth/logout', { onRequest: requireAdmin }, async (_request, reply) => {
    reply.clearCookie(COOKIE_NAME, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', { onRequest: requireAdmin }, async (request) => ({
    user: { id: request.user.sub, username: request.user.username },
  }));

  app.patch('/api/auth/account', { onRequest: requireAdmin }, async (request, reply) => {
    const parsed = changePasswordSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: {
          code: 'invalid_request',
          message: parsed.error.issues[0]?.message ?? '输入无效。',
        },
      });
    }
    const result = await getPool().query<UserRow>(
      'SELECT id, username, password_hash FROM platform_users WHERE id = $1',
      [adminId(request)],
    );
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(parsed.data.currentPassword, user.password_hash))) {
      return reply
        .code(403)
        .send({ error: { code: 'invalid_password', message: '当前密码不正确。' } });
    }
    const passwordHash = await bcrypt.hash(parsed.data.newPassword, 12);
    try {
      await getPool().query(
        `UPDATE platform_users
            SET username = $2, password_hash = $3, updated_at = now()
          WHERE id = $1`,
        [user.id, parsed.data.newUsername ?? user.username, passwordHash],
      );
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        return reply
          .code(409)
          .send({ error: { code: 'username_taken', message: '该用户名已被使用。' } });
      }
      throw error;
    }
    reply.clearCookie(COOKIE_NAME, { path: '/' });
    return { ok: true, reauthenticate: true };
  });
}
