export interface AttemptSignature { action: string; errorCode?: string; inputHash: string }

export class LoopGuard {
  private readonly attempts: AttemptSignature[] = [];
  constructor(private readonly maxRepeated = 2, private readonly maxTotal = 12) {}

  record(attempt: AttemptSignature): void {
    this.attempts.push(attempt);
    if (this.attempts.length > this.maxTotal) throw new Error("loop_total_limit_exceeded");
    const identical = this.attempts.filter((item) => item.action === attempt.action && item.errorCode === attempt.errorCode && item.inputHash === attempt.inputHash).length;
    if (identical > this.maxRepeated) throw new Error("loop_repeated_attempt_detected");
  }
}
