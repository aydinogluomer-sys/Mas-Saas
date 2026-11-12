import NextLink from "next/link";
import type { ComponentProps } from "react";

export type AppLinkProps = ComponentProps<typeof NextLink>;

/**
 * On-demand navigation link wrapper ("yalnız tıklanan istek yüklensin").
 *
 * Next.js `<Link>` defaults to `prefetch={null}` (AUTO), which fires background RSC prefetch
 * requests for every visible link entering the viewport (9 sidebar links + up to 17 module tabs +
 * 31 calendar day cells = 50+ background requests contending for the 10-connection PostgreSQL pool
 * and running session checks on routes the user never clicked).
 *
 * Defaulting `prefetch` to `false` guarantees zero background prefetch traffic while keeping
 * client-side SPA transitions when the user actually clicks.
 */
export default function Link({ prefetch = false, ...props }: AppLinkProps) {
  return <NextLink prefetch={prefetch} {...props} />;
}

