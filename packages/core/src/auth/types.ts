/** The app's signed-in customer, as reported by the app's own auth system. */
export interface UsherUser {
  id: string;
  name?: string;
  email?: string;
}

/**
 * The bridge to the auth system the app already has (Better Auth, Clerk,
 * Supabase, Auth.js, a custom session...). Usher never manages passwords or
 * sessions itself.
 */
export interface IdentityAdapter {
  /** Return the signed-in user for this browser request, or null if not signed in. */
  getUser(request: Request): UsherUser | null | Promise<UsherUser | null>;
  /** Where to send a signed-out user. They must come back to `returnTo` after login. */
  loginUrl(returnTo: string): string;
}

/** Who is calling a tool: which customer, through which agent. */
export interface Principal {
  user: { id: string };
  agent: { clientId: string; name: string; verified: boolean };
  grantId: string;
}
