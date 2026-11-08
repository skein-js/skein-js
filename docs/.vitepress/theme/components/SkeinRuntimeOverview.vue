<script setup lang="ts">
import { withBase } from "vitepress";

import overviewSvg from "../../../public/images/runtime-overview.svg?raw";

const callers = [
  {
    title: "Apps & services",
    detail: "LangChain SDKs · HTTP/SSE",
    guide: "/react-sdk",
    label: "Connect LangChain SDKs",
  },
  {
    title: "Agents & tools",
    detail: "MCP / A2A",
    guide: "/agent-protocol#mcp-and-a2a",
    label: "Connect MCP and A2A agents",
  },
  {
    title: "Native callers",
    detail: "TypeScript / optional BullMQ",
    guide: "/native-access",
    label: "Connect native callers and BullMQ",
  },
  {
    title: "Channels",
    detail: "Verified provider events",
    guide: "/channels",
    label: "Connect channels and provider events",
  },
];

const hosts = [
  {
    title: "Shared server",
    detail: "Node / containers",
    guide: "/deploy",
    label: "Deploy a shared server",
  },
  {
    title: "Existing backend",
    detail: "Framework adapters",
    guide: "/embedding",
    label: "Embed graphs in your backend",
  },
  {
    title: "Local application",
    detail: "Desktop / CLI / daemon",
    guide: "/local-deployment",
    label: "Run graphs in local applications",
  },
];

// Match the shared SVG's 1200 × 550 viewBox. HTML anchors also support VitePress prefetching.
function positionOverviewLink(x: number, y: number, width: number, height: number) {
  return {
    left: `${(x / 1200) * 100}%`,
    top: `${(y / 550) * 100}%`,
    width: `${(width / 1200) * 100}%`,
    height: `${(height / 550) * 100}%`,
  };
}

const desktopLinks = [
  ...callers.map((caller, index) => ({
    ...caller,
    position: positionOverviewLink(24, 120 + index * 94, 280, 62),
  })),
  ...hosts.map((host, index) => ({
    ...host,
    position: positionOverviewLink(939, 117 + index * 118, 237, 86),
  })),
];
</script>

<template>
  <figure class="runtime-overview" aria-label="Your clients, graphs, and infrastructure">
    <!-- The same trusted SVG is embedded in the root README. Inline it here for the theme toggle. -->
    <div class="wide-overview">
      <div v-html="overviewSvg" />
      <a
        v-for="link in desktopLinks"
        :key="link.label"
        class="overview-link"
        :href="withBase(link.guide)"
        :aria-label="link.label"
        :style="link.position"
      />
    </div>
    <div class="narrow-overview">
      <p class="flow-heading">Connect from</p>
      <ul class="caller-list">
        <li v-for="caller in callers" :key="caller.title">
          <a :href="withBase(caller.guide)">
            <strong>{{ caller.title }}</strong>
            <span>{{ caller.detail }}</span>
          </a>
        </li>
      </ul>
      <div class="flow-join" aria-hidden="true" />
      <div class="runtime-node">
        <strong>skein-js</strong>
        <span>Your LangGraph.js graphs &amp; Deep Agents</span>
      </div>
      <span class="flow-arrow" aria-hidden="true">↓</span>
      <p class="flow-heading">Choose one host</p>
      <ul class="host-list">
        <li v-for="host in hosts" :key="host.title">
          <a :href="withBase(host.guide)">
            <strong>{{ host.title }}</strong>
            <span>{{ host.detail }}</span>
          </a>
        </li>
      </ul>
    </div>
    <figcaption>
      Apps, agents, native callers, and channels share the same graph backend. Choose the host and
      access methods your application needs.
    </figcaption>
  </figure>
</template>

<style scoped>
.runtime-overview {
  margin: 36px 0;
}

.wide-overview {
  position: relative;
}

.overview-link {
  position: absolute;
  border: 2px solid transparent;
  border-radius: 18px;
}

.overview-link:hover,
.overview-link:focus-visible {
  border-color: var(--vp-c-brand-1);
  background: var(--vp-c-brand-soft);
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 3px;
}

.wide-overview :deep(svg) {
  display: block;
  width: 100%;
  height: auto;
}

.narrow-overview {
  display: none;
}

figcaption {
  color: var(--vp-c-text-2);
  font-size: 14px;
  line-height: 1.6;
  text-align: center;
}

@media (max-width: 899px) {
  .wide-overview {
    display: none;
  }

  .narrow-overview {
    display: block;
  }

  .flow-heading {
    margin: 0 0 14px;
    color: var(--vp-c-text-2);
    font-size: 13px;
    font-weight: 600;
    text-align: center;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .caller-list,
  .host-list {
    display: grid;
    gap: 12px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .caller-list {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .caller-list li,
  .host-list li {
    margin: 0;
    padding: 0;
  }

  .caller-list a,
  .host-list a {
    display: flex;
    height: 100%;
    flex-direction: column;
    justify-content: center;
    gap: 5px;
    padding: 14px 12px;
    border: 1px solid var(--vp-c-divider);
    border-radius: 14px;
    background: var(--vp-c-bg-soft);
    text-align: center;
    text-decoration: none;
  }

  .caller-list a:hover,
  .host-list a:hover {
    border-color: var(--vp-c-brand-1);
  }

  a strong {
    font-size: 14px;
    line-height: 1.4;
  }

  a span {
    color: var(--vp-c-text-2);
    font-size: 12px;
    line-height: 1.5;
  }

  .flow-join {
    position: relative;
    width: 60%;
    height: 28px;
    margin: 0 auto 28px;
    border: solid var(--vp-c-brand-1);
    border-width: 0 2px 2px;
    border-radius: 0 0 22px 22px;
  }

  .flow-join::after {
    position: absolute;
    top: 100%;
    left: 50%;
    height: 28px;
    border-left: 2px solid var(--vp-c-brand-1);
    content: "";
  }

  .runtime-node {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 22px 16px;
    border: 1px solid var(--vp-c-brand-1);
    border-radius: 18px;
    background: var(--vp-c-brand-soft);
    text-align: center;
  }

  .runtime-node strong {
    color: var(--vp-c-brand-1);
    font-size: 28px;
  }

  .runtime-node span {
    color: var(--vp-c-text-1);
    font-size: 14px;
  }

  .flow-arrow {
    display: block;
    margin: 8px 0;
    color: var(--vp-c-brand-1);
    font-size: 28px;
    text-align: center;
  }

  .host-list {
    margin-bottom: 20px;
  }
}
</style>
