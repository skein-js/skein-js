# Deploy on Kubernetes

**Postgres and Redis are required for Skein’s standard production server.** Use a Deployment and
Service for the Skein image, and pass both database URLs to its Pods through a Secret.

Everything platform-agnostic — environment variables, pool sizing, probes, scaling caveats — is in
[deploy.md](./deploy.md).

## Before you start

You need a cluster, a namespace, and a registry your nodes can pull from.

### Provision Postgres and Redis

For managed services, use the [Cloud SQL and Memorystore setup](./deploy-cloud-run.md#provision-postgres-and-redis)
or the [RDS and ElastiCache setup](./deploy-aws.md#provision-postgres-and-redis) as a provisioning guide.
Configure DNS and network access from your Pods to the database endpoints. Use the provider’s
direct TCP Postgres URL for Pods unless you have set up a local database proxy. The Cloud Run
socket path in the Cloud SQL guide is specific to Cloud Run.

For in-cluster databases, use persistent storage and private Services. Use the writable service
endpoints and set Redis to `noeviction`. In either setup, give the Postgres role permission to
migrate the application database. Use pgvector only when the graph project enables `store.index`.

## 1. Push the image

```bash
export DOCKER_DEFAULT_PLATFORM=linux/amd64   # match your nodes' architecture
skein build -t registry.example.com/skein-app:v1
docker push registry.example.com/skein-app:v1
```

## 2. Manifests

Put the two URLs in a local, untracked `skein-secrets.env` file with mode `0600`. Use raw
`KEY=value` lines with the keys `POSTGRES_URI` and `REDIS_URI`. Include any model or tool
credentials the graph expects. Create the Secret in the namespace where you’ll apply the
manifest. Repeat the command pipeline when you rotate a credential, then restart the Deployment
to load the new values. [Kubernetes Secrets](https://kubernetes.io/docs/tasks/configmap-secret/managing-secret-using-kubectl/)

```bash
NAMESPACE=your-existing-namespace
kubectl -n "$NAMESPACE" create secret generic skein-secrets \
  --from-env-file=skein-secrets.env --dry-run=client -o yaml \
  | kubectl -n "$NAMESPACE" apply -f -
```

Save the manifest below as `skein.yaml`, substitute your image, and run
`kubectl -n "$NAMESPACE" apply -f skein.yaml`.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: skein-app
spec:
  replicas: 2
  selector:
    matchLabels: { app: skein-app }
  template:
    metadata:
      labels: { app: skein-app }
    spec:
      # Must exceed SKEIN_SHUTDOWN_GRACE_MS plus skein's force-exit buffer, or the pod is SIGKILLed
      # mid-drain and in-flight runs are stranded.
      terminationGracePeriodSeconds: 30
      containers:
        - name: skein
          image: registry.example.com/skein-app:v1
          ports:
            - containerPort: 8123
          envFrom:
            - secretRef: { name: skein-secrets }
          env:
            - name: PG_POOL_MAX
              value: "5"
            - name: SKEIN_RUN_CONCURRENCY
              value: "5"
            - name: SKEIN_SHUTDOWN_GRACE_MS
              value: "20000"
          # Give boot migrations time before checking HTTP liveness.
          startupProbe:
            httpGet: { path: /ok, port: 8123 }
            periodSeconds: 5
            failureThreshold: 24
          livenessProbe:
            httpGet: { path: /ok, port: 8123 }
            periodSeconds: 20
          readinessProbe:
            httpGet: { path: /ok, port: 8123 }
            periodSeconds: 10
          resources:
            requests: { cpu: "250m", memory: "512Mi" }
            limits: { memory: "1Gi" }
          securityContext:
            # Numeric UID of the node user in the default image.
            runAsUser: 1000
            runAsNonRoot: true
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
---
apiVersion: v1
kind: Service
metadata:
  name: skein-app
spec:
  selector: { app: skein-app }
  ports:
    - port: 80
      targetPort: 8123
```

Boot migrations take their own advisory lock, so a rolling update where old and new pods overlap is
safe — pods that don't win the lock wait for it and then find nothing to apply. You do not need an
init container or a migration Job.

> Requires skein **0.10.0+**. Earlier versions took the lock with `pg_try_advisory_lock` and the
> losing pod crashed with "Another migration is already running" instead of waiting.

## 3. Ingress and streaming

SSE breaks behind a buffering ingress. With ingress-nginx:

```yaml
metadata:
  annotations:
    nginx.ingress.kubernetes.io/proxy-buffering: "off"
    # skein sends no SSE heartbeat, so a quiet stream must not be culled early.
    nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "3600"
```

## 4. Verify

```bash
kubectl -n "$NAMESPACE" port-forward svc/skein-app 8123:80
```

Then run the [verification sequence](./deploy.md#verify-a-deployment) against
`http://localhost:8123`.

## Kubernetes caveats

- **`terminationGracePeriodSeconds` must exceed your drain window.** The default 30s comfortably
  covers skein's default (5s drain + 3s buffer) and the 20s shown above. See
  [Graceful shutdown](./deploy.md#graceful-shutdown).
- **Autoscaling on CPU is usually wrong.** Runs are typically I/O-bound on a model provider, so CPU
  stays low while the worker is saturated. Raise `SKEIN_RUN_CONCURRENCY` first; scale replicas when
  runs are genuinely CPU-bound, and watch the
  [connection budget](./deploy.md#connection-budget) — `3 × PG_POOL_MAX × replicas`.
- **`replicas: 2` and above**: cross-instance cancellation and the one-active-run-per-thread guard hold
  with Postgres + Redis configured, so no session affinity or thread-affinity routing is needed. Read
  [Scaling past one instance](./deploy.md#scaling-past-one-instance) for the connection budget, since
  each executing run holds one connection for its whole duration.
- Add a **PodDisruptionBudget** (`minAvailable: 1`) so a node drain doesn't take every replica at
  once.
- `readOnlyRootFilesystem: true` works because skein itself writes nothing to disk in production (the
  `.skein` snapshot is a `skein dev` feature). If one of _your_ graph's dependencies needs scratch
  space, mount an `emptyDir` at `/tmp`.
