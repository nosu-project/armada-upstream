/**
 * The CI run row: a claim attributed to its signer, with each job's log
 * fetched on demand and rendered inline.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GitTimelineRow } from "@/components/chat/GitTimeline";
import { CI_JOB_RESULT_KIND, CI_RESULT_KIND, parseCIJobResult, parseCIRun } from "@/lib/ci";
import { parseGitRepositoryAddress } from "@/lib/gitActivity";

import type { GitChannelTimelineEntry } from "@/components/chat/channelTimeline";
import type { NostrEvent } from "@nostrify/nostrify";

vi.mock("@/hooks/useAuthor", () => ({ useAuthor: () => ({ data: undefined }) }));
vi.mock("@/hooks/useScopedDisplayName", () => ({
  useScopedDisplayName: () => "ngit-ci",
  useScopedIdentity: () => ({ displayName: "ngit-ci", color: undefined, label: undefined }),
}));

const OWNER = "781a1527055f74c1f70230f10384609b34548f8ab6a0a6caa74025827f9fdae5";
const COORD = `30617:${OWNER}:armada`;
const LOGS = "https://blossom.example/log.txt";

function event(kind: number, tags: string[][], content = "", id = Math.random().toString(36).slice(2).padEnd(64, "0")): NostrEvent {
  return { id, pubkey: "cafe".padEnd(64, "0"), created_at: 1_785_000_000, kind, tags, content, sig: "" } as NostrEvent;
}

const common = [["a", COORD], ["c", "ea956a992ea06b618e7d262638b9615f8d3f1f74"], ["w", ".ngit/act/workflows/deploy-web.yml"], ["o", "push"]];

function entryWith(logsUrl: string | undefined, tail: string): GitChannelTimelineEntry {
  const jobEvent = event(
    CI_JOB_RESULT_KIND,
    [...common, ["job", "deploy"], ["name", "Deploy web/deploy"], ["conclusion", "success"], ...(logsUrl ? [["logs", logsUrl]] : [])],
    tail,
    "job".padEnd(64, "0"),
  );
  const runEvent = event(CI_RESULT_KIND, [...common, ["conclusion", "success"], ["q", jobEvent.id, "wss://r.test", "cafe".padEnd(64, "0"), "deploy"]]);
  const run = parseCIRun(runEvent)!;
  run.jobs[0].result = parseCIJobResult(jobEvent);
  return {
    type: "git-ci-run",
    id: `git:${run.id}`,
    createdAt: run.createdAt,
    activity: { type: "ci-run", run, repository: parseGitRepositoryAddress(COORD)!, createdAt: run.createdAt },
  };
}

function renderRow(entry: GitChannelTimelineEntry) {
  return render(<GitTimelineRow entry={entry} onOpen={() => {}} />);
}

/** A concluded run of one workflow, with no jobs to expand. */
function runEntry(workflow: string, conclusion: string, commit: string, createdAt: number): GitChannelTimelineEntry {
  const run = parseCIRun(event(
    CI_RESULT_KIND,
    [["a", COORD], ["c", commit], ["w", `.ngit/act/workflows/${workflow}.yml`], ["o", "push"], ["conclusion", conclusion]],
    "",
    `${workflow}${createdAt}`.padEnd(64, "0"),
  ))!;
  run.createdAt = createdAt;
  return {
    type: "git-ci-run",
    id: `git:${run.id}`,
    createdAt,
    activity: { type: "ci-run", run, repository: parseGitRepositoryAddress(COORD)!, createdAt },
  };
}

describe("a stretch of CI runs", () => {
  /** Ten pushes, each firing both workflows; `test` broke on the last one. */
  const stretch = Array.from({ length: 10 }, (_, i) => [
    runEntry("desktop", "success", `c${i}`.padEnd(40, "0"), 1_785_000_000 + i * 2),
    runEntry("test", i === 9 ? "failure" : "success", `c${i}`.padEnd(40, "0"), 1_785_000_000 + i * 2 + 1),
  ]).flat();

  function renderGroup(entries: GitChannelTimelineEntry[]) {
    return render(<GitTimelineRow entry={entries[0]} related={entries} onOpen={() => {}} />);
  }

  it("states where each workflow stands instead of listing every run", () => {
    renderGroup(stretch);
    expect(screen.getByText(/20 runs/)).toBeInTheDocument();
    expect(screen.getByText(/1 failing, 1 passing/)).toBeInTheDocument();
    // Twenty commits' worth of detail is exactly what the fold is for.
    expect(screen.queryByText("c9000000")).not.toBeInTheDocument();
  });

  it("opens the runs behind the fold on click", () => {
    renderGroup(stretch);
    fireEvent.click(screen.getByRole("button", { name: /show ci runs/i }));
    expect(screen.getByText("test")).toBeInTheDocument();
    expect(screen.getByText("desktop")).toBeInTheDocument();
    expect(screen.getByText(/failed/)).toBeInTheDocument();
    // The run each workflow is currently on, not the nineteen before it.
    expect(screen.getAllByTitle(/succeeded/).length).toBeGreaterThan(0);
  });

  it("names the workflow once when the whole stretch is one workflow", () => {
    renderGroup(stretch.filter((entry) => entry.type === "git-ci-run" && entry.activity.run.workflow?.includes("test")));
    expect(screen.getByText(/latest of 10 runs/)).toBeInTheDocument();
  });

  it("leaves a lone run as the sentence it already is", () => {
    renderGroup([runEntry("test", "success", "a".repeat(40), 1_785_000_000)]);
    expect(screen.queryByRole("button", { name: /show ci runs/i })).not.toBeInTheDocument();
    expect(screen.getByText(/succeeded/)).toBeInTheDocument();
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("CI run row", () => {
  it("names the workflow, outcome, commit and the signer that reported it", () => {
    renderRow(entryWith(LOGS, "tail"));
    expect(screen.getByText("deploy-web")).toBeInTheDocument();
    expect(screen.getByText(/succeeded/)).toBeInTheDocument();
    expect(screen.getByText("ea956a9")).toBeInTheDocument();
    // The signer is the whole trust story; it must never be implicit.
    expect(screen.getByText("ngit-ci")).toBeInTheDocument();
  });

  it("links the raw log out with an accessible external-link control", () => {
    renderRow(entryWith(LOGS, "tail"));
    const link = screen.getByRole("link", { name: /open the full log/i });
    expect(link).toHaveAttribute("href", LOGS);
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("fetches the log only on expand, then renders it inline", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => "line one\nline two" });
    vi.stubGlobal("fetch", fetchMock);
    renderRow(entryWith(LOGS, "tail"));

    // Deferred: a channel may hold many runs, each an arbitrary blob.
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /Deploy web\/deploy/ }));
    await waitFor(() => expect(screen.getByText(/line one/)).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith(LOGS);
    expect(screen.getByText(/line one/).tagName).toBe("CODE");
  });

  it("falls back to the job's own log tail when the blob is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    renderRow(entryWith(LOGS, "tail from the event"));

    fireEvent.click(screen.getByRole("button", { name: /Deploy web\/deploy/ }));
    await waitFor(() => expect(screen.getByText(/Couldn't load the log/)).toBeInTheDocument());
    expect(screen.getByText(/tail from the event/)).toBeInTheDocument();
  });

  it("refuses to fetch a log over a non-https URL", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    renderRow(entryWith("http://blossom.example/log.txt", "tail"));

    fireEvent.click(screen.getByRole("button", { name: /Deploy web\/deploy/ }));
    await waitFor(() => expect(screen.getByText(/not https/i)).toBeInTheDocument());
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
