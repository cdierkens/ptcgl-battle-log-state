import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "coverage/**", ".agents/**"],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    // The plain-JS scripts run in Node, so they need the Node globals. The
    // `.ts` files under src/ are handled by the TS parser, which resolves
    // globals from `@types/node` instead.
    files: ["scripts/**/*.js", "scripts/**/*.mjs"],
    languageOptions: {
      globals: {
        Buffer: "readonly",
        console: "readonly",
        process: "readonly",
        URL: "readonly",
      },
    },
  },
);
