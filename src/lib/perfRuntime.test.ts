import { describe, expect, it } from "vitest";

import { callSite, changedProps, fiberName, filterShape, frameHead, frameKind, socketKey, walkCommit } from "./perfRuntime";

describe("frameHead", () => {
  it("reads the verb and subscription id of a relay frame", () => {
    expect(frameHead('["EVENT","sub-1",{"kind":1}]')).toEqual({ verb: "EVENT", sub: "sub-1" });
    expect(frameHead('["EOSE", "abc"]')).toEqual({ verb: "EOSE", sub: "abc" });
    expect(frameHead('["CLOSED","x","auth-required: no"]')).toEqual({ verb: "CLOSED", sub: "x" });
  });

  it("has no sub for an outbound EVENT, whose second element is the event", () => {
    expect(frameHead('["EVENT",{"id":"aa"}]')).toEqual({ verb: "EVENT" });
  });

  it("rejects what is not a Nostr frame", () => {
    expect(frameHead("hello")).toBeUndefined();
    expect(frameHead("{}")).toBeUndefined();
  });
});

describe("frameKind", () => {
  it("finds the event's kind", () => {
    expect(frameKind('["EVENT","s",{"id":"a","kind":1059,"content":"x"}]')).toBe(1059);
  });

  it("is not fooled by kind text inside content, where quotes are escaped", () => {
    expect(frameKind('["EVENT","s",{"content":"{\\"kind\\":7}","kind":9}]')).toBe(9);
  });
});

describe("filterShape", () => {
  it("keeps kinds, counts every other key's values, and never names them", () => {
    const shape = filterShape([{ kinds: [1059, 4], "#p": ["a".repeat(64)], limit: 50 }]);
    expect(shape).toBe("{kinds:4,1059 #p×1 limit}");
    expect(shape).not.toContain("aaaa");
  });

  it("is order-independent, so the same subscription always has one shape", () => {
    expect(filterShape([{ limit: 1, kinds: [2, 1] }])).toBe(filterShape([{ kinds: [1, 2], limit: 1 }]));
  });

  it("joins multiple filters", () => {
    expect(filterShape([{ kinds: [0] }, { ids: ["x", "y"] }])).toBe("{kinds:0} {ids×2}");
  });
});

describe("socketKey", () => {
  it("drops the query, which is where a LiveKit token lives", () => {
    expect(socketKey("wss://lk.example.com/rtc?access_token=secret")).toBe("wss://lk.example.com/rtc");
  });

  it("drops a bare trailing slash", () => {
    expect(socketKey("wss://relay.example.com/")).toBe("wss://relay.example.com");
  });
});

describe("callSite", () => {
  it("skips the instrument's own frame and strips origins and queries (V8)", () => {
    const stack = [
      "Error",
      "    at w.setTimeout (http://localhost:8080/src/lib/perfRuntime.ts?t=1:10:5)",
      "    at poll (http://localhost:8080/src/hooks/usePoll.ts?t=2:42:7)",
      "    at http://localhost:8080/src/main.tsx:5:1",
    ].join("\n");
    expect(callSite(stack)).toBe("poll (/src/hooks/usePoll.ts:42:7) < /src/main.tsx:5:1");
  });

  it("reads WebKit frames", () => {
    const stack = "setTimeout@capacitor://localhost/assets/a.js:1:2\nloop@capacitor://localhost/assets/b.js:3:4";
    expect(callSite(stack, 1, 1)).toBe("loop@/assets/b.js:3:4");
  });

  it("degrades to ? without a stack", () => {
    expect(callSite(undefined)).toBe("?");
  });
});

describe("walkCommit", () => {
  type F = Parameters<typeof walkCommit>[0] & object;
  function fiber(name: string, over: Partial<F> = {}): F {
    const type = Object.defineProperty(function () {}, "name", { value: name });
    return { tag: 0, type, flags: 0, child: null, sibling: null, alternate: null, ...over };
  }

  it("counts mounts and components that performed work, and skips bailed-out subtrees", () => {
    // Previous tree: App > [Idle > Deep, Busy]
    const oldDeep = fiber("Deep");
    const oldIdle = fiber("Idle", { child: oldDeep });
    const oldBusy = fiber("Busy");
    const oldApp = fiber("App");

    // New tree: App bailed out itself but its children were cloned; Idle
    // bailed out of its subtree (child pointer shared), Busy re-rendered, and
    // New mounted.
    const idle = fiber("Idle", { alternate: oldIdle, child: oldDeep });
    const mounted = fiber("New");
    const busy = fiber("Busy", { alternate: oldBusy, flags: 1, sibling: mounted });
    idle.sibling = busy;
    const app = fiber("App", { alternate: oldApp, child: idle });

    const seen: string[] = [];
    walkCommit(app, (name, mount) => seen.push(`${name}${mount ? "+" : ""}`));
    expect(seen.sort()).toEqual(["Busy", "New+"]);
  });

  it("names forwardRef and memo fibers", () => {
    expect(fiberName({ tag: 11, type: { render: function Inner() {} } })).toBe("Inner");
    expect(fiberName({ tag: 15, type: function Memoed() {} })).toBe("Memoed");
    expect(fiberName({ tag: 5, type: "div" })).toBeUndefined();
  });
});

describe("changedProps", () => {
  it("names the props whose identity changed", () => {
    const onClick = () => {};
    expect(changedProps({ a: 1, onClick }, { a: 1, onClick: () => {} })).toEqual(["onClick"]);
  });

  it("blames state or context when no prop changed", () => {
    const props = { a: 1 };
    expect(changedProps(props, props)).toEqual(["(state/context)"]);
    expect(changedProps({ a: 1 }, { a: 1 })).toEqual(["(state/context)"]);
  });

  it("reports children only when nothing else explains the render", () => {
    expect(changedProps({ children: [1] }, { children: [1] })).toEqual(["children"]);
    expect(changedProps({ x: 1, children: [1] }, { x: 2, children: [1] })).toEqual(["x"]);
  });
});
