import type { Text } from "@codemirror/state";

/**
 * Line numbers come from recorded traces, analysis and user-edited code, and any of
 * them can name a line that does not exist in the document being shown (0 for
 * "unknown", a line past the end after an edit, NaN from a malformed event).
 * CodeMirror throws on those, and a throw inside a React effect takes the whole app
 * down — so every lookup goes through here.
 */
export function isLineInDoc(n: unknown, lineCount: number): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= lineCount;
}

export function lineAt(doc: Text, n: unknown): ReturnType<Text["line"]> | undefined {
  return isLineInDoc(n, doc.lines) ? doc.line(n) : undefined;
}
