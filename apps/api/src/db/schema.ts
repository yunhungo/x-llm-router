/**
 * @created 2026-08-10
 * @description 定义数据库结构及兼容迁移。
 * @author yunhungo
 */
export const schemaVersion = 19;

export const schemaMigrationsTableSql = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version integer PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
`;

export const schemaSql = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version integer PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS platform_users (
  id uuid PRIMARY KEY,
  username varchar(80) NOT NULL UNIQUE,
  password_hash text NOT NULL,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS provider_connections (
  id uuid PRIMARY KEY,
  name varchar(120) NOT NULL,
  provider varchar(40) NOT NULL,
  auth_type varchar(40) NOT NULL CHECK (auth_type IN ('oauth', 'api_key')),
  api_mode varchar(40) NOT NULL DEFAULT 'chat.completions'
    CHECK (api_mode IN ('responses', 'chat.completions')),
  status varchar(24) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'error')),
  credentials_ciphertext text NOT NULL,
  account_id varchar(255),
  base_url text NOT NULL,
  default_model varchar(120),
  priority integer NOT NULL DEFAULT 100,
  token_expires_at timestamptz,
  last_error text,
  created_by uuid REFERENCES platform_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS provider_connections_routing_idx
  ON provider_connections(status, priority, created_at);

ALTER TABLE provider_connections
  DROP CONSTRAINT IF EXISTS provider_connections_provider_check;

ALTER TABLE provider_connections
  ADD COLUMN IF NOT EXISTS api_mode varchar(40),
  ADD COLUMN IF NOT EXISTS available_models jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS models_refreshed_at timestamptz,
  ADD COLUMN IF NOT EXISTS models_refresh_error text;

UPDATE provider_connections
   SET api_mode = CASE WHEN auth_type = 'oauth' THEN 'responses' ELSE 'chat.completions' END
 WHERE api_mode IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version >= 10) THEN
    UPDATE provider_connections
       SET provider = 'custom'
     WHERE auth_type = 'api_key'
       AND provider = 'openai-compatible';

    UPDATE provider_connections
       SET provider = CASE
         WHEN lower(base_url) LIKE '%openrouter.ai%' THEN 'openrouter'
         ELSE 'custom'
       END
     WHERE auth_type = 'api_key'
       AND provider = 'openai'
       AND lower(base_url) NOT LIKE 'https://api.openai.com%';
  END IF;
END $$;

ALTER TABLE provider_connections
  ALTER COLUMN api_mode SET DEFAULT 'chat.completions',
  ALTER COLUMN api_mode SET NOT NULL;

ALTER TABLE provider_connections
  DROP CONSTRAINT IF EXISTS provider_connections_api_mode_check;

ALTER TABLE provider_connections
  ADD CONSTRAINT provider_connections_api_mode_check
  CHECK (api_mode IN ('responses', 'chat.completions'));

CREATE TABLE IF NOT EXISTS oauth_device_flows (
  id uuid PRIMARY KEY,
  provider varchar(40) NOT NULL CHECK (provider IN ('openai')),
  desired_name varchar(120) NOT NULL,
  device_auth_id_ciphertext text NOT NULL,
  user_code varchar(64) NOT NULL,
  verification_url text NOT NULL,
  poll_interval_seconds integer NOT NULL DEFAULT 5,
  status varchar(24) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'complete', 'expired', 'failed')),
  expires_at timestamptz NOT NULL,
  last_error text,
  created_by uuid REFERENCES platform_users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS virtual_api_keys (
  id uuid PRIMARY KEY,
  name varchar(120) NOT NULL,
  key_prefix varchar(24) NOT NULL,
  key_hash char(64) NOT NULL UNIQUE,
  status varchar(24) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  budget_usd numeric(14, 6),
  spend_usd numeric(14, 6) NOT NULL DEFAULT 0,
  rpm_limit integer NOT NULL DEFAULT 60,
  expires_at timestamptz,
  last_used_at timestamptz,
  provider_connection_id uuid REFERENCES provider_connections(id) ON DELETE SET NULL,
  created_by uuid REFERENCES platform_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

ALTER TABLE virtual_api_keys
  ADD COLUMN IF NOT EXISTS langfuse_config_ciphertext text,
  ADD COLUMN IF NOT EXISTS middleware_code text,
  ADD COLUMN IF NOT EXISTS middleware_updated_at timestamptz;

CREATE INDEX IF NOT EXISTS virtual_api_keys_status_idx ON virtual_api_keys(status, expires_at);

CREATE TABLE IF NOT EXISTS usage_logs (
  id uuid PRIMARY KEY,
  request_id varchar(120) NOT NULL UNIQUE,
  virtual_api_key_id uuid REFERENCES virtual_api_keys(id) ON DELETE SET NULL,
  provider_connection_id uuid REFERENCES provider_connections(id) ON DELETE SET NULL,
  endpoint varchar(40) NOT NULL,
  requested_model varchar(120) NOT NULL,
  model varchar(120) NOT NULL,
  call_status varchar(24) NOT NULL DEFAULT 'processing'
    CHECK (call_status IN ('processing', 'thinking', 'responding', 'completed', 'failed')),
  status_code integer,
  success boolean,
  input_tokens integer NOT NULL DEFAULT 0,
  cached_input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  reasoning_tokens integer,
  total_tokens integer NOT NULL DEFAULT 0,
  cost_usd numeric(14, 8) NOT NULL DEFAULT 0,
  latency_ms integer NOT NULL DEFAULT 0,
  time_to_first_token_ms integer,
  time_to_first_visible_token_ms integer,
  error_code varchar(120),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE usage_logs
  ADD COLUMN IF NOT EXISTS cached_input_tokens integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS requested_model varchar(120),
  ADD COLUMN IF NOT EXISTS reasoning_tokens integer,
  ADD COLUMN IF NOT EXISTS time_to_first_visible_token_ms integer,
  ADD COLUMN IF NOT EXISTS call_status varchar(24);

UPDATE usage_logs
   SET call_status = CASE WHEN success THEN 'completed' ELSE 'failed' END
 WHERE call_status IS NULL;

ALTER TABLE usage_logs
  ALTER COLUMN call_status SET DEFAULT 'processing',
  ALTER COLUMN call_status SET NOT NULL,
  ALTER COLUMN status_code DROP NOT NULL,
  ALTER COLUMN success DROP NOT NULL;

ALTER TABLE usage_logs
  DROP CONSTRAINT IF EXISTS usage_logs_call_status_check;

ALTER TABLE usage_logs
  ADD CONSTRAINT usage_logs_call_status_check
  CHECK (call_status IN ('processing', 'thinking', 'responding', 'completed', 'failed'));

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version >= 8) THEN
    UPDATE usage_logs
       SET time_to_first_visible_token_ms = time_to_first_token_ms,
           time_to_first_token_ms = NULL
     WHERE time_to_first_visible_token_ms IS NULL
       AND time_to_first_token_ms IS NOT NULL;
  END IF;
END $$;

UPDATE usage_logs
   SET requested_model = model
 WHERE requested_model IS NULL;

UPDATE usage_logs
   SET model = substring(model FROM 9)
 WHERE model LIKE 'chatgpt-gpt-%'
   AND metadata->>'providerAuthType' = 'oauth';

ALTER TABLE usage_logs
  ALTER COLUMN requested_model SET NOT NULL;

CREATE INDEX IF NOT EXISTS usage_logs_created_idx ON usage_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS usage_logs_created_id_idx ON usage_logs(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS usage_logs_key_created_idx ON usage_logs(virtual_api_key_id, created_at DESC);
CREATE INDEX IF NOT EXISTS usage_logs_model_created_idx ON usage_logs(model, created_at DESC);

CREATE TABLE IF NOT EXISTS usage_log_details (
  usage_log_id uuid PRIMARY KEY REFERENCES usage_logs(id) ON DELETE CASCADE,
  gateway_curl text NOT NULL,
  router_api_token_ciphertext text,
  upstream_api_token_ciphertext text,
  upstream_curl text,
  client_request jsonb NOT NULL DEFAULT '{}'::jsonb,
  upstream_request jsonb,
  upstream_response jsonb,
  error jsonb,
  captured_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 days')
);

ALTER TABLE usage_log_details
  ADD COLUMN IF NOT EXISTS router_api_token_ciphertext text;

ALTER TABLE usage_log_details
  ADD COLUMN IF NOT EXISTS upstream_api_token_ciphertext text;

CREATE INDEX IF NOT EXISTS usage_log_details_expires_idx ON usage_log_details(expires_at);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version >= 9) THEN
    UPDATE usage_logs u
       SET reasoning_tokens = (
         jsonb_path_query_first(
           d.upstream_response,
           '$.body.**.reasoning_tokens ? (@.type() == "number")'
         ) #>> '{}'
       )::integer
      FROM usage_log_details d
     WHERE d.usage_log_id = u.id
       AND (u.reasoning_tokens IS NULL OR u.reasoning_tokens = 0);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version >= 8) THEN
    UPDATE usage_logs u
       SET reasoning_tokens =
         (d.upstream_response #>> '{body,usage,output_tokens_details,reasoning_tokens}')::integer
      FROM usage_log_details d
     WHERE d.usage_log_id = u.id
       AND u.reasoning_tokens IS NULL
       AND jsonb_typeof(
         d.upstream_response #> '{body,usage,output_tokens_details,reasoning_tokens}'
       ) = 'number';

    UPDATE usage_logs u
       SET reasoning_tokens =
         (d.upstream_response #>> '{body,usage,completion_tokens_details,reasoning_tokens}')::integer
      FROM usage_log_details d
     WHERE d.usage_log_id = u.id
       AND u.reasoning_tokens IS NULL
       AND jsonb_typeof(
         d.upstream_response #> '{body,usage,completion_tokens_details,reasoning_tokens}'
       ) = 'number';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS platform_settings (
  key varchar(120) PRIMARY KEY,
  value_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  secret_ciphertext text,
  updated_by uuid REFERENCES platform_users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS model_prices (
  virtual_api_key_id uuid REFERENCES virtual_api_keys(id) ON DELETE CASCADE,
  provider varchar(40) NOT NULL DEFAULT '*',
  model_pattern varchar(120) NOT NULL,
  input_per_million numeric(14, 6) NOT NULL,
  cached_input_per_million numeric(14, 6) NOT NULL,
  output_per_million numeric(14, 6) NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE model_prices
  ADD COLUMN IF NOT EXISTS virtual_api_key_id uuid,
  ADD COLUMN IF NOT EXISTS provider varchar(40) NOT NULL DEFAULT '*',
  ADD COLUMN IF NOT EXISTS cached_input_per_million numeric(14, 6);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'model_prices'::regclass
       AND contype = 'f'
       AND conname = 'model_prices_virtual_api_key_id_fkey'
  ) THEN
    ALTER TABLE model_prices
      ADD CONSTRAINT model_prices_virtual_api_key_id_fkey
      FOREIGN KEY (virtual_api_key_id) REFERENCES virtual_api_keys(id) ON DELETE CASCADE;
  END IF;
END $$;

UPDATE model_prices
   SET cached_input_per_million = input_per_million
 WHERE cached_input_per_million IS NULL;

ALTER TABLE model_prices
  ALTER COLUMN cached_input_per_million SET NOT NULL;

ALTER TABLE model_prices DROP CONSTRAINT IF EXISTS model_prices_pkey;

CREATE UNIQUE INDEX IF NOT EXISTS model_prices_scope_provider_pattern_uidx
  ON model_prices(virtual_api_key_id, provider, model_pattern) NULLS NOT DISTINCT;

-- Keep enough precision when CNY prices are normalized into the existing USD ledger.
ALTER TABLE usage_logs ALTER COLUMN cost_usd TYPE numeric(20, 12);
ALTER TABLE virtual_api_keys ALTER COLUMN spend_usd TYPE numeric(20, 12);

CREATE TABLE IF NOT EXISTS provider_model_prices (
  provider_connection_id uuid NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
  provider varchar(40) NOT NULL DEFAULT '*',
  model_pattern varchar(120) NOT NULL,
  currency varchar(3) NOT NULL DEFAULT 'CNY' CHECK (currency = 'CNY'),
  input_per_million numeric(14, 6) NOT NULL CHECK (input_per_million >= 0),
  cached_input_per_million numeric(14, 6) NOT NULL CHECK (cached_input_per_million >= 0),
  output_per_million numeric(14, 6) NOT NULL CHECK (output_per_million >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_connection_id, provider, model_pattern)
);

-- Migrate only unanimous rules: conflicting Key overrides cannot be safely shared.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version >= 16) THEN
    INSERT INTO provider_model_prices (
      provider_connection_id, provider, model_pattern, currency,
      input_per_million, cached_input_per_million, output_per_million
    )
    SELECT p.id, m.provider, m.model_pattern, 'CNY',
           min(m.input_per_million) * 6.7, min(m.cached_input_per_million) * 6.7, min(m.output_per_million) * 6.7
      FROM provider_connections p
      JOIN model_prices m ON m.provider IN (p.provider, '*')
      LEFT JOIN virtual_api_keys k ON k.id = m.virtual_api_key_id
     WHERE (m.virtual_api_key_id IS NULL OR k.provider_connection_id = p.id)
       AND (
         m.virtual_api_key_id IS NOT NULL
         OR m.provider = p.provider
         OR starts_with(p.default_model, m.model_pattern)
         OR EXISTS (
           SELECT 1 FROM jsonb_array_elements_text(p.available_models) AS catalog(model)
            WHERE starts_with(catalog.model, m.model_pattern)
         )
       )
     GROUP BY p.id, m.provider, m.model_pattern
    HAVING count(DISTINCT (m.input_per_million, m.cached_input_per_million, m.output_per_million)) = 1
    ON CONFLICT DO NOTHING;
  END IF;
END $$;

-- Repair wildcard catalog rows copied to unrelated connections by version 16.
-- Transaction timestamps identify untouched imports; user edits and Key-specific
-- rules are preserved, and the original USD rules remain in model_prices.
DELETE FROM provider_model_prices price
 USING provider_connections p, schema_migrations migration
 WHERE migration.version = 16
   AND price.provider_connection_id = p.id
   AND price.provider = '*'
   AND price.updated_at = migration.applied_at
   AND NOT COALESCE(starts_with(p.default_model, price.model_pattern), false)
   AND NOT EXISTS (
     SELECT 1 FROM jsonb_array_elements_text(p.available_models) AS catalog(model)
      WHERE starts_with(catalog.model, price.model_pattern)
   )
   AND EXISTS (
     SELECT 1 FROM model_prices legacy
      WHERE legacy.virtual_api_key_id IS NULL
        AND legacy.provider = price.provider
        AND legacy.model_pattern = price.model_pattern
        AND legacy.input_per_million * 6.7 = price.input_per_million
        AND legacy.cached_input_per_million * 6.7 = price.cached_input_per_million
        AND legacy.output_per_million * 6.7 = price.output_per_million
   )
   AND NOT EXISTS (
     SELECT 1 FROM model_prices legacy
     JOIN virtual_api_keys k ON k.id = legacy.virtual_api_key_id
      WHERE k.provider_connection_id = p.id
        AND legacy.provider = price.provider
        AND legacy.model_pattern = price.model_pattern
   );

`;

