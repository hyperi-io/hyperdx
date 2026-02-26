// DFE User Provisioning
// Find-or-create users from OIDC identity headers.
// This is a NEW controller — it does not modify any upstream HyperDX files.

import type { ObjectId } from '@/models';
import User from '@/models/user';
import logger from '@/utils/logger';

/**
 * Find an existing user by email in a specific team, or create a new one.
 * Called by the OIDC identity middleware on each request.
 *
 * The email is lowercased to match the upstream User model's convention
 * (passport-local-mongoose lowercases emails via usernameLowerCase: true).
 */
export async function findOrCreateUserFromOIDC(
  email: string,
  teamId: ObjectId,
  name?: string,
) {
  const normalizedEmail = email.toLowerCase();

  let user = await User.findOne({ email: normalizedEmail, team: teamId });

  if (user) {
    return { user, created: false };
  }

  user = new User({
    email: normalizedEmail,
    name: name || normalizedEmail.split('@')[0],
    team: teamId,
  });
  await user.save();

  logger.info(
    { userId: user._id, email: normalizedEmail, teamId },
    'DFE: provisioned new user from OIDC',
  );

  return { user, created: true };
}
