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
    .option("-j, --job", "Show Job details")
    .option("-c, --container", "Show Container details")
    .option("-i, --image", "Show Image details")
    .option("-e, --environment", "Show Environment details")
    .option("-l, --logs", "Show Logs")
    .option("-n, --network", "Show Network details")
    .option("-v, --vpc", "Show VPC details")
    .option("--ecs", "Show ECS Task details")
    .option("--ec2", "Show EC2 Instance details")
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
        const showFlags = {
          job: Boolean(opts.job),
          container: Boolean(opts.container),
          image: Boolean(opts.image),
          envVars: Boolean(opts.environment),
          logs: Boolean(opts.logs),
          network: Boolean(opts.network),
          vpc: Boolean(opts.vpc),
          ecs: Boolean(opts.ecs),
          ec2: Boolean(opts.ec2),
        };
        const anyRequested = Object.values(showFlags).some(Boolean);
        const shouldShow = (k: keyof typeof showFlags) => !anyRequested || showFlags[k];
        
        if (shouldShow("job")) {
          console.log(colors.gray("───────────────────────────────────────────────────────────────────────"));
          section(colors.yellow(colors.bold("Job Details")));
          kv("Id", `${info.job.jobName} (${info.job.jobId})`, (s) => colors.brightCyan(s));
          if (exitCode != null) kv("Exit Code", exitCode, colors.brightCyan);
          kv("Status", statusStyled, colors.brightCyan);

          const isFargate = info.ecsTask?.launchType === "FARGATE" || info.job.platformCapabilities?.includes?.("FARGATE");
          const isEks = !!(info.job.eksAttempts?.length || info.job.eksProperties || info.job.platformCapabilities?.includes?.("EKS"));
          if (!anyRequested) {
            if (isEks) console.log(colors.yellow("This job appears to be Batch on EKS (no ECS/EC2)."));
            if (isFargate) console.log(colors.yellow("This job ran on Fargate (no EC2 host)."));
          }
          if (reason) kv("Reason", failed ? colors.red(reason) : colors.yellow(reason), colors.red);
          kv("Queue", info.job.jobQueue, colors.brightCyan);
          if (!anyRequested) kv("ComputeEnv", info.computeEnvironmentArn || info.job.computeEnvironment, colors.brightCyan);
          console.log(colors.gray(""));
        }

        // Image details
        if (shouldShow("image")) {
          console.log(colors.gray("───────────────────────────────────────────────────────────────────────"));
          section(colors.yellow(colors.bold("Image")));
          kv("Image", info.image || "-", colors.brightCyan);
          if (info.command?.length) kv("Cmd", info.command.join(" "), colors.brightCyan);
          console.log(colors.gray(""));
        }

        // Container details
        if (shouldShow("container")) {
          console.log(colors.gray("───────────────────────────────────────────────────────────────────────"));
          section(colors.yellow(colors.bold("Container Details")));
          const resourceRequirements = info.job.container?.resourceRequirements;
          const vCPUs = resourceRequirements?.find((r: any) => r.type === "VCPU")?.value;
          const memory = resourceRequirements?.find((r: any) => r.type === "MEMORY")?.value;
          const gpu = resourceRequirements?.find((r: any) => r.type === "GPU")?.value;
          kv("vCPUs", vCPUs ?? "-", colors.brightCyan);
          kv("Memory", memory ?? "-", colors.brightCyan);
          kv("GPU", gpu ?? "-", colors.brightCyan);
          console.log(colors.gray(""));
        }

        if (shouldShow("ecs")) {
          console.log(colors.gray("───────────────────────────────────────────────────────────────────────"));
          if (info.ecsTask || info.taskArn || info.containerInstanceArn) {
            section(colors.yellow(colors.bold("ECS Task")));
            if (info.ecsTask?.taskArn || info.taskArn) kv("ARN", info.ecsTask?.taskArn || info.taskArn, colors.brightCyan);
            if (info.ecsClusterArn) kv("Cluster", info.ecsClusterArn, colors.brightCyan);
            if (info.containerInstanceArn) kv("ContainerInstance", info.containerInstanceArn, colors.brightCyan);
            if (info.ecsClusterArn && (info.ecsTask?.taskArn || info.taskArn)) {
              const ecsPath = `ecs/home#/clusters/${encodeURIComponent(
                info.ecsClusterArn
              )}/tasks/${encodeURIComponent(info.ecsTask?.taskArn || info.taskArn || "")}`;
              kv("Console", awsConsoleUrl("ecs", ctx.region, ecsPath), colors.brightCyan);
            }
          } else {
            section(colors.yellow(colors.bold("ECS Task")));
            console.log(colors.gray("No ECS details available."));
          }
          console.log(colors.gray(""));
        }

        // Environment (Compute Environment) details — show only in default summary
        if (!anyRequested && (info.computeEnvironment || info.computeEnvironmentArn)) {
          section(colors.yellow(colors.bold("Environment")));
          if (info.computeEnvironment?.computeEnvironmentName)
            kv("Name", info.computeEnvironment.computeEnvironmentName, colors.brightCyan);
          if (info.computeEnvironmentArn)
            kv("ARN", info.computeEnvironmentArn, colors.brightCyan);
          if (info.computeEnvironment?.ecsClusterArn)
            kv("ECS Cluster", info.computeEnvironment.ecsClusterArn, colors.brightCyan);
          if (info.computeEnvironment?.type) { kv("Type", info.computeEnvironment.type, colors.brightCyan); }
          if (info.computeEnvironment?.state) { kv("State", info.computeEnvironment.state, colors.brightCyan); }
          if (info.computeEnvironment?.status) {
            kv("Status", info.computeEnvironment.status, colors.brightCyan);
            if (info.computeEnvironment !== 'VALID') { kv("Status Reason", info.computeEnvironment.statusReason, colors.brightCyan); }
          }
          // Orchestration type
          kv("Orchestration Type", info.computeEnvironment.containerOrchestrationType, colors.brightCyan);
          // Update Policy -> [terminateJobsOnUpdate, jobExecutionTimeoutMinutes]
          kv("Terminate Jobs On Update", info.computeEnvironment.updatePolicy.terminateJobsOnUpdate, colors.brightCyan);
          kv("Job Timeout (Min.)", info.computeEnvironment.updatePolicy.jobExecutionTimeoutMinutes, colors.brightCyan);
          // Service role
          kv("Service Role", info.computeEnvironment.serviceRole, colors.brightCyan);
          if (info.computeEnvironment?.computeResources) {
            section(colors.magenta(colors.bold("Compute Details")));
            kv("Type", info.computeEnvironment.computeResources.type, colors.brightCyan);
            kv("Allocation Strategy", info.computeEnvironment.computeResources.allocationStrategy, colors.brightCyan);
            kv("Min vCPUs", info.computeEnvironment.computeResources.minvCpus, colors.brightCyan);
            kv("Max vCPUs", info.computeEnvironment.computeResources.maxvCpus, colors.brightCyan);
            kv("Instance Types", info.computeEnvironment.computeResources.instanceTypes.join(", "), colors.brightCyan);
            if (info.computeEnvironment.computeResources.subnets) {
              kv("Subnets", info.computeEnvironment.computeResources.subnets.join(", "), colors.brightCyan);
              // Get more info about networks-- private/public, etc
            }
            if (info.computeEnvironment.computeResources.securityGroupIds) {
              kv("Security Group IDs", info.computeEnvironment.computeResources.securityGroupIds.join(", "), colors.brightCyan);
            }
            if (info.computeEnvironment.computeResources.launchTemplate) {
              kv("Launch Template", info.computeEnvironment.computeResources.launchTemplate.launchTemplateName, colors.brightCyan);
              kv("Launch Template Version", info.computeEnvironment.computeResources.launchTemplate.version, colors.brightCyan);
            }
            if (info.computeEnvironment.computeResources.ec2Configuration) {
              kv("Image Type", info.computeEnvironment.computeResources.ec2Configuration.imageType, colors.brightCyan);
            }
          }
          
          
          console.log(colors.gray(""));
        }

        // VPC details (derived) — only if requested or default summary
        if (shouldShow("vpc")) {
          console.log(colors.gray("───────────────────────────────────────────────────────────────────────"));
          section(colors.yellow(colors.bold("VPC")));
          if (info.vpc) {
            kv("Name", info.vpc.name, colors.brightCyan);
            kv("Id", info.vpc.vpcId, colors.brightCyan);
            kv("IPv4 CIDR", info.vpc.cidrBlock, colors.brightCyan);
            kv("IPv6 CIDR", info.vpc.ipv6CidrBlock, colors.brightCyan);
            kv("State", info.vpc.state, colors.brightCyan);
            kv("DHCP Options", info.vpc.dhcpOptionsId, colors.brightCyan);
            if (info.vpc.tags && info.vpc.tags.length) {
              kv("Tags", info.vpc.tags.map((t: any) => `${t.Key}=${t.Value}`).join(", "), colors.brightCyan);
            }
          } else {
            console.log(colors.gray("No VPC details available."));
          }
          console.log(colors.gray(""));
        }

        if (shouldShow("ec2")) {
          console.log(colors.gray("───────────────────────────────────────────────────────────────────────"));
          section("Host (EC2)");
          if (info.ec2Instance) {
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
          } else if (info.ec2InstanceId) {
            kv("InstanceId", info.ec2InstanceId, colors.brightCyan);
            const ec2Path = `ec2/v2/home#InstanceDetails:instanceId=${info.ec2InstanceId}`;
            kv("Console", awsConsoleUrl("ec2", ctx.region, ec2Path), colors.brightCyan);
          } else {
            console.log(colors.gray("No EC2 details available."));
          }
          console.log(colors.gray(""));
        }

        if (shouldShow("network")) {
          console.log(colors.gray("───────────────────────────────────────────────────────────────────────"));
          if (info.vpc) {
            section(colors.yellow(colors.bold("Network")));
            if (info.vpc.vpcId) kv("VPC", `${info.vpc.name ? info.vpc.name + " " : ""}(${info.vpc.vpcId})`, colors.brightCyan);
            if (info.vpc.cidrBlock) kv("CIDR", info.vpc.cidrBlock, colors.brightCyan);
            if (info.vpc.ipv6CidrBlock) kv("IPv6 CIDR", info.vpc.ipv6CidrBlock, colors.brightCyan);
            if (info.vpc.subnets?.length) {
              const subs = (info.vpc.subnets || []).slice(0, 5);
              for (const s of subs) {
                const label = `${s.name ? s.name + " " : ""}(${s.subnetId})`;
                const cls = s.classification || (s.isPublic ? "public" : s.hasNat ? "private" : "isolated");
                kv("Subnet", `${label}  ${cls}  az=${s.availabilityZone || "-"}  rt=${s.routeTableId || "-"}`, colors.brightCyan);
              }
              if ((info.vpc.subnets || []).length > 5) console.log(colors.gray("  ..."));
            }
          } else {
            section(colors.yellow(colors.bold("Network")));
            console.log(colors.gray("No Network details available."));
          }
          console.log(colors.gray(""));
        }

        if (shouldShow("logs")) {
          console.log(colors.gray("───────────────────────────────────────────────────────────────────────"));
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
          } else {
            section(colors.yellow(colors.bold("Logs")));
            console.log(colors.gray("No Logs available."));
          }
        }

        if (shouldShow("envVars")) {
          console.log(colors.gray("───────────────────────────────────────────────────────────────────────"));
          const envEntries = Object.entries(info.environment);
          if (envEntries.length) {
            section(`Env (${envEntries.length})`);
            for (const [k, v] of envEntries.slice(0, 10)) {
              console.log(`  ${k}=${v ?? ""}`);
            }
            if (envEntries.length > 10) console.log("  ...");
          } else {
            section("Env (0)");
            console.log(colors.gray("No Environment variables available."));
          }
        }
      } catch (err: any) {
        console.error(`[error] ${err.message || err}`);
        process.exitCode = 1;
      }
    });
}
