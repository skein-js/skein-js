<template>
  <figure class="skein-hero-diagram" aria-label="How skein-js fits into your application">
    <div class="endpoint">
      <p class="node-title">Your application</p>
      <p class="node-detail">LangGraph SDK · useStream</p>
    </div>

    <div class="connection">
      <svg aria-hidden="true" width="16" height="48" viewBox="0 0 16 48">
        <path d="M8 2v44M4 6l4-4 4 4M4 42l4 4 4-4" />
      </svg>
      <span class="connection-label">Agent Protocol</span>
    </div>

    <div class="skein-boundary">
      <div class="skein-heading">
        <p class="skein-name">skein-js</p>
        <p class="node-detail">Self-hosted backend</p>
      </div>

      <ul class="capabilities" aria-label="Backend services provided by skein-js">
        <li>API &amp; streaming</li>
        <li>Persistence</li>
        <li>Background jobs</li>
        <li>Console</li>
      </ul>

      <div class="graph-node">
        <p class="node-title">Your LangGraph.js agent</p>
        <p class="node-detail">Graph logic &amp; execution</p>
      </div>
    </div>

    <div class="connection">
      <svg aria-hidden="true" width="16" height="32" viewBox="0 0 16 32">
        <path d="M8 0v30M4 26l4 4 4-4" />
      </svg>
    </div>

    <div class="endpoint">
      <p class="node-title">Your models &amp; tools</p>
      <p class="node-detail">Chosen in your graph</p>
    </div>

    <figcaption>LangGraph runs the graph. Skein supplies the backend.</figcaption>
  </figure>
</template>

<style scoped>
.skein-hero-diagram {
  width: 100%;
  max-width: 480px;
  margin: 0 auto;
  color: var(--vp-c-text-1);
  font-size: 14px;
  line-height: 1.5;
  text-align: center;
}

.skein-hero-diagram p {
  margin: 0;
}

.endpoint,
.graph-node {
  padding: 14px 16px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 10px;
  background: var(--vp-c-bg-soft);
}

.endpoint {
  width: 100%;
  max-width: 320px;
  margin: 0 auto;
}

.node-title {
  font-size: 16px;
  font-weight: 600;
}

.node-detail,
figcaption {
  color: var(--vp-c-text-2);
}

.connection {
  position: relative;
  display: flex;
  justify-content: center;
  align-items: center;
}

.connection svg {
  display: block;
  flex-shrink: 0;
  fill: none;
  stroke: var(--vp-c-text-2);
  stroke-width: 1.25;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.connection-label {
  position: absolute;
  left: calc(50% + 16px);
  color: var(--vp-c-text-2);
}

.skein-boundary {
  padding: 20px;
  border: 1px solid var(--vp-c-brand-1);
  border-radius: 16px;
  background: var(--vp-c-brand-soft);
}

.skein-heading {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: center;
  gap: 4px 16px;
  margin-bottom: 16px;
  text-align: left;
}

.skein-name {
  color: var(--vp-c-brand-1);
  font-size: 22px;
  font-weight: 700;
  letter-spacing: -0.02em;
}

.capabilities {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.capabilities li {
  padding: 8px 4px;
  border-radius: 6px;
  background: var(--vp-c-bg);
}

.graph-node {
  position: relative;
  margin-top: 16px;
  background: var(--vp-c-bg);
}

/* Continue the graph's connection through the surrounding backend boundary. */
.graph-node::after {
  content: "";
  position: absolute;
  top: 100%;
  left: 50%;
  height: 21px;
  border-left: 1.25px solid var(--vp-c-text-2);
}

figcaption {
  margin-top: 16px;
  text-wrap: balance;
}
</style>
