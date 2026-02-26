// DFE OIDC Identity Middleware
// Reads identity headers set by Envoy (after OIDC validation) and
// resolves the user + team in HyperDX. Populates req.user the same
// way Passport does, so existing isUserAuthenticated passes through.
//
// This is a NEW file — it does not modify any upstream HyperDX files.

import type { NextFunction, Request, Response } from 'express';

import logger from '@/utils/logger';

import * as dfeConfig from '../config';
import { findOrCreateTeamByName } from '../controllers/team-provisioning';
import { findOrCreateUserFromOIDC } from '../controllers/user-provisioning';

/**
 * Express middleware that extracts identity from Envoy-set headers.
 *
 * Expected headers (configurable via DFE_AUTH_HEADER_EMAIL / DFE_AUTH_HEADER_GROUPS):
 *   - X-Forwarded-Email: user@example.com
 *   - X-Forwarded-Groups: team-sre,team-platform (comma-separated)
 *
 * Behavior:
 *   - If no email header is present, falls through to existing Passport auth
 *   - Finds or creates the User and Team from OIDC claims
 *   - Calls req.login() so Passport's req.isAuthenticated() returns true
 *   - Sets req.user with the resolved User document
 */
export async function oidcIdentityMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const emailHeader = req.headers[dfeConfig.DFE_AUTH_HEADER_EMAIL];
  if (!emailHeader) {
    // No OIDC headers — fall through to existing Passport auth
    return next();
  }

  const email = Array.isArray(emailHeader)
    ? emailHeader[0]
    : emailHeader;

  if (!email) {
    return next();
  }

  try {
    // Resolve team from OIDC group claims
    const groupsHeader = req.headers[dfeConfig.DFE_AUTH_HEADER_GROUPS];
    const groupsRaw = Array.isArray(groupsHeader)
      ? groupsHeader[0]
      : groupsHeader;
    const groups = groupsRaw
      ? groupsRaw.split(',').map(g => g.trim()).filter(Boolean)
      : [];

    // Use the first group as the team name, or fall back to a default
    const teamName =
      groups[0] || dfeConfig.DFE_AUTH_DEFAULT_TEAM || 'default';

    const { team } = await findOrCreateTeamByName(teamName);
    const { user } = await findOrCreateUserFromOIDC(email, team._id);

    // Populate req.user the same way Passport does
    // req.login() sets up the session so req.isAuthenticated() returns true
    req.login(user, { session: false }, (err) => {
      if (err) {
        logger.error({ err, email }, 'DFE: req.login failed');
        return next(err);
      }
      next();
    });
  } catch (err) {
    logger.error({ err, email }, 'DFE: OIDC identity resolution failed');
    next(err);
  }
}
