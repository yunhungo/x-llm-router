# Provider Adapter 架构

网关路由只依赖 `ProviderAdapter`，不包含任何 Provider 的协议或认证分支。运行时流程为：

1. `services/providers.ts` 从 PostgreSQL 解析连接和认证信息。
2. `providers/registry.ts` 按连接的 `provider` 字段选择 Adapter。
3. Adapter 将网关请求准备为上游请求，并声明响应转换模式。
4. 网关统一执行 HTTP、断连处理、Langfuse 追踪和用量记录。
5. Adapter 负责 JSON 响应和 SSE 事件流的协议转换。

## OpenAI Adapter

- OpenAI API Key：Responses 和 Chat Completions 均原样直通。
- ChatGPT OAuth：上游只调用 Responses；Chat Completions 请求、非流式响应、SSE 文本增量、工具调用和 usage 由 Adapter 双向转换。
- Responses 请求保持 Responses 语义；字符串 `input` 会规范化为输入 Item 列表。

## OpenAI-compatible Adapter

DeepSeek 和自定义 OpenAI-compatible 上游使用通用直通 Adapter。每个实现通过 capability 明确声明可用端点；当前 DeepSeek 只声明其官方 Chat Completions 接口，不会把不支持的 Responses 请求发送到上游。

## 新增 Provider

新增 Provider 时只需：

1. 实现 `providers/types.ts` 中的 `ProviderAdapter`。
2. 在 `providers/registry.ts` 注册实现。
3. 根据 Provider 的认证方式增加凭据录入；API Key 类型已使用通用的 `provider` 字段。

Provider 数据库字段不再限制为 OpenAI。未注册的 Provider 会在创建连接或路由时明确拒绝，不会进入网关主流程。
