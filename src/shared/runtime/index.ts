// Aigram runtime — single entry point for game code.
//
// Examples:
//   import {
//     setGameUuid, useGameScore, useGameSave, useGenImage, useUpload,
//   } from '@shared/runtime';

// Bridge primitives (rarely needed directly by games)
export {
  callAigramAPI,
  postAigramAPI,
  openAigramProfile,
  openAigramPost,
  api_origin,
  telegramId,
  isInAigram,
} from './bridge';
export type { AigramResponse } from './bridge';

// Game UUID resolution
export { setGameUuid, getGameUuid } from './game-id';

// Runtime service hooks
export { useGenImage } from './useGenImage';
export type { GenImageOptions, UseGenImage } from './useGenImage';

export { useUpload } from './useUpload';
export type { UploadResult, UseUpload } from './useUpload';

export { useChat } from './useChat';
export type { ChatMessage, ChatRole, UseChatOptions, UseChat } from './useChat';

// Event reporting + stats
export { useGameEvent } from './useGameEvent';
export type { UseGameEvent } from './useGameEvent';

export { useGameStats } from './useGameStats';
export type { PlayStats, UseGameStats } from './useGameStats';
