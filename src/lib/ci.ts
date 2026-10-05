/**
 * ngit-ci workflow events — NIP-34 CI extension (experimental kinds 9840 /
 * 9841 / 9842 / 39842). 9841 Job Result: signed by the compute provider.
 * 9842 Workflow Result: the durable outcome, signed by the coordinator,
 * quoting jobs via `q`. 39842 Workflow Progress: addressable, expiring (≤30 min).
 *
 * Trust model: none (like gitworkshop). Nothing binds a coordinator to a repo,
 * so render every CI event and ALWAYS show the signer; never imply verification.
 *
 * Multi-maintainer repos yield one `a` tag per coordinate; match every one.
 */

import { parseGitRepositoryAddress, type GitRepositoryAddress } from "@/lib/gitActivity";
import { sanitizeUrl } from "@/lib/sanitizeUrl";

import type { NostrRumor } from "@/lib/nostrRumor";
/** Kind 9841 — one job's result, signed by the compute provider. */
export const CI_JOB_RESULT_KIND = 9841;
/** Kind 9842 — a workflow run's combined outcome, signed by the coordinator. */
export const CI_RESULT_KIND = 9842;
/** Kind 39842 — addressable, expiring progress marker for an in-flight run. */
export const CI_PROGRESS_KIND = 39842;

/** The CI kinds a client subscribes to. 9840 is a request, not a result. */
export const CI_EVENT_KINDS = [CI_JOB_RESULT_KIND, CI_RESULT_KIND, CI_PROGRESS_KIND] as const;

/** Conclusions the extension reports, aligned with GitHub's `conclusion`. */
export const CI_CONCLUSIONS = [
  "success",
  "failure",
  "neutral",
  "cancelled",
  "skipped",
  "timed_out",
  "startup_failure",
] as const;
export type CIConclusion = (typeof CI_CONCLUSIONS)[number];

/** A run attempt's lifecycle position. A 9842 is always `concluded`. */
export type CIStatus = "queued" | "in_progress" | "concluded";

export interface CIJobResult {
  event: NostrRumor;
  id: string;
  author: string;
  job: string;
  name?: string;
  conclusion?: CIConclusion;
  /** Blossom URL of the full log. */
  logs?: string;
  createdAt: number;
}

export interface CIRunJob {
  job: string;
  eventId: string;
  /** The provider the coordinator vouched for, from the `q` tag. */
  provider?: string;
  result?: CIJobResult;
}

export interface CIRun {
  event: NostrRumor;
  id: string;
  /** The coordinator that signed the run. Displayed, never trusted. */
  author: string;
  repositoryAddresses: GitRepositoryAddress[];
  /** First `c` tag: the commit the workflow ran against. */
  commit?: string;
  workflow?: string;
  /** Normalized trigger: push | pull_request | schedule | manual. */
  trigger?: string;
  /** `refs/heads/...` or `refs/tags/...` for push triggers. */
  ref?: string;
  status: CIStatus;
  conclusion?: CIConclusion;
  jobs: CIRunJob[];
  createdAt: number;
}

function firstTagValue(event: NostrRumor, name: string): string | undefined {
  return event.tags.find(([tagName]) => tagName === name)?.[1];
}

function asConclusion(value: string | undefined): CIConclusion | undefined {
  return value && (CI_CONCLUSIONS as readonly string[]).includes(value) ? (value as CIConclusion) : undefined;
}

function repositoryAddressesOf(event: NostrRumor): GitRepositoryAddress[] {
  const seen = new Set<string>();
  const out: GitRepositoryAddress[] = [];
  for (const tag of event.tags) {
    if (tag[0] !== "a" || !tag[1]) continue;
    const address = parseGitRepositoryAddress(tag[1]);
    if (!address || seen.has(address.coordinate)) continue;
    seen.add(address.coordinate);
    out.push(address);
  }
  return out;
}

