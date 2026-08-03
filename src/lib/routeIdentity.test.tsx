import { render, screen } from "@testing-library/react";
import { useEffect, useRef, useState } from "react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { describe, expect, it } from "vitest";

/**
 * The room/thread/message routes declare several paths that render the SAME
 * page component (`/c/:communityId/:channelId`, `.../t/:threadRoot`, and so
 * on). That is only a sound design if moving between them preserves the
 * component instance: a remount would tear down the timeline, its transport
 * and its loaded history every time a reader opens a thread or follows a
 * permalink — turning a panel toggle into a full channel reload.
 *
 * React Router renders matches without per-path keys, so React reconciles by
 * type and position and the instance survives. This pins that behavior, since
 * it is an implementation detail of the router rather than a documented
 * guarantee, and the failure mode (a slow reload, not an error) is easy to
 * miss in review.
 */
function Probe({ label }: { label: string }) {
  const mounts = useRef(0);
  const [, force] = useState(0);
  useEffect(() => {
    mounts.current += 1;
    force((n) => n + 1);
  }, []);
  return <span data-testid="probe">{`${label}:${mounts.current}`}</span>;
}

function Nav({ to }: { to: string }) {
  const navigate = useNavigate();
  useEffect(() => {
    navigate(to);
  }, [navigate, to]);
  return null;
}

describe("route identity", () => {
  it("preserves the component instance across sibling routes rendering it", async () => {
    function App({ to }: { to?: string }) {
      return (
        <Routes>
          <Route path="/c/:communityId/:channelId" element={<><Probe label="room" />{to ? <Nav to={to} /> : null}</>} />
          <Route path="/c/:communityId/:channelId/t/:threadRoot" element={<Probe label="thread" />} />
          <Route path="/c/:communityId/:channelId/t/:threadRoot/m/:messageId" element={<Probe label="reply" />} />
        </Routes>
      );
    }

    render(
      <MemoryRouter initialEntries={["/c/comm/chan"]}>
        <App to="/c/comm/chan/t/root" />
      </MemoryRouter>,
    );

    // One mount for the channel route, and still one after the router has
    // swapped in the thread route: the same instance, not a fresh one.
    expect((await screen.findByTestId("probe")).textContent).toBe("thread:1");
  });
});
