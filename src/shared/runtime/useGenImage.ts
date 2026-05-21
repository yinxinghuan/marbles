// Runtime image generation — txt2img / img2img through the platform's HTTPS
// proxy at https://chat.aiwaves.tech/aigram/api/gen-image.
//
// Direct fetch, not the postMessage bridge — this endpoint is anonymous and
// the platform team explicitly wants game frontends to call it directly.
//
// Wall-clock cost is ~200s per image; allow generous UI timeouts.

import { useCallback, useState } from 'react';

const GEN_IMAGE_URL = 'https://chat.aiwaves.tech/aigram/api/gen-image';

export interface GenImageOptions {
  /** Required. Prompt text. */
  prompt: string;
  /** Optional. Public HTTPS URL of a reference image. When set, this is an
   *  img2img call and the output aspect ratio will match the ref's. */
  ref_url?: string;
}

export interface UseGenImage {
  generate: (opts: GenImageOptions) => Promise<string>;
  loading: boolean;
  error: Error | null;
  lastUrl: string | null;
}

export function useGenImage(): UseGenImage {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [lastUrl, setLastUrl] = useState<string | null>(null);

  const generate = useCallback(async (opts: GenImageOptions): Promise<string> => {
    if (!opts.prompt) throw new Error('gen-image: prompt is required');
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(GEN_IMAGE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(opts),
      });
      if (!res.ok) {
        throw new Error(`gen-image failed: HTTP ${res.status}`);
      }
      const json = (await res.json()) as { url?: string };
      if (!json.url) {
        throw new Error('gen-image response had no url');
      }
      setLastUrl(json.url);
      return json.url;
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      setError(err);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  return { generate, loading, error, lastUrl };
}
