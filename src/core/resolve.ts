import {
  BatchClient,
  DescribeJobsCommand,
  DescribeJobQueuesCommand,
  DescribeComputeEnvironmentsCommand,
} from "@aws-sdk/client-batch";
import {
  ECSClient,
  DescribeTasksCommand,
  DescribeContainerInstancesCommand,
  ListClustersCommand,
  ListTasksCommand,
} from "@aws-sdk/client-ecs";
import {
  EC2Client,
  DescribeInstancesCommand,
  DescribeNetworkInterfacesCommand,
  DescribeVpcsCommand,
  DescribeSubnetsCommand,
} from "@aws-sdk/client-ec2";
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
  containerInstanceArn?: string;
  computeEnvironmentArn?: string;
  computeEnvironment?: any;
  logStreamName?: string;
  image?: string;
  command?: string[];
  environment: Record<string, string | undefined>;
  ecsTask?: any;
  ec2InstanceId?: string;
  ec2Instance?: any;
  lastLogLines?: string[];
  vpc?: {
    networkAclId?: string;
    vpcId?: string;
    name?: string;
    cidrBlock?: string;
    ipv6CidrBlock?: string;
    state?: string;
    dhcpOptionsId?: string;
    tags?: Array<{ Key?: string; Value?: string }>;
  };
};

const last = <T>(arr?: T[]) => (arr && arr.length ? arr[arr.length - 1] : undefined);
const debugOn = () => process.env.BATCHI_DEBUG === "1" || process.env.BATCHI_DEBUG === "true";
const dbg = (k: string, v: any) => debugOn() && console.error(`[debug] ${k}:`, v);
const dbe = (label: string, e: unknown) => debugOn() && console.error(`[debug][error] ${label}:`, (e as any)?.message || e);

// Some ECS calls during cluster/task resolution intentionally probe mismatched clusters.
// Those errors are expected; suppress them from debug error output to reduce noise.
const isExpectedClusterMismatch = (e: unknown): boolean => {
  const msg = ((e as any)?.message ?? "") as string;
  return typeof msg === "string" && msg.includes("cluster identifiers mismatch");
};

/** arn:aws:ecs:region:acct:task/<cluster-name>/<task-id> → "cluster-name" */
const clusterFromTaskArn = (arn?: string): string | undefined => {
  if (!arn) return;
  const m = arn.match(/:task\/([^/]+)\/[A-Za-z0-9-]+$/);
  return m?.[1];
};

/** build cluster ARN from task ARN parts if possible */
const clusterArnFromTaskArn = (arn?: string): string | undefined => {
  if (!arn) return;
  const parts = arn.split(":");
  if (parts.length < 6) return;
  const region = parts[3];
  const account = parts[4];
  const name = clusterFromTaskArn(arn);
  if (!region || !account || !name) return;
  return `arn:aws:ecs:${region}:${account}:cluster/${name}`;
};

/** derive cluster name from container-instance ARN */
const clusterFromContainerInstanceArn = (arn?: string): string | undefined => {
  if (!arn) return;
  const m = arn.match(/:container-instance\/([^/]+)\/[A-Za-z0-9-]+$/);
  return m?.[1];
};
const clusterArnFromContainerInstanceArn = (arn?: string): string | undefined => {
  if (!arn) return;
  const parts = arn.split(":");
  if (parts.length < 6) return;
  const region = parts[3];
  const account = parts[4];
  const name = clusterFromContainerInstanceArn(arn);
  if (!region || !account || !name) return;
  return `arn:aws:ecs:${region}:${account}:cluster/${name}`;
};

/** try to infer cluster from the job queue → CE → ecsClusterArn */
const clusterFromJobQueue = async (
  d: ResolveDeps,
  queue?: string
): Promise<string | undefined> => {
  if (!queue) return;
  try {
    const jq = await d.batch.send(new DescribeJobQueuesCommand({ jobQueues: [queue] }));
    const ceArn = jq.jobQueues?.[0]?.computeEnvironmentOrder?.[0]?.computeEnvironment;
    if (!ceArn) return;
    const ce = await d.batch.send(
      new DescribeComputeEnvironmentsCommand({ computeEnvironments: [ceArn] })
    );
    return ce.computeEnvironments?.[0]?.ecsClusterArn;
  } catch {
    return;
  }
};

