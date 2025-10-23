export function awsConsoleUrl(service: string, region: string, path: string) {
    // path should exclude the leading slash segment that console adds itself
    // e.g. service="ecs", path="ecs/home#/clusters/clusterArn/tasks/taskArn"
    return `https://${service}.console.aws.amazon.com/${path}?region=${region}`;
  }
  