/** Parse a kind-9841 Job Result. */
export function parseCIJobResult(event: NostrRumor): CIJobResult | undefined {
  if (event.kind !== CI_JOB_RESULT_KIND) return undefined;
  const job = firstTagValue(event, "job")?.trim();
  if (!job) return undefined;
  return {
    event,
    id: event.id,
    author: event.pubkey,
    job,
    name: firstTagValue(event, "name")?.trim() || undefined,
    conclusion: asConclusion(firstTagValue(event, "conclusion")?.trim()),
    // Only an http(s) URL: it becomes a link and a fetch.
    logs: sanitizeUrl(firstTagValue(event, "logs")?.trim()),
    createdAt: event.created_at,
  };
}

/**
 * Parse a 9842 (always concluded) or 39842 into a run. A 39842 with an
 * unrecognized status is treated as in-progress: its existence is the signal.
 */
export function parseCIRun(event: NostrRumor): CIRun | undefined {
  if (event.kind !== CI_RESULT_KIND && event.kind !== CI_PROGRESS_KIND) return undefined;
  const repositoryAddresses = repositoryAddressesOf(event);
  if (repositoryAddresses.length === 0) return undefined;

  const rawStatus = firstTagValue(event, "status")?.trim();
  const status: CIStatus = event.kind === CI_RESULT_KIND
    ? "concluded"
    : rawStatus === "queued" || rawStatus === "concluded" ? rawStatus : "in_progress";

  const jobs: CIRunJob[] = [];
  const seenJobs = new Set<string>();
  for (const tag of event.tags) {
    // ["q", <job-result-id>, <relay>, <provider-pubkey>, <job-id>]
    if (tag[0] !== "q" || !tag[1]) continue;
    const job = tag[4]?.trim() || tag[1];
    if (seenJobs.has(job)) continue;
    seenJobs.add(job);
    jobs.push({ job, eventId: tag[1], provider: tag[3]?.trim() || undefined });
  }

  return {
    event,
    id: event.id,
    author: event.pubkey,
    repositoryAddresses,
    commit: firstTagValue(event, "c")?.trim() || undefined,
    workflow: firstTagValue(event, "w")?.trim() || undefined,
    trigger: firstTagValue(event, "o")?.trim() || undefined,
    ref: firstTagValue(event, "r")?.trim() || undefined,
    status,
    conclusion: asConclusion(firstTagValue(event, "conclusion")?.trim()),
    jobs,
    createdAt: event.created_at,
  };
}

/** The run attempt a 9842/39842 pair describes: one coordinator, commit, workflow. */
function runKey(run: CIRun): string {
  return `${run.author}\u0000${run.commit ?? ""}\u0000${run.workflow ?? ""}`;
}

/**
 * Collapse CI events into one run per attempt, resolving Job Results onto `q`
 * tags. 39842 and 9842 share no run id, so they join on (coordinator, commit,
 * workflow); the durable 9842 always wins (the marker expires). Re-runs
 * collapse to the newest, as the extension prescribes.
 */
export function assembleCIRuns(events: readonly NostrRumor[]): CIRun[] {
  const jobResults = new Map<string, CIJobResult>();
  for (const event of events) {
    const job = parseCIJobResult(event);
    if (job) jobResults.set(job.id, job);
  }

  const byAttempt = new Map<string, CIRun>();
  for (const event of events) {
    const run = parseCIRun(event);
    if (!run) continue;
    const key = runKey(run);
    const existing = byAttempt.get(key);
    if (existing && !supersedes(run, existing)) continue;
    byAttempt.set(key, run);
  }

  return [...byAttempt.values()]
    .map((run) => ({
      ...run,
      jobs: run.jobs.map((job) => ({ ...job, result: jobResults.get(job.eventId) })),
    }))
    .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
}

/** The durable result outranks a progress marker; otherwise newest wins. */
function supersedes(candidate: CIRun, existing: CIRun): boolean {
  const candidateDurable = candidate.event.kind === CI_RESULT_KIND;
  const existingDurable = existing.event.kind === CI_RESULT_KIND;
  if (candidateDurable !== existingDurable) return candidateDurable;
  return candidate.createdAt > existing.createdAt
    || (candidate.createdAt === existing.createdAt && candidate.id.localeCompare(existing.id) < 0);
}