/** resolve ECS task with layered fallbacks, returning the task and the cluster we used */
async function resolveTask(
  ecs: ECSClient,
  jobId: string,
  taskArn?: string,
  hintedClusterArn?: string
): Promise<{ task?: any; clusterArn?: string }> {
  const parsedName = clusterFromTaskArn(taskArn);
  const parsedArn = clusterArnFromTaskArn(taskArn);

  const tries: Array<{ label: string; input: any }> = [];

  if (hintedClusterArn) {
    tries.push({
      label: `DescribeTasks(hint=${hintedClusterArn})`,
      input: { cluster: hintedClusterArn, tasks: [taskArn!] },
    });
  }
  if (parsedArn) {
    tries.push({
      label: `DescribeTasks(parsedArn=${parsedArn})`,
      input: { cluster: parsedArn, tasks: [taskArn!] },
    });
  }
  if (parsedName) {
    tries.push({
      label: `DescribeTasks(parsedName=${parsedName})`,
      input: { cluster: parsedName, tasks: [taskArn!] },
    });
  }

  // Try without cluster (may fail with identifier mismatch but quick)
  tries.push({ label: "DescribeTasks(noCluster)", input: { tasks: [taskArn!] } });

  for (const t of tries) {
    try {
      dbg("ecs.try", t.label);
      const r = await ecs.send(new DescribeTasksCommand(t.input));
      if (r.tasks?.length) {
        const clusterArn = r.tasks[0].clusterArn || (t.input as any).cluster;
        return { task: r.tasks[0], clusterArn };
      }
    } catch (e) {
      if (!isExpectedClusterMismatch(e)) dbe(t.label, e);
    }
  }

  // Enumerate clusters and try each
  try {
    const lc = await ecs.send(new ListClustersCommand({}));
    for (const c of lc.clusterArns ?? []) {
      try {
        const label = `DescribeTasks(enumerated=${c})`;
        dbg("ecs.try", label);
        const r = await ecs.send(
          new DescribeTasksCommand({ cluster: c, tasks: [taskArn!] })
        );
        if (r.tasks?.length) return { task: r.tasks[0], clusterArn: c };
      } catch (e) {
        if (!isExpectedClusterMismatch(e)) dbe("DescribeTasks(enumerated)", e);
      }
    }
  } catch (e) {
    dbe("ListClusters", e);
  }

  // Last resort: startedBy == jobId
  try {
    const lc = await ecs.send(new ListClustersCommand({}));
    for (const c of lc.clusterArns ?? []) {
      try {
        const lt = await ecs.send(
          new ListTasksCommand({ cluster: c, startedBy: jobId, maxResults: 100 })
        );
        dbg("ecs.startedBy.result", { cluster: c, count: lt.taskArns?.length || 0 });
        if (lt.taskArns?.length) {
          const dt = await ecs.send(
            new DescribeTasksCommand({ cluster: c, tasks: lt.taskArns })
          );
          if (dt.tasks?.length) return { task: dt.tasks[0], clusterArn: c };
        }
      } catch (e) {
        if (!isExpectedClusterMismatch(e)) dbe("List/Describe by startedBy", e);
      }
    }
  } catch (e) {
    dbe("ListClusters(startedBy path)", e);
  }

  dbg("ecs.unresolvedTaskArn", taskArn);
  return {};
}


