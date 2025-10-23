import { Command } from "commander";
import { resolveJobChain } from "../core/resolve";
import { awsConsoleUrl } from "../utils/urls";
import { section, kv } from "../utils/print";

export function registerInspect(program: Command, makeAwsCtx: (region?: string) => any) {
  program
    .command("inspect")
    .usage("<jobId> [options]")
    .argument("<jobId>", "AWS Batch Job ID")
    .option("-r, --region <region>", "AWS region")
    .option("--log-group <name>", "CloudWatch Logs group name", "/aws/batch/job")
    .option("--log-lines <n>", "Number of last log lines to include", "50")
    .description("Show job summary: status, links, image, env, host, last logs")
    .showHelpAfterError()
    .action(async (jobId, opts) => {
      const ctx = makeAwsCtx(opts.region);
      try {
        const info = await resolveJobChain(
          { region: ctx.region, batch: ctx.batch, ecs: ctx.ecs, ec2: ctx.ec2, logs: ctx.logs },
          jobId,
          { logGroup: opts.logGroup, logLines: Number(opts.logLines) }
        );

        const status = info.job.status;
        const exitCode = info.container?.exitCode;
        const reason = info.container?.reason || info.job.statusReason;
        const attempts = info.job.attempts?.length ?? 0;

        console.log(
          `Job: ${info.job.jobName} (${info.job.jobId}) [${status}]${exitCode != null ? ` Exit ${exitCode}` : ""}`
        );
        if (reason) kv("Reason", reason);
        kv("Queue", info.job.jobQueue);
        kv("ComputeEnv", info.job.computeEnvironment);
        kv("Image", info.image);
        if (info.command?.length) kv("Cmd", info.command.join(" "));

        if (info.ecsTask) {
          section("ECS Task");
          kv("ARN", info.ecsTask.taskArn);
          const ecsPath = `ecs/home#/clusters/${encodeURIComponent(
            info.ecsClusterArn ?? ""
          )}/tasks/${encodeURIComponent(info.ecsTask.taskArn)}`;
          kv("Console", awsConsoleUrl("ecs", ctx.region, ecsPath));
        }

        if (info.ec2Instance) {
          section("Host (EC2)");
          const iid = info.ec2Instance.InstanceId;
          const pri = info.ec2Instance.PrivateIpAddress;
          const pub = info.ec2Instance.PublicIpAddress || "-";
          const subnet = info.ec2Instance.SubnetId;
          const sgs = (info.ec2Instance.SecurityGroups || [])
            .map((g: any) => `${g.GroupName}(${g.GroupId})`)
            .join(", ");
          kv("Instance", iid);
          kv("Private IP", pri);
          kv("Public IP", pub);
          kv("Subnet", subnet);
          kv("SGs", sgs);
          const ec2Path = `ec2/v2/home#InstanceDetails:instanceId=${iid}`;
          kv("Console", awsConsoleUrl("ec2", ctx.region, ec2Path));
        }

        if (info.logStreamName) {
          section("Logs");
          kv("Group", opts.logGroup);
          kv("Stream", info.logStreamName);
          const logsPath = `cloudwatch/home#logsV2:log-groups/log-group/${encodeURIComponent(
            opts.logGroup
          )}/log-events/${encodeURIComponent(info.logStreamName)}`;
          kv("Console", awsConsoleUrl("logs", ctx.region, logsPath));

          const lines = info.lastLogLines ?? [];
          if (lines.length) {
            section(`Last ${lines.length} line(s)`);
            for (const line of lines) console.log(`  ${line}`);
          }
        }

        const envEntries = Object.entries(info.environment);
        if (envEntries.length) {
          section(`Env (${envEntries.length})`);
          for (const [k, v] of envEntries.slice(0, 10)) {
            console.log(`  ${k}=${v ?? ""}`);
          }
          if (envEntries.length > 10) console.log("  ...");
        }
      } catch (err: any) {
        console.error(`[error] ${err.message || err}`);
        process.exitCode = 1;
      }
    });
}
