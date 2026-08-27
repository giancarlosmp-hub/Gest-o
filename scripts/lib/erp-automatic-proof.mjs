const DELAY_CLASSES = [
  [5 * 60, "under_5m"],
  [30 * 60, "5_to_30m"],
  [90 * 60, "30_to_90m"],
];

export function classifyNextRunDelay(nextRunAt, now = new Date()) {
  const delaySeconds = Math.max(0, Math.ceil((new Date(nextRunAt).getTime() - now.getTime()) / 1000));
  if (!Number.isFinite(delaySeconds)) throw new Error("invalid nextRunAt");
  return DELAY_CLASSES.find(([limit]) => delaySeconds < limit)?.[1] ?? "over_90m";
}

export function isNextRunInsideProofWindow(nextRunAt, windowSeconds, now = new Date()) {
  const next = new Date(nextRunAt).getTime();
  const current = now.getTime();
  return Number.isFinite(next) && next >= current && next - current < windowSeconds * 1000;
}

export function classifyProofFailure({ nextRunWithinWindow, latestStatus, triggerObserved, lockState }) {
  if (!nextRunWithinWindow) return "next_run_outside_window";
  if (!triggerObserved) return "automatic_trigger_not_observed";
  if (latestStatus === "FAILED") return "automatic_run_failed";
  if (latestStatus === "RUNNING") return "automatic_run_still_running";
  if (lockState === "active") return "automatic_lock_blocked";
  return "successful_run_not_found";
}

if (process.argv[1]?.endsWith("erp-automatic-proof.mjs")) {
  const [nextRunAt, windowText, nowText] = process.argv.slice(2);
  const windowSeconds = Number(windowText);
  const now = nowText ? new Date(nowText) : new Date();
  console.log(`NEXT_RUN_DELAY_CLASS=${classifyNextRunDelay(nextRunAt, now)}`);
  console.log(`NEXT_RUN_WITHIN_WINDOW=${isNextRunInsideProofWindow(nextRunAt, windowSeconds, now)}`);
}
