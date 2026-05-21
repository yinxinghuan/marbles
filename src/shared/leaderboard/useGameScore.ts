// Per-game leaderboard hook. Wraps the platform's rank API; binds the
// game's permanent UUID (`@shared/runtime/setGameUuid`) to `session_id`.
//
// No friends-leaderboard, no global-by-game-id query. The new platform only
// supports per-session leaderboards (one board per game UUID).

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  callAigramAPI,
  isInAigram,
  telegramId,
  openAigramPost,
  type AigramResponse,
} from '../runtime/bridge';
import { getGameUuid } from '../runtime/game-id';

// ─── Public shapes ────────────────────────────────────────────────────────

export interface LeaderboardEntry {
  user_id: string;
  name: string;
  avatar_url: string;
  score: number;
  rank: number;
  isMe?: boolean;
}

export interface CurrentUser {
  telegram_id: string;
  name: string;
  head_url: string;
}

// ─── Wire shapes ──────────────────────────────────────────────────────────

interface RankRow {
  id: string;
  game_id: string;
  session_id: string;
  user_id: string;
  score: string; // server returns score as string
  rank: number;
  user_name: string;
  head_url: string;
  create_time: number;
  update_time: number;
}

// ─── Hook ─────────────────────────────────────────────────────────────────

export function useGameScore() {
  const sessionId = getGameUuid();
  // canRank: the platform requires a session_id on every endpoint, and the
  // submit endpoint additionally needs the host to inject the user's token,
  // which only happens when running inside Aigram.
  const canRank = isInAigram && !!sessionId;

  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  const userRef = useRef<CurrentUser | null>(null);

  useEffect(() => {
    if (!isInAigram || !telegramId) return;
    callAigramAPI<AigramResponse<CurrentUser>>(
      `/note/telegram/user/get/info/by/telegram_id?telegram_id=${telegramId}`,
    )
      .then(res => {
        setCurrentUser(res.data);
        userRef.current = res.data;
      })
      .catch(() => {
        /* silent */
      });
  }, []);

  const submitScore = useCallback(
    async (score: number) => {
      if (!canRank || !sessionId || score <= 0) return;
      try {
        await callAigramAPI<AigramResponse<null>>(
          '/note/aigram/ai/game/rank/score/save',
          'POST',
          { session_id: sessionId, score },
        );
      } catch {
        /* silent */
      }
    },
    [canRank, sessionId],
  );

  const fetchLeaderboard = useCallback(async (): Promise<LeaderboardEntry[]> => {
    if (!canRank || !sessionId) return [];
    try {
      const res = await callAigramAPI<AigramResponse<RankRow[]>>(
        `/note/aigram/ai/game/rank/score/list/by/session_id?session_id=${encodeURIComponent(sessionId)}`,
        'GET',
      );
      const rows: RankRow[] = Array.isArray(res?.data) ? res.data : [];
      return rows.map(r => ({
        user_id: String(r.user_id),
        name: r.user_name,
        avatar_url: r.head_url,
        score: Number(r.score),
        rank: r.rank,
        isMe: telegramId != null && String(r.user_id) === telegramId,
      }));
    } catch {
      return [];
    }
  }, [canRank, sessionId]);

  /** Share an image to Aigram chat stream as a post; returns the new post id. */
  const postToAigram = useCallback(
    async (photoUrl: string): Promise<string | null> => {
      if (!isInAigram) throw new Error('not in aigram');
      const res = await callAigramAPI<{ data: string } | string>(
        '/note/telegram/note/add',
        'POST',
        {
          photo_url: photoUrl,
          type: 7,
          telegram_id_list: telegramId ? [telegramId] : [],
          style: 'No Style',
        },
      );
      const postId =
        typeof res === 'string'
          ? res
          : (res as { data: string })?.data ?? null;
      if (postId) openAigramPost(postId);
      return postId;
    },
    [],
  );

  return {
    isInAigram,
    telegramId,
    sessionId,
    canRank,
    currentUser,
    submitScore,
    fetchLeaderboard,
    postToAigram,
  };
}