export async function resolveJobChain(
  d: ResolveDeps,
  jobId: string,
  opts?: { logGroup?: string; logLines?: number }
): Promise<JobChain> {
  const logGroup = opts?.logGroup ?? "/aws/batch/job";
  const logLines = Math.max(1, Number(opts?.logLines ?? 50));

  // Batch: job
  const jobRes = await d.batch.send(new DescribeJobsCommand({ jobs: [jobId] }));
  const job = jobRes.jobs?.[0];
  if (!job) throw new Error(`Job not found: ${jobId}`);

  type MaybeJobDetail = { platformCapabilities?: string[]; [k: string]: any };

  const plat: string[] = Array.isArray((job as MaybeJobDetail).platformCapabilities)
    ? (job as MaybeJobDetail).platformCapabilities as string[]
    : [];

  const isFargateJob = plat.includes("FARGATE");

  // Batch on EKS jobs expose eksProperties / eksAttempts; EC2/ECS jobs do not.
  const isEksJob = Boolean((job as any).eksProperties || (job as any).eksAttempts?.length);

  // Optional debug
  dbg("platformCapabilities", plat);
  dbg("isFargateJob", isFargateJob);
  dbg("isEksJob", isEksJob);

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

  dbg("attempts.count", (job.attempts ?? []).length);
  dbg("attempt.container.hasTaskArn", !!attemptContainer?.taskArn);
  dbg("attempt.container.hasENIs", !!(attemptContainer?.networkInterfaces?.length));
  dbg("job.container.taskArn", !!jobContainer?.taskArn);
  dbg("job.queue", job.jobQueue);
  dbg("region", d.region);

  // Cluster hint via CE from the queue
  let ecsClusterArn: string | undefined;
  try {
    ecsClusterArn = await (async () => {
      try {
        const jq = await d.batch.send(new DescribeJobQueuesCommand({ jobQueues: [job.jobQueue] }));
        const ceArn = jq.jobQueues?.[0]?.computeEnvironmentOrder?.[0]?.computeEnvironment;
        if (!ceArn) return undefined;
        const ce = await d.batch.send(
          new DescribeComputeEnvironmentsCommand({ computeEnvironments: [ceArn] })
        );
        return ce.computeEnvironments?.[0]?.ecsClusterArn;
      } catch (e) {
        dbe("DescribeJobQueues/DescribeComputeEnvironments", e);
        return undefined;
      }
    })();
  } catch (e) {
    dbe("cluster hint error", e);
  }
  dbg("ecsClusterArn_hint_from_CE", ecsClusterArn);

  // ECS task (if any) will resolve to containerInstanceArn (via cluster ARN)
  let ecsTask: any | undefined;
  let containerInstanceArn: string | undefined =
    attemptContainer?.containerInstanceArn ?? jobContainer?.containerInstanceArn;

  if (taskArn) {
    const parsedClusterArn = clusterArnFromTaskArn(taskArn);
    const parsedClusterName = clusterFromTaskArn(taskArn);

    // Prefer cluster parsed from the task ARN (most authoritative)
    try {
      if (parsedClusterArn) {
        const r = await d.ecs.send(
          new DescribeTasksCommand({ cluster: parsedClusterArn, tasks: [taskArn] })
        );
        if (r.tasks?.length) {
          ecsTask = r.tasks[0];
          ecsClusterArn = r.tasks[0].clusterArn || parsedClusterArn;
        }
      }
    } catch (e) {
      if (!isExpectedClusterMismatch(e)) dbe(`DescribeTasks(parsedClusterArn=${parsedClusterArn})`, e);
    }

    // Try hinted CE cluster
    try {
      if (ecsClusterArn) {
        const r = await d.ecs.send(
          new DescribeTasksCommand({ cluster: ecsClusterArn, tasks: [taskArn] })
        );
        if (r.tasks?.length) {
          ecsTask = r.tasks[0];
        }
      }
    } catch (e) {
      if (!isExpectedClusterMismatch(e)) dbe(`DescribeTasks(hintedClusterArn=${ecsClusterArn})`, e);
    }

    // Try parsed cluster from task ARN
    if (!ecsTask) {
      try {
        if (parsedClusterName) {
          const r = await d.ecs.send(
            new DescribeTasksCommand({ cluster: parsedClusterName, tasks: [taskArn] })
          );
          if (r.tasks?.length) ecsTask = r.tasks[0];
        }
      } catch (e) {
        if (!isExpectedClusterMismatch(e)) dbe(`DescribeTasks(parsedCluster=${parsedClusterName})`, e);
      }
    }

    // Try without cluster
    if (!ecsTask) {
      try {
        const r = await d.ecs.send(new DescribeTasksCommand({ tasks: [taskArn] }));
        if (r.tasks?.length) ecsTask = r.tasks[0];
      } catch (e) {
        if (!isExpectedClusterMismatch(e)) dbe("DescribeTasks(noCluster)", e);
      }
    }

    // Enumerate clusters
    if (!ecsTask) {
      try {
        const list = await d.ecs.send(new ListClustersCommand({}));
        for (const clusterArn of list.clusterArns ?? []) {
          try {
            const r = await d.ecs.send(
              new DescribeTasksCommand({ cluster: clusterArn, tasks: [taskArn] })
            );
            if (r.tasks?.length) {
              ecsTask = r.tasks[0];
              ecsClusterArn = clusterArn;
              break;
            }
          } catch (e) {
            if (!isExpectedClusterMismatch(e)) dbe(`DescribeTasks(cluster=${clusterArn})`, e);
          }
        }
      } catch (e) {
        dbe("ListClusters", e);
      }
    }

    // Try startedBy path
    if (!ecsTask) {
      try {
        const list = await d.ecs.send(new ListClustersCommand({}));
        for (const clusterArn of list.clusterArns ?? []) {
          try {
            const lt = await d.ecs.send(
              new ListTasksCommand({
                cluster: clusterArn,
                startedBy: job.jobId,
                maxResults: 100,
              })
            );
            if (lt.taskArns?.length) {
              const dt = await d.ecs.send(
                new DescribeTasksCommand({ cluster: clusterArn, tasks: lt.taskArns })
              );
              if (dt.tasks?.length) {
                ecsTask = dt.tasks[0];
                ecsClusterArn = clusterArn;
                break;
              }
            }
          } catch (e) {
            if (!isExpectedClusterMismatch(e)) dbe(`List/DescribeTasks(startedBy=${job.jobId}, cluster=${clusterArn})`, e);
          }
        }
      } catch (e) {
        dbe("ListClusters(startedBy)", e);
      }
    }

    if (ecsTask) {
      ecsClusterArn = ecsTask.clusterArn || ecsClusterArn || clusterArnFromTaskArn(taskArn);
      containerInstanceArn = ecsTask.containerInstanceArn || containerInstanceArn;
    }
  }

  // ECS container instance → EC2 instance ID (non-Fargate)
  let ec2InstanceId: string | undefined;
  if (containerInstanceArn && !isFargateJob) {
    const clusterForCi =
      ecsClusterArn ||
      clusterArnFromContainerInstanceArn(containerInstanceArn) ||
      clusterFromContainerInstanceArn(containerInstanceArn);
    try {
      if (clusterForCi) {
        const ci = await d.ecs.send(
          new DescribeContainerInstancesCommand({
            cluster: clusterForCi,
            containerInstances: [containerInstanceArn],
          })
        );
        ec2InstanceId = ci.containerInstances?.[0]?.ec2InstanceId;
      }
    } catch (e) {
      dbe(`DescribeContainerInstances(cluster=${clusterForCi})`, e);
    }
  }

  // ENI → EC2 fallback
  if (!ec2InstanceId && (container?.networkInterfaces?.length ?? 0) > 0) {
    const eniId = (container.networkInterfaces?.[0] as any)?.networkInterfaceId as
      | string
      | undefined;
    dbg("eniFallbackId", eniId);
    try {
      if (eniId) {
        const eni = await d.ec2.send(
          new DescribeNetworkInterfacesCommand({
            NetworkInterfaceIds: [eniId],
          })
        );
        const iid = eni.NetworkInterfaces?.[0]?.Attachment?.InstanceId;
        ec2InstanceId = iid ?? ec2InstanceId;
      }
    } catch (e) {
      dbe("DescribeNetworkInterfaces", e);
    }
  }

  // EC2 instance details
  let ec2Instance: any | undefined;
  if (ec2InstanceId) {
    try {
      const di = await d.ec2.send(
        new DescribeInstancesCommand({ InstanceIds: [ec2InstanceId] })
      );
      ec2Instance = di.Reservations?.[0]?.Instances?.[0];
    } catch (e) {
      dbe("DescribeInstances", e);
    }
  }

  // Resolve the Compute Environment actually used (if possible)
  let computeEnvironmentArn: string | undefined = (job as any)?.computeEnvironment;
  let computeEnvironment: any | undefined;
  try {
    if (computeEnvironmentArn) {
      const ce = await d.batch.send(
        new DescribeComputeEnvironmentsCommand({ computeEnvironments: [computeEnvironmentArn] })
      );
      computeEnvironment = ce.computeEnvironments?.[0];
      computeEnvironmentArn = computeEnvironment?.computeEnvironmentArn || computeEnvironmentArn;
    } else if (job.jobQueue) {
      // Consider all CEs attached to the queue and pick the one matching the ECS cluster (if known)
      const jq = await d.batch.send(new DescribeJobQueuesCommand({ jobQueues: [job.jobQueue] }));
      const ceArns = (jq.jobQueues?.[0]?.computeEnvironmentOrder || [])
        .map((o: any) => o?.computeEnvironment)
        .filter(Boolean);
      if (ceArns.length) {
        const ceRes = await d.batch.send(
          new DescribeComputeEnvironmentsCommand({ computeEnvironments: ceArns })
        );
        const ces = ceRes.computeEnvironments || [];
        // Prefer CE whose ecsClusterArn matches the resolved ecsClusterArn
        const match = ecsClusterArn
          ? ces.find((c: any) => c?.ecsClusterArn === ecsClusterArn)
          : undefined;
        const chosen = match || ces[0];
        if (chosen) {
          computeEnvironment = chosen;
          computeEnvironmentArn = chosen.computeEnvironmentArn || chosen.computeEnvironmentName;
        }
      }
    }
  } catch (e) {
    dbe("Resolve ComputeEnvironment", e);
  }

  // Resolve VPC details via instance → ENI → CE subnet
  let vpc: JobChain["vpc"] | undefined;
  try {
    let vpcId: string | undefined = ec2Instance?.VpcId;
    let subnetId: string | undefined = ec2Instance?.SubnetId;

    // If no instance-derived VPC, try ENI from container
    if (!vpcId && (container?.networkInterfaces?.length ?? 0) > 0) {
      const eniId = (container.networkInterfaces?.[0] as any)?.networkInterfaceId as
        | string
        | undefined;
      if (eniId) {
        try {
          const eni = await d.ec2.send(
            new DescribeNetworkInterfacesCommand({ NetworkInterfaceIds: [eniId] })
          );
          const ni = eni.NetworkInterfaces?.[0];
          vpcId = ni?.VpcId || vpcId;
          subnetId = ni?.SubnetId || subnetId;
        } catch (e) {
          dbe("DescribeNetworkInterfaces(for VPC)", e);
        }
      }
    }

    // If still no VPC, try CE subnet
    if (!vpcId && !subnetId) {
      const ceSubnets: string[] | undefined = (computeEnvironment as any)?.computeResources?.subnets;
      if (Array.isArray(ceSubnets) && ceSubnets.length > 0) subnetId = ceSubnets[0];
    }

    // Derive VPC from subnet if needed
    if (!vpcId && subnetId) {
      try {
        const sub = await d.ec2.send(new DescribeSubnetsCommand({ SubnetIds: [subnetId] }));
        const s = sub.Subnets?.[0];
        vpcId = s?.VpcId || vpcId;
      } catch (e) {
        dbe("DescribeSubnets", e);
      }
    }

    if (vpcId) {
      try {
        const vpcs = await d.ec2.send(new DescribeVpcsCommand({ VpcIds: [vpcId] }));
        const v = vpcs.Vpcs?.[0];
        if (v) {
          const name = (v.Tags || []).find((t) => t.Key === "Name")?.Value;
          const ipv6 = (v.Ipv6CidrBlockAssociationSet || []).find(
            (a) => (a.Ipv6CidrBlock || "").length > 0
          )?.Ipv6CidrBlock;
          vpc = {
            vpcId: v.VpcId,
            name,
            cidrBlock: v.CidrBlock,
            ipv6CidrBlock: ipv6,
            state: v.State,
            dhcpOptionsId: v.DhcpOptionsId,
            tags: v.Tags as Array<{ Key?: string; Value?: string }> | undefined,
          };
        }
      } catch (e) {
        dbe("DescribeVpcs", e);
      }
    }
  } catch (e) {
    dbe("Resolve VPC", e);
  }

  // Logs
  let lastLogLines: string[] | undefined;
  if (logStreamName) {
    try {
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
    } catch (e) {
      dbe("GetLogEvents", e);
    }
  }

  return {
    job,
    container,
    ecsClusterArn,
    taskArn,
    containerInstanceArn,
    computeEnvironmentArn,
    computeEnvironment,
    logStreamName,
    image,
    command,
    environment,
    ecsTask,
    ec2InstanceId,
    ec2Instance,
    lastLogLines,
    vpc,
  };
}
