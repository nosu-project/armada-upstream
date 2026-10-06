// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { linkActionsAt } from "./ChatImageMenuContext";

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
