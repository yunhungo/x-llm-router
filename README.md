# xRouter

xRouter 是一个可自托管的 OpenAI 兼容 LLM 网关。管理端可以配置 Pi AI 预置或自定义 Provider、完成 GPT OAuth 设备授权、签发虚拟 Key，并查看调用统计、成本和 Langfuse 追踪；客户端统一通过 `/v1/responses` 或 `/v1/chat/completions` 访问。

## 首版能力

- ChatGPT OAuth：采用 Codex 官方设备码授权流程，访问令牌、刷新令牌和账号信息以 AES-256-GCM 加密保存。
- Pi AI Provider：预置 OpenAI、OpenRouter、Anthropic、Google、xAI、Groq、DeepSeek 等 Provider，并允许注册自定义 OpenAI-compatible 上游。
- 双协议网关：Pi AI 负责构建上游请求、解析流、归一化文本/思考/工具调用/用量；xRouter 对外暴露 Responses 与 Chat Completions 的 JSON 和 SSE。
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
  Fastify Gateway ──────► Pi AI ──► API Key providers
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
- 健康检查：<http://localhost:59051/readyz>（响应中的 `buildSha` 可用于确认当前容器对应的 Git 提交）
- 默认管理员账号：`admin`
- 默认管理员密码：`change-me-now`

GitHub Actions 只发布一个同时包含 API 与管理后台的 `x-llm-router` 镜像，目标为 `ghcr.io/<owner>/x-llm-router` 和 Docker Hub 的 `<DOCKERHUB_USERNAME>/x-llm-router`。

数据库账号写在 Compose 中且不映射到宿主机端口。首次启动时，应用会在 PostgreSQL 的 `platform_settings` 表中生成 JWT 密钥和凭据加密密钥，后续启动复用原值。所有持久化数据均保存在 `/share/Container/xrouter/postgres`；请备份该目录，并在首次登录后立即修改默认管理员密码。

## 配置上游

### GPT OAuth

进入「上游连接」→「GPT OAuth」，系统会请求一次性设备码并打开 OpenAI 授权页。授权完成后，管理台会轮询状态并创建连接。设备码 15 分钟过期；只确认你本人从 xRouter 发起的授权。

首次使用前，需要在 ChatGPT 个人账号的安全设置中启用 Device Code，或由工作区管理员在权限设置中启用设备码登录。若未启用，OpenAI 会拒绝设备授权请求。

如果部署网络不能直连 `auth.openai.com` 和 `chatgpt.com`，请为应用容器配置可达的 HTTP(S) 代理。代理地址不能写容器内的 `127.0.0.1` 或 `localhost`；应使用容器能够访问的主机名、局域网地址或同一 Docker 网络中的代理服务。宿主机代理还必须监听非 loopback 地址并允许 Docker 网段访问。下面的地址只是示例，请替换为实际代理地址：

```bash
XROUTER_HTTP_PROXY=http://192.168.1.20:7897 \
XROUTER_HTTPS_PROXY=http://192.168.1.20:7897 \
docker compose -f docker-compose.release.yml up -d --force-recreate app
```

QNAP/Linux 上若代理运行在 NAS 宿主机，通常填写 NAS 的局域网 IP；也可以显式配置 Docker `host-gateway`。自定义 `XROUTER_NO_PROXY` 时，它会完整替换默认值，必须保留 `localhost,127.0.0.1,db`，并按需加入不应经过代理的内部上游或 Langfuse 域名。

应用要求 Node.js 22.21+ 并已启用环境代理支持。OAuth 网络失败会返回可识别的 `openai_oauth_unavailable`（502），OpenAI 拒绝授权则返回 `openai_oauth_rejected`（502），不再统一显示为不可诊断的 500。

该能力复用 OpenAI Codex 的 ChatGPT 登录与 Codex backend，实际可用模型、额度和地区由连接账号的计划与 OpenAI 策略决定。授权完成后会同步账号当前可见的模型目录；「上游连接」卡片可查看或手动刷新，任一 Key 的全局「模型价格」表会同时列出所有已启用上游同步的模型与该 Key 的历史调用模型。模型目录同步失败不会撤销已经完成的 OAuth 连接，管理台会保留错误原因供重试。对于通用生产 API 工作负载，仍建议添加独立的 OpenAI API Key 连接。

