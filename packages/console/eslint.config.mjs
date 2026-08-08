// Lint config for @skein-js/console (the package). It exists because ESLint 9's flat config does not
// nest: a single run from this directory would lint the SPA under `ui/` with the workspace's
// server-side rules — no React plugins, no browser globals — and report errors for a project that
// lints cleanly under `nx lint console-ui`.
//
// It also has to restate the codegen-script globals. The workspace config grants them to
// `packages/*/scripts/**/*.mjs`, but `files` patterns resolve relative to the config that is running,
// which from here is this directory — so that pattern silently matches nothing.
import baseConfig from "../../eslint.config.mjs";

export default [
  { ignores: ["ui/**"] },
  ...baseConfig,
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: { console: "readonly", process: "readonly", URL: "readonly" },
    },
  },
];
