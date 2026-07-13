// Flat ESLint config for the Skein workspace.
// ESLint owns correctness + imports; Prettier owns formatting (eslint-config-prettier
// disables any stylistic rules that would fight the formatter). See docs/code-practices.md.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import importPlugin from "eslint-plugin-import";
import unusedImports from "eslint-plugin-unused-imports";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/.next/**",
      "**/node_modules/**",
      "**/.nx/**",
      "**/*.config.*",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    plugins: {
      import: importPlugin,
      "unused-imports": unusedImports,
    },
    rules: {
      // --- functional / simplicity leanings (see docs/code-practices.md §2–3) ---
      "prefer-const": "error",
      "no-var": "error",
      "no-param-reassign": "error",
      eqeqeq: ["error", "always", { null: "ignore" }],
      "object-shorthand": ["error", "always"],

      // --- named exports only in library code ---
      "import/no-default-export": "error",

      // --- tidy imports ---
      "unused-imports/no-unused-imports": "error",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "import/order": [
        "warn",
        {
          "newlines-between": "always",
          alphabetize: { order: "asc", caseInsensitive: true },
          groups: ["builtin", "external", "internal", "parent", "sibling", "index"],
        },
      ],

      // --- explicitness ---
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },

  // Frameworks that REQUIRE default exports (Next.js pages/layouts, config files).
  {
    files: ["examples/react-usestream/**/*.{ts,tsx}", "**/*.config.{ts,mts,mjs}"],
    rules: { "import/no-default-export": "off" },
  },

  // Tests may be a little looser.
  {
    files: ["**/*.test.ts", "**/*.integration.test.ts", "**/test-support/**"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },

  prettier,
);
