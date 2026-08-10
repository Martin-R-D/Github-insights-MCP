import js from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * Flat ESLint config. Type-aware linting is intentionally left off for speed;
 * `npm run typecheck` (tsc) covers type correctness. This focuses on catching
 * obvious bugs (unused vars, unreachable code) without stylistic noise.
 */
export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**", "**/*.test.ts"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // TypeScript resolves globals/identifiers; no-undef only causes false
      // positives on Node/DOM globals in a flat config.
      "no-undef": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
);
