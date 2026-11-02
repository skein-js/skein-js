import type { Theme } from "vitepress";
// `theme-without-fonts`, not `theme`: the default entry bundles 14 Inter woff2 files and @font-faces
// them. Overriding --vp-font-family-base alone changes what renders but still ships the payload —
// this drops it. The system stack is set in style.css, matching the console's no-webfont budget.
import DefaultTheme from "vitepress/theme-without-fonts";
// Tabs are the one piece of interactive markdown the landing page needs, so the three on-ramps read
// as "pick yours" rather than as three walls of content stacked on each other. This is the plugin
// maintained alongside VitePress itself rather than a hand-rolled component — golden rule 1.
import { enhanceAppWithTabs } from "vitepress-plugin-tabs/client";

import Layout from "./Layout.vue";
import "./style.css";

// The default theme with the console's tokens layered on top — see style.css. `Layout` is a wrapper
// around the default one that fills `doc-before` for the Copy-page control and `home-hero-image` for
// the homepage diagram. Add further slots there rather than forking the theme here.
export default {
  extends: DefaultTheme,
  Layout,
  enhanceApp({ app }) {
    enhanceAppWithTabs(app);
  },
} satisfies Theme;