const costBreakdownSql = `
ALTER TABLE usage_logs ADD COLUMN IF NOT EXISTS cost_breakdown jsonb;
`;

const legacyCostBreakdownSql = `
-- Only reconstruct historical parts when today's matching price reproduces the ledger total.
WITH priced AS (
  SELECT u.id, u.input_tokens, u.cached_input_tokens, u.output_tokens,
         price.input_per_million, price.cached_input_per_million, price.output_per_million,
         GREATEST(u.input_tokens - LEAST(u.input_tokens, u.cached_input_tokens), 0) AS uncached_tokens,
         LEAST(u.input_tokens, u.cached_input_tokens) AS cached_tokens
    FROM usage_logs u
    JOIN provider_connections pc ON pc.id = u.provider_connection_id
    JOIN LATERAL (
      SELECT input_per_million, cached_input_per_million, output_per_million
        FROM provider_model_prices
       WHERE provider_connection_id = u.provider_connection_id
         AND provider IN (pc.provider, '*')
         AND starts_with(u.model, model_pattern)
       ORDER BY CASE WHEN provider = pc.provider THEN 0 ELSE 1 END,
                length(model_pattern) DESC
       LIMIT 1
    ) price ON true
   WHERE u.cost_breakdown IS NULL
     AND u.cost_usd > 0
     AND u.call_status IN ('completed', 'failed')
), matched AS (
  SELECT priced.*,
         (uncached_tokens * input_per_million +
          cached_tokens * cached_input_per_million +
          output_tokens * output_per_million) / 1000000 AS total_cny
    FROM priced
)
UPDATE usage_logs u
   SET cost_breakdown = jsonb_build_object(
     'inputPerMillionCny', matched.input_per_million::float8,
     'cachedInputPerMillionCny', matched.cached_input_per_million::float8,
     'outputPerMillionCny', matched.output_per_million::float8,
     'inputCostUsd', (matched.uncached_tokens * matched.input_per_million / 1000000 / 6.7)::float8,
     'cachedInputCostUsd', (matched.cached_tokens * matched.cached_input_per_million / 1000000 / 6.7)::float8,
     'outputCostUsd', (matched.output_tokens * matched.output_per_million / 1000000 / 6.7)::float8
   )
  FROM matched
 WHERE u.id = matched.id
   AND u.cost_breakdown IS NULL
   AND round(u.cost_usd * 6.7, 8) = round(matched.total_cny, 8);
`;

export const migrations = [
  { version: 17, sql: schemaSql },
  { version: 18, sql: costBreakdownSql },
  { version: schemaVersion, sql: legacyCostBreakdownSql },
] as const;
