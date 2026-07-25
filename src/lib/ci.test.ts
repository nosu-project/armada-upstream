/**
 * ngit-ci CI events (NIP-34 CI extension). Fixtures mirror events observed on
 * relay.ngit.dev, including the multi-`a` tagging every multi-maintainer
 * repository produces.
 */

import { describe, expect, it } from "vitest";

import {
  assembleCIRuns,
  CI_JOB_RESULT_KIND,
  CI_PROGRESS_KIND,
  CI_RESULT_KIND,
  matchCIEventRepository,
  matchCIRepository,
  parseCIJobResult,
  parseCIRun,
} from "@/lib/ci";
import { buildGitTimelineActivities, parseGitRepositoryAddress } from "@/lib/gitActivity";

import type { NostrEvent } from "@nostrify/nostrify";

const OWNER = "781a1527055f74c1f70230f10384609b34548f8ab6a0a6caa74025827f9fdae5";
const FORK = "86184109eae937d8d6f980b4a0b46da4ef0d983eade403ee1b4c0b6bde238b47";
const COORDINATOR = "df5937d363b7a400cedcfad49a79cec871091bf74a6c079e3b10f7fdaa378e28";
const COMMIT = "ea956a992ea06b618e7d262638b9615f8d3f1f74";
const WORKFLOW = ".ngit/act/workflows/deploy-web.yml";

const OWNER_COORD = `30617:${OWNER}:armada`;
const FORK_COORD = `30617:${FORK}:armada`;

function event(partial: Partial<NostrEvent> & { kind: number; tags: string[][] }): NostrEvent {
  return {
    id: partial.id ?? Math.random().toString(36).slice(2).padEnd(64, "0"),
    pubkey: partial.pubkey ?? COORDINATOR,
    created_at: partial.created_at ?? 1_785_000_000,
    kind: partial.kind,
    tags: partial.tags,
    content: partial.content ?? "",
    sig: "",
  } as NostrEvent;
}

/** The common tags every CI event carries, tagged under BOTH maintainers. */
const commonTags = [
  ["a", FORK_COORD],
  ["a", OWNER_COORD],
  ["c", COMMIT],
  ["w", WORKFLOW, "287322fe"],
  ["o", "push"],
  ["r", "refs/heads/main"],
];

const jobResult = event({
  id: "job1".padEnd(64, "0"),
  kind: CI_JOB_RESULT_KIND,
  content: "[log-tail omitted=7126]\nassets/web.js",
  tags: [...commonTags, ["job", "deploy"], ["name", "Deploy web/deploy"], ["conclusion", "success"], ["logs", "https://blossom.example/log.txt"]],
});

const workflowResult = event({
  id: "run1".padEnd(64, "0"),
  created_at: 1_785_000_500,
  kind: CI_RESULT_KIND,
  tags: [...commonTags, ["conclusion", "success"], ["q", jobResult.id, "wss://relay.test", COORDINATOR, "deploy"]],
});

describe("parsing", () => {
  it("reads a workflow result", () => {
    const run = parseCIRun(workflowResult)!;
    expect(run.status).toBe("concluded");
    expect(run.conclusion).toBe("success");
    expect(run.commit).toBe(COMMIT);
    expect(run.workflow).toBe(WORKFLOW);
    expect(run.trigger).toBe("push");
    expect(run.ref).toBe("refs/heads/main");
    expect(run.jobs).toEqual([{ job: "deploy", eventId: jobResult.id, provider: COORDINATOR }]);
  });

  it("reads a job result", () => {
    const job = parseCIJobResult(jobResult)!;
    expect(job.job).toBe("deploy");
    expect(job.name).toBe("Deploy web/deploy");
    expect(job.conclusion).toBe("success");
    expect(job.logs).toBe("https://blossom.example/log.txt");
  });

  it("treats a progress marker without a conclusion as in-progress", () => {
    const run = parseCIRun(event({
      kind: CI_PROGRESS_KIND,
      tags: [...commonTags, ["d", "abc"], ["status", "in_progress"]],
    }))!;
    expect(run.status).toBe("in_progress");
    expect(run.conclusion).toBeUndefined();
  });

  it("rejects an unrecognized conclusion rather than displaying it", () => {
    const run = parseCIRun(event({ kind: CI_RESULT_KIND, tags: [...commonTags, ["conclusion", "sabotaged"]] }))!;
    expect(run.conclusion).toBeUndefined();
  });

  it("ignores an event with no parseable repository coordinate", () => {
    expect(parseCIRun(event({ kind: CI_RESULT_KIND, tags: [["c", COMMIT]] }))).toBeUndefined();
  });
});

