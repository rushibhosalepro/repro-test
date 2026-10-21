// Error monitoring. Only active when SENTRY_DSN is set (so local dev and CI stay quiet).
import * as Sentry from "@sentry/bun";

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  enabled: Boolean(process.env.SENTRY_DSN),
  release: process.env.SENTRY_RELEASE,
  environment: process.env.SENTRY_ENVIRONMENT ?? "production",
});

export { Sentry };
