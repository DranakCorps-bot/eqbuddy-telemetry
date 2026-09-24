import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(__dirname, "migrations"));
  return {
    test: {
      projects: [
        {
          // Runs inside workerd against a real (local) D1 with the shipped migrations.
          plugins: [
            cloudflareTest({
              wrangler: { configPath: "./wrangler.jsonc" },
              miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
            }),
          ],
          test: {
            name: "worker",
            include: ["test/worker/**/*.test.ts"],
            setupFiles: ["./test/worker/apply-migrations.ts"],
          },
        },
        {
          // Reads the repo's own files: config, schema, source.
          test: {
            name: "static",
            environment: "node",
            include: ["test/static/**/*.test.ts"],
          },
        },
      ],
    },
  };
});
