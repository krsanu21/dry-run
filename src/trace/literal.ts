/**
 * Lenient literal parser for the test-case inputs. Accepts JSON plus the
 * Python/JS literal syntax people paste from LeetCode or notes, and returns
 * strict JSON text:
 *
 *   (1, 2)  -> [1, 2]        {1, 2}  -> [1, 2]       {1: [2]} -> {"1": [2]}
 *   'a'     -> "a"           None / undefined -> null   True -> true
 *   [1, 2,] -> [1, 2]        edges = [...]  -> [...]  (a leading `name =` is dropped)
 *
 * Numbers are copied verbatim so big integers keep their precision.
 */

export type LiteralResult = { ok: true; json: string } | { ok: false; error: string };

class Fail extends Error {
  constructor(
    message: string,
    readonly pos: number,
  ) {
    super(message);
  }
}

const NUMBER = /^[+-]?(?:\d[\d_]*\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)/;
const IDENT = /^[A-Za-z_$][\w$]*/;
const WORDS: Record<string, string> = {
  true: "true",
  True: "true",
  false: "false",
  False: "false",
  null: "null",
  None: "null",
  undefined: "null",
  NaN: "null",
};

class Parser {
  private i = 0;
  constructor(private readonly s: string) {}

  parseTop(): string {
    this.ws();
    // `edges = [...]`, `const x = ...;`
    const m = /^(?:(?:const|let|var)\s+)?[A-Za-z_$][\w$]*\s*(?::[^=]+)?=(?!=)/.exec(this.s.slice(this.i));
    if (m) this.i += m[0].length;
    const out = this.value();
    this.ws();
    if (this.s[this.i] === ";") this.i++;
    this.ws();
    if (this.i < this.s.length) throw new Fail(`unexpected "${this.s[this.i]}"`, this.i);
    return out;
  }

  private ws(): void {
    for (;;) {
      while (this.i < this.s.length && /\s/.test(this.s[this.i] as string)) this.i++;
      if (this.s[this.i] === "#" || (this.s[this.i] === "/" && this.s[this.i + 1] === "/")) {
        while (this.i < this.s.length && this.s[this.i] !== "\n") this.i++;
      } else return;
    }
  }

  private value(): string {
    this.ws();
    const c = this.s[this.i];
    if (c === undefined) throw new Fail("value expected", this.i);
    if (c === "[") return this.seq("]", true);
    if (c === "(") return this.paren();
    if (c === "{") return this.brace();
    if (c === '"' || c === "'" || c === "`") return this.str();
    const rest = this.s.slice(this.i);
    const num = NUMBER.exec(rest);
    if (num) {
      this.i += num[0].length;
      return num[0].replace(/_/g, "").replace(/^\+/, "");
    }
    const id = IDENT.exec(rest);
    if (id) {
      const w = WORDS[id[0]];
      if (w === undefined) throw new Fail(`"${id[0]}" is not a value (use a literal, not a variable or call)`, this.i);
      this.i += id[0].length;
      return w;
    }
    throw new Fail(`unexpected "${c}"`, this.i);
  }

  /** [a, b, c] and set/array bodies; trailing comma allowed. */
  private seq(close: string, consumeOpen: boolean): string {
    if (consumeOpen) this.i++;
    const items: string[] = [];
    for (;;) {
      this.ws();
      if (this.s[this.i] === close) {
        this.i++;
        return `[${items.join(", ")}]`;
      }
      items.push(this.value());
      this.ws();
      if (this.s[this.i] === ",") this.i++;
      else if (this.s[this.i] !== close) throw new Fail(`"," or "${close}" expected`, this.i);
    }
  }

  /** (1, 2) is a tuple, (1,) a one-tuple, (1) just a parenthesised value, () the empty tuple. */
  private paren(): string {
    this.i++;
    const items: string[] = [];
    let comma = false;
    for (;;) {
      this.ws();
      if (this.s[this.i] === ")") {
        this.i++;
        return items.length === 1 && !comma ? (items[0] as string) : `[${items.join(", ")}]`;
      }
      items.push(this.value());
      this.ws();
      if (this.s[this.i] === ",") {
        comma = true;
        this.i++;
      } else if (this.s[this.i] !== ")") throw new Fail('"," or ")" expected', this.i);
    }
  }