describe("repository matching", () => {
  it("matches a coordinate that is not the first `a` tag", () => {
    // The fork is tagged first; a client holding only the canonical repo must
    // still match, exactly as NIP-34 tickets do.
    const run = parseCIRun(workflowResult)!;
    expect(matchCIRepository(run, new Set([OWNER_COORD]))?.coordinate).toBe(OWNER_COORD);
  });

  it("scopes job results by their own `a` tags, with no root lookup", () => {
    expect(matchCIEventRepository(jobResult, new Set([OWNER_COORD]))?.coordinate).toBe(OWNER_COORD);
  });

  it("does not match an unrelated repository", () => {
    expect(matchCIEventRepository(jobResult, new Set(["30617:deadbeef:other"]))).toBeUndefined();
  });
});

describe("assembleCIRuns", () => {
  it("resolves quoted job results onto the run", () => {
    const [run] = assembleCIRuns([jobResult, workflowResult]);
    expect(run.jobs[0].result?.name).toBe("Deploy web/deploy");
    expect(run.jobs[0].result?.logs).toBe("https://blossom.example/log.txt");
  });

  it("prefers the durable result over a newer progress marker for the same attempt", () => {
    // The marker expires within 30 minutes; letting it win would show a
    // concluded run as 'running' and then drop it entirely.
    const progress = event({
      id: "prog".padEnd(64, "0"),
      created_at: workflowResult.created_at + 60,
      kind: CI_PROGRESS_KIND,
      tags: [...commonTags, ["d", "abc"], ["status", "in_progress"]],
    });
    const runs = assembleCIRuns([progress, workflowResult]);
    expect(runs).toHaveLength(1);
    expect(runs[0].event.kind).toBe(CI_RESULT_KIND);
    expect(runs[0].status).toBe("concluded");
  });

  it("shows a progress marker while no result exists yet", () => {
    const progress = event({ kind: CI_PROGRESS_KIND, tags: [...commonTags, ["d", "abc"], ["status", "queued"]] });
    const runs = assembleCIRuns([progress]);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("queued");
  });

  it("collapses a re-run of the same workflow and commit to the newest attempt", () => {
    const rerun = event({
      id: "run2".padEnd(64, "0"),
      created_at: workflowResult.created_at + 500,
      kind: CI_RESULT_KIND,
      tags: [...commonTags, ["conclusion", "failure"]],
    });
    const runs = assembleCIRuns([workflowResult, rerun]);
    expect(runs).toHaveLength(1);
    expect(runs[0].conclusion).toBe("failure");
  });

  it("keeps runs from different coordinators separate", () => {
    const rival = event({
      id: "run3".padEnd(64, "0"),
      pubkey: "beef".padEnd(64, "0"),
      kind: CI_RESULT_KIND,
      tags: [...commonTags, ["conclusion", "failure"]],
    });
    expect(assembleCIRuns([workflowResult, rival])).toHaveLength(2);
  });
});

describe("timeline integration", () => {
  const address = parseGitRepositoryAddress(OWNER_COORD)!;

  it("renders a run inside the attachment interval", () => {
    const activities = buildGitTimelineActivities(
      [jobResult, workflowResult],
      [{ address, relayHints: [], attachedAt: workflowResult.created_at - 10 }],
    );
    expect(activities).toHaveLength(1);
    expect(activities[0].type).toBe("ci-run");
  });

  it("drops a run that predates the attachment, like any other activity", () => {
    const activities = buildGitTimelineActivities(
      [jobResult, workflowResult],
      [{ address, relayHints: [], attachedAt: workflowResult.created_at + 10 }],
    );
    expect(activities).toHaveLength(0);
  });

  it("does not render a run for an unattached repository", () => {
    const other = parseGitRepositoryAddress("30617:" + "ab".repeat(32) + ":other")!;
    const activities = buildGitTimelineActivities(
      [jobResult, workflowResult],
      [{ address: other, relayHints: [], attachedAt: 0 }],
    );
    expect(activities).toHaveLength(0);
  });
});
