<script setup lang="ts">
// Keep the homepage diagram and prose-page control in the default theme's documented slots.
// `doc-before` is a doc-layout slot, so the button appears on every prose page and on none of the
// pages that have no prose: the `layout: home` landing page and 404 never render it, with no
// frontmatter check here to keep in sync.
import { useData } from "vitepress";
import DefaultTheme from "vitepress/theme-without-fonts";

import CopyPage from "./components/CopyPage.vue";
import SkeinHeroDiagram from "./components/SkeinHeroDiagram.vue";

const { Layout } = DefaultTheme;
const { page } = useData();
</script>

<template>
  <Layout>
    <template v-if="page.relativePath === 'index.md'" #home-hero-image>
      <SkeinHeroDiagram />
    </template>
    <template #doc-before>
      <CopyPage />
    </template>
  </Layout>
</template>