  /** {k: v} dict (keys become strings, as JSON requires) or {a, b} set (becomes an array). */
  private brace(): string {
    this.i++;
    this.ws();
    if (this.s[this.i] === "}") {
      this.i++;
      return "{}";
    }
    const first = this.entryKey();
    this.ws();
    if (this.s[this.i] !== ":") {
      // set literal
      const items = [first.json];
      for (;;) {
        this.ws();
        if (this.s[this.i] === ",") this.i++;
        this.ws();
        if (this.s[this.i] === "}") {
          this.i++;
          return `[${items.join(", ")}]`;
        }
        items.push(this.value());
        this.ws();
        if (this.s[this.i] !== "," && this.s[this.i] !== "}") throw new Fail('"," or "}" expected', this.i);
      }
    }
    const entries: string[] = [];
    let key = first;
    for (;;) {
      this.ws();
      if (this.s[this.i] !== ":") throw new Fail('":" expected after key', this.i);
      if (key.composite) throw new Fail("a list or dict cannot be a dict key; use a string", key.start);
      this.i++;
      entries.push(`${JSON.stringify(key.text)}: ${this.value()}`);
      this.ws();
      if (this.s[this.i] === ",") this.i++;
      this.ws();
      if (this.s[this.i] === "}") {
        this.i++;
        return `{${entries.join(", ")}}`;
      }
      if (this.i >= this.s.length) throw new Fail('"}" expected', this.i);
      key = this.entryKey();
    }
  }

  /** A dict key: string, number, bool/None, or a bare JS identifier. Returns its JSON form and its string-key form. */
  private entryKey(): { json: string; text: string; composite: boolean; start: number } {
    this.ws();
    const rest = this.s.slice(this.i);
    const id = IDENT.exec(rest);
    if (id && !(id[0] in WORDS)) {
      // JS-style bare key {a: 1}; only valid when followed by ':'
      const after = rest.slice(id[0].length).trimStart();
      if (after.startsWith(":")) {
        this.i += id[0].length;
        return { json: JSON.stringify(id[0]), text: id[0], composite: false, start: this.i };
      }
    }
    const start = this.i;
    const json = this.value();
    const raw = this.s.slice(start, this.i).trim();
    let text: string;
    if (json.startsWith('"')) text = JSON.parse(json) as string;
    else text = /^(true|false|null)$/.test(json) ? raw : json;
    return { json, text, composite: json.startsWith("[") || json.startsWith("{"), start };
  }

  private str(): string {
    const q = this.s[this.i] as string;
    const start = this.i;
    this.i++;
    let out = "";
    while (this.i < this.s.length && this.s[this.i] !== q) {
      let c = this.s[this.i] as string;
      if (c === "\\") {
        this.i++;
        c = this.s[this.i] ?? "";
        const map: Record<string, string> = { n: "\n", t: "\t", r: "\r", "0": "\0", "\\": "\\", "'": "'", '"': '"', "`": "`" };
        if (c === "u") {
          const hex = this.s.slice(this.i + 1, this.i + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Fail("bad \\u escape", this.i);
          out += String.fromCharCode(parseInt(hex, 16));
          this.i += 5;
          continue;
        }
        out += map[c] ?? `\\${c}`;
      } else out += c;
      this.i++;
    }
    if (this.s[this.i] !== q) throw new Fail("unterminated string", start);
    this.i++;
    return JSON.stringify(out);
  }
}

export function parseLiteral(text: string): LiteralResult {
  if (!text.trim()) return { ok: false, error: "empty" };
  try {
    return { ok: true, json: new Parser(text).parseTop() };
  } catch (e) {
    if (e instanceof Fail) {
      const before = text.slice(0, e.pos);
      const line = before.split("\n").length;
      const col = e.pos - before.lastIndexOf("\n");
      return { ok: false, error: `${e.message} (line ${line}, column ${col})` };
    }
    return { ok: false, error: String(e) };
  }
}

/** Normalised JSON text, or null if the input is not a recognisable literal. */
export function toJson(text: string): string | null {
  const r = parseLiteral(text);
  return r.ok ? r.json : null;
}
