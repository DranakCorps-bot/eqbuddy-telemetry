import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach } from "vitest";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// Every test starts from empty tables, whatever the pool's storage isolation does.
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM heartbeat"),
    env.DB.prepare("DELETE FROM bucket_count"),
    env.DB.prepare("DELETE FROM daily_rollup"),
    env.DB.prepare("DELETE FROM metrics_snapshot"),
  ]);
});
