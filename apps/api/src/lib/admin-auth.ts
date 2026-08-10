import type { FastifyReply, FastifyRequest } from 'fastify';

export async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    await request.jwtVerify();
  } catch {
    await reply.code(401).send({ error: { code: 'unauthorized', message: '请先登录管理后台。' } });
  }
}

export function adminId(request: FastifyRequest): string {
  return request.user.sub;
}
