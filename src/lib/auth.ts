import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer } from "better-auth/plugins";
import { db, schema } from "@/db";

/**
 * Authentication.
 *
 * Better Auth rather than Auth.js: Auth.js was handed to the Better Auth team
 * in September 2025 and its v5 is still beta years on, with its own maintainers
 * recommending Better Auth for new projects. Sessions live in our database,
 * which also gives immediate revocation.
 *
 * Email and password only. Strava is connected separately, for sync, and is
 * not a way to sign in — an OAuth sign-in dependency would buy nothing.
 */
export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      user: schema.user,
      session: schema.session,
      account: schema.account,
      verification: schema.verification,
    },
  }),
  emailAndPassword: {
    enabled: true,
    // No mail provider is wired up yet, so requiring verification would lock
    // every new account out. Revisit before this is public.
    requireEmailVerification: false,
    minPasswordLength: 10,
  },
  session: {
    expiresIn: 60 * 60 * 24 * 30,
    updateAge: 60 * 60 * 24,
  },
  advanced: {
    // Accounts are invite-scale, so cookies can be strict.
    defaultCookieAttributes: { sameSite: "lax", secure: process.env.NODE_ENV === "production" },
  },
  plugins: [
    // A native app cannot hold a browser cookie jar, so the same session is
    // also addressable as `Authorization: Bearer <token>`. Same sessions table,
    // same expiry, same revocation — one auth system, two transports, rather
    // than a second parallel scheme with its own bugs.
    bearer(),
  ],
});

/**
 * Resolve the caller, from either transport.
 *
 * Every route that touches ride data starts here. Authorisation is checked in
 * the handler next to the query rather than in middleware: middleware runs on a
 * path pattern, and a path pattern is the wrong unit for "does this person own
 * this ride".
 */
export async function requireUser(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers });
  return session?.user ?? null;
}

export type Session = typeof auth.$Infer.Session;
