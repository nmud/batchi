import { Command } from "commander";
import { resolveJobChain } from "../core/resolve";
import { colors, kv, section } from "../utils/print";
import { S3Client, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const S3_URL_RE = /s3:\/\/([A-Za-z0-9.-]{3,63})\/(\S+)/g; // captures bucket and key/prefix

type FoundUrl = { source: "env" | "cmd"; name?: string; bucket: string; key: string };

function extractS3Urls(env: Record<string, string | undefined>, cmd?: string[]): FoundUrl[] {
  const found: FoundUrl[] = [];
  // Scan env values
  for (const [name, value] of Object.entries(env)) {
    if (!value) continue;
    let m: RegExpExecArray | null;
    S3_URL_RE.lastIndex = 0;
    while ((m = S3_URL_RE.exec(value))) {
      found.push({ source: "env", name, bucket: m[1], key: m[2] });
    }
  }
  // Scan command args
  for (const a of cmd || []) {
    let m: RegExpExecArray | null;
    S3_URL_RE.lastIndex = 0;
    while ((m = S3_URL_RE.exec(a))) {
      found.push({ source: "cmd", bucket: m[1], key: m[2] });
    }
  }
  // Deduplicate by bucket/key
  const uniq = new Map<string, FoundUrl>();
  for (const u of found) {
    const k = `${u.bucket}/${u.key}`;
    if (!uniq.has(k)) uniq.set(k, u);
  }
  return Array.from(uniq.values());
}

async function presignIfExists(s3: S3Client, bucket: string, key: string, expiresIn: number): Promise<{ url?: string; exists: boolean; isPrefix: boolean; size?: number; contentType?: string }>{
  // Try head object first
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn });
    return { url, exists: true, isPrefix: false, size: Number(head.ContentLength || 0), contentType: head.ContentType };
  } catch {}
  // Maybe it's a prefix
  try {
    const list = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: key, MaxKeys: 1 }));
    if ((list.Contents || []).length > 0) {
      return { exists: true, isPrefix: true };
    }
  } catch {}
  return { exists: false, isPrefix: false };
}

function s3ConsoleUrl(region: string, bucket: string, key: string | undefined, isPrefix: boolean): string {
  if (!key || key.endsWith("/")) isPrefix = true;
  if (isPrefix) {
    // Browse bucket at prefix
    return `https://s3.console.aws.amazon.com/s3/buckets/${encodeURIComponent(bucket)}?region=${region}&prefix=${encodeURIComponent(key || "")}&showversions=false`;
  }
  // Object view
  return `https://s3.console.aws.amazon.com/s3/object/${encodeURIComponent(bucket)}?region=${region}&prefix=${encodeURIComponent(key)}`;
}

async function listKeys(s3: S3Client, bucket: string, prefix: string, maxTotal = 1000): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const r = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token, MaxKeys: Math.min(1000, maxTotal - keys.length) }));
    for (const obj of r.Contents || []) {
      if (obj.Key) keys.push(obj.Key);
      if (keys.length >= maxTotal) break;
    }
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token && keys.length < maxTotal);
  return keys;
}

export function registerArtifacts(program: Command, makeAwsCtx: (region?: string) => any) {
  program
    .command("artifacts")
    .usage("<jobId> [options]")
    .argument("<jobId>", "AWS Batch Job ID")
    .option("-r, --region <region>", "AWS region")
    .option("--expires <sec>", "Presign expiry in seconds", "3600")
    .option("--log-group <name>", "CloudWatch Logs group name (for resolution)", "/aws/batch/job")
    .option("--console", "Print AWS Console links for each S3 URL")
    .option("--list", "List object names for detected S3 objects/prefixes")
    .description("Detect s3:// inputs/outputs from env/cmd and presign for quick download")
    .action(async (jobId, opts) => {
      const ctx = makeAwsCtx(opts.region);
      const expires = Math.max(60, Number(opts.expires || 3600));
      const wantConsole: boolean = Boolean(opts.console);
      const wantList: boolean = Boolean(opts.list);
      try {
        const info = await resolveJobChain(
          { region: ctx.region, batch: ctx.batch, ecs: ctx.ecs, ec2: ctx.ec2, logs: ctx.logs, ecr: ctx.ecr, credsProvider: ctx.credsProvider },
          jobId,
          { logGroup: opts.logGroup, logLines: 1 }
        );

        const found = extractS3Urls(info.environment || {}, info.command || []);

        console.log(colors.gray("───────────────────────────────────────────────────────────────────────"));
        section(colors.yellow(colors.bold("Artifacts")));
        if (!found.length) {
          console.log(colors.gray("No s3:// URLs found in env or command."));
          return;
        }

        for (const u of found) {
          const label = u.name ? `${u.name}` : u.source === "cmd" ? "cmd" : "env";
          kv("Source", label, colors.brightCyan);
          kv("S3", `s3://${u.bucket}/${u.key}`, colors.brightCyan);
          const res = await presignIfExists(ctx.s3, u.bucket, u.key, expires);
          if (!res.exists) {
            kv("Status", colors.red("Not Found"), (s) => s);
          } else if (res.isPrefix) {
            kv("Type", "Prefix", colors.brightCyan);
            if (wantConsole) kv("Console", s3ConsoleUrl(ctx.region, u.bucket, u.key, true), colors.brightCyan);
            kv("Hint", `Use AWS Console to browse`, colors.brightCyan);
            if (wantList) {
              const keys = await listKeys(ctx.s3, u.bucket, u.key);
              if (keys.length) {
                section(colors.magenta(colors.bold(`Objects (${keys.length}${keys.length >= 1000 ? "+" : ""})`)));
                for (const k of keys) console.log(colors.dim(`  ${k}`));
              } else {
                kv("List", "No objects under prefix", colors.brightCyan);
              }
            }
          } else {
            kv("Type", res.contentType ? `${res.contentType}` : "Object", colors.brightCyan);
            if (res.size != null) kv("Size", `${res.size} bytes`, colors.brightCyan);
            if (res.url) kv("Presigned", res.url, colors.brightCyan);
            if (wantConsole) kv("Console", s3ConsoleUrl(ctx.region, u.bucket, u.key, false), colors.brightCyan);
            if (wantList) {
              section(colors.magenta(colors.bold("Object")));
              console.log(colors.dim(`  ${u.key}`));
            }
          }
          console.log(colors.gray(""));
        }
      } catch (err: any) {
        console.error(`[error] ${err.message || err}`);
        process.exitCode = 1;
      }
    });
}


