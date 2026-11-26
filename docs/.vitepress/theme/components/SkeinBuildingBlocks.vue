<script setup lang="ts">
import { useData, withBase } from "vitepress";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

const props = defineProps<{ autoplay?: boolean }>();
const { isDark } = useData();
const steps = [
  { id: "request", detail: "Skein accepts the request and starts a run on the thread." },
  {
    id: "model",
    detail: "LangGraph.js executes your model node. The model asks for the weather tool.",
  },
  { id: "tool", detail: "Your weather tool looks up Nairobi and returns the result." },
  {
    id: "result",
    detail: "LangGraph.js follows the return edge so the model can read the tool result.",
  },
  {
    id: "reply",
    detail: "LangGraph.js emits the model’s reply and Skein streams it to the client.",
  },
] as const;

const stepIndex = ref(-1);
const playing = ref(false);
const step = computed(() => steps[stepIndex.value]);
const isModelActive = computed(() => step.value?.id === "model" || step.value?.id === "result");
let timer: ReturnType<typeof setTimeout> | undefined;

function stopRun() {
  clearTimeout(timer);
  playing.value = false;
}

function advanceRun() {
  if (stepIndex.value === steps.length - 1) {
    stopRun();
    return;
  }

  stepIndex.value += 1;
  timer = setTimeout(advanceRun, 2200);
}

function playRun() {
  stepIndex.value = -1;
  playing.value = true;
  advanceRun();
}

function toggleRun() {
  if (playing.value) stopRun();
  else playRun();
}

onMounted(() => {
  if (props.autoplay) playRun();
});
onBeforeUnmount(stopRun);
</script>

<template>
  <figure
    class="building-blocks"
    aria-label="An example run, from client request to streamed reply"
  >
    <div class="run-message" :class="{ active: step?.id === 'request' }">
      <div class="message-copy">
        <span class="message-label">Example request</span>
        <strong>What’s the weather in Nairobi?</strong>
      </div>
      <button type="button" class="run-button" @click="toggleRun">
        <span aria-hidden="true">{{ playing ? "■" : "▶" }}</span>
        {{ playing ? "Stop run" : step ? "Replay run" : "Play run" }}
      </button>
      <span class="run-status" role="status">{{
        step?.detail ?? "The model can call a weather tool before it replies."
      }}</span>
    </div>
    <span class="message-wire" :class="{ active: step?.id === 'request' }" aria-hidden="true"
      >↓</span
    >

    <div class="host-layer" :class="{ active: step?.id === 'request' || step?.id === 'reply' }">
      <div class="layer-heading">
        <img
          :src="withBase(isDark ? '/skein-knot-dark.svg' : '/skein-knot.svg')"
          width="26"
          height="26"
          alt=""
        />
        <div>
          <strong>Skein hosts it</strong>
          <span>API, runs, threads, storage, schedules, and callbacks</span>
        </div>
      </div>

      <div class="execution-layer" :class="{ active: isModelActive || step?.id === 'tool' }">
        <div class="layer-heading">
          <span class="layer-symbol" aria-hidden="true">⑂</span>
          <div>
            <strong>LangGraph.js executes it</strong>
            <span>Runs nodes, handles interrupts, writes checkpoints, and emits events</span>
          </div>
        </div>

        <div class="graph-layer">
          <div class="layer-heading">
            <span class="layer-symbol" aria-hidden="true">{ }</span>
            <div>
              <strong>You define the graph</strong>
              <span>State schema, routing, model, prompts, and tools</span>
            </div>
          </div>

          <div
            class="graph-route"
            role="group"
            aria-label="The model can call the weather tool, read its result, and reply"
          >
            <div class="graph-node" :class="{ active: isModelActive }">
              <span class="node-symbol" aria-hidden="true">✦</span>
              <strong>Model</strong>
            </div>
            <div class="tool-edges" aria-hidden="true">
              <span :class="{ active: step?.id === 'tool' }">→</span>
              <span :class="{ active: step?.id === 'result' }">←</span>
            </div>
            <div class="graph-node" :class="{ active: step?.id === 'tool' }">
              <span class="node-symbol" aria-hidden="true">☀︎</span>
              <strong>Weather tool</strong>
            </div>
            <span class="reply-edge" :class="{ active: step?.id === 'reply' }" aria-hidden="true"
              >↓</span
            >
            <span class="reply-node" :class="{ active: step?.id === 'reply' }">Reply</span>
          </div>
        </div>
      </div>
    </div>

    <span class="message-wire" :class="{ active: step?.id === 'reply' }" aria-hidden="true">↓</span>
    <div class="run-message" :class="{ active: step?.id === 'reply' }">
      <div class="message-copy">
        <span class="message-label">Skein streams the reply</span>
        <strong>Nairobi is 23°C and partly cloudy.</strong>
      </div>
    </div>
  </figure>
