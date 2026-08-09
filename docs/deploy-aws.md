# Deploy on AWS (App Runner or ECS Fargate)

Two ways to run the skein image on AWS. **App Runner** is the closest analogue to Cloud Run — give it
an image, get a URL — and is the lower-effort choice. **ECS Fargate** is more setup but gives you a
long stop timeout, real background-run behavior, and fits teams already running ECS.

Both share the same registry, database, and secret plumbing. Everything platform-agnostic —
environment variables, pool sizing, probes, scaling caveats — is in [deploy.md](./deploy.md).

## Shared setup

### 1. Push the image to ECR

```bash
export AWS_REGION=us-east-1 ACCOUNT=123456789012 REPO=skein-app
export IMAGE=$ACCOUNT.dkr.ecr.$AWS_REGION.amazonaws.com/$REPO:v1

# Fargate and App Runner run x86 by default; skein build doesn't pass --platform.
export DOCKER_DEFAULT_PLATFORM=linux/amd64

aws ecr create-repository --repository-name $REPO
aws ecr get-login-password --region $AWS_REGION \
  | docker login --username AWS --password-stdin $ACCOUNT.dkr.ecr.$AWS_REGION.amazonaws.com

skein build -t $REPO
docker tag $REPO $IMAGE
docker push $IMAGE
```

### 2. Postgres and Redis

**RDS for PostgreSQL** (15+ has pgvector, needed only if you set `store.index`) and **ElastiCache for
Redis or Valkey**. Put both in the same VPC as the service, and set the Redis maxmemory policy to
`noeviction`.

Keep both connection strings in **Secrets Manager** and inject them by reference rather than as
plaintext environment variables.

### 3. Security groups

The service's security group needs egress to the database security groups on 5432 and 6379, and the
database groups need matching ingress. Both engines are private-subnet resources — nothing here
should be publicly reachable.

## App Runner

You declare the port App Runner routes to; it also sets `PORT` in the container to match, and skein
binds it. Either way the answer is **8123**, the port the image exposes.

```bash
aws apprunner create-service \
  --service-name skein-app \
  --source-configuration '{
    "ImageRepository": {
      "ImageIdentifier": "'"$IMAGE"'",
      "ImageRepositoryType": "ECR",
      "ImageConfiguration": {
        "Port": "8123",
        "RuntimeEnvironmentSecrets": {
          "POSTGRES_URI": "arn:aws:secretsmanager:…:skein/postgres-uri",
          "REDIS_URI": "arn:aws:secretsmanager:…:skein/redis-uri"
        },
        "RuntimeEnvironmentVariables": {
          "PG_POOL_MAX": "5",
          "SKEIN_RUN_CONCURRENCY": "5"
        }
      }
    }
  }' \
  --health-check-configuration '{
    "Protocol": "HTTP", "Path": "/ok",
    "Interval": 20, "Timeout": 5, "HealthyThreshold": 1, "UnhealthyThreshold": 5
  }' \
  --instance-configuration '{"Cpu":"1 vCPU","Memory":"2 GB"}'
```

To reach a private RDS or ElastiCache, attach a **VPC connector** (`NetworkConfiguration.EgressConfiguration`).

### App Runner caveats

- **CPU is throttled between requests**, the same hazard as Cloud Run: a background run keeps
  executing after its request returns, and a throttled instance stops making progress. If you rely on
  background runs, prefer ECS Fargate — App Runner gives you no equivalent of
  `--no-cpu-throttling`. Inline runs (`/runs/wait`, `/runs/stream`) are unaffected.
- The health check path must be `/ok`; the default `/` is not a skein route.
- Streaming works, but App Runner's request timeout caps a long SSE run.

## ECS Fargate

A task definition, a service, and an ALB. The parts that matter:

```json
{
  "family": "skein-app",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "1024",
  "memory": "2048",
  "containerDefinitions": [
    {
      "name": "skein",
      "image": "ACCOUNT.dkr.ecr.REGION.amazonaws.com/skein-app:v1",
      "portMappings": [{ "containerPort": 8123, "protocol": "tcp" }],
      "environment": [
        { "name": "PG_POOL_MAX", "value": "5" },
        { "name": "SKEIN_RUN_CONCURRENCY", "value": "5" },
        { "name": "SKEIN_SHUTDOWN_GRACE_MS", "value": "20000" }
      ],
      "secrets": [
        { "name": "POSTGRES_URI", "valueFrom": "arn:aws:secretsmanager:…:skein/postgres-uri" },
        { "name": "REDIS_URI", "valueFrom": "arn:aws:secretsmanager:…:skein/redis-uri" }
      ],
      "healthCheck": {
        "command": [
          "CMD-SHELL",
          "node -e \"fetch('http://127.0.0.1:8123/ok').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""
        ],
        "interval": 30,
        "timeout": 5,
        "retries": 3,
        "startPeriod": 30
      },
      "stopTimeout": 30,
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/skein-app",
          "awslogs-region": "us-east-1",
          "awslogs-stream-prefix": "skein"
        }
      }
    }
  ]
}
```

Point the ALB target group's health check at **`/ok`** on port 8123, with a healthy threshold that
tolerates the ~20s boot.

### ECS caveats

- **`stopTimeout: 30`** gives skein room to drain. With it, you can raise
  `SKEIN_SHUTDOWN_GRACE_MS` above the 5s default (20s, as above) so long runs finish instead of being
  aborted on every deploy — see [Graceful shutdown](./deploy.md#graceful-shutdown).
- **Background runs work by default** — Fargate doesn't throttle CPU between requests. This is the
  main reason to pick ECS over App Runner.
- Raise the ALB's **idle timeout** past your longest quiet SSE stretch; skein sends no heartbeat
  frame ([details](./deploy.md#streaming-through-proxies-sse)).
- `desiredCount` above 1 means reading
  [Scaling past one instance](./deploy.md#scaling-past-one-instance).
- Enable the deployment circuit breaker so a failed boot (a bad `POSTGRES_URI`, a missing pgvector)
  rolls back instead of cycling tasks.

## Verify

Run the [verification sequence](./deploy.md#verify-a-deployment) against your App Runner URL or the
ALB's DNS name.
