/**
 * Minimal RFC 6570 expansion: `{var}` (encoded) and `{+var}` (reserved kept);
 * unknown vars → "". Ported from Ditto for template compatibility.
 */
export function fillUriTemplate(template: string, vars: Record<string, string | undefined>): string {
  return template.replace(/\{(\+?)([A-Za-z0-9_]+)\}/g, (_match, plus: string, name: string) => {
    const value = vars[name];
    if (value === undefined) return "";
    if (plus) {
      return encodeURI(value);
    }
    return encodeURIComponent(value);
  });
}
