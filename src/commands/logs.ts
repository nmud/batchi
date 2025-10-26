import { Command } from "commander";
import { resolveJobChain } from "../core/resolve";
import { awsConsoleUrl } from "../utils/urls";
import { section, kv, colors } from "../utils/print";
import { GetLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";

export function registerLogs(program: Command, makeAwsCtx: (region?: string) => any) {
  program
    .command("logs")
    .usage("<jobId> [options]")
    .argument("<jobId>", "AWS Batch Job ID")
    .option("-r, --region <region>", "AWS region")
    .option("--log-group <name>", "CloudWatch Logs group name", "/aws/batch/job")
    .option("--log-lines <n>", "Number of last log lines to include", "50")
    .option("--stream <name>", "Override log stream name (skip job resolution)")
    .option("-f, --follow", "Stream logs until interrupted")
    .option("--from-start", "When following, start from beginning of stream")
    .option("--since <min>", "Only show events since N minutes ago (fetch mode)")
    .description("Fetch or stream CloudWatch logs for the job's log stream")
    .action(async (jobId, opts) => {
      const ctx = makeAwsCtx(opts.region);
      const group: string = opts.logGroup || "/aws/batch/job";
      const lines: number = Math.max(1, Number(opts.logLines || 50));
      const follow: boolean = Boolean(opts.follow);
      const fromStart: boolean = Boolean(opts.fromStart);
      const sinceMin: number | undefined = opts.since ? Number(opts.since) : undefined;

      try {
        // Resolve log stream unless explicitly provided
        let logStreamName: string | undefined = opts.stream;
        if (!logStreamName) {
          const info = await resolveJobChain(
            { region: ctx.region, batch: ctx.batch, ecs: ctx.ecs, ec2: ctx.ec2, logs: ctx.logs, ecr: ctx.ecr, credsProvider: ctx.credsProvider },
            jobId,
            { logGroup: group, logLines: lines }
          );
          logStreamName = info.logStreamName;
        }

        console.log(colors.gray("───────────────────────────────────────────────────────────────────────"));
        section(colors.yellow(colors.bold("Logs")));
        kv("Group", group, colors.brightCyan);
        kv("Stream", logStreamName || "-", colors.brightCyan);
        if (logStreamName) {
          const logsPath = `cloudwatch/home#logsV2:log-groups/log-group/${encodeURIComponent(
            group
          )}/log-events/${encodeURIComponent(logStreamName)}`;
          kv("Console", awsConsoleUrl("logs", ctx.region, logsPath), colors.brightCyan);
        }
        console.log(colors.gray(""));

        if (!logStreamName) {
          console.log(colors.gray("No Logs available."));
          return;
        }

        const startTimeMs = sinceMin && sinceMin > 0 ? Date.now() - sinceMin * 60_000 : undefined;

        if (!follow) {
          // Single fetch
          const r = await ctx.logs.send(
            new GetLogEventsCommand({
              logGroupName: group,
              logStreamName,
              startFromHead: Boolean(startTimeMs || lines > 5000),
              ...(startTimeMs ? { startTime: startTimeMs } : {}),
            })
          );
          const events = (r.events || [])
            .map((e) => (e.message ?? "").trim())
            .filter(Boolean);
          const last = events.slice(-lines);
          if (last.length) {
            console.log(colors.gray(`─── Logs (last ${last.length}) BEGIN ─────────────────────────────────`));
            for (const line of last) console.log(colors.dim(`  ${line}`));
            console.log(colors.gray(`─── Logs END ───────────────────────────────────────────────────────`));
          } else {
            console.log(colors.gray("No log events found."));
          }
          return;
        }

        // Follow mode
        console.log(colors.gray("─── Streaming (Ctrl+C to stop) ───────────────────────────────────────"));
        let nextToken: string | undefined;
        let initialized = false;
        while (true) {
          const r = await ctx.logs.send(
            new GetLogEventsCommand({
              logGroupName: group,
              logStreamName,
              startFromHead: fromStart,
              ...(initialized && nextToken ? { nextToken } : {}),
              ...(startTimeMs && !initialized ? { startTime: startTimeMs } : {}),
            })
          );
          initialized = true;
          const events = (r.events || [])
            .map((e) => (e.message ?? "").trim())
            .filter(Boolean);
          if (events.length) {
            for (const line of events) console.log(colors.dim(`  ${line}`));
          }
          if (r.nextForwardToken && r.nextForwardToken !== nextToken) {
            nextToken = r.nextForwardToken;
          }
          await new Promise((res) => setTimeout(res, 1500));
        }
      } catch (err: any) {
        console.error(`[error] ${err.message || err}`);
        process.exitCode = 1;
      }
    });
}