/** Simple LCS-based line diff, returns unified diff text or undefined if too large. */
export function formatTextDiff(
  oldStr: string,
  newStr: string,
  maxLines = 30,
): string | undefined {
  const oldLines = oldStr.split("\n");
  const newLines = newStr.split("\n");
  const m = oldLines.length;
  const n = newLines.length;

  // Skip diffing if input is too large
  if (m + n > 500) return undefined;

  // LCS table
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    Array(n + 1).fill(0),
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        oldLines[i - 1] === newLines[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  // Backtrack to get changes
  const changes: { type: "ctx" | "add" | "del"; text: string }[] = [];
  let i = m,
    j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      changes.unshift({ type: "ctx", text: oldLines[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      changes.unshift({ type: "add", text: newLines[j - 1] });
      j--;
    } else {
      changes.unshift({ type: "del", text: oldLines[i - 1] });
      i--;
    }
  }

  // Compact: only show changed lines with up to 2 lines of context
  const CTX = 2;
  const shown = new Set<number>();
  for (let k = 0; k < changes.length; k++) {
    if (changes[k].type !== "ctx") {
      for (
        let c = Math.max(0, k - CTX);
        c <= Math.min(changes.length - 1, k + CTX);
        c++
      ) {
        shown.add(c);
      }
    }
  }

  const lines: string[] = [];
  let lastShown = -1;
  for (const k of shown) {
    if (lastShown >= 0 && k > lastShown + 1) lines.push("  ...");
    const ch = changes[k];
    const prefix = ch.type === "add" ? "+" : ch.type === "del" ? "-" : " ";
    lines.push(`${prefix} ${ch.text}`);
    lastShown = k;
  }

  if (lines.length === 0 || lines.length > maxLines) return undefined;
  return lines.join("\n");
}
