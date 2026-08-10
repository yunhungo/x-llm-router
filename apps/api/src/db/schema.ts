export const schemaVersion = 2;

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
  provider varchar(40) NOT NULL CHECK (provider IN ('openai')),
  auth_type varchar(40) NOT NULL CHECK (auth_type IN ('oauth', 'api_key')),
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
  model varchar(120) NOT NULL,
  status_code integer NOT NULL,
  success boolean NOT NULL,
  input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  total_tokens integer NOT NULL DEFAULT 0,
  cost_usd numeric(14, 8) NOT NULL DEFAULT 0,
  latency_ms integer NOT NULL DEFAULT 0,
  time_to_first_token_ms integer,
  error_code varchar(120),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS usage_logs_created_idx ON usage_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS usage_logs_key_created_idx ON usage_logs(virtual_api_key_id, created_at DESC);
CREATE INDEX IF NOT EXISTS usage_logs_model_created_idx ON usage_logs(model, created_at DESC);

CREATE TABLE IF NOT EXISTS platform_settings (
  key varchar(120) PRIMARY KEY,
  value_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  secret_ciphertext text,
  updated_by uuid REFERENCES platform_users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS model_prices (
  model_pattern varchar(120) PRIMARY KEY,
  input_per_million numeric(14, 6) NOT NULL,
  output_per_million numeric(14, 6) NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO model_prices(model_pattern, input_per_million, output_per_million)
VALUES
  ('gpt-5.6-sol', 5.0, 30.0),
  ('gpt-5.6', 5.0, 30.0),
  ('gpt-5.6-terra', 2.0, 12.0),
  ('gpt-5.6-luna', 0.2, 1.2)
ON CONFLICT (model_pattern) DO NOTHING;
`;
