// DFE Casbin Authorization Middleware
// Enforces RBAC policies on every API request. Maps Express routes
// to Casbin resources and HTTP methods to actions.
//
// This is a NEW file — it does not modify any upstream HyperDX files.
// It runs as global middleware injected via the conditional block in api-app.ts.

import type { NextFunction, Request, Response } from 'express';

import logger from '@/utils/logger';

import { getEnforcer } from '../bootstrap';

// Map Express route prefixes to Casbin resource names
const ROUTE_RESOURCE_MAP: Record<string, string> = {
  '/dashboards': 'dashboards',
  '/alerts': 'alerts',
  '/saved-search': 'saved-searches',
  '/connections': 'connections',
  '/sources': 'sources',
  '/team': 'team-settings',
  '/webhooks': 'webhooks',
  '/ai': 'ai',
  '/clickhouse-proxy': 'clickhouse',
  '/me': 'profile',
  '/dfe': 'dfe',
};

// Map HTTP methods to Casbin actions
const METHOD_ACTION_MAP: Record<string, string> = {
  GET: 'read',
  HEAD: 'read',
  OPTIONS: 'read',
  POST: 'write',
  PUT: 'write',
  PATCH: 'write',
  DELETE: 'delete',
};

/**
 * Resolve a request path to a Casbin resource name.
 * Matches on the first path segment after the mount point.
 */
function resolveResource(path: string): string | null {
  for (const [prefix, resource] of Object.entries(ROUTE_RESOURCE_MAP)) {
    if (path === prefix || path.startsWith(prefix + '/')) {
      return resource;
    }
  }
  return null;
}

/**
 * Express middleware that enforces Casbin RBAC policies.
 *
 * Skips enforcement for:
 *   - Public routes (/, /health, /installation, /login/*, /register/*, /logout)
 *   - External API routes (/api/v2/*)
 *   - Routes with no resource mapping (logged as warning)
 *
 * For all other routes, calls enforcer.enforce(email, teamName, resource, action).
 * Returns 403 if the policy denies access.
 */
export async function casbinAuthzMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  // Skip public routes — these are handled by the root router without auth
  const publicPrefixes = [
    '/health',
    '/installation',
    '/login',
    '/register',
    '/logout',
    '/ext/',
    '/api/v2',
  ];
  if (publicPrefixes.some(p => req.path === p || req.path.startsWith(p))) {
    return next();
  }

  // If user is not authenticated, skip RBAC (auth middleware will handle 401)
  if (!req.user) {
    return next();
  }

  const resource = resolveResource(req.path);
  if (!resource) {
    // Unknown route — let the normal 404 handling deal with it
    return next();
  }

  const action = METHOD_ACTION_MAP[req.method] || 'read';
  const email = req.user.email;
  const teamName = req.user.team?.toString();

  if (!email || !teamName) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const enforcer = await getEnforcer();
    const allowed = await enforcer.enforce(email, teamName, resource, action);

    if (!allowed) {
      logger.debug(
        { email, teamName, resource, action },
        'DFE: Casbin denied access',
      );
      return res.status(403).json({ error: 'Forbidden' });
    }

    next();
  } catch (err) {
    logger.error({ err, email, resource, action }, 'DFE: Casbin enforce error');
    next(err);
  }
}