### API Key 上游

进入「上游连接」→「添加上游」，可以直接选择 Pi AI 注册的预置 Provider。xRouter 保存连接、加密凭据和路由优先级；Pi AI 根据请求模型选择对应上游协议，并负责请求构建、SSE 解析以及文本、思考、工具调用、Token 和成本的归一化。无论上游使用哪种协议，客户端都可以调用 xRouter 的 Responses 或 Chat Completions 接口。

若服务不在预置目录中，选择 `Custom OpenAI Compatible`，填写 Base URL，并指定其真实协议：

- Responses API：请求发送到 Base URL 下的 `/responses`。
- Chat Completions API：请求发送到 Base URL 下的 `/chat/completions`。

Base URL 不需要包含上述接口路径。预置 Provider 会展示 Pi AI 自带的模型目录；自定义 Provider 可以通过上游 `/models` 刷新模型。升级时，旧版中以 OpenAI-compatible 形式保存的 OpenRouter 和其他自定义地址会自动迁移到对应 Provider。

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

在「API Keys」中可为每个虚拟 Key 独立配置 Public Key、Secret Key、Base URL、Environment、Trace Name、Version、Tags、用户/会话请求头、自定义 Metadata，以及是否采集输入和输出。保存前可点击「测试连接」校验 Base URL、项目凭据和 OTLP traces 接收端；测试只发送一个不含 span 的空 protobuf 请求，不会写入测试 trace，留空 Secret Key 时会复用已保存的密钥，且不会修改当前配置。保存后立即生效，不需要重启容器。

设置 `LANGFUSE_DIAGNOSTICS=1` 后，Docker 会输出脱敏的 Langfuse 诊断日志；未设置或设为 `0` 时默认关闭。Compose 可通过同名环境变量控制该开关。诊断日志会记录 SDK 启动、项目加载、observation 创建与结束、span 是否匹配并进入当前虚拟 Key 的 exporter 队列，以及 OTLP 导出失败；不会记录 Secret Key、Authorization、输入输出、Base URL 路径或 exporter 响应正文。开启后可用下面的命令查看：

```bash
docker logs --since 30m xrouter-app-1 2>&1 \
  | grep -Ei '"component":"langfuse"|Langfuse observation|Observability initialized'
```

一次正常请求应依次出现 `project_registration_checked`、`observation_started`、`span_queued`（`routed:true`）和 `observation_ended`。`span_queued` 表示 span 已交给匹配的 Langfuse processor，SDK 仍按正常批处理策略导出；导出失败会单独出现 `otel_export_error`。排查完成后可将 `LANGFUSE_DIAGNOSTICS=0` 并重建 app 容器；导出错误仍会强制输出。

不同虚拟 Key 的追踪只会进入各自配置的 Langfuse 项目。自托管时将 Base URL 指向对应实例；若输入或输出包含敏感信息，可分别关闭正文采集。

客户端可以通过配置的请求头提供 `userId` 和 `sessionId`。若未提供用户头，xRouter 优先使用 OpenAI 请求体的 `user`，再回退到当前虚拟 Key 的稳定匿名身份；若未提供会话头则不伪造 Session，避免把每次随机 ID 误当成会话。缺失的 `x-request-id` 会由网关逐请求生成 UUID，用于本地调用记录、上游请求和 Langfuse trace 的关联。

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
- 价格优先使用 Pi AI 对已知 Provider/模型计算的请求成本；无法识别时回退到 xRouter 的模型价格表。价格表会合并上游同步模型、连接默认模型和历史调用模型，未知模型仍记录 Token。

## 参考

- [OpenAI Codex authentication](https://learn.chatgpt.com/docs/auth)
- [OpenAI Responses migration guide](https://developers.openai.com/api/docs/guides/migrate-to-responses)
- [Pi AI](https://github.com/earendil-works/pi/tree/main/packages/ai)
- [LiteLLM](https://github.com/BerriAI/litellm)
- [Langfuse JS/TS observability](https://langfuse.com/docs/observability/get-started)
