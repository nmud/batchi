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
        // Flat line below Job line
        kv("Status", statusStyled, colors.brightCyan);
        if (reason) kv("Reason", failed ? colors.red(reason) : colors.yellow(reason), colors.red);
        kv("Queue", info.job.jobQueue, colors.brightCyan);
        kv("ComputeEnv", info.job.computeEnvironment, colors.brightCyan);
        kv("Image", info.image, colors.brightCyan);
        if (info.command?.length) kv("Cmd", info.command.join(" "), colors.brightCyan);
        // Empty Line below Job Details
        console.log(colors.gray(""));
        console.log(colors.gray("───────────────────────────────────────────────────────────────────────"));

        if (info.ecsTask) {
          section("ECS Task");
          kv("ARN", info.ecsTask.taskArn);
          const ecsPath = `ecs/home#/clusters/${encodeURIComponent(
            info.ecsClusterArn ?? ""
          )}/tasks/${encodeURIComponent(info.ecsTask.taskArn)}`;
          kv("Console", awsConsoleUrl("ecs", ctx.region, ecsPath));
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
          kv("Instance", iid);
          kv("Private IP", pri);
          kv("Public IP", pub);
          kv("Subnet", subnet);
          kv("SGs", sgs);
          const ec2Path = `ec2/v2/home#InstanceDetails:instanceId=${iid}`;
          kv("Console", awsConsoleUrl("ec2", ctx.region, ec2Path));
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
          // Empty Line below Logs
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
