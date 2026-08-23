import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { getCachedHighlight } from "@/lib/codeHighlight";

import { CodeBlock } from "./Markdown";

afterEach(cleanup);

describe("CodeBlock", () => {
  it("renders plain code when the fence names no language", () => {
    const { container } = render(<CodeBlock code='{"a": 1}' />);
    expect(container.querySelector("code")?.textContent).toBe('{"a": 1}');
    expect(container.querySelector("code span")).toBeNull();
  });

  it("highlights a known language once the grammars load, keeping the text intact", async () => {
    const code = '{"name": "Eduardo"}';
    const { container } = render(<CodeBlock code={code} lang="json" />);
    await waitFor(() => expect(container.querySelector(".hljs-attr")).not.toBeNull());
    expect(container.querySelector(".hljs-attr")?.textContent).toBe('"name"');
    expect(container.querySelector(".hljs-string")?.textContent).toBe('"Eduardo"');
    expect(container.querySelector("code")?.textContent).toBe(code);
    expect(container.querySelector("pre")?.dataset.lang).toBe("json");
  });

  it("paints a previously highlighted block on its first render", async () => {
    const code = "SELECT 1;";
    const first = render(<CodeBlock code={code} lang="sql" />);
    await waitFor(() => expect(first.container.querySelector(".hljs-keyword")).not.toBeNull());
    cleanup();
    // Same block again: the cache answers synchronously, no await needed.
    const second = render(<CodeBlock code={code} lang="sql" />);
    expect(second.container.querySelector(".hljs-keyword")?.textContent).toBe("SELECT");
  });

  it("leaves an unknown language plain", async () => {
    const { container } = render(<CodeBlock code="hello" lang="klingon" />);
    // The lookup still runs (and settles as "not highlightable"); the block must not change.
    await waitFor(() => expect(getCachedHighlight("klingon", "hello")).toBeNull());
    expect(container.querySelector("code span")).toBeNull();
    expect(container.querySelector("code")?.textContent).toBe("hello");
  });
});
