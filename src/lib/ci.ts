/**
 * ngit-ci CI workflow events — the NIP-34 CI extension (experimental kinds
 * 9840 / 9841 / 9842 / 39842).
 *
 * Kind 9841 "Job Result" is signed by the compute provider that ran the job;
 * its content is a log tail and the full log hangs off a `logs` tag. Kind 9842
 * "Workflow Result" is the durable combined outcome, signed by the coordinator
 * that scheduled the run, quoting each Job Result with a `q` tag. Kind 39842
 * "Workflow Progress" is an addressable, EXPIRING (≤30 min) mirror of the same
 * shape for a run that is still queued or executing — so the durable record is
 * always the 9842 and a progress marker must never be the thing a feed
 * remembers.
 *
 * Trust model: none, matching gitworkshop. The extension explicitly leaves the
 * choice to clients ("Clients choose which coordinator and compute-provider
 * pubkeys to trust"), and no designation mechanism exists on-relay — nothing
 * binds a coordinator to a repository, and the `a` tag is unauthenticated. We
 * therefore render every CI event and ALWAYS surface the signer, so a reader
 * judges the claim by its key rather than by our having shown it. Anyone can
 * publish a green run against a public coordinate; the UI must not imply we
 * verified it.
 *
 * Multi-maintainer repositories are announced once per maintainer, so CI
 * events carry one `a` tag per coordinate. Match against every coordinate the
 * caller holds, never just the first tag.
 */

import { parseGitRepositoryAddress, type GitRepositoryAddress } from "@/lib/gitActivity";

import type { NostrRumor } from "@/lib/nostrRumor";

/** Kind 9840 — maintainer-requested manual workflow trigger. */
export const CI_MANUAL_TRIGGER_KIND = 9840;
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
  /** The compute provider's key — the direct execution claim. */
  author: string;
  /** Job id as declared in the workflow file. */
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
  /** Resolved once the Job Result itself is in hand. */
  result?: CIJobResult;
}

export interface CIRun {
  /** The 9842 when one exists, else the newest 39842 for the attempt. */
  event: NostrRumor;
  id: string;
  /** The coordinator that signed the run. Displayed, never trusted. */
  author: string;
  repositoryAddresses: GitRepositoryAddress[];
  /** First `c` tag: the commit the workflow ran against. */
  commit?: string;
  /** Workflow file path from the `w` tag. */
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
    logs: firstTagValue(event, "logs")?.trim() || undefined,
    createdAt: event.created_at,
  };
}

/**
 * Parse a kind-9842 Workflow Result or kind-39842 Workflow Progress into a run.
 * A 9842 has no `status` tag and is by definition concluded; a 39842 without a
 * recognized status is treated as in-progress rather than dropped, since the
 * marker's existence is itself the signal that something is running.
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
 * Collapse CI events into one run per attempt, with Job Results resolved onto
 * the `q` tags that quoted them.
 *
 * A 39842 progress marker and the 9842 it precedes describe the SAME attempt
 * but share no run identifier — the progress `d` is random and the result has
 * no `d` at all — so they are joined on (coordinator, commit, workflow). The
 * durable 9842 always wins that join even when a progress marker is newer,
 * because the marker expires within 30 minutes and would otherwise take the
 * concluded result's place and then vanish. Re-runs of the same workflow on the
 * same commit collapse to the newest, which is what the extension prescribes
 * ("clients SHOULD order attempts by created_at and treat the latest as
 * current").
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

/**
 * The held repository a raw CI event belongs to. Job Results carry the same
 * common `a` tags as runs, so all three kinds scope identically — no root
 * lookup, unlike NIP-22 comments and NIP-34 statuses.
 */
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
