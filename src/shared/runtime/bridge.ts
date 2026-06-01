// Aigram runtime bridge — the only file in this workspace that knows how the
// game iframe talks to the Aigram host.
//
// IMPORTANT: do not rewrite or simplify the bodies of `callAigramAPI` /
// `postAigramAPI`. The platform team's skill explicitly forbids it — the
// postMessage envelope (base64 of JSON, request_id, emitter) and the iOS
// WKWebView fallback (window.webkit.messageHandlers.aigram + a per-request
// global callback) are fragile, hand-tuned, and load-bearing. Treat this file
// as copied-from-spec, not invented.

// ─── Context (read once at module load) ──────────────────────────────────

const _params =
  typeof window !== 'undefined'
    ? new URLSearchParams(window.location.search)
    : new URLSearchParams();

const _rawOrigin = _params.get('api_origin');

/** Aigram host origin (URL-decoded). Null when running outside Aigram. */
export const api_origin: string | null = _rawOrigin
  ? decodeURIComponent(_rawOrigin)
  : null;

/** Current player's telegram_id, supplied by Aigram on iframe launch. */
export const telegramId: string | null = _params.get('telegram_id');

/** True when both `api_origin` and `telegram_id` are present. */
export const isInAigram: boolean = !!api_origin && !!telegramId;

// ─── Base64 helpers ───────────────────────────────────────────────────────

function toBase64(str: string): string {
  return btoa(unescape(encodeURIComponent(str)));
}
function fromBase64(str: string): string {
  return decodeURIComponent(escape(atob(str)));
}

// ─── Response envelope types ──────────────────────────────────────────────

interface BridgeResult<T = unknown> {
  request_id: string;
  success: boolean;
  data?: T;
  error?: string;
}

/** Shape of the unwrapped Aigram backend response (after the bridge strips
 *  its own envelope). Most endpoints return retcode=0 + data. */
export interface AigramResponse<T = unknown> {
  retcode: number;
  errcode?: number;
  msg: string;
  data: T;
}

// ─── callAigramAPI — request/response, returns Promise<T> ─────────────────

/**
 * Call an Aigram backend API through the host bridge.
 *
 * Resolves to the response body (the bridge envelope is stripped — you get
 * back the same JSON the platform's HTTP API would have returned).
 *
 * Three execution paths:
 *  - iOS WKWebView: native bridge via `window.webkit.messageHandlers.aigram`
 *    + a global callback function the native code invokes with the result.
 *  - Web iframe / Android WebView: `window.parent.postMessage` round-trip.
 *
 * `method` defaults to GET. `data` is the JSON body for POST.
 */
export function callAigramAPI<T = unknown>(
  url: string,
  method: 'GET' | 'POST' = 'GET',
  data: unknown = null,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    let timer: ReturnType<typeof setTimeout>;
    const payload = toBase64(
      JSON.stringify({
        url,
        method,
        data,
        request_id: requestId,
        emitter: window.location.origin,
      }),
    );

    function handleResult(result: BridgeResult<T>) {
      clearTimeout(timer);
      cleanup();
      if (result.success) resolve(result.data as T);
      else reject(new Error(result.error || 'API error'));
    }

    // iOS WKWebView: native calls this global function with the response JSON.
    const cbKey = '__aigram_cb_' + requestId.replace(/-/g, '_');
    (window as any)[cbKey] = function (resultJson: string) {
      try {
        const result = JSON.parse(resultJson) as BridgeResult<T>;
        if (result.request_id !== requestId) return;
        handleResult(result);
      } catch {
        /* ignore — malformed payload, let the timeout fire */
      }
    };

    // Web iframe / Android WebView: listen for postMessage response.
    function handler(event: MessageEvent) {
      if (api_origin && event.origin !== api_origin) return;
      const msg = typeof event.data === 'string' ? event.data : '';
      if (!msg.startsWith('callAPIResult-')) return;
      try {
        const result = JSON.parse(
          fromBase64(msg.slice('callAPIResult-'.length)),
        ) as BridgeResult<T>;
        if (result.request_id !== requestId) return;
        handleResult(result);
      } catch {
        /* ignore */
      }
    }
    window.addEventListener('message', handler);

    function cleanup() {
      window.removeEventListener('message', handler);
      try {
        delete (window as any)[cbKey];
      } catch {
        (window as any)[cbKey] = undefined;
      }
    }

    timer = setTimeout(function () {
      cleanup();
      reject(new Error('timeout'));
    }, 10_000);

    // Send: iOS WKWebView first, fallback to postMessage.
    const w = window as any;
    if (
      w.webkit &&
      w.webkit.messageHandlers &&
      w.webkit.messageHandlers.aigram
    ) {
      w.webkit.messageHandlers.aigram.postMessage('callAPI-' + payload);
    } else {
      window.parent.postMessage('callAPI-' + payload, api_origin || '*');
    }
  });
}

// ─── postAigramAPI — fire-and-forget ──────────────────────────────────────

/**
 * Fire-and-forget variant. Use for event reports (`/record/play`) and saves
 * (`/save/data`) where the caller does not need the response.
 *
 * Same dual path as `callAigramAPI`, just without the listener / promise.
 */
export function postAigramAPI(url: string, data: unknown): void {
  const payload = toBase64(
    JSON.stringify({
      url,
      method: 'post',
      data,
      request_id: crypto.randomUUID(),
      emitter: window.location.origin,
    }),
  );
  const w = window as any;
  if (
    w.webkit &&
    w.webkit.messageHandlers &&
    w.webkit.messageHandlers.aigram
  ) {
    w.webkit.messageHandlers.aigram.postMessage('callAPI-' + payload);
  } else {
    window.parent.postMessage('callAPI-' + payload, api_origin || '*');
  }
}

// ─── System UI calls (AW.* protocol) ──────────────────────────────────────

// Dual-path sender for AW.* messages. Mirrors callAigramAPI's transport:
// iOS WKWebView native bridge first, web iframe / Android WebView fallback.
// The native side must register a handler for the AW.* prefix on its
// `aigram` script-message handler (same handler that receives `callAPI-`).
function sendAWMessage(msg: string): void {
  const w = window as any;
  try {
    if (w.webkit?.messageHandlers?.aigram) {
      w.webkit.messageHandlers.aigram.postMessage(msg);
      return;
    }
    if (api_origin) {
      window.parent.postMessage(msg, new URL(api_origin).origin);
    }
  } catch {
    /* ignore */
  }
}

/** Open a user's Aigram profile. */
export function openAigramProfile(userId: string): void {
  if (!userId) return;
  const encoded = btoa(JSON.stringify({ id: userId }));
  sendAWMessage(`AW.PROFILE.OPEN-${encoded}`);
}

/** Open a post by id. */
export function openAigramPost(postId: string): void {
  if (!postId) return;
  const encoded = btoa(JSON.stringify({ post_id: postId }));
  sendAWMessage(`AW.POST.OPEN-${encoded}`);
}
