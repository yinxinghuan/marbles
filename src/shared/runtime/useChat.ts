// Runtime LLM chat — OpenAI-format messages POST to
// https://chat.aiwaves.tech/aigram/api/game-chat. Direct fetch.
//
// Server is stateless. History is maintained on the client and re-sent every
// call. The hook auto-truncates to `maxHistory` most recent turns to keep
// payload bounded.

import { useCallback, useRef, useState } from 'react';

const CHAT_URL = 'https://chat.aiwaves.tech/aigram/api/game-chat';

export type ChatRole = 'system' | 'user' | 'assistant';
export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface UseChatOptions {
  /** System prompt; defines the NPC persona. Prepended to every request. */
  system?: string;
  /** How many past user+assistant turns to retain. Defaults to 20. */
  maxHistory?: number;
}

export interface UseChat {
  send: (text: string) => Promise<string>;
  reset: () => void;
  history: ChatMessage[];
  sending: boolean;
  error: Error | null;
}

export function useChat(opts: UseChatOptions = {}): UseChat {
  const { system, maxHistory = 20 } = opts;
  const [history, setHistory] = useState<ChatMessage[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const inFlight = useRef(false);

  const send = useCallback(
    async (text: string): Promise<string> => {
      if (inFlight.current) {
        throw new Error('chat: previous send is still in flight');
      }
      if (!text) throw new Error('chat: text is required');
      inFlight.current = true;
      setSending(true);
      setError(null);

      const userMsg: ChatMessage = { role: 'user', content: text };
      // Build messages: system + truncated history + new user turn
      const msgs: ChatMessage[] = [];
      if (system) msgs.push({ role: 'system', content: system });
      msgs.push(...history.slice(-maxHistory), userMsg);

      try {
        const res = await fetch(CHAT_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: msgs }),
        });
        if (!res.ok) throw new Error(`chat failed: HTTP ${res.status}`);
        const json = (await res.json()) as {
          choices?: Array<{ message?: ChatMessage }>;
        };
        const reply = json.choices?.[0]?.message?.content ?? '';
        setHistory(h => [...h, userMsg, { role: 'assistant', content: reply }]);
        return reply;
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        setError(err);
        throw err;
      } finally {
        inFlight.current = false;
        setSending(false);
      }
    },
    [system, maxHistory, history],
  );

  const reset = useCallback(() => {
    setHistory([]);
    setError(null);
  }, []);

  return { send, reset, history, sending, error };
}
