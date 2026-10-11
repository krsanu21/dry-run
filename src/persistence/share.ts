/**
 * Shareable URLs. The workspace (source + one test case) is JSON-encoded,
 * compressed with the browser's built-in deflate-raw CompressionStream and
 * stored in the URL *fragment* (`#share=…`). Fragments are not sent to the
 * server in HTTP requests. Opening a link never runs code automatically.
 */
import type { ArgConversion, Language, RunMode } from "../trace/schema";

export interface SharePayload {
  v: 1;
  language: Language;
  source: string;
  mode: RunMode;
  entry: string;
  title: string;
  test: { name: string; args: string[]; expected: string; conversions: ArgConversion[]; stdin: string };
  fragment?: { initialState: string; setup: string; startLine: number; endLine: number };
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
const MODES = new Set(["function", "script", "fragment"]);

export function validatePayload(x: unknown): SharePayload {
  if (!x || typeof x !== "object") throw new ShareDecodeError("payload is not an object");
  const p = x as Record<string, unknown>;
  if (p.v !== 1) throw new ShareDecodeError("unsupported share version");
  if (typeof p.language !== "string" || !LANGS.has(p.language)) throw new ShareDecodeError("unknown language");
  if (typeof p.source !== "string" || p.source.length > 200_000) throw new ShareDecodeError("missing or oversized source");
  if (typeof p.mode !== "string" || !MODES.has(p.mode)) throw new ShareDecodeError("unknown mode");
  const t = p.test as Record<string, unknown> | undefined;
  if (!t || !Array.isArray(t.args) || !t.args.every((a) => typeof a === "string")) throw new ShareDecodeError("invalid test case");
  const conversions = Array.isArray(t.conversions) ? t.conversions.filter((c): c is ArgConversion => ["auto", "raw", "linked-list", "binary-tree"].includes(String(c))) : [];
  const frag = p.fragment as Record<string, unknown> | undefined;
  return {
    v: 1,
    language: p.language as Language,
    source: p.source,
    mode: p.mode as RunMode,
    entry: typeof p.entry === "string" ? p.entry : "",
    title: typeof p.title === "string" ? p.title.slice(0, 120) : "Shared solution",
    test: {
      name: typeof t.name === "string" ? t.name.slice(0, 80) : "Shared case",
      args: t.args as string[],
      expected: typeof t.expected === "string" ? t.expected : "",
      conversions,
      stdin: typeof t.stdin === "string" ? t.stdin : "",
    },
    ...(frag && typeof frag.initialState === "string"
      ? {
          fragment: {
            initialState: frag.initialState,
            setup: typeof frag.setup === "string" ? frag.setup : "",
            startLine: Number(frag.startLine) || 1,
            endLine: Number(frag.endLine) || 1,
          },
        }
      : {}),
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
