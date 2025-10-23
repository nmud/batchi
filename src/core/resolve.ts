import {
    BatchClient,
    DescribeJobsCommand,
  } from "@aws-sdk/client-batch";
  import {
    ECSClient,
    DescribeTasksCommand,
    DescribeContainerInstancesCommand,
  } from "@aws-sdk/client-ecs";
  import { EC2Client, DescribeInstancesCommand } from "@aws-sdk/client-ec2";
  import {
    CloudWatchLogsClient,
    GetLogEventsCommand,
  } from "@aws-sdk/client-cloudwatch-logs";
  
  export type ResolveDeps = {
    region: string;
    batch: BatchClient;
    ecs: ECSClient;
    ec2: EC2Client;
    logs: CloudWatchLogsClient;
  };
  
  export type JobChain = {
    job: any;
    container: any | undefined;
    ecsClusterArn?: string;
    taskArn?: string;
    logStreamName?: string;
    image?: string;
    command?: string[];
    environment: Record<string, string | undefined>;
    ecsTask?: any;
    ec2InstanceId?: string;
    ec2Instance?: any;
    lastLogLines?: string[];
  };
  
  const last = <T>(arr?: T[]) => (arr && arr.length ? arr[arr.length - 1] : undefined);
  const clusterFromTaskArn = (arn?: string): string | undefined => {
    if (!arn) return undefined;
    // arn:aws:ecs:region:account:task/cluster-name/task-id
    const taskIdx = arn.indexOf(":task/");
    if (taskIdx === -1) return undefined;
    const after = arn.slice(taskIdx + 6);
    const firstSlash = after.indexOf("/");
    if (firstSlash === -1) return undefined;
    const clusterName = after.slice(0, firstSlash);
    return clusterName || undefined;
  };
  const clusterArnFromTaskArn = (arn?: string): string | undefined => {
    // Build cluster ARN from task ARN parts if possible
    if (!arn) return undefined;
    const parts = arn.split(":");
    if (parts.length < 6) return undefined;
    const region = parts[3];
    const account = parts[4];
    const name = clusterFromTaskArn(arn);
    if (!region || !account || !name) return undefined;
    return `arn:aws:ecs:${region}:${account}:cluster/${name}`;
  };
  
  export async function resolveJobChain(
    d: ResolveDeps,
    jobId: string,
    opts?: { logGroup?: string; logLines?: number }
  ): Promise<JobChain> {
    const logGroup = opts?.logGroup ?? "/aws/batch/job";
    const logLines = Math.max(1, Number(opts?.logLines ?? 50));
  
    // 1) Batch → job
    const jobRes = await d.batch.send(new DescribeJobsCommand({ jobs: [jobId] }));
    const job = jobRes.jobs?.[0];
    if (!job) throw new Error(`Job not found: ${jobId}`);
  
    // Prefer latest attempt container for runtime/task details; use job.container for image/cmd/env
    const attemptContainer = last(job.attempts ?? [])?.container;
    const jobContainer = job.container;
    const container = attemptContainer ?? jobContainer;

    const taskArn = attemptContainer?.taskArn ?? jobContainer?.taskArn;
    const logStreamName = attemptContainer?.logStreamName ?? jobContainer?.logStreamName;
    const image = jobContainer?.image;
    const command = jobContainer?.command;
    const environment =
      jobContainer?.environment?.reduce((map, pair) => {
        if (pair?.name) map[pair.name] = pair.value;
        return map;
      }, {} as Record<string, string | undefined>) ?? {};
  
    // 2) ECS cluster ARN will be resolved from the ECS task (below)
    let ecsClusterArn: string | undefined;
  
    // 3) ECS task (if any) → containerInstanceArn
    let ecsTask: any | undefined;
    let containerInstanceArn: string | undefined;
    if (taskArn) {
      const hintCluster = clusterFromTaskArn(taskArn);
      let t;
      try {
        t = await d.ecs.send(
          new DescribeTasksCommand({ cluster: hintCluster, tasks: [taskArn] })
        );
      } catch (e: any) {
        // Retry without cluster if the hint was wrong or empty
        t = await d.ecs.send(new DescribeTasksCommand({ tasks: [taskArn] }));
      }
      ecsTask = t.tasks?.[0];
      ecsClusterArn = ecsTask?.clusterArn ?? clusterArnFromTaskArn(taskArn) ?? ecsClusterArn;
      containerInstanceArn = ecsTask?.containerInstanceArn;
    }
  
    // 4) ECS container instance → EC2 instance ID
    let ec2InstanceId: string | undefined;
    if (containerInstanceArn) {
      const ci = await d.ecs.send(
        new DescribeContainerInstancesCommand({
          cluster: ecsClusterArn,
          containerInstances: [containerInstanceArn],
        })
      );
      ec2InstanceId = ci.containerInstances?.[0]?.ec2InstanceId;
    }
  
    // 5) EC2 instance details (if not Fargate)
    let ec2Instance: any | undefined;
    if (ec2InstanceId) {
      const di = await d.ec2.send(
        new DescribeInstancesCommand({ InstanceIds: [ec2InstanceId] })
      );
      ec2Instance = di.Reservations?.[0]?.Instances?.[0];
    }
  
    // 6) Pull last N log lines (optional but nice)
    let lastLogLines: string[] | undefined;
    if (logStreamName) {
      const r = await d.logs.send(
        new GetLogEventsCommand({
          logGroupName: logGroup,
          logStreamName,
          limit: logLines,
          startFromHead: false,
        })
      );
      lastLogLines = (r.events ?? [])
        .slice(-logLines)
        .map((e) => (e.message ?? "").trim())
        .filter(Boolean);
    }
  
    return {
      job,
      container,
      ecsClusterArn,
      taskArn,
      logStreamName,
      image,
      command,
      environment,
      ecsTask,
      ec2InstanceId,
      ec2Instance,
      lastLogLines,
    };
  }
  