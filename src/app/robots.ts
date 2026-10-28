import type { MetadataRoute } from "next";

// A private, single-company finance tool: nothing here is meant to be found. robots.txt is served
// without a session (src/middleware.ts) precisely so that it can say so. The layer's version
// allowed "/" and disallowed an /admin/ route this app does not have.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      disallow: "/",
    },
  };
}
