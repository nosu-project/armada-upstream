import type { ReactElement } from "react";

/** Draws a sprite of palette characters as one rect per horizontal run; any other character is clear. */
export function pixelRects(rows: readonly string[], palette: Record<string, string>) {
  const rects: ReactElement[] = [];
  for (let y = 0; y < rows.length; y++) {
    const row = rows[y];
    for (let x = 0; x < row.length; x++) {
      const fill = palette[row[x]];
      if (!fill) continue;
      let end = x;
      while (row[end + 1] === row[x]) end++;
      rects.push(<rect key={`${x},${y}`} x={x} y={y} width={end - x + 1} height={1} fill={fill} />);
      x = end;
    }
  }
  return rects;
}
