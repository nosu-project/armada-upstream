// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

import { contextActionsAt, linkActionsAt } from "./ChatImageMenuContext";

function inside(html: string): Element {
  const root = document.createElement("div");
  root.innerHTML = html;
  return root.querySelector("#t")!;
}

describe("linkActionsAt", () => {
  it("offers Copy link for an external anchor", () => {
    const actions = linkActionsAt(inside('<a href="https://example.com/a?b=1"><span id="t">x</span></a>'));
    expect(actions?.map((a) => a.label)).toEqual(["Copy link"]);
  });

  it("prefers the sent URL on an in-app link", () => {
    expect(linkActionsAt(inside('<a id="t" href="/c/abc" data-copy-url="https://armada.buzz/c/abc">c</a>'))).not.toBeNull();
  });

  it("ignores text, relative links and unsafe schemes", () => {
    expect(linkActionsAt(inside('<p id="t">plain</p>'))).toBeNull();
    expect(linkActionsAt(inside('<a id="t" href="/c/abc">c</a>'))).toBeNull();
    expect(linkActionsAt(inside('<a id="t" href="javascript:alert(1)">c</a>'))).toBeNull();
  });

  it("copies the address of a mailto link", () => {
    expect(linkActionsAt(inside('<a id="t" href="mailto:a@b.c">a</a>'))?.[0].label).toBe("Copy email address");
  });
});

describe("contextActionsAt", () => {
  function rows(): [HTMLElement, HTMLElement] {
    document.body.innerHTML = '<div id="a"><p>hello world</p></div><div id="b"><a href="https://x.y">link</a></div>';
    return [document.getElementById("a")!, document.getElementById("b")!];
  }

  function select(node: Node, start: number, end: number) {
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, end);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  }

  it("offers the highlighted text in the row it touches", async () => {
    const [a] = rows();
    select(a.querySelector("p")!.firstChild!, 6, 11);
    const actions = contextActionsAt(a, a);
    expect(actions?.map((x) => x.id)).toEqual(["copy-selection"]);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    actions![0].onSelect();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("world"));
  });

  it("ignores a selection elsewhere and a collapsed one, keeping link actions", () => {
    const [a, b] = rows();
    select(a.querySelector("p")!.firstChild!, 0, 5);
    expect(contextActionsAt(b.querySelector("a"), b)?.map((x) => x.id)).toEqual(["copy-link-target"]);
    select(a.querySelector("p")!.firstChild!, 2, 2);
    expect(contextActionsAt(a, a)).toBeNull();
  });
});
