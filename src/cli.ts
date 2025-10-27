#!/usr/bin/env node
/* Batch Inspector (batchi) - AWS Batch job debugging CLI
 * Currently only the 'inspect' command is wired.
 */

import { Command } from "commander";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { BatchClient } from "@aws-sdk/client-batch";
import { ECSClient } from "@aws-sdk/client-ecs";
import { EC2Client } from "@aws-sdk/client-ec2";
import { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { S3Client } from "@aws-sdk/client-s3";
import { ECRClient } from "@aws-sdk/client-ecr";
import { registerInspect } from "./commands/inspect";
import { registerLogs } from "./commands/logs";
import { registerArtifacts } from "./commands/artifacts";
import { registerDoctor } from "./commands/doctor";
const {version} = require('../package.json');

const program = new Command();
program
  .name("batchi")
  .description("Batch Inspector CLI")
  // Get actual version from package.json
  .version(version, "-v, -V, --version");

export type AwsCtx = {
  region: string;
  credsProvider: ReturnType<typeof fromNodeProviderChain>;
  batch: BatchClient;
  ecs: ECSClient;
  ec2: EC2Client;
  logs: CloudWatchLogsClient;
  s3: S3Client;
  ecr: ECRClient;
};

export function makeAwsCtx(region?: string): AwsCtx {
  const resolvedRegion =
    region || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-west-2";
  const credsProvider = fromNodeProviderChain();
  return {
    region: resolvedRegion,
    credsProvider,
    batch: new BatchClient({ region: resolvedRegion, credentials: credsProvider }),
    ecs: new ECSClient({ region: resolvedRegion, credentials: credsProvider }),
    ec2: new EC2Client({ region: resolvedRegion, credentials: credsProvider }),
    logs: new CloudWatchLogsClient({ region: resolvedRegion, credentials: credsProvider }),
    s3: new S3Client({ region: resolvedRegion, credentials: credsProvider }),
    ecr: new ECRClient({ region: resolvedRegion, credentials: credsProvider }),
  };
}

// Register commands
registerInspect(program, makeAwsCtx);
registerLogs(program, makeAwsCtx);
registerArtifacts(program, makeAwsCtx);
registerDoctor(program, makeAwsCtx);

// Parse
program.parseAsync(process.argv);
