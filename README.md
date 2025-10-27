# Batch Inspector (batchi)

One CLI to explain any AWS Batch job: end-to-end.

## Why

Debugging Batch typically means hopping across several services just to answer:
- Where did my job actually run?
- Why did it fail (exit 137? OOMKilled? ECR 403? No route to host)?
- What image/env/command were used?
- What subnet/SG/ENI/IP did it use?
- What were CPU/Mem (and GPU) at failure?
- How do I replay the exact job locally?

`batchi` turns that into one command.

## Features

`inspect` - full job summary: image, cmd, env, attempts, reason, EC2 task, EC2/Fargate details, subnet/SG/IP, last log lines.
`logs` - stream or fetch recent CloudWatch logs for the job.
`artifacts` - detect `s3://` inputs/outputs from env/cmd and presign for quick download.

## Setup

Requires Node.js >= 20 and AWS creds (profile/SSO/role/etc).

### Global Install

```
npm i -g @nmud/batchi
# ex; batchi inspect <jobId>
```

### Local Install

```
npm install @nmud/batchi --save-dev
# ex; npx batchi inspect <jobId>
```

## AWS Configuration
### AWS CLI
- Run: `aws configure sso`
- Validate: `aws sts get-caller-identity --profile <profile>`
- Login: `aws sso login --profile <profile>`
  
Ensure:
```
AWS_PROFILE=<profile>
AWS_REGION=<region>
```
are set in environment.

## Local Development
Two flows: global link or run directly via ts-node.
```
npm install
npm run build
npm link
batchi -v

batchi inspect <jobId> -r <region>
```
If `batchi` is not found, ensure global npm bin is on PATH:
```npm config get prefix```
Add `%APPDATA%\npm` to PATH if needed

### Run without Linking
```
npm install
npm run dev --inspect <jobId> -r <region>
```
### Rebuild after changes
```
npm run build
```
### Unlink
```
npm unlink -g @nmud/batchi
```
## Commands

### inspect
Show job summary including status, last logs, image, env, ECS/EC2/VPC details.

Usage:
```
batchi inspect <jobId> [options]
```

Options:
```
-r, --region <region>         AWS region
--log-group <name>            CloudWatch Logs group name (default: /aws/batch/job)
--log-lines <n>               Number of last log lines to include (default: 50)

-j, --job                     Show Job details
-c, --container               Show Container details
-i, --image                   Show Image details
--image-verbose               Show extended ECR image metadata if available
-e, --environment             Show Environment details
-l, --logs                    Show Logs
-n, --network                 Show Network details
-v, --vpc                     Show VPC details
--ecs                         Show ECS Task details
--ec2                         Show EC2 Instance details
```

Image metadata:
- If the container image is hosted in ECR and in the same region, inspect will include digest, tags, pushedAt, size (MB), and, with `--image-verbose`, image scan status and summarized findings when available.
 - Requires IAM permission: `ecr:DescribeImages` on the repository. Cross‑region ECR is supported.

### logs
Fetch or stream CloudWatch logs for a job.

Usage:
```
batchi logs <jobId> [options]
```

Options:
```
-r, --region <region>         AWS region
--log-group <name>            CloudWatch Logs group name (default: /aws/batch/job)
--log-lines <n>               Number of last log lines to include (default: 50)
--stream <name>               Override log stream name (skip job resolution)
-f, --follow                  Stream logs until interrupted
--from-start                  When following, start from beginning of stream
--since <min>                 Only show events since N minutes ago (fetch mode)
```

### artifacts
Detect s3:// URLs from job env and command, and presign object URLs for quick download.

Usage:
```
batchi artifacts <jobId> [options]
```

Options:
```
-r, --region <region>         AWS region
--expires <sec>               Presign expiry in seconds (default: 3600)
--log-group <name>            CloudWatch Logs group (used during resolution)
--console                     Print AWS Console links for S3 objects/prefixes
--list                        List object names under detected objects/prefixes
```

Notes:
- Outputs any found s3:// URLs and presigns objects when they exist. If a prefix is detected, it provides a hint to browse in console.
- Requires IAM permissions to access S3 objects (s3:HeadObject, s3:GetObject, s3:ListBucket for prefixes).

### Costs
The CLI uses standard AWS APIs. Some calls can incur small charges:

- CloudWatch Logs (used by `inspect`/`logs`): `GetLogEvents` has no per‑request fee; you pay for log ingestion/storage and any data transfer out.
- S3 (used by `artifacts`):
  - `HeadObject`/`GetObject` are charged per request (very small per 1,000 requests) and standard data transfer if you download content.
  - `ListObjectsV2` (when `--list`) is charged per LIST request (slightly higher per 1,000 than GET/HEAD).
- ECR (used by `inspect --image`): `DescribeImages` has no per‑request fee; normal ECR storage/data transfer pricing applies.

Always refer to the AWS pricing pages for up‑to‑date numbers. The CLI aims to minimize request counts (batching where possible), but repeated use may produce small charges.
