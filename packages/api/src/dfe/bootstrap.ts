// DFE Bootstrap
// Initializes the Casbin enforcer with the RBAC model and PostgreSQL adapter.
// Called once at startup when DFE_AUTH_MODE === 'oidc-proxy'.
//
// This is a NEW file — it does not modify any upstream HyperDX files.

import path from 'path';

import logger from '@/utils/logger';

import * as dfeConfig from './config';

// Casbin types — imported dynamically to avoid requiring the dependency
// when DFE is not enabled
type Enforcer = import('casbin').Enforcer;

let _enforcer: Enforcer | null = null;
let _initPromise: Promise<Enforcer> | null = null;
let _reloadInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Initialize the Casbin enforcer.
 * Safe to call multiple times — subsequent calls return the same instance.
 */
export async function initEnforcer(): Promise<Enforcer> {
  if (_enforcer) return _enforcer;
  if (_initPromise) return _initPromise;

  _initPromise = _doInit();
  return _initPromise;
}

async function _doInit(): Promise<Enforcer> {
  // Dynamic imports so casbin + pg-adapter are only loaded when DFE is enabled
  const { newEnforcer } = await import('casbin');

  // casbin-pg-adapter — resolve at runtime
  // The package exports a default class with a static newAdapter() factory
  const pgAdapterModule = await import('casbin-pg-adapter');
  const PostgresAdapter =
    pgAdapterModule.default || pgAdapterModule.PostgresAdapter;

  const modelPath = path.resolve(
    __dirname,
    '..',
    dfeConfig.CASBIN_MODEL_PATH,
  );

  logger.info(
    { modelPath, pgUrl: dfeConfig.CASBIN_PG_URL.replace(/:[^@]+@/, ':***@') },
    'DFE: initializing Casbin enforcer',
  );

  const adapter = await PostgresAdapter.newAdapter(dfeConfig.CASBIN_PG_URL);
  const enforcer = await newEnforcer(modelPath, adapter);

  // Load policies from PostgreSQL
  await enforcer.loadPolicy();

  // Set up periodic policy reload
  if (dfeConfig.CASBIN_RELOAD_INTERVAL_MS > 0) {
    _reloadInterval = setInterval(async () => {
      try {
        await enforcer.loadPolicy();
      } catch (err) {
        logger.warn({ err }, 'DFE: failed to reload Casbin policies');
      }
    }, dfeConfig.CASBIN_RELOAD_INTERVAL_MS);
  }

  _enforcer = enforcer;
  logger.info('DFE: Casbin enforcer initialized');

  return enforcer;
}

/**
 * Get the initialized Casbin enforcer.
 * If the enforcer hasn't been initialized yet, triggers lazy init.
 * Returns null during initialization (caller should skip enforcement).
 */
export async function getEnforcer(): Promise<Enforcer> {
  if (_enforcer) return _enforcer;
  return initEnforcer();
}

/**
 * Cleanup: stop the reload interval.
 */
export function stopEnforcer() {
  if (_reloadInterval) {
    clearInterval(_reloadInterval);
    _reloadInterval = null;
  }
  _enforcer = null;
}
