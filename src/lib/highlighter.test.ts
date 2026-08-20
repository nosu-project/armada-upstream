import { describe, expect, it } from "vitest";

import { highlightCode, MAX_HIGHLIGHT_CHARS, resolveLanguage } from "./highlighter";

import type { Root, RootContent } from "hast";

/** Flatten a tree into [scope classes, text] pairs for assertions. */
function scopes(root: Root): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const walk = (nodes: RootContent[], cls: string) => {
    for (const n of nodes) {
      if (n.type === "text") out.push([cls, n.value]);
      else if (n.type === "element") {
        const c = n.properties.className;
        walk(n.children, Array.isArray(c) ? c.join(" ") : cls);
      }
    }
  };
  walk(root.children, "");
  return out;
}

describe("resolveLanguage", () => {
  it("accepts highlight.js grammar names and its built-in aliases", () => {
    for (const name of ["json", "js", "ts", "jsx", "tsx", "py", "sh", "bash", "yml", "html", "rs", "kt", "c++", "golang"]) {
      expect(resolveLanguage(name), name).not.toBeNull();
    }
  });

  it("is case-insensitive and trims", () => {
    expect(resolveLanguage("JSON")).toBe("json");
    expect(resolveLanguage(" Python ")).toBe("python");
  });

  it("maps fence names highlight.js lacks onto grammars it has", () => {
    expect(resolveLanguage("docker")).toBe("dockerfile");
    expect(resolveLanguage("vue")).toBe("xml");
    expect(resolveLanguage("mjs")).toBe("javascript");
    expect(resolveLanguage("env")).toBe("ini");
  });

  it("returns null for unknown or empty names", () => {
    expect(resolveLanguage(undefined)).toBeNull();
    expect(resolveLanguage("")).toBeNull();
    expect(resolveLanguage("   ")).toBeNull();
    expect(resolveLanguage("klingon")).toBeNull();
  });
});

describe("highlightCode", () => {
  it("scopes JSON keys, strings, numbers and literals", () => {
    const tree = highlightCode("json", '{"name": "Eduardo", "age": 30, "ok": true}');
    expect(tree).not.toBeNull();
    const s = scopes(tree!);
    expect(s).toContainEqual(["hljs-attr", '"name"']);
    expect(s).toContainEqual(["hljs-string", '"Eduardo"']);
    expect(s).toContainEqual(["hljs-number", "30"]);
    expect(s).toContainEqual(["hljs-keyword", "true"]);
  });

  it("scopes keywords and strings in TypeScript", () => {
    const s = scopes(highlightCode("ts", 'const greeting: string = "hi";')!);
    expect(s).toContainEqual(["hljs-keyword", "const"]);
    expect(s).toContainEqual(["hljs-string", '"hi"']);
  });

  it("reproduces the source text exactly", () => {
    const code = "const x = `a${b}`; // hi\nif (x) {\n  y();\n}\n";
    const tree = highlightCode("ts", code)!;
    expect(scopes(tree).map(([, t]) => t).join("")).toBe(code);
  });

  it("returns null for an unknown or missing language", () => {
    expect(highlightCode("klingon", "x")).toBeNull();
    expect(highlightCode(undefined, "x")).toBeNull();
  });

  it("skips blocks over the size cap", () => {
    expect(highlightCode("json", "1".repeat(MAX_HIGHLIGHT_CHARS + 1))).toBeNull();
    expect(highlightCode("json", "1".repeat(MAX_HIGHLIGHT_CHARS))).not.toBeNull();
  });
});
