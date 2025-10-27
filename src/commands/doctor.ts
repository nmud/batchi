import { Command } from "commander";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { BatchClient, DescribeJobQueuesCommand } from "@aws-sdk/client-batch";
import { ECSClient, ListClustersCommand } from "@aws-sdk/client-ecs";
import { EC2Client, DescribeVpcsCommand } from "@aws-sdk/client-ec2";
import { CloudWatchLogsClient, DescribeLogGroupsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { ECRClient, DescribeRepositoriesCommand } from "@aws-sdk/client-ecr";
import { S3Client, ListBucketsCommand } from "@aws-sdk/client-s3";
import { colors, kv, section } from "../utils/print";

type AwsMakers = (region?: string) => {
  region: string;
  batch: BatchClient;
  ecs: ECSClient;
  ec2: EC2Client;
  logs: CloudWatchLogsClient;
  s3: S3Client;
  ecr: ECRClient;
};

const ok = colors.green("✓");
const bad = colors.red("✗");

async function check(call: () => Promise<unknown>): Promise<{ pass: boolean; message?: string }> {
  try {
    await call();
    return { pass: true };
  } catch (e: any) {
    const msg = e?.message || String(e);
    return { pass: false, message: msg };
  }
}

export function registerDoctor(program: Command, makeAwsCtx: AwsMakers) {
  program
    .command("doctor")
    .description("Check AWS configuration and required permissions for batchi commands")
    .option("-r, --region <region>", "AWS region")
    .action(async (opts) => {
      const ctx = makeAwsCtx(opts.region);

      console.log(colors.gray("───────────────────────────────────────────────────────────────────────"));
      section(colors.yellow(colors.bold("Doctor")));

      // Identity and region
      const sts = new STSClient({ region: ctx.region });
      const id = await check(async () => sts.send(new GetCallerIdentityCommand({})));
      kv("Region", ctx.region, colors.brightCyan);
      if (id.pass) {
        console.log(`${ok} ${colors.brightCyan("AWS credentials resolved")}`);
      } else {
        console.log(`${bad} ${colors.red("AWS credentials not configured or invalid")}`);
        if (id.message) console.log(colors.dim(`  ${id.message}`));
      }

      // Per-command capability checks
      console.log(colors.gray(""));
      section(colors.yellow(colors.bold("Command Permissions")));

      // INSPECT touches Batch, ECS, EC2, Logs, ECR (read-only)
      const inspectChecks = await Promise.all([
        check(async () => ctx.batch.send(new DescribeJobQueuesCommand({ maxResults: 1 }))),
        check(async () => ctx.ecs.send(new ListClustersCommand({ maxResults: 1 }))),
        check(async () => ctx.ec2.send(new DescribeVpcsCommand({ MaxResults: 5 }))),
        check(async () => ctx.logs.send(new DescribeLogGroupsCommand({ limit: 1 } as any))),
        check(async () => ctx.ecr.send(new DescribeRepositoriesCommand({ maxResults: 1 } as any))),
      ]);
      const inspectPass = inspectChecks.every((r) => r.pass);
      console.log(`${inspectPass ? ok : bad} inspect`);
      if (!inspectPass) {
        for (const r of inspectChecks) if (!r.pass && r.message) console.log(colors.dim(`  ${r.message}`));
      }

      // LOGS touches Logs and Batch for resolution (read-only)
      const logsChecks = await Promise.all([
        check(async () => ctx.logs.send(new DescribeLogGroupsCommand({ limit: 1 } as any))),
        check(async () => ctx.batch.send(new DescribeJobQueuesCommand({ maxResults: 1 }))),
      ]);
      const logsPass = logsChecks.every((r) => r.pass);
      console.log(`${logsPass ? ok : bad} logs`);
      if (!logsPass) {
        for (const r of logsChecks) if (!r.pass && r.message) console.log(colors.dim(`  ${r.message}`));
      }

      // ARTIFACTS touches S3 list/head, Batch, Logs (read-only)
      const artifactsChecks = await Promise.all([
        check(async () => ctx.s3.send(new ListBucketsCommand({}))),
        check(async () => ctx.batch.send(new DescribeJobQueuesCommand({ maxResults: 1 }))),
        check(async () => ctx.logs.send(new DescribeLogGroupsCommand({ limit: 1 } as any))),
      ]);
      const artifactsPass = artifactsChecks.every((r) => r.pass);
      console.log(`${artifactsPass ? ok : bad} artifacts`);
      if (!artifactsPass) {
        for (const r of artifactsChecks) if (!r.pass && r.message) console.log(colors.dim(`  ${r.message}`));
      }

      console.log(colors.gray(""));
      const allPass = id.pass && inspectPass && logsPass && artifactsPass;
      if (allPass) {
        console.log(colors.green(colors.bold("You're good to go!")));
        console.log(colors.gray("If this package helped, consider leaving a ⭐ on GitHub!"));
        console.log(colors.brightCyan("https://github.com/nmud/batchi"));
      } else {
        console.log(colors.red(colors.bold("Some checks failed. Please review errors above.")));
      }
    });
}


