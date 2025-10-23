import { Command } from "commander";
import { resolveJobChain } from "../core/resolve";
import { awsConsoleUrl } from "../utils/urls";
import { section, kv, colors } from "../utils/print";

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

        const failed = status === "FAILED" || (exitCode != null && exitCode !== 0);
        const jobLabel = colors.bold(colors.yellow("Job"));
        const statusWord = failed ? "Failed" : status === "SUCCEEDED" ? "Success" : status;
        const statusStyled = failed
          ? colors.red(colors.bold(`[${statusWord}]`))
          : status === "SUCCEEDED"
          ? colors.green(colors.bold(`[${statusWord}]`))
          : colors.yellow(colors.bold(`[${statusWord}]`));
        
        console.log(colors.gray("───────────────────────────────────────────────────────────────────────"));
        section(colors.yellow(colors.bold("Job Details")));
        kv("Id", `${info.job.jobName} (${info.job.jobId})`, (s) => colors.brightCyan(s));
        if (exitCode != null) kv("Exit Code", exitCode, colors.brightCyan);
        kv("Status", statusStyled, colors.brightCyan);

        const isFargate = info.ecsTask?.launchType === "FARGATE" || info.job.platformCapabilities?.includes?.("FARGATE");
        const isEks = !!(info.job.eksAttempts?.length || info.job.eksProperties || info.job.platformCapabilities?.includes?.("EKS"));
        if (isEks) console.log(colors.yellow("This job appears to be Batch on EKS (no ECS/EC2)."));
        if (isFargate) console.log(colors.yellow("This job ran on Fargate (no EC2 host)."));

        if (!info.ecsTask) {
          console.log(colors.gray("No ECS task object resolved; showing available identifiers."));
        } else if (!info.ec2Instance && !isFargate) {
          console.log(colors.gray("ECS task resolved, but EC2 instance not found (could be ENI not attached or perms)."));
        }

        if (reason) kv("Reason", failed ? colors.red(reason) : colors.yellow(reason), colors.red);
        kv("Queue", info.job.jobQueue, colors.brightCyan);
        kv("ComputeEnv", info.job.computeEnvironment, colors.brightCyan);
        kv("Image", info.image, colors.brightCyan);
        if (info.command?.length) kv("Cmd", info.command.join(" "), colors.brightCyan);
        console.log(colors.gray(""));
        console.log(colors.gray("───────────────────────────────────────────────────────────────────────"));

        if (info.ecsTask || info.taskArn || info.containerInstanceArn) {
          section("ECS Task");
          if (info.ecsTask?.taskArn || info.taskArn) kv("ARN", info.ecsTask?.taskArn || info.taskArn, colors.brightCyan);
          if (info.ecsClusterArn) kv("Cluster", info.ecsClusterArn, colors.brightCyan);
          if (info.containerInstanceArn) kv("ContainerInstance", info.containerInstanceArn, colors.brightCyan);
          if (info.ecsClusterArn && (info.ecsTask?.taskArn || info.taskArn)) {
            const ecsPath = `ecs/home#/clusters/${encodeURIComponent(
              info.ecsClusterArn
            )}/tasks/${encodeURIComponent(info.ecsTask?.taskArn || info.taskArn || "")}`;
            kv("Console", awsConsoleUrl("ecs", ctx.region, ecsPath), colors.brightCyan);
          }
          console.log(colors.gray(""));
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
          kv("Instance", iid, colors.brightCyan);
          kv("Private IP", pri, colors.brightCyan);
          kv("Public IP", pub, colors.brightCyan);
          kv("Subnet", subnet, colors.brightCyan);
          kv("SGs", sgs, colors.brightCyan);
          const ec2Path = `ec2/v2/home#InstanceDetails:instanceId=${iid}`;
          kv("Console", awsConsoleUrl("ec2", ctx.region, ec2Path), colors.brightCyan);
          console.log(colors.gray(""));
        } else if (info.ec2InstanceId) {
          section("Host (EC2)");
          kv("InstanceId", info.ec2InstanceId, colors.brightCyan);
          const ec2Path = `ec2/v2/home#InstanceDetails:instanceId=${info.ec2InstanceId}`;
          kv("Console", awsConsoleUrl("ec2", ctx.region, ec2Path), colors.brightCyan);
          console.log(colors.gray(""));
        }

        if (info.logStreamName) {
          section(colors.yellow(colors.bold("Logs")));
          kv("Group", opts.logGroup, colors.brightCyan);
          kv("Stream", info.logStreamName, colors.brightCyan);
          const logsPath = `cloudwatch/home#logsV2:log-groups/log-group/${encodeURIComponent(
            opts.logGroup
          )}/log-events/${encodeURIComponent(info.logStreamName)}`;
          kv("Console", awsConsoleUrl("logs", ctx.region, logsPath), colors.brightCyan);
          console.log(colors.gray(""));

          const lines = info.lastLogLines ?? [];
          if (lines.length) {
            console.log(colors.gray(`─── Logs (last ${lines.length}) BEGIN ─────────────────────────────────`));
            for (const line of lines) console.log(colors.dim(`  ${line}`));
            console.log(colors.gray(`─── Logs END ───────────────────────────────────────────────────────`));
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