/** The run's repository among those the caller holds, matching every `a` tag. */
export function matchCIRepository(
  run: CIRun,
  known: { has(coordinate: string): boolean },
): GitRepositoryAddress | undefined {
  return run.repositoryAddresses.find((address) => known.has(address.coordinate));
}

/** Whether a kind belongs to this extension (for ingest/subscription gating). */
export function isCIEventKind(kind: number): boolean {
  return (CI_EVENT_KINDS as readonly number[]).includes(kind);
}

/** The held repository a raw CI event belongs to; all three kinds carry `a` tags (no root lookup). */
export function matchCIEventRepository(
  event: NostrRumor,
  known: { has(coordinate: string): boolean },
): GitRepositoryAddress | undefined {
  if (!isCIEventKind(event.kind)) return undefined;
  return repositoryAddressesOf(event).find((address) => known.has(address.coordinate));
}

/** A workflow's display name: the file's basename without extension. */
export function ciWorkflowName(run: Pick<CIRun, "workflow">): string {
  const path = run.workflow?.trim();
  if (!path) return "workflow";
  return path.split("/").pop()?.replace(/\.ya?ml$/i, "") || "workflow";
}

/** The run's headline outcome for display. */
export function ciRunOutcome(run: Pick<CIRun, "status" | "conclusion">): CIConclusion | CIStatus {
  return run.status === "concluded" ? run.conclusion ?? "neutral" : run.status;
}

/** Outcomes that mean the workflow did not pass, as opposed to not running. */
const CI_FAILING: ReadonlySet<string> = new Set(["failure", "timed_out", "startup_failure"]);

export function isCIFailure(outcome: CIConclusion | CIStatus): boolean {
  return CI_FAILING.has(outcome);
}

export interface CIWorkflowGroup {
  name: string;
  runs: CIRun[];
  /** The run whose outcome is the workflow's CURRENT state. */
  latest: CIRun;
}

/**
 * Collapse CI runs to one entry per workflow (different commits); only the
 * newest outcome is current, the rest is history behind a disclosure.
 */
export function groupCIRunsByWorkflow(runs: readonly CIRun[]): CIWorkflowGroup[] {
  const groups = new Map<string, CIRun[]>();
  for (const run of runs) {
    const name = ciWorkflowName(run);
    const existing = groups.get(name);
    if (existing) existing.push(run);
    else groups.set(name, [run]);
  }
  return [...groups]
    .map(([name, workflowRuns]) => {
      const sorted = [...workflowRuns].sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
      return { name, runs: sorted, latest: sorted[0] };
    })
    .sort((a, b) => b.latest.createdAt - a.latest.createdAt || a.name.localeCompare(b.name));
}

/** Overall state from each workflow's latest run; a failure outranks in-flight work. */
export function ciGroupsOutcome(groups: readonly CIWorkflowGroup[]): CIConclusion | CIStatus {
  const outcomes = groups.map((group) => ciRunOutcome(group.latest));
  if (outcomes.some(isCIFailure)) return "failure";
  if (outcomes.some((outcome) => outcome === "in_progress" || outcome === "queued")) return "in_progress";
  if (outcomes.some((outcome) => outcome === "success")) return "success";
  return outcomes[0] ?? "neutral";
}

/** "2 passing, 1 failing" — the current state of a multi-workflow stretch. */
export function ciGroupsSummary(groups: readonly CIWorkflowGroup[]): string {
  const outcomes = groups.map((group) => ciRunOutcome(group.latest));
  const counts = {
    failing: outcomes.filter(isCIFailure).length,
    running: outcomes.filter((outcome) => outcome === "in_progress" || outcome === "queued").length,
    passing: outcomes.filter((outcome) => outcome === "success").length,
  };
  const parts = [
    counts.failing > 0 ? `${counts.failing} failing` : undefined,
    counts.running > 0 ? `${counts.running} running` : undefined,
    counts.passing > 0 ? `${counts.passing} passing` : undefined,
  ].filter((part): part is string => part !== undefined);
  return parts.length > 0 ? parts.join(", ") : `${groups.length} workflows`;
}
