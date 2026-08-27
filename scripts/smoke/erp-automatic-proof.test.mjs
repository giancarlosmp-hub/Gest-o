import assert from "node:assert/strict";
import { classifyNextRunDelay, classifyProofFailure, isNextRunInsideProofWindow } from "../lib/erp-automatic-proof.mjs";

const now = new Date("2026-08-27T12:00:00.000Z");
const after = (seconds) => new Date(now.getTime() + seconds * 1000).toISOString();

assert.equal(classifyNextRunDelay(after(60), now), "under_5m");
assert.equal(classifyNextRunDelay(after(300), now), "5_to_30m");
assert.equal(classifyNextRunDelay(after(1800), now), "30_to_90m");
assert.equal(classifyNextRunDelay(after(5400), now), "over_90m");
assert.equal(isNextRunInsideProofWindow(after(5399), 5400, now), true);
assert.equal(isNextRunInsideProofWindow(after(5400), 5400, now), false);
assert.equal(isNextRunInsideProofWindow("not-a-date", 5400, now), false);

assert.equal(classifyProofFailure({ nextRunWithinWindow: false }), "next_run_outside_window");
assert.equal(classifyProofFailure({ nextRunWithinWindow: true, triggerObserved: false }), "automatic_trigger_not_observed");
assert.equal(classifyProofFailure({ nextRunWithinWindow: true, triggerObserved: true, latestStatus: "FAILED" }), "automatic_run_failed");
assert.equal(classifyProofFailure({ nextRunWithinWindow: true, triggerObserved: true, latestStatus: "RUNNING" }), "automatic_run_still_running");
assert.equal(classifyProofFailure({ nextRunWithinWindow: true, triggerObserved: true, latestStatus: "ABSENT", lockState: "active" }), "automatic_lock_blocked");
assert.equal(classifyProofFailure({ nextRunWithinWindow: true, triggerObserved: true, latestStatus: "ABSENT", lockState: "free" }), "successful_run_not_found");

console.log("ERP automatic proof temporal diagnostics: PASS");
