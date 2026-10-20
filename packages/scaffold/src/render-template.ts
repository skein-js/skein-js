// Rendering a project template.
//
// The engine is EJS — the same one Nx's `generateFiles` uses, so these templates are idiomatic to
// anyone who has written an Nx generator and would drop straight into devkit if this package ever
// took that dependency. It is 211 KB with *zero* transitive dependencies, which is what makes it
// affordable on the `npm create skein-js` path where every byte sits in front of a user's first
// impression of the project. (Nunjucks would be 1.8 MB and would pull a second, older `commander`
// alongside the one this package already ships.)
//
// Syntax, all standard EJS:
//   <%= name %>              substitute a value
//   <%_ if (flag) { _%>      keep a block when `flag` is truthy
//   <%_ } _%>                `<%_` and `_%>` slurp the tag line's own whitespace, so a dropped
//                            block leaves no blank hole and a kept one gains no stray indent

// Default import, not `import { render }`: ejs's ESM build has a single default export, so a named
// import type-checks against @types/ejs and then fails at runtime under real ESM resolution.
import ejs from "ejs";

import { TEMPLATE_SOURCES } from "./templates.generated.js";

/** Values a template can interpolate. Booleans drive conditionals; strings are substituted. */
export type TemplateValues = Readonly<Record<string, string | boolean>>;

/**
 * EJS escapes `<%= %>` for HTML by default. That is exactly wrong for a code generator — it would
 * turn a `&` in a URL into `&amp;` inside a TypeScript file — so escaping is replaced with plain
 * stringification. Templates that genuinely wanted HTML escaping would ask for it themselves.
 */
const renderOptions = { escape: (value: unknown) => String(value) };

/**
 * Render one template by key — its path under `templates/` with the `.tmpl` suffix dropped, e.g.
 * `"src/echo-graph.ts"`.
 *
 * A template referencing a name the caller did not supply throws (EJS evaluates in a `with` block,
 * so an unknown name is a ReferenceError). That is deliberate: a typo in a placeholder should fail
 * the build, not silently emit an empty string into someone's starter project.
 */
export function renderTemplate(templateKey: string, values: TemplateValues): string {
  const source = TEMPLATE_SOURCES[templateKey];
  if (source === undefined) {
    throw new Error(`No template named "${templateKey}".`);
  }

  try {
    return ejs.render(source, values, renderOptions);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to render template "${templateKey}": ${reason}`, { cause: error });
  }
}
