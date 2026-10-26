# Native and BullMQ approval example

One LangGraph approval graph, with two hosts. No model credentials are required. Use Node 24 or
newer; the outcome receiver uses Node's built-in SQLite module. Library imports use package roots.
From the repository root, run `pnpm install` once.

## Embedded SQLite, without HTTP or Redis

```sh
pnpm exec nx run example-native-transports:embedded
```

The command admits an approval request, waits for its interrupt, prints its receipt and whole retained
result, then closes the worker and storage. Run it again: the same source/principal/key recover the
same receipt. Set `SKEIN_COMMAND_ID=approval-2` for a new request. The application owns the decision
to resume an interrupt or retry an abandoned attempt. SQLite marks attempts abandoned during execution
as failed; it never automatically replays them.

`src/embedded.ts` shows `runtime.createNativeClient`, explicit worker startup, durable acceptance and
reconciliation. `src/approval.ts` owns approval policy.

## HTTP and BullMQ on one backend

Start a local Redis service, for example `docker run --rm -p 127.0.0.1:6379:6379 redis:7-alpine`.
Use separate terminals:

```sh
# Terminal 1: single SQLite owner, loopback HTTP, explicit BullMQ consumption.
pnpm exec nx run example-native-transports:backend

# Terminal 2: admit, receive the interrupt, answer, fetch results and record outcomes.
pnpm exec nx run example-native-transports:producer
```

The producer prints both receipts and the `approved` decision. Re-run it, or restart both processes
and re-run it: the same keys recover the same runs. It uses the original run's retained checkpoint,
so a retry retains its meaning after the thread advances. It verifies offsets, total size and SHA-256
before parsing broker results. The 2 KiB message limit demonstrates bounded retrieval; stored native
results remain whole.

The backend also accepts Agent Protocol HTTP requests:

```sh
curl -H 'Authorization: Bearer local-example' -H 'Content-Type: application/json' \
  -d '{"assistant_id":"approval","input":{"request":"Publish the release notes"}}' \
  http://127.0.0.1:2024/runs
```

Both transports use one graph and one host-controlled principal. They can share an authorized thread;
source keys remain separate. For multiple backend replicas, use Postgres/Redis assembly instead of
sharing SQLite. The packed consumer test demonstrates that deployment.

The outcome worker records `eventId` in a SQLite table with a unique key **before** acknowledgement.
Put application database effects in the same transaction. Keep the inbox independently of Redis job
removal. Outcomes can be duplicated or arrive out of order; associate each with its receipt's run ID.
If delivery is missed, reconcile using `result.get`.

| Environment variable  | Default                        | Purpose                                      |
| --------------------- | ------------------------------ | -------------------------------------------- |
| `REDIS_URI`           | `redis://127.0.0.1:6379`       | Redis connection, including credentials/TLS  |
| `PORT`                | `2024`                         | Loopback HTTP port                           |
| `SKEIN_SQLITE_PATH`   | `.skein/native-example.sqlite` | Backend storage; one owner                   |
| `SKEIN_RECEIVER_PATH` | `.skein/receiver.sqlite`       | Durable outcome inbox                        |
| `SKEIN_COMMAND_ID`    | `approval-demo-1`              | Stable command key; change for a new request |
| `SKEIN_COMMAND_QUEUE` | `native-example-commands`      | Stable external command queue                |
| `SKEIN_OUTCOME_QUEUE` | `native-example-outcomes`      | Stable external outcome queue                |
| `SKEIN_EXAMPLE_TOKEN` | `local-example`                | Local demonstration HTTP token               |

Paths resolve from the example directory. Stop the backend before switching hosts that use its
database. `Ctrl-C` closes consumption, HTTP/runtime, storage and borrowed resources in that order.
Remove `.skein/` after stopping both processes to discard local history. Redis copies need separate
cleanup.

## Trust and application policy

This local example assumes Redis credentials restrict the command queue to **one trusted backend
producer**. It binds that producer to a principal in server code. It does not verify end-user identity
from message fields. Replace the local token and configure Redis ACLs, TLS, network restrictions and
retention before using real data. Redis readers can inspect payloads and query return values.

`projectResult` exposes decision and checkpoint on outcomes and `result.get`. It does not redact
`state.get` or `run.get`. The host rejects `run.get` and permits full state for this trusted producer.
An assistant allowlist limits routing; it does not isolate data between graphs sharing a thread.

See [native access](../../docs/native-access.md) and
[security and operations](../../docs/native-access-security.md) for resume, stop confirmation,
deadlines, recovery and retained-data boundaries.

## End-to-end checks

```sh
pnpm exec nx run-many -t lint typecheck build -p example-native-transports
pnpm exec nx run example-native-transports:test-integration
pnpm exec nx run test-support:test-native-consumer
```

The example target boots real Redis, runs the built entrypoints in separate processes, reopens
embedded storage, calls real HTTP, restarts backend and receiver, and checks stable receipts, results
and durable outcome deduplication. Packed consumers also cover Postgres, process crashes, stale
answers, chunking and package installation outside the workspace.

The example supports the tested BullMQ 5/6 and ioredis 5/6 combinations. BullMQ queues/workers receive
connection options and own their clients. The backend lends a separate ioredis client to Skein's
transport and closes it after the transport stops. This also avoids nominal connector-type conflicts
when BullMQ 5 retains its own ioredis 5 dependency alongside application ioredis 6.
