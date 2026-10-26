import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/__tests__/**"],
      reporter: ["text", "lcov"],
      // A floor, not a target. Set at what the module actually holds, so a
      // refactor cannot quietly shed the tests it has.
      thresholds: {
        branches: 78,
        functions: 93,
        lines: 85,
        statements: 85,
      },
    },
  },
});
