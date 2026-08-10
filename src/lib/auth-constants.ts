// Deliberately zero-dependency — src/middleware.ts (Edge runtime, no Node.js APIs, no `pg`,
// no native bindings) needs the cookie name without pulling in the rest of src/lib/auth.ts
// (which imports next/headers, @node-rs/argon2, and the Postgres pool).
export const SESSION_COOKIE = "mas_session";
