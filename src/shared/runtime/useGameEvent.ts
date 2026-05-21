// Game event reporting — POST /note/aigram/ai/game/record/play through the
// fire-and-forget bridge. Each call records one event occurrence; optional
// `config_json` can attach actions (notify) and stat_conditions for the
// platform's backend to fan out into Aigram notifications / threshold
// triggers.

import { useCallback } from 'react';
import { postAigramAPI, isInAigram } from './bridge';
import { getGameUuid } from './game-id';

export interface UseGameEvent {
  /** Report an event. `configJson` is optional; pass an object and it will
   *  be JSON.stringified for you, or pass a pre-stringified string. */
  trigger: (event: string, configJson?: object | string) => void;
  /** Whether the bridge has a session_id wired and we're in Aigram. */
  canEmit: boolean;
}

export function useGameEvent(): UseGameEvent {
  const sessionId = getGameUuid();
  const canEmit = isInAigram && !!sessionId;

  const trigger = useCallback(
    (event: string, configJson?: object | string) => {
      if (!canEmit || !sessionId || !event) return;
      const body: { session_id: string; event: string; config_json?: string } = {
        session_id: sessionId,
        event,
      };
      if (configJson != null) {
        body.config_json =
          typeof configJson === 'string'
            ? configJson
            : JSON.stringify(configJson);
      }
      postAigramAPI('/note/aigram/ai/game/record/play', body);
    },
    [canEmit, sessionId],
  );

  return { trigger, canEmit };
}
