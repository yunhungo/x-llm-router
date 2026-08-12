export const schemaVersion = 7;

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

UPDATE provider_connections
   SET provider = 'openai'
 WHERE auth_type = 'api_key' AND provider = 'openai-compatible';

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
  ADD COLUMN IF NOT EXISTS langfuse_config_ciphertext text;

CREATE INDEX IF NOT EXISTS virtual_api_keys_status_idx ON virtual_api_keys(status, expires_at);

CREATE TABLE IF NOT EXISTS usage_logs (
  id uuid PRIMARY KEY,
  request_id varchar(120) NOT NULL UNIQUE,
  virtual_api_key_id uuid REFERENCES virtual_api_keys(id) ON DELETE SET NULL,
  provider_connection_id uuid REFERENCES provider_connections(id) ON DELETE SET NULL,
  endpoint varchar(40) NOT NULL,
  requested_model varchar(120) NOT NULL,
  model varchar(120) NOT NULL,
  status_code integer NOT NULL,
  success boolean NOT NULL,
  input_tokens integer NOT NULL DEFAULT 0,
  cached_input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  total_tokens integer NOT NULL DEFAULT 0,
  cost_usd numeric(14, 8) NOT NULL DEFAULT 0,
  latency_ms integer NOT NULL DEFAULT 0,
  time_to_first_token_ms integer,
  error_code varchar(120),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE usage_logs
  ADD COLUMN IF NOT EXISTS cached_input_tokens integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS requested_model varchar(120);

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
CREATE INDEX IF NOT EXISTS usage_logs_key_created_idx ON usage_logs(virtual_api_key_id, created_at DESC);
CREATE INDEX IF NOT EXISTS usage_logs_model_created_idx ON usage_logs(model, created_at DESC);

CREATE TABLE IF NOT EXISTS usage_log_details (
  usage_log_id uuid PRIMARY KEY REFERENCES usage_logs(id) ON DELETE CASCADE,
  gateway_curl text NOT NULL,
  upstream_curl text,
  client_request jsonb NOT NULL DEFAULT '{}'::jsonb,
  upstream_request jsonb,
  upstream_response jsonb,
  error jsonb,
  captured_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 days')
);

CREATE INDEX IF NOT EXISTS usage_log_details_expires_idx ON usage_log_details(expires_at);

CREATE TABLE IF NOT EXISTS platform_settings (
  key varchar(120) PRIMARY KEY,
  value_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  secret_ciphertext text,
  updated_by uuid REFERENCES platform_users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS model_prices (
  provider varchar(40) NOT NULL DEFAULT '*',
  model_pattern varchar(120) NOT NULL,
  input_per_million numeric(14, 6) NOT NULL,
  cached_input_per_million numeric(14, 6) NOT NULL,
  output_per_million numeric(14, 6) NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(provider, model_pattern)
);

ALTER TABLE model_prices
  ADD COLUMN IF NOT EXISTS provider varchar(40) NOT NULL DEFAULT '*',
  ADD COLUMN IF NOT EXISTS cached_input_per_million numeric(14, 6);

UPDATE model_prices
   SET cached_input_per_million = input_per_million
 WHERE cached_input_per_million IS NULL;

ALTER TABLE model_prices
  ALTER COLUMN cached_input_per_million SET NOT NULL;

DO $$
DECLARE
  primary_key_columns integer;
BEGIN
  SELECT cardinality(conkey)
    INTO primary_key_columns
    FROM pg_constraint
   WHERE conrelid = 'model_prices'::regclass AND contype = 'p';

  IF primary_key_columns = 1 THEN
    ALTER TABLE model_prices DROP CONSTRAINT model_prices_pkey;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'model_prices'::regclass AND contype = 'p'
  ) THEN
    ALTER TABLE model_prices ADD PRIMARY KEY(provider, model_pattern);
  END IF;
END $$;

INSERT INTO model_prices(provider, model_pattern, input_per_million, cached_input_per_million, output_per_million)
VALUES
  ('*', 'gpt-5.6-sol', 5.0, 0.5, 30.0),
  ('*', 'gpt-5.6', 5.0, 0.5, 30.0),
  ('*', 'gpt-5.6-terra', 2.0, 0.2, 12.0),
  ('*', 'gpt-5.6-luna', 0.2, 0.02, 1.2)
ON CONFLICT (provider, model_pattern) DO NOTHING;
`;