</template>

<style scoped>
.building-blocks {
  --layer-stroke: color-mix(in srgb, var(--vp-c-border), var(--vp-c-text-2) 22%);

  margin: 30px 0;
  padding: clamp(12px, 3vw, 22px);
  border: 1px solid var(--vp-c-divider);
  border-radius: 20px;
  background: var(--vp-c-bg-alt);
}

.run-message,
.layer-heading {
  display: flex;
  align-items: center;
  gap: 12px;
}

.run-message {
  flex-wrap: wrap;
  justify-content: space-between;
  padding: 12px 14px;
  border: 1px solid var(--layer-stroke);
  border-radius: 12px;
  background: var(--vp-c-bg-elv);
}

.message-copy,
.layer-heading div {
  display: grid;
  gap: 2px;
  line-height: 1.45;
}

.message-copy strong,
.layer-heading strong {
  font-size: 15px;
  font-weight: 650;
}

.message-label,
.run-status,
.layer-heading div span {
  font-size: 13px;
  color: var(--vp-c-text-2);
}

.run-status {
  flex-basis: 100%;
  min-height: 1.5em;
  line-height: 1.5;
}

.run-button {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 6px 12px;
  border: 1px solid var(--layer-stroke);
  border-radius: 8px;
  color: var(--vp-c-text-1);
  background: var(--vp-c-bg-soft);
  font-size: 13px;
  font-weight: 650;
  white-space: nowrap;
}

.run-button span {
  color: var(--vp-c-brand-1);
  font-size: 10px;
}

.run-button:hover,
.run-button:focus-visible {
  border-color: var(--vp-c-brand-1);
}

.run-button:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 2px;
}

.host-layer,
.execution-layer,
.graph-layer {
  padding: clamp(10px, 2.4vw, 16px);
  border: 1px solid var(--layer-stroke);
  border-radius: 14px;
}

.host-layer {
  background-color: var(--vp-c-bg-soft);
  background-image: radial-gradient(var(--layer-stroke) 1px, transparent 1px);
  background-size: 16px 16px;
}

.execution-layer,
.graph-layer {
  margin-top: 12px;
  background: var(--vp-c-bg-elv);
}

.graph-layer {
  border-color: color-mix(in srgb, var(--vp-c-brand-1) 42%, var(--layer-stroke));
  background: color-mix(in srgb, var(--vp-c-bg-elv), var(--vp-c-brand-1) 6%);
}

.layer-heading img,
.layer-symbol {
  flex: 0 0 26px;
}

.layer-symbol,
.node-symbol {
  color: var(--vp-c-brand-1);
  font-weight: 650;
  text-align: center;
}

.graph-route {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 30px minmax(0, 1fr);
  align-items: center;
  gap: 3px 6px;
  max-width: 380px;
  margin: 16px auto 0;
}

.graph-node {
  display: flex;
  min-height: 48px;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 6px;
  border: 1px solid var(--layer-stroke);
  border-radius: 9px;
  background: var(--vp-c-bg-elv);
  font-size: 13px;
  line-height: 1.3;
  text-align: center;
}

.message-wire,
.reply-edge,
.tool-edges {
  display: grid;
  justify-items: center;
  color: var(--vp-c-text-2);
  font-size: 18px;
  line-height: 1.15;
}

.message-wire {
  margin: 3px 0;
}

.reply-node {
  grid-column: 1;
  justify-self: center;
  padding: 2px 12px;
  border: 1px solid var(--layer-stroke);
  border-radius: 999px;
  background: var(--vp-c-bg-elv);
  font-size: 12px;
  font-weight: 650;
  line-height: 1.6;
}

.active {
  border-color: var(--vp-c-brand-1);
}

.graph-node.active,
.reply-node.active,
.run-message.active {
  background: color-mix(in srgb, var(--vp-c-bg-elv), var(--vp-c-brand-1) 13%);
}

.reply-edge.active,
.message-wire.active,
.tool-edges .active {
  color: var(--vp-c-brand-1);
  font-weight: 700;
}

@media (prefers-reduced-motion: no-preference) {
  .run-message,
  .host-layer,
  .execution-layer,
  .graph-node,
  .reply-node {
    transition:
      border-color 220ms ease,
      background-color 220ms ease;
  }

  .tool-edges .active,
  .message-wire.active,
  .reply-edge.active {
    animation: signal 500ms ease-out;
  }

  @keyframes signal {
    from {
      opacity: 0.4;
      transform: scale(0.72);
    }
    to {
      opacity: 1;
      transform: scale(1);
    }
  }
}

@media (max-width: 480px) {
  .run-status {
    min-height: 3em;
  }

  .layer-heading {
    gap: 7px;
  }

  .graph-node {
    flex-direction: column;
  }
}
</style>
