# Provider 运行时架构

API Key Provider 统一注册到 Pi AI 运行时。运行时流程为：

1. `services/providers.ts` 从 PostgreSQL 解析连接和认证信息。
2. Registry 从 Pi AI 的预置目录或 `custom` 定义中解析 Provider 和模型。
3. Pi AI 将 Responses/Chat Completions 请求转换为模型原生协议，执行 HTTP 请求并输出统一事件流。
4. xRouter 将统一事件流编码为客户端选择的 Responses 或 Chat Completions JSON/SSE。
5. 网关继续负责断连处理、调用详情、usage/cost 落库和 Langfuse observation。

## 两类运行时

- API Key：由 Pi AI 处理预置 Provider 的原生协议；`custom` 的 `api_mode` 描述真实上游协议，两个网关端点均可调用。
- ChatGPT OAuth：继续使用专用 OpenAI Adapter 和 Codex Responses 上游，避免改变现有设备授权及令牌刷新语义。

当网关端点与 OpenAI-compatible 上游协议相同时，Pi AI 的 payload hook 会保留调用方的扩展字段；跨协议或原生 Provider 则从统一 Context 重新构建请求。

## 新增 Provider

新增 Provider 时优先向 Pi AI 注册模型和 Provider；xRouter 会自动将具备 API Key、Base URL 和静态模型目录的条目加入管理目录。若只需接入一个 OpenAI-compatible 地址，无需新增代码，选择 `custom` 即可。

只有需要特殊 OAuth、凭据组合或 xRouter 生命周期逻辑的 Provider 才应增加专用 Adapter。未注册 Provider 会在创建连接时明确拒绝。
