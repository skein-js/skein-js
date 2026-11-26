<script setup lang="ts">
import { useData, withBase } from "vitepress";
import { ref } from "vue";

import SkeinBuildingBlocks from "./SkeinBuildingBlocks.vue";

const { isDark } = useData();
const runDialog = ref<HTMLDialogElement | null>(null);
const showRun = ref(false);

function watchRun() {
  runDialog.value?.showModal();
  showRun.value = true;
}
</script>

<template>
  <figure class="skein-hero-diagram" aria-label="How Skein fits into your application">
    <div class="client-layer layer-heading">
      <span class="layer-symbol" aria-hidden="true">▤</span>
      <div>
        <strong>Your application</strong>
        <span class="layer-description">LangGraph SDK · useStream</span>
      </div>
    </div>

    <div class="connection">
      <span class="connection-arrow" aria-hidden="true">↕</span>
      <span>Agent Protocol</span>
    </div>

    <div class="host-layer">
      <div class="layer-heading">
        <img
          :src="withBase(isDark ? '/skein-knot-dark.svg' : '/skein-knot.svg')"
          width="26"
          height="26"
          alt=""
        />
        <div>
          <strong>Skein hosts it</strong>
          <span class="layer-description">Self-hosted backend</span>
        </div>
      </div>

      <ul class="capabilities" aria-label="Backend services provided by Skein">
        <li>API &amp; streaming</li>
        <li>Persistence</li>
        <li>Background jobs</li>
        <li>Console</li>
      </ul>

      <div class="execution-layer">
        <div class="layer-heading">
          <span class="layer-symbol" aria-hidden="true">⑂</span>
          <strong>LangGraph.js executes it</strong>
        </div>

        <div class="graph-layer layer-heading">
          <span class="layer-symbol" aria-hidden="true">{ }</span>
          <div>
            <strong>You define the graph</strong>
            <span class="layer-description">State, nodes, edges, models, prompts, and tools</span>
          </div>
        </div>
      </div>
    </div>

    <figcaption class="diagram-actions">
      <button
        type="button"
        class="diagram-button watch-button"
        aria-haspopup="dialog"
        aria-controls="homepage-example-run"
        @click="watchRun"
      >
        <span aria-hidden="true">▶</span>
        Watch an example run
      </button>
    </figcaption>
  </figure>

  <dialog
    id="homepage-example-run"
    ref="runDialog"
    class="run-dialog"
    aria-labelledby="homepage-example-run-title"
    @close="showRun = false"
  >
    <header class="dialog-header">
      <h2 id="homepage-example-run-title">Example run</h2>
      <button type="button" class="diagram-button" autofocus @click="runDialog?.close()">
        Close
      </button>
    </header>
    <SkeinBuildingBlocks v-if="showRun" class="dialog-walkthrough" autoplay />
  </dialog>
</template>

<style scoped>
.skein-hero-diagram,
.run-dialog {
  --layer-stroke: color-mix(in srgb, var(--vp-c-border), var(--vp-c-text-2) 22%);
  color: var(--vp-c-text-1);
}

.skein-hero-diagram {
  width: 100%;
  max-width: 480px;
  margin: 0 auto;
  font-size: 14px;
  line-height: 1.5;
}

.client-layer,
.host-layer,
.execution-layer,
.graph-layer {
  border: 1px solid var(--layer-stroke);
  border-radius: 14px;
  background-color: var(--vp-c-bg-elv);
}

.client-layer {
  width: fit-content;
  max-width: 100%;
  margin: 0 auto;
  padding: 10px 20px;
}

.layer-heading {
  display: flex;
  align-items: center;
  gap: 10px;
}

.layer-heading img,
.layer-symbol {
  flex: 0 0 26px;
}

.layer-heading strong {
  font-size: 15px;
  font-weight: 650;
}

.layer-symbol {
  color: var(--vp-c-brand-1);
  font-weight: 650;
  text-align: center;
}

.layer-description {
  display: block;
  color: var(--vp-c-text-2);
  font-size: 12px;
}

.connection {
  display: flex;
  min-height: 36px;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--vp-c-text-2);
  font-size: 13px;
}

.connection-arrow {
  color: var(--vp-c-brand-1);
  font-size: 22px;
  line-height: 1;
}

.host-layer {
  padding: clamp(10px, 2vw, 16px);
  border-color: color-mix(in srgb, var(--vp-c-brand-1) 55%, var(--layer-stroke));
  border-radius: 18px;
  background-color: var(--vp-c-bg-soft);
  background-image: radial-gradient(var(--layer-stroke) 1px, transparent 1px);
  background-size: 16px 16px;
}

.capabilities {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
  margin: 12px 0;
  padding: 0;
  list-style: none;
}

.capabilities li {
  display: grid;
  min-height: 34px;
  place-items: center;
  padding: 4px 6px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  background: var(--vp-c-bg-elv);
  font-size: 13px;
  text-align: center;
}

.execution-layer,
.graph-layer {
  padding: 10px;
}

.graph-layer {
  margin-top: 8px;
  border-color: color-mix(in srgb, var(--vp-c-brand-1) 42%, var(--layer-stroke));
  border-radius: 10px;
  background: color-mix(in srgb, var(--vp-c-bg-elv), var(--vp-c-brand-1) 6%);
}

.diagram-actions {
  margin-top: 12px;
  text-align: center;
}

.diagram-button {
  padding: 7px 14px;
  border: 1px solid var(--layer-stroke);
  border-radius: 9px;
  background: var(--vp-c-bg-elv);
  color: var(--vp-c-text-1);
  font-size: 13px;
  font-weight: 650;
}

.diagram-button:hover,
.diagram-button:focus-visible {
  border-color: var(--vp-c-brand-1);
}

.diagram-button:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 3px;
}

.watch-button {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.watch-button span {
  color: var(--vp-c-brand-1);
  font-size: 10px;
}

.run-dialog {
  position: fixed;
  inset: 0;
  width: min(680px, calc(100% - 24px));
  max-height: calc(100dvh - 24px);
  margin: auto;
  padding: 0;
  overflow: auto;
  overscroll-behavior: contain;
  border: 1px solid var(--layer-stroke);
  border-radius: 18px;
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
}

.run-dialog::backdrop {
  background: rgb(0 0 0 / 62%);
}

.dialog-header {
  position: sticky;
  z-index: 1;
  top: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg);
}

.dialog-header h2 {
  font-size: 16px;
  font-weight: 650;
}

.dialog-walkthrough {
  margin: 12px;
}
</style>
