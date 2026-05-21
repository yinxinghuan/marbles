// Type declarations for @shared alias — Vite resolves the actual files,
// tsc uses these inline types for type checking.

declare module '@shared/leaderboard' {
  import type { FC } from 'react';

  export interface LeaderboardEntry {
    user_id: string;
    name: string;
    avatar_url: string;
    score: number;
    rank: number;
    isMe?: boolean;
  }

  interface LeaderboardProps {
    gameName: string;
    isInAigram: boolean;
    onClose: () => void;
    fetch: () => Promise<LeaderboardEntry[]>;
  }

  export const Leaderboard: FC<LeaderboardProps>;

  interface CurrentUser {
    telegram_id: string;
    name: string;
    head_url: string;
  }

  interface GameScoreResult {
    isInAigram: boolean;
    telegramId: string | null;
    sessionId: string | null;
    canRank: boolean;
    currentUser: CurrentUser | null;
    submitScore: (score: number) => Promise<void>;
    fetchLeaderboard: () => Promise<LeaderboardEntry[]>;
    postToAigram: (photoUrl: string) => Promise<string | null>;
  }

  export function useGameScore(): GameScoreResult;
}
