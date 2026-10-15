/**
 * Shareable URLs. The workspace (source + test cases) is JSON-encoded,
 * compressed with the browser's built-in deflate-raw CompressionStream and
 * stored in the URL *fragment* (`#share=…`). Fragments are not sent to the
 * server in HTTP requests. Opening a link never runs code automatically.
 */
import type { ArgConversion, Language } from "../trace/schema";

export interface SharePayload {
  v: 1;
  language: Language;
  source: string;
  /** what Run runs: "" = decided from the code, "<file>", or a function's qualname */
  target: string;
  title: string;
  tests: { args: string[]; expected: string }[];
  conversions: ArgConversion[];
  stdin: string;
}

/** Conservative limit that works across browsers and chat/email clients. */
export const MAX_URL_LENGTH = 8000;

function toBase64Url(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i] as number);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

export async function encodeShare(p: SharePayload): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(p));
  if (typeof CompressionStream !== "undefined") {
    const z = await pipe(json, new CompressionStream("deflate-raw"));
    return `z.${toBase64Url(z)}`;
  }
  return `j.${toBase64Url(json)}`;
}

export class ShareDecodeError extends Error {}

const LANGS = new Set(["python", "javascript"]);

export function validatePayload(x: unknown): SharePayload {
  if (!x || typeof x !== "object") throw new ShareDecodeError("payload is not an object");
  const p = x as Record<string, unknown>;
  if (p.v !== 1) throw new ShareDecodeError("unsupported share version");
  if (typeof p.language !== "string" || !LANGS.has(p.language)) throw new ShareDecodeError("unknown language");
  if (typeof p.source !== "string" || p.source.length > 200_000) throw new ShareDecodeError("missing or oversized source");
  // links made before multiple cases were shared carry a single `test`
  const raw = Array.isArray(p.tests) ? (p.tests as unknown[]) : [p.test];
  const tests = raw.slice(0, 50).map((x) => {
    const c = x as Record<string, unknown> | undefined;
    if (!c || !Array.isArray(c.args) || !c.args.every((a) => typeof a === "string")) throw new ShareDecodeError("invalid test case");
    return { args: c.args as string[], expected: typeof c.expected === "string" ? c.expected : "" };
  });
  if (!tests.length) throw new ShareDecodeError("invalid test case");
  const t = (p.test ?? {}) as Record<string, unknown>;
  const convs = Array.isArray(p.conversions) ? p.conversions : Array.isArray(t.conversions) ? t.conversions : [];
  // links made before run targets existed carry a `mode` (+ `entry`) instead
  const target = typeof p.target === "string" ? p.target : p.mode === "script" ? "<file>" : p.mode === "function" && typeof p.entry === "string" ? p.entry : "";
  return {
    v: 1,
    language: p.language as Language,
    source: p.source,
    target,
    title: typeof p.title === "string" ? p.title.slice(0, 120) : "Shared solution",
    tests,
    conversions: convs.filter((c): c is ArgConversion => ["auto", "raw", "linked-list", "binary-tree"].includes(String(c))),
    stdin: typeof p.stdin === "string" ? p.stdin : typeof t.stdin === "string" ? t.stdin : "",
  };
}

export async function decodeShare(token: string): Promise<SharePayload> {
  try {
    const [kind, data] = [token.slice(0, 2), token.slice(2)];
    let bytes = fromBase64Url(data);
    if (kind === "z.") bytes = await pipe(bytes, new DecompressionStream("deflate-raw"));
    else if (kind !== "j.") throw new ShareDecodeError("unrecognized share format");
    return validatePayload(JSON.parse(new TextDecoder().decode(bytes)));
  } catch (e) {
    if (e instanceof ShareDecodeError) throw e;
    throw new ShareDecodeError("the link is malformed or truncated");
  }
}

export function shareTokenFromHash(hash: string): string | null {
  const m = /[#&]share=([^&]+)/.exec(hash);
  return m ? (m[1] as string) : null;
}
