// DFE Configuration
// All DFE-specific environment variables are read here.
// When DFE_AUTH_MODE is unset, all DFE middleware is disabled and
// HyperDX behaves exactly as upstream.

const env = process.env;

export const DFE_AUTH_MODE = env.DFE_AUTH_MODE as
  | 'oidc-proxy'
  | undefined;

export const DFE_AUTH_HEADER_EMAIL =
  env.DFE_AUTH_HEADER_EMAIL || 'x-forwarded-email';

export const DFE_AUTH_HEADER_GROUPS =
  env.DFE_AUTH_HEADER_GROUPS || 'x-forwarded-groups';

export const DFE_AUTH_DEFAULT_TEAM = env.DFE_AUTH_DEFAULT_TEAM as
  | string
  | undefined;

// PostgreSQL connection for Casbin RBAC policy store
// This is the same PostgreSQL instance that backs FerretDB
export const CASBIN_PG_URL =
  env.CASBIN_PG_URL || 'postgres://hyperdx:hyperdx@localhost:5432/postgres';

// Path to the Casbin RBAC model configuration file
export const CASBIN_MODEL_PATH =
  env.CASBIN_MODEL_PATH || 'rbac_with_tenants_model.conf';

// Casbin policy reload interval in milliseconds (default: 30 seconds)
export const CASBIN_RELOAD_INTERVAL_MS = Number(
  env.CASBIN_RELOAD_INTERVAL_MS || '30000',
);

export const isDfeEnabled = DFE_AUTH_MODE === 'oidc-proxy';
