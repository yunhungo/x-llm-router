import type { Completion } from '@codemirror/autocomplete';

type CompletionKind = 'property' | 'function';

function item(label: string, type: CompletionKind, detail: string, info?: string): Completion {
  return { label, type, detail, ...(info ? { info } : {}) };
}

const property = (label: string, detail: string, info?: string) =>
  item(label, 'property', detail, info);
const fn = (label: string, detail: string, info?: string) => item(label, 'function', detail, info);

export const middlewareCompletionOptions: readonly Completion[] = [
  property('ctx.request', 'KeyMiddlewareRequest', '当前客户端请求；onRequest 中可直接修改。'),
  property('ctx.request.method', 'string', '客户端 HTTP 方法。'),
  property('ctx.request.url', 'string', '客户端请求的完整 URL。'),
  property(
    'ctx.request.headers',
    'Record<string, string | string[] | undefined>',
    '客户端请求头，只应用于读取。',
  ),
  property(
    'ctx.request.body',
    'ResponsesRequestBody | ChatCompletionsRequestBody',
    '根据 ctx.endpoint 判断请求体类型；未知或 provider 扩展字段仍可直接读写。',
  ),
  property(
    'ctx.request.upstreamHeaders',
    'Record<string, string>',
    '要追加到上游请求的安全自定义请求头。',
  ),

  property('ctx.request.body.model', 'string', 'Responses / Chat Completions'),
  property('ctx.request.body.stream', 'boolean', 'Responses / Chat Completions'),
  property('ctx.request.body.temperature', 'number', 'Responses / Chat Completions'),
  property('ctx.request.body.top_p', 'number', 'Responses / Chat Completions'),
  property('ctx.request.body.tools', 'Tool[]', 'Responses / Chat Completions'),
  property('ctx.request.body.tool_choice', 'string | object', 'Responses / Chat Completions'),
  property('ctx.request.body.parallel_tool_calls', 'boolean', 'Responses / Chat Completions'),
  property('ctx.request.body.metadata', 'Record<string, string>', 'Responses / Chat Completions'),
  property('ctx.request.body.user', 'string', 'Responses / Chat Completions'),
  property('ctx.request.body.input', 'string | ResponseInputItem[]', '仅 Responses API。'),
  property('ctx.request.body.instructions', 'string', '仅 Responses API。'),
  property('ctx.request.body.max_output_tokens', 'number', '仅 Responses API。'),
  property('ctx.request.body.previous_response_id', 'string | null', '仅 Responses API。'),
  property(
    'ctx.request.body.reasoning',
    '{ effort?: string; summary?: string }',
    '仅 Responses API。',
  ),
  property('ctx.request.body.store', 'boolean', '仅 Responses API。'),
  property('ctx.request.body.text', 'ResponseTextConfig', '仅 Responses API。'),
  property('ctx.request.body.truncation', "'auto' | 'disabled'", '仅 Responses API。'),
  property('ctx.request.body.messages', 'ChatCompletionMessage[]', '仅 Chat Completions API。'),
  property('ctx.request.body.max_completion_tokens', 'number', '仅 Chat Completions API。'),
  property('ctx.request.body.reasoning_effort', 'string', '仅 Chat Completions API。'),
  property('ctx.request.body.response_format', 'object', '仅 Chat Completions API。'),
  property('ctx.request.body.stop', 'string | string[]', '仅 Chat Completions API。'),
  property('ctx.request.body.stream_options', '{ include_usage?: boolean }', '流式请求配置。'),

  property('ctx.response', 'KeyMiddlewareResponse', '仅 onResponse 中存在。'),
  property('ctx.response.status', 'number', 'HTTP 状态码，范围 100–599。'),
  property('ctx.response.headers', 'Record<string, string>', '发往客户端的响应头，可修改。'),
  property(
    'ctx.response.body',
    'object | string | null',
    "phase='complete' 时通常是 JSON；phase='chunk' 时是 SSE 文本。",
  ),
  property('ctx.response.stream', 'boolean', '是否为流式响应。'),
  property(
    'ctx.response.phase',
    "'headers' | 'chunk' | 'complete'",
    '可用作判别字段，再安全处理 response.body。',
  ),
  property('ctx.response.body.id', 'string', "仅 phase='complete' 的常见响应字段。"),
  property('ctx.response.body.model', 'string', "仅 phase='complete' 的常见响应字段。"),
  property('ctx.response.body.usage', 'Usage', "仅 phase='complete' 的常见响应字段。"),
  property('ctx.response.body.output', 'ResponseOutputItem[]', 'Responses 完整响应。'),
  property('ctx.response.body.output_text', 'string', 'Responses 完整响应。'),
  property('ctx.response.body.choices', 'ChatCompletionChoice[]', 'Chat Completions 完整响应。'),

  property('ctx.key', 'KeyMiddlewareKey', '当前 xRouter 虚拟 API Key 的安全元信息。'),
  property('ctx.key.id', 'string', '虚拟 API Key ID。'),
  property('ctx.key.name', 'string', '虚拟 API Key 名称。'),
  property('ctx.key.prefix', 'string', '虚拟 API Key 前缀，不包含完整密钥。'),
  property('ctx.key.budgetUsd', 'number | null', '配置的总预算；null 表示不限制。'),
  property('ctx.key.spendUsd', 'number', '当前累计消费金额。'),
  property('ctx.key.rpmLimit', 'number', '每分钟请求上限；0 表示不限制。'),
  property('ctx.key.provider', 'KeyMiddlewareProvider', '本次请求实际选中的上游连接。'),
  property('ctx.key.provider.id', 'string', '上游连接 ID。'),
  property('ctx.key.provider.name', 'string', '上游连接名称。'),
  property('ctx.key.provider.slug', 'string', 'provider 标识，例如 openai、anthropic。'),
  property('ctx.key.provider.authType', "'oauth' | 'api_key'", '上游连接认证方式。'),
  property(
    'ctx.key.provider.apiMode',
    "'responses' | 'chat.completions'",
    '上游连接配置的 API 模式。',
  ),
  property('ctx.key.provider.baseUrl', 'string', '上游 API Base URL；不包含认证信息。'),
  property('ctx.key.provider.defaultModel', 'string | null', '上游连接的默认模型。'),

  property(
    'ctx.endpoint',
    "'responses' | 'chat.completions'",
    '客户端调用的网关端点，可用于收窄 request.body。',
  ),
  property('ctx.requestId', 'string', '当前请求 ID。'),
  property('ctx.state', 'Record<string, unknown>', '同一请求内 onRequest/onResponse 共享状态。'),

  fn('ctx.crypto.randomUUID', '() => string', '生成 UUID。'),
  fn('ctx.crypto.sha256', '(value: unknown) => string', '返回 SHA-256 hex。'),
  fn(
    'ctx.crypto.hmacSha256',
    '(secret: unknown, value: unknown) => string',
    '返回 HMAC-SHA256 hex。',
  ),
  fn('ctx.base64.encode', '(value: unknown) => string'),
  fn('ctx.base64.decode', '(value: unknown) => string'),
  fn('ctx.base64.urlEncode', '(value: unknown) => string'),
  fn('ctx.base64.urlDecode', '(value: unknown) => string'),
  fn('ctx.url.parse', '(value: unknown) => ParsedUrl'),
  fn('ctx.url.resolve', '(value: unknown, base: unknown) => string'),
  property('ctx.modules.crypto', 'typeof ctx.crypto'),
  property('ctx.modules.base64', 'typeof ctx.base64'),
  property('ctx.modules.url', 'typeof ctx.url'),
  fn('ctx.log.debug', '(...values: unknown[]) => void'),
  fn('ctx.log.info', '(...values: unknown[]) => void'),
  fn('ctx.log.warn', '(...values: unknown[]) => void'),
  fn('ctx.log.error', '(...values: unknown[]) => void'),
];
