# Why skein-js

Use skein-js when you have LangGraph.js agents and want to run them on infrastructure you control,
with conversations, streaming, background execution, persistence, and a console available together.
Your application continues to choose its models, tools, prompts, and access policy.

For a support workflow, that might mean keeping a ticket's conversation, looking up its order,
waiting for a refund approval, and continuing tomorrow without losing the request. Start with the
parts your application needs; you do not have to use every capability.

## Is it a fit? {#who-this-is-for}

<span id="how-everyone-gets-here"></span>
<span id="your-stack-is-already-typescript"></span>
<span id="a-good-fit"></span>

| You need                                    | What skein-js provides                                                  |
| ------------------------------------------- | ----------------------------------------------------------------------- |
| A server for existing TypeScript graphs     | Load your `langgraph.json` or embed compiled graphs in your backend     |
| Conversations and human approval            | Threads, checkpoints, interrupt/resume, and history                     |
| Work after an HTTP request ends             | Background runs, schedules, and completion delivery                     |
| A way to test before building a frontend    | A local [console](./console.md) for inputs, output, state, and failures |
| Durable shared services                     | Postgres storage, with Redis for cross-instance queues and streaming    |
| Agents inside a desktop app, CLI, or daemon | SQLite embedding with one Node process owning the file                  |

Keep TypeScript graphs and application code together when that fits your team. If a tool or model
requires another language, your graph can call that service; skein-js does not require you to rewrite it.

## Choose how much to adopt {#your-four-options}

<span id="build-it-yourself"></span>
<span id="langgraph-platform"></span>
<span id="aegra"></span>
<span id="skein-js"></span>
<span id="how-they-compare"></span>

You can run a LangGraph graph directly when you only need graph execution. Add skein-js when your
application needs a hosted protocol, shared state, background work, or an inspection UI. You can also
use a [plain graph endpoint](./serving-a-single-graph.md) when threads and runs are unnecessary.

Choose an adoption path:

- **Existing `langgraph.json`:** replace `langgraph dev` with `skein dev`; follow
  [Getting started](./getting-started.md#path-b--i-have-a-langgraphjson-drop-in).
- **Existing backend:** [embed your graph](./embedding.md) alongside your own application routes.
- **New project:** [create your first agent](./your-first-agent.md) and test it without a model key.
- **Local application:** [embed with SQLite](./local-deployment.md) and let your host own process lifetime.

## What you operate {#the-same-stack-in-dev-and-production}

You deploy and maintain the server or local application, storage, credentials, backups, and
application access policy. The default development server needs no database; choose durable storage
for deployment. SQLite suits a single local Node owner; Postgres and Redis suit shared services.
See [deployment choices](./deploy.md#choose-a-deployment).

<span id="the-licensing-part-plainly"></span>

skein-js is [Apache-2.0 licensed](https://github.com/skein-js/skein-js/blob/main/LICENSE). It requires
no skein-js account or license key. You still pay for the infrastructure and model services you choose.
If you prefer a provider to operate your deployment, compare managed offerings against your hosting,
security, and support requirements using their current terms.

## Keep your existing clients {#we-want-leaving-to-be-easy}

<span id="wont-it-drift-out-of-compatibility"></span>
<span id="won-t-it-drift-out-of-compatibility"></span>
<span id="why-we-bet-on-langgraph"></span>
<span id="so-am-i-locked-in"></span>

Your graphs remain LangGraph.js graphs, and clients use the standard LangChain SDKs. Test an existing
client against skein-js before migration; check the [compatibility reference](./langgraph-compatibility.md)
for verified versions, supported behavior, and intentional differences. Skein-specific options such
as durable delivery need consideration when moving to another host.

## When to choose something else {#probably-not-for-you}

<span id="what-we-deliberately-dont-do"></span>
<span id="what-we-deliberately-don-t-do"></span>

If you only need to invoke a graph inside one request, direct LangGraph execution may be enough.
If you want a managed control plane, billing system, model gateway, or evaluation service, those
remain separate choices. A frozen serverless function cannot continue background work after its
request ends; use a long-lived backend for that [deployment pattern](./deploy-serverless.md).

## Try it with your project {#convinced-or-curious}

Follow [Getting started](./getting-started.md), run a known input in the [console](./console.md),
and add a [repeatable project test](./testing-your-project.md). Verify the behavior your application
relies on before choosing a deployment.
