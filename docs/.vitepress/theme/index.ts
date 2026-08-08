import type { Theme } from "vitepress";
// `theme-without-fonts`, not `theme`: the default entry bundles 14 Inter woff2 files and @font-faces
// them. Overriding --vp-font-family-base alone changes what renders but still ships the payload —
// this drops it. The system stack is set in style.css, matching the console's no-webfont budget.
import DefaultTheme from "vitepress/theme-without-fonts";
import "./style.css";

// The default theme with the console's tokens layered on top — see style.css. Nothing here extends
// the layout; if the site ever needs slots (`home-hero-image`, `doc-after`), add a Layout wrapper
// rather than forking the theme.
export default {
  extends: DefaultTheme,
} satisfies Theme;
