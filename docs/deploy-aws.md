# Deploy on AWS (App Runner or ECS Fargate)

**Postgres and Redis are required for Skein’s standard production server.** Use private RDS for
PostgreSQL and ElastiCache with ECS Fargate. Existing App Runner customers can use the same database
setup for inline runs. [App Runner availability](https://docs.aws.amazon.com/apprunner/latest/dg/apprunner-availability-change.html)

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

skein build --artifact-only
curl -fsS https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
  -o .skein/build/rds-ca-bundle.pem
docker build -t "$IMAGE" .skein/build
docker push "$IMAGE"
```

The image includes the RDS CA bundle at `/app/rds-ca-bundle.pem` for certificate verification.

<span id="provision-postgres-and-redis"></span>

### 2. Postgres and Redis

1. In **RDS → Databases → Create database**, choose **PostgreSQL**, select the app’s VPC and a
   private DB subnet group, and set **Public access** to **No**. Create a database and a role
   that owns it so Skein can run migrations at boot. For `store.index`, choose a Postgres version
   with pgvector and enable it with a privileged role if needed. Copy the DB instance’s writer
   **Endpoint** and **Port** from **Connectivity & security**. Make the RDS CA bundle available
   to the container at the path in your `POSTGRES_URI`:

   ```text
   postgresql://USER:PASSWORD@RDS_ENDPOINT:5432/DATABASE?sslmode=verify-full&sslrootcert=/app/rds-ca-bundle.pem
   ```

   [Create an RDS instance](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_CreateDBInstance.html) ·
   [RDS PostgreSQL TLS](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/PostgreSQL.Concepts.General.SSL.html)

2. In **ElastiCache**, create a **node-based** Valkey or Redis OSS deployment with **cluster
   mode disabled** in private subnets in that VPC. Use a custom parameter group for the engine
   family with `maxmemory-policy=noeviction`. Enable in-transit encryption and configure an
   AUTH token. Copy the writable **Primary endpoint** and port from the deployment details
   for `REDIS_URI`:

   ```text
   rediss://:AUTH_TOKEN@PRIMARY_ENDPOINT:6379
   ```

   [Create an ElastiCache deployment](https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/Clusters.Create.html) ·
   [ElastiCache parameter groups](https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/ParameterGroups.Engine.html) ·
   [ElastiCache AUTH](https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/auth.html)

3. URL-encode any reserved characters in the credentials. In **Secrets Manager**, create two
   secrets, `skein/postgres-uri` and `skein/redis-uri`. Store each raw URI as the entire secret
   value using the plaintext editor, then copy both full secret ARNs. Use these ARNs in the
   service configuration below.

### 3. Security groups

Allow the service’s security group to reach the RDS and ElastiCache security groups on ports 5432
and 6379. On each database group, allow inbound traffic on its port from the service group. For App
Runner, use the VPC connector’s security group as the source.

## App Runner

For an existing App Runner account, create or update a service from the ECR image. Set the
container port to **8123** and use an HTTP health check at **`/ok`**. Choose an ECR access role
for the image and a separate instance role with `secretsmanager:GetSecretValue` on the two secrets.
Add them as secret-backed environment variables named `POSTGRES_URI` and `REDIS_URI`. Set outbound
networking to a **VPC connector** that can reach both databases. If your graphs call public API
endpoints, the connector’s subnets need outbound internet access through a NAT gateway.
[App Runner secret access](https://docs.aws.amazon.com/apprunner/latest/dg/env-variable.html) ·
[App Runner outbound networking](https://docs.aws.amazon.com/apprunner/latest/dg/network-vpc.html)

### App Runner caveats

- **CPU is throttled between requests**, the same hazard as Cloud Run: a background run keeps
  executing after its request returns, and a throttled instance stops making progress. If you rely on
  background runs, prefer ECS Fargate — App Runner gives you no equivalent of
  `--no-cpu-throttling`. Inline runs (`/runs/wait`, `/runs/stream`) are unaffected.
- The health check path must be `/ok`; the default `/` is not a skein route.
- Streaming works, but App Runner's request timeout caps a long SSE run.

## ECS Fargate

Create an ECS task execution role with access to pull from ECR, write to the CloudWatch log group,
and read both secrets via `secretsmanager:GetSecretValue`. Include `kms:Decrypt` if you use a
customer-managed KMS key. Create the log group, then register the task definition with the
execution role ARN, image URL, and both secret ARNs substituted. If the graph needs model or tool
credentials, add their Secrets Manager references too. [ECS task execution role](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_execution_IAM_role.html)

```json
{
  "family": "skein-app",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "executionRoleArn": "arn:aws:iam::ACCOUNT:role/skeinTaskExecutionRole",
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
        {
          "name": "POSTGRES_URI",
          "valueFrom": "arn:aws:secretsmanager:REGION:ACCOUNT:secret:skein/postgres-uri-SUFFIX"
        },
        {
          "name": "REDIS_URI",
          "valueFrom": "arn:aws:secretsmanager:REGION:ACCOUNT:secret:skein/redis-uri-SUFFIX"
        }
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

Run the task as a Fargate service in private subnets using the service security group. The tasks
need outbound access to ECR, CloudWatch Logs, and Secrets Manager through NAT or VPC endpoints.
Attach an Application Load Balancer with an IP target group on port 8123 and an HTTP health check
at **`/ok`**. Give the service time for boot migrations before health checks can replace a task.

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

Run the [verification sequence](./deploy.md#verify-a-deployment) against your service URL. On App
Runner, use the inline run and checkpoint checks. On ECS Fargate, continue through the queued run
and stream replay checks. Configure [application auth](./deploy.md#5-auth--read-this-before-you-expose-it)
before accepting public traffic.
