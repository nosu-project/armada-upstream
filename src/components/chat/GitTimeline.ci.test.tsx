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
  return render(<GitTimelineRow entry={entry} members={new Set()} onOpen={() => {}} />);
}

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
