import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Runs before any test file. Points ORION_HOME at an empty temp
    // directory so the suite never reads the developer's real config or
    // installed reference data — see the file for the two tests that caught it.
    globalSetup: ["test/setup.ts"],
    environment: "node",
    testTimeout: 30_000,
  },
});
