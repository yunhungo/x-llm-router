# xRouter

xRouter 是一个可自托管的 OpenAI 兼容 LLM 网关。首版聚焦 OpenAI / ChatGPT：管理端可以完成 GPT OAuth 设备授权、OpenAI API Key 连接、虚拟 Key 签发、调用统计、成本估算和 Langfuse 追踪；客户端通过 `/v1/responses` 或 `/v1/chat/completions` 访问。

## 首版能力

- ChatGPT OAuth：采用 Codex 官方设备码授权流程，访问令牌、刷新令牌和账号信息以 AES-256-GCM 加密保存。
- OpenAI API 上游：使用 OpenAI-compatible 接口，可为每条连接指定 Responses 或 Chat Completions；密钥不会以明文写入数据库或日志。
- OpenAI 双协议：暴露 Responses 与 Chat Completions；支持 JSON 和 SSE 流式响应。
- 虚拟 API Key：完整 Key 只显示一次；数据库只存 HMAC，支持 RPM、预算、过期时间和固定上游。
- 用量与成本：逐请求记录 Token、状态、延迟、TTFT、TPS、缓存命中与成本，并提供天/周/月图表和异常请求下钻。
- Langfuse SDK v5：每个虚拟 API Key 绑定独立 Langfuse 项目，可配置输入输出采集和追踪上下文。
- 管理后台：连接、Key、调用日志、Key 级 Langfuse 和管理员账号全部可视化配置。
- 自托管：PostgreSQL + xRouter 两服务 Docker Compose；单个 xRouter 镜像同时提供 API 和管理后台，启动时自动执行幂等迁移并创建初始管理员。

## 架构

```text
Client / OpenAI SDK
        │  Bearer xr_...
        ▼
  Fastify Gateway ──────► OpenAI API Key upstream
        │                ► ChatGPT Codex OAuth upstream
        ├── serves React Admin UI and /api/admin/*
        ├── PostgreSQL: users, providers, virtual keys, usage
        └── Langfuse: generation observations (optional)
```

项目采用 pnpm workspace：

```text
apps/api/                 Fastify 网关、OAuth、用量与管理 API
apps/web/                 React + Vite 管理后台
packages/contracts/       前后端共享 Zod 契约
Dockerfile                API + Web 单一多阶段镜像
docker-compose.yml        PostgreSQL / xRouter 编排
DESIGN.md                 Vercel-inspired UI 规范
```

## Docker Compose 启动

生产部署不需要创建 `.env` 或手工生成密钥，直接启动：

```bash
docker compose -f docker-compose.release.yml up -d
docker compose -f docker-compose.release.yml ps
```

- 管理后台：<http://localhost:59051>
- API：<http://localhost:59051/v1>
- 健康检查：<http://localhost:59051/readyz>
- 默认管理员账号：`admin`
- 默认管理员密码：`change-me-now`

GitHub Actions 只发布一个同时包含 API 与管理后台的 `x-llm-router` 镜像，目标为 `ghcr.io/<owner>/x-llm-router` 和 Docker Hub 的 `<DOCKERHUB_USERNAME>/x-llm-router`。

数据库账号写在 Compose 中且不映射到宿主机端口。首次启动时，应用会在 PostgreSQL 的 `platform_settings` 表中生成 JWT 密钥和凭据加密密钥，后续启动复用原值。所有持久化数据均保存在 `/share/Container/xrouter/postgres`；请备份该目录，并在首次登录后立即修改默认管理员密码。

## 配置上游

### GPT OAuth

进入「上游连接」→「GPT OAuth」，系统会请求一次性设备码并打开 OpenAI 授权页。授权完成后，管理台会轮询状态并创建连接。设备码 15 分钟过期；只确认你本人从 xRouter 发起的授权。

该能力复用 OpenAI Codex 的 ChatGPT 登录与 Codex backend，实际可用模型、额度和地区由连接账号的计划与 OpenAI 策略决定。对于通用生产 API 工作负载，仍建议添加独立的 OpenAI API Key 连接。

### API Key 上游

进入「上游连接」→「添加上游」，Provider 选择 OpenAI，再选择 API Key 或 OAuth 接入方式。选择 API Key 时，接口类型固定为 OpenAI Compatible，并需要指定 API 方式：

- Responses API：请求发送到 Base URL 下的 `/responses`。
- Chat Completions API：请求发送到 Base URL 下的 `/chat/completions`。

Base URL 不需要包含上述接口路径。输入框可以选择 OpenAI、OpenRouter、SiliconFlow 等常用地址，也可以直接填写其他 OpenAI-compatible 服务的自定义域名，不需要为每个服务商单独增加 Provider 类型。

所有上游密钥都会加密保存。创建虚拟 API Key 时可以固定一个上游；客户端仍只需连接 xRouter 的 `/v1` 地址。

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

在「API Keys」中可为每个虚拟 Key 独立配置 Public Key、Secret Key、Base URL、Environment、Trace Name、Version、Tags、用户/会话请求头、自定义 Metadata，以及是否采集输入和输出。保存后立即生效，不需要重启容器。

不同虚拟 Key 的追踪只会进入各自配置的 Langfuse 项目。自托管时将 Base URL 指向对应实例；若输入或输出包含敏感信息，可分别关闭正文采集。

Key 详情页默认展示最近一天的数据，也可切换到周或月。调用趋势、缓存命中率、TPS、TTFT、端到端延迟、Token 与成本均使用时间序列图展示；成本按请求发生时匹配的模型单价计算并落库。点击时间桶或 P95/P99 等尾延迟指标，可下钻到具体调用记录。

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

- 应用首次启动会在 PostgreSQL 中生成彼此独立的 32 字节 `ENCRYPTION_KEY` 和 `JWT_SECRET`，无需手工配置。
- `ENCRYPTION_KEY` 随 PostgreSQL 数据持久化；数据库数据丢失后，现有上游凭据无法恢复。
- 管理端会话使用 HttpOnly、SameSite=Lax Cookie；合并部署会自动校验当前访问来源，只有前后端分离部署时才需要设置 `WEB_ORIGIN`。
- 虚拟 Key 的 RPM 校验由 PostgreSQL 调用日志计算，适合首版和中等流量；多副本高吞吐部署应增加 Redis/Valkey 原子限流。
- 目前价格表内置 GPT-5.6 系列示例，可通过管理 API/数据库更新；未知模型仍记录 Token，但成本显示为 0。

## 参考

- [OpenAI Codex authentication](https://learn.chatgpt.com/docs/auth)
- [OpenAI Responses migration guide](https://developers.openai.com/api/docs/guides/migrate-to-responses)
- [LiteLLM](https://github.com/BerriAI/litellm)
- [Langfuse JS/TS observability](https://langfuse.com/docs/observability/get-started)
