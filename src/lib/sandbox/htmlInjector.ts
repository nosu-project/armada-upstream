/** Prepend `<script>` tags inside `<head>` (via DOMParser) so they run before the app's scripts. */
export function injectScriptTags(html: string, scriptPaths: string[]): string {
  if (scriptPaths.length === 0) return html;

  const doc = new DOMParser().parseFromString(html, "text/html");

  // Insert in reverse order so the first path ends up first in <head>.
  for (let i = scriptPaths.length - 1; i >= 0; i--) {
    const script = doc.createElement("script");
    script.src = scriptPaths[i];
    doc.head.prepend(script);
  }

  // DOMParser strips the doctype; re-add it when the original had one.
  const hasDoctype = /^<!doctype\s/i.test(html.trimStart());
  const serialised = doc.documentElement.outerHTML;
  return hasDoctype ? "<!DOCTYPE html>\n" + serialised : serialised;
}
