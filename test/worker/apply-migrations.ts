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
    env.DB.prepare("DELETE FROM history_snapshot"),
    env.DB.prepare("DELETE FROM downloads_daily"),
    // The one-row all-time count keeps its row; only its value is reset.
    env.DB.prepare("UPDATE all_time_total SET installs_first_seen = 0 WHERE id = 1"),
  ]);
});
