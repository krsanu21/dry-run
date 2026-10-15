import { parseLiteral } from "./literal";

/**
 * Test cases from LeetCode-style text:
 *
 *   nums = [2,7,11,15], target = 9                 one case, named arguments
 *   Input: nums = [3,2,4], target = 6              …with an expected value
 *   Output: [1,2]
 *   [2,7,11,15]                                    LeetCode's one-value-per-line format
 *   9
 *
 * Several `Input:` blocks give several cases. Names are matched to parameters; values
 * without a name fill the remaining parameters in order.
 */

export interface ParsedCase {
  args: string[];
  expected: string;
}

export interface ParseResult {
  cases: ParsedCase[];
  /** what could not be used, in plain words */
  problems: string[];
}

/** Splits at top-level separators (outside brackets and strings). */
function splitTopLevel(text: string, seps: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (quote) {
      cur += c;
      if (c === "\\") cur += text[++i] ?? "";
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if ("[({".includes(c)) depth++;
    else if ("])}".includes(c)) depth--;
    else if (depth === 0 && seps.includes(c)) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

const NAMED = /^([A-Za-z_$][\w$]*)\s*=(?!=)\s*([\s\S]+)$/;

function parseInput(text: string, params: readonly string[], label: string, problems: string[]): string[] | null {
  const args: string[] = new Array<string>(params.length).fill("");
  const positional: string[] = [];
  for (const piece of splitTopLevel(text, ",\n")) {
    const m = NAMED.exec(piece);
    if (m) {
      const i = params.indexOf(m[1] as string);
      if (i < 0) {
        problems.push(`${label}found "${piece.length > 40 ? `${piece.slice(0, 40)}…` : piece}" but there is no parameter called ${m[1]}`);
        continue;
      }
      args[i] = (m[2] as string).trim();
    } else positional.push(piece);
  }
  for (const v of positional) {
    const i = args.findIndex((a) => a === "");
    if (i < 0) {
      problems.push(`${label}more values than parameters (${params.length}); "${v.slice(0, 30)}" was not used`);
      break;
    }
    args[i] = v;
  }
  args.forEach((a, i) => {
    if (a && !parseLiteral(a).ok) problems.push(`${label}${params[i]}: ${(parseLiteral(a) as { error: string }).error}`);
  });
  return args.some((a) => a !== "") ? args : null;
}

/** Text pasted by the user, or taken from the problem statement. */
export function parseExamples(text: string, params: readonly string[]): ParseResult {
  const problems: string[] = [];
  const cases: ParsedCase[] = [];
  const src = text.replace(/\r/g, "");
  const blocks = /\binput\s*:/i.test(src) ? src.split(/\binput\s*:/i).slice(1) : [src];
  blocks.forEach((block, k) => {
    const label = blocks.length > 1 ? `Example ${k + 1}: ` : "";
    // the input ends where the output / explanation / next example starts
    const outAt = block.search(/\boutput\s*:/i);
    const endAt = block.search(/\b(explanation|example\s*\d*|constraints)\s*:?/i);
    const inputText = block.slice(0, [outAt, endAt].filter((x) => x >= 0).reduce((a, b) => Math.min(a, b), block.length));
    let expected = "";
    if (outAt >= 0) {
      const rest = block.slice(outAt).replace(/^\s*output\s*:\s*/i, "");
      expected = (rest.split("\n")[0] ?? "").trim();
    }
    const args = parseInput(inputText, params, label, problems);
    if (args) cases.push({ args, expected });
  });
  if (!cases.length && !problems.length) problems.push("No values found. Paste something like: nums = [2,7,11,15], target = 9");
  return { cases, problems };
}

/**
 * Examples written in the code itself — a problem statement pasted as a comment or docstring.
 * Only `Input:` blocks count, so ordinary code is never mistaken for an example.
 */
export function examplesInSource(source: string, params: readonly string[]): ParsedCase[] {
  if (!params.length || !/\binput\s*:/i.test(source)) return [];
  const text = source
    .split("\n")
    .map((l) => l.replace(/^\s*(#+|\/\/+|\/?\*+\/?|"""|''')\s?/, "").replace(/("""|'''|\*\/)\s*$/, ""))
    .join("\n");
  return parseExamples(text, params).cases.filter((c) => c.args.every((a) => a !== ""));
}
