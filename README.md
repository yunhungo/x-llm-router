# xRouter

xRouter 是一个可自托管的 OpenAI 兼容 LLM 网关。首版聚焦 OpenAI / ChatGPT：管理端可以完成 GPT OAuth 设备授权、OpenAI API Key 连接、虚拟 Key 签发、调用统计、成本估算和 Langfuse 追踪；客户端通过 `/v1/responses` 或 `/v1/chat/completions` 访问。

## 首版能力

- ChatGPT OAuth：采用 Codex 官方设备码授权流程，访问令牌、刷新令牌和账号信息以 AES-256-GCM 加密保存。
- OpenAI API Key：支持官方或兼容 Base URL，密钥不会以明文写入数据库或日志。
- OpenAI 双协议：暴露 Responses 与 Chat Completions；支持 JSON 和 SSE 流式响应。
- 虚拟 API Key：完整 Key 只显示一次；数据库只存 HMAC，支持 RPM、预算、过期时间和固定上游。
- 用量与成本：逐请求记录 Token、状态、延迟、TTFT 与成本，并提供 14/30 天聚合视图。
- Langfuse SDK v5：每个虚拟 API Key 绑定独立 Langfuse 项目，默认不采集提示词/输出正文。
- 管理后台：连接、Key、调用日志、Key 级 Langfuse 和管理员账号全部可视化配置。
- 自托管：PostgreSQL + API + Nginx Web 三服务 Docker Compose，启动时自动执行幂等迁移并创建初始管理员。

## 架构

```text
Client / OpenAI SDK
        │  Bearer xr_...
        ▼
  Fastify Gateway ──────► OpenAI API Key upstream
        │                ► ChatGPT Codex OAuth upstream
        ├── PostgreSQL: users, providers, virtual keys, usage
        └── Langfuse: generation observations (optional)

React Admin UI ─────────► /api/admin/*
```

项目采用 pnpm workspace：

```text
apps/api/                 Fastify 网关、OAuth、用量与管理 API
apps/web/                 React + Vite 管理后台
packages/contracts/       前后端共享 Zod 契约
infra/nginx/              Web 静态托管与 SSE 反向代理
Dockerfile.api            API 多阶段镜像
Dockerfile.web            Web 多阶段镜像
docker-compose.yml        PostgreSQL / API / Web 编排
DESIGN.md                 Vercel-inspired UI 规范
```

## Docker Compose 启动

生产环境先生成独立密钥：

```bash
cp .env.example .env
openssl rand -base64 32  # 写入 ENCRYPTION_KEY
openssl rand -base64 32  # 写入 JWT_SECRET
```

同时修改 `.env` 中的 `POSTGRES_PASSWORD` 与 `INITIAL_ADMIN_PASSWORD`，然后启动：

```bash
docker compose up --build -d
docker compose ps
```

- 管理后台：<http://localhost:3000>
- API：<http://localhost:4000>
- 健康检查：<http://localhost:4000/readyz>

未提供 `.env` 时，Compose 的演示初始账号是 `admin` / `change-me-now`。首次登录后请立即在「平台设置」中修改；默认密钥只适合本机开发，不能用于公网部署。

## 配置上游

### GPT OAuth

进入「上游连接」→「GPT OAuth」，系统会请求一次性设备码并打开 OpenAI 授权页。授权完成后，管理台会轮询状态并创建连接。设备码 15 分钟过期；只确认你本人从 xRouter 发起的授权。

该能力复用 OpenAI Codex 的 ChatGPT 登录与 Codex backend，实际可用模型、额度和地区由连接账号的计划与 OpenAI 策略决定。对于通用生产 API 工作负载，仍建议添加独立的 OpenAI API Key 连接。

### OpenAI API Key

进入「上游连接」→「API Key」，填写密钥、Base URL 和可选默认模型。默认 Base URL 是 `https://api.openai.com/v1`。

## 调用示例

先在「API Keys」页创建虚拟 Key。Responses API：

```bash
curl http://localhost:4000/v1/responses \
  -H "Authorization: Bearer xr_your_virtual_key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.6",
    "input": "Explain why gateways use virtual API keys."
  }'
```

Chat Completions：

```bash
curl http://localhost:4000/v1/chat/completions \
  -H "Authorization: Bearer xr_your_virtual_key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.6",
    "messages": [{"role":"user","content":"Say hello."}],
    "stream": true
  }'
```

OpenAI SDK 只需替换 `baseURL`：

```ts
import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: process.env.XROUTER_API_KEY,
  baseURL: 'http://localhost:4000/v1',
});

const response = await client.responses.create({
  model: 'gpt-5.6',
  input: 'Hello from xRouter',
});
```

## Langfuse

在「API Keys」中为每个虚拟 Key 独立填写 Public Key、Secret Key、Base URL 与 Environment。保存后重启 API 容器：

```bash
docker compose restart api
```

不同虚拟 Key 的追踪只会进入各自配置的 Langfuse 项目。默认不记录输入和输出正文；自托管时将 Base URL 指向对应实例。

## 本地开发

需要 Node.js 22、pnpm 10 和 PostgreSQL 15+：

```bash
cp .env.example .env
docker compose up -d db
pnpm install
pnpm db:migrate
pnpm dev
```

常用质量命令：

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm format:check
```

## 安全边界

- 请使用至少 32 字节随机值作为 `ENCRYPTION_KEY` 和 `JWT_SECRET`，并确保它们彼此不同。
- `ENCRYPTION_KEY` 丢失后无法解密上游凭据；轮换需要重新连接上游。
- 管理端会话使用 HttpOnly、SameSite=Lax Cookie；生产部署必须通过 HTTPS，并将 `WEB_ORIGIN` 设置为准确域名。
- 虚拟 Key 的 RPM 校验由 PostgreSQL 调用日志计算，适合首版和中等流量；多副本高吞吐部署应增加 Redis/Valkey 原子限流。
- 目前价格表内置 GPT-5.6 系列示例，可通过管理 API/数据库更新；未知模型仍记录 Token，但成本显示为 0。

## 参考

- [OpenAI Codex authentication](https://learn.chatgpt.com/docs/auth)
- [OpenAI Responses migration guide](https://developers.openai.com/api/docs/guides/migrate-to-responses)
- [LiteLLM](https://github.com/BerriAI/litellm)
- [Langfuse JS/TS observability](https://langfuse.com/docs/observability/get-started)
