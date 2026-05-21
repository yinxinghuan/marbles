// Each game's permanent UUID (matches the `uuid` field in games.json) is
// used as `session_id` by every Aigram runtime endpoint that scopes data
// per-game (rank, save, event/stats). It must be the same UUID across
// every install of the same game — it is the global identity of the game
// for the platform.
//
// PHASE 2 will pick exactly one injection mechanism (per-game source file
// vs. Vite define vs. <meta>). Until then this module resolves from any
// of the three, in priority order:
//
//   1. `setGameUuid(...)` called once at app boot (preferred for the
//      per-game-file route — each game's main.tsx does:
//        import { setGameUuid } from '@shared/runtime';
//        setGameUuid('1243f25d-9955-4068-9587-652d5f707eae');
//
//   2. `window.__GAME_UUID__` (preferred for the Vite-define route — set
//      it via `define` in vite.config.ts).
//
//   3. `<meta name="game-uuid" content="...">` in the HTML head (fallback
//      for vanilla-HTML games like agent-string).
//
// Returns `null` if none of those have been set. Callers should gate
// session-scoped behavior (`canRank`, `canSync`) on a non-null UUID.

declare global {
  interface Window {
    __GAME_UUID__?: string;
  }
}

let _explicit: string | null = null;

/**
 * Set this game's UUID at app boot. Idempotent — calling with the same
 * value is a no-op. Calling with a different value logs a warning and
 * keeps the first one (the UUID should never change at runtime).
 */
export function setGameUuid(uuid: string): void {
  if (!uuid) return;
  if (_explicit && _explicit !== uuid) {
    console.warn(
      `[shared/runtime] setGameUuid called with a different uuid (had ${_explicit}, ignoring ${uuid})`,
    );
    return;
  }
  _explicit = uuid;
}

/** Read the resolved UUID, or null if none of the sources are populated. */
export function getGameUuid(): string | null {
  if (_explicit) return _explicit;
  if (typeof window !== 'undefined') {
    if (window.__GAME_UUID__) return window.__GAME_UUID__;
    if (typeof document !== 'undefined') {
      const meta = document.querySelector('meta[name="game-uuid"]');
      const v = meta?.getAttribute('content');
      if (v) return v;
    }
  }
  return null;
}
