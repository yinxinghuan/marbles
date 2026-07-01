import { type CSSProperties, useEffect, useState } from 'react';
import { openAigramProfile } from '../runtime/bridge';
import type { LeaderboardEntry } from './useGameScore';
import './Leaderboard.less';

// ─── Built-in i18n (no dependency on game's i18n) ────────────────────────

const STRINGS = {
  zh: {
    title: '排行榜',
    me: '我',
    empty: '暂无记录，快来第一个上榜！',
    openInAlterU: '在 AlterU 中打开即可查看排行榜',
    downloadAlterU: '下载 AlterU',
  },
  en: {
    title: 'Leaderboard',
    me: 'me',
    empty: 'No records yet. Be the first!',
    openInAlterU: 'Open in AlterU to view the leaderboard.',
    downloadAlterU: 'Get AlterU on the App Store',
  },
} as const;

function detectLang(): 'zh' | 'en' {
  try {
    const override = localStorage.getItem('game_locale');
    if (override === 'zh' || override === 'en') return override;
  } catch { /* ignore */ }
  return navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

const s = STRINGS[detectLang()];

// ─── Sub-components ───────────────────────────────────────────────────────

function Avatar({ url, name, size = 40 }: { url: string; name: string; size?: number }) {
  return (
    <div className="lb-avatar" style={{ width: size, height: size, fontSize: size * 0.38 }}>
      {url
        ? <img src={url} alt={name} draggable={false} />
        : <span>{name.charAt(0).toUpperCase()}</span>
      }
    </div>
  );
}

// ─── Props ────────────────────────────────────────────────────────────────

interface Props {
  gameName: string;
  isInAigram: boolean;
  onClose: () => void;
  fetch: () => Promise<LeaderboardEntry[]>;
}

const MEDALS = ['🥇', '🥈', '🥉'];
const MEDAL_COLORS = ['#FFD700', '#C0C0C0', '#CD7F32'];
const ALTERU_APP_URL = 'https://apps.apple.com/app/id6769646546';

// ─── Component ────────────────────────────────────────────────────────────

export default function Leaderboard({ gameName, isInAigram, onClose, fetch }: Props) {
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!isInAigram) {
      setEntries([]);
      setLoading(false);
      return;
    }

    let alive = true;
    setLoading(true);
    fetch()
      .then(data => { if (alive) setEntries(data); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [fetch, isInAigram]);

  return (
    <div className="lb-backdrop" onPointerDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="lb-panel">

        {/* Header */}
        <div className="lb-header">
          <div className="lb-header__left">
            <span className="lb-header__icon">🏆</span>
            <div>
              <div className="lb-header__title">{s.title}</div>
              <div className="lb-header__game">{gameName}</div>
            </div>
          </div>
          <button className="lb-close" onPointerDown={onClose}>✕</button>
        </div>

        {/* List */}
        <div className="lb-body">
          {loading && (
            <div className="lb-state">
              <span className="lb-spinner" />
            </div>
          )}

          {!loading && !isInAigram && (
            <div className="lb-state lb-state--download">
              <span className="lb-state__icon">🏆</span>
              <span className="lb-state__text">{s.openInAlterU}</span>
              <a
                className="lb-state__download"
                href={ALTERU_APP_URL}
                target="_blank"
                rel="noopener noreferrer"
              >
                {s.downloadAlterU}
              </a>
            </div>
          )}

          {!loading && isInAigram && entries.length === 0 && (
            <div className="lb-state">
              <span className="lb-state__icon">🎮</span>
              <span className="lb-state__text">{s.empty}</span>
            </div>
          )}

          {!loading && isInAigram && entries.map((entry, i) => (
            <div
              key={entry.user_id}
              className={`lb-row ${entry.isMe ? 'lb-row--me' : ''} ${i < 3 ? 'lb-row--top' : ''} ${isInAigram ? 'lb-row--clickable' : ''}`}
              style={i < 3 ? { '--medal-color': MEDAL_COLORS[i] } as CSSProperties : undefined}
              onClick={isInAigram ? () => openAigramProfile(entry.user_id) : undefined}
            >
              <div className="lb-row__rank">
                {i < 3
                  ? <span className="lb-row__medal">{MEDALS[i]}</span>
                  : <span className="lb-row__num">{i + 1}</span>
                }
              </div>

              <Avatar url={entry.avatar_url} name={entry.name} size={i < 3 ? 44 : 38} />

              <div className="lb-row__info">
                <span className="lb-row__name">{entry.name}</span>
                {entry.isMe && <span className="lb-row__me">{s.me}</span>}
              </div>

              <span className="lb-row__score">{entry.score.toLocaleString()}</span>
            </div>
          ))}
        </div>

      </div>
    </div>
  );
}
