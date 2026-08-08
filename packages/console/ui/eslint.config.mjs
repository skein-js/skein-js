// Lint config for the console SPA. It extends the workspace config and adds the two things that only
// apply to browser React code: the react-hooks rules (which catch real bugs — a stale closure in a
// live-run view is not a style question) and browser globals, which the workspace config has no
// reason to define.
//
// It uses the React plugins directly rather than @nx/eslint-plugin's `flat/react` preset: the preset
// is another dependency in front of the same three plugins, and the console is the only project here
// that needs them.
import jsxA11y from "eslint-plugin-jsx-a11y";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";

import baseConfig from "../../../eslint.config.mjs";

export default [
  ...baseConfig,
  {
    files: ["**/*.{ts,tsx}"],
    plugins: { react, "react-hooks": reactHooks, "jsx-a11y": jsxA11y },
    languageOptions: {
      globals: {
        window: "readonly",
        document: "readonly",
        fetch: "readonly",
        localStorage: "readonly",
        AbortController: "readonly",
        AbortSignal: "readonly",
        URLSearchParams: "readonly",
        HTMLElement: "readonly",
        console: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
      },
    },
    // `@/…` is this app's own source, not a third-party package — without this the import/order rule
    // groups it as external and asks for `./parts` to be hoisted above `@/api`, which reads backwards.
    settings: { react: { version: "detect" }, "import/internal-regex": "^@/" },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // The new JSX transform means React need not be in scope for JSX.
      "react/react-in-jsx-scope": "off",
      // This is an application bundle, and its entry point is a default-exported component — the one
      // place the workspace's named-exports-only rule does not apply. `@skein-js/console` itself
      // (packages/console/src) stays named-exports-only like every other package.
      "import/no-default-export": "off",
    },
  },
];
