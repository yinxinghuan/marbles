// Game stats reader — GET /note/aigram/ai/game/get/play/stats. Returns
// daily/total counts plus current-user continuous streak for a given event.
//
// PLATFORM RULE: do not accumulate locally. Re-fetch after every trigger.

import { useCallback, useEffect, useState } from 'react';
import { callAigramAPI, isInAigram, type AigramResponse } from './bridge';
import { getGameUuid } from './game-id';

export interface PlayStats {
  day_click_count: number;
  day_user_count: number;
  total_click_count: number;
  total_user_count: number;
  continuous_days: number;
}

const EMPTY: PlayStats = {
  day_click_count: 0,
  day_user_count: 0,
  total_click_count: 0,
  total_user_count: 0,
  continuous_days: 0,
};

export interface UseGameStats {
  stats: PlayStats;
  loading: boolean;
  refresh: () => Promise<void>;
}

/**
 * Subscribe to the platform-side aggregate stats for a single event.
 * Auto-fetches once on mount and whenever `event` changes; callers should
 * also `refresh()` after each `useGameEvent().trigger(event)` to pick up the
 * new counts.
 */
export function useGameStats(event: string): UseGameStats {
  const sessionId = getGameUuid();
  const enabled = isInAigram && !!sessionId && !!event;

  const [stats, setStats] = useState<PlayStats>(EMPTY);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!enabled || !sessionId) {
      setStats(EMPTY);
      return;
    }
    setLoading(true);
    try {
      const res = await callAigramAPI<AigramResponse<PlayStats>>(
        `/note/aigram/ai/game/get/play/stats?session_id=${encodeURIComponent(sessionId)}&event=${encodeURIComponent(event)}`,
        'GET',
      );
      setStats(res?.data ?? EMPTY);
    } catch {
      setStats(EMPTY);
    } finally {
      setLoading(false);
    }
  }, [enabled, sessionId, event]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { stats, loading, refresh };
}
