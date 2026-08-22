export interface ScalePolicy { minimumWarm: number; maximumWorkers: number; scaleUpQueueDepth: number; scaleDownUtilization: number }
export interface ScaleSnapshot { readyWorkers: number; provisioningWorkers: number; queueDepth: number; averageUtilization: number }

export function decideScale(policy: ScalePolicy, snapshot: ScaleSnapshot): "up" | "down" | "hold" {
  const total = snapshot.readyWorkers + snapshot.provisioningWorkers;
  if (snapshot.queueDepth >= policy.scaleUpQueueDepth && total < policy.maximumWorkers && snapshot.provisioningWorkers === 0) return "up";
  if (snapshot.queueDepth === 0 && snapshot.averageUtilization < policy.scaleDownUtilization && snapshot.readyWorkers > policy.minimumWarm) return "down";
  return "hold";
}
