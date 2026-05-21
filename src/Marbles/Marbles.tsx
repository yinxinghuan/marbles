import { useEffect, useRef, useState } from 'react';
import { useGameScore, Leaderboard } from '@shared/leaderboard';
import './Marbles.less';

// ── Aesthetic palette: 6 distinct hues so same-color merge is unambiguous ──
// Each spans the color wheel (red / yellow / green / blue / pink / cream)
// while keeping the muted Morandi vibe — saturated enough to pair-spot.
interface ColorEntry { hex: string }
const PALETTE: ColorEntry[] = [
  { hex: '#C44E3D' }, // terracotta red
  { hex: '#D4A857' }, // mustard yellow
  { hex: '#6E9070' }, // sage green
  { hex: '#5B7593' }, // slate blue
  { hex: '#C18A9A' }, // dusty rose
  { hex: '#E8D4B5' }, // ivory cream
];
function pickColor(): string {
  return PALETTE[Math.floor(Math.random() * PALETTE.length)].hex;
}

// ── Physics constants ──────────────────────────────────────────────────────
const GRAVITY_BASE = 0.42;        // px/frame²
const AIR_DAMP = 0.9985;
const FLOOR_REST = 0.62;          // bounce energy retained on floor
const WALL_REST = 0.74;
const BALL_REST = 0.78;           // ball-ball
const COLL_DAMP = 0.985;
const MIN_R = 13;
const MAX_R = 30;
const MAX_BALLS = 140;            // soft cap — oldest fade out beyond

interface Ball {
  id: number;
  x: number; y: number;
  vx: number; vy: number;
  r: number;
  color: string;
  born: number;                   // ms
  fading: number;                 // 0..1 → 0 means fading to gone
  bornGlow: number;               // 0..1, freshly merged balls glow briefly
}

interface BurstParticle {
  x: number; y: number;
  vx: number; vy: number;
  r: number;
  color: string;
  life: number;                   // 0..1, 0 = dead
}

const BURST_RADIUS = 68;          // merged ball larger than this → burst

// ── Top tray layout (single source of truth — canvas + DOM share this) ────
const HOLE_DIA = 52;              // recessed sockets: bigger touch target
const HOLE_GAP = 6;
const SHAKE_GAP = 10;             // extra space between last hole and shake dome
const TRAY_TOP_Y = 18;
function trayLayout(canvasW: number) {
  const total = PALETTE.length * HOLE_DIA + (PALETTE.length - 1) * HOLE_GAP + SHAKE_GAP + HOLE_DIA;
  const startX = (canvasW - total) / 2;
  const holes = PALETTE.map((c, i) => ({
    color: c.hex,
    cx: startX + HOLE_DIA / 2 + i * (HOLE_DIA + HOLE_GAP),
    cy: TRAY_TOP_Y + HOLE_DIA / 2,
  }));
  const shakeCx = startX + PALETTE.length * (HOLE_DIA + HOLE_GAP) + (SHAKE_GAP - HOLE_GAP) + HOLE_DIA / 2;
  return { startX, total, holes, shakeCx, shakeCy: TRAY_TOP_Y + HOLE_DIA / 2 };
}

// ── Hex parsing helper ────────────────────────────────────────────────────
function shadeHex(hex: string, amount: number): string {
  const c = parseInt(hex.slice(1), 16);
  const r = Math.max(0, Math.min(255, Math.round(((c >> 16) & 0xff) * amount)));
  const g = Math.max(0, Math.min(255, Math.round(((c >> 8) & 0xff) * amount)));
  const b = Math.max(0, Math.min(255, Math.round((c & 0xff) * amount)));
  return `rgb(${r}, ${g}, ${b})`;
}

// ── Pegs (chime obstacles) — each tuned to a C-major pentatonic note ─────
// Position is % of canvas; radius in px. Notes descend top → bottom for a
// "raindrops-on-windchime" cascade as balls fall through.
interface PegDef { xPct: number; yPct: number; r: number; freq: number }
const PEGS: PegDef[] = [
  { xPct: 22, yPct: 24, r: 9, freq: 880.00 }, // A5  ── top row (under tray)
  { xPct: 76, yPct: 21, r: 8, freq: 783.99 }, // G5
  { xPct: 50, yPct: 32, r: 9, freq: 659.25 }, // E5
  { xPct: 14, yPct: 40, r: 8, freq: 587.33 }, // D5
  { xPct: 88, yPct: 38, r: 8, freq: 523.25 }, // C5
  { xPct: 36, yPct: 48, r: 9, freq: 440.00 }, // A4
  { xPct: 64, yPct: 50, r: 9, freq: 392.00 }, // G4
  { xPct: 24, yPct: 60, r: 8, freq: 329.63 }, // E4
  { xPct: 78, yPct: 64, r: 8, freq: 293.66 }, // D4
  { xPct: 50, yPct: 68, r: 9, freq: 261.63 }, // C4  ── lowest, bottom row
];

export default function Marbles() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ballsRef = useRef<Ball[]>([]);
  const gravityRef = useRef({ gx: 0, gy: GRAVITY_BASE });
  const sizeRef = useRef({ w: 0, h: 0 });
  const grainRef = useRef<HTMLCanvasElement | null>(null);
  const longPressRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFiredRef = useRef(false);
  const audioCtxRef = useRef<AudioContext | null>(null);
  // Per-peg flash timer (0 = no flash, 1 = just hit, decays to 0)
  const pegFlashRef = useRef<number[]>(PEGS.map(() => 0));
  // Burst particles spawned when a merged ball exceeds the size cap
  const burstsRef = useRef<BurstParticle[]>([]);
  const ballIdRef = useRef(0);
  // Per-color budget — each color starts with this many marbles. Counts down
  // as the player drops; when ANY color hits 0 the run ends.
  const STARTING_BUDGET = 99;
  const colorCountsRef = useRef<Record<string, number>>(
    Object.fromEntries(PALETTE.map(c => [c.hex, STARTING_BUDGET])),
  );
  // Total balls that have burst this run — score = bursts × 100
  const burstScoreRef = useRef(0);
  // Per-color timestamp of the last decrement — used to flash the countdown
  // number and float a small "−1" tick when the player spends a ball.
  const colorChangeRef = useRef<Record<string, number>>({});
  // Combo: bursts within COMBO_WINDOW chain together. Each chained burst
  // beyond the first triggers a "rainbow rain" — one free ball of every color
  // drops from the top, no stock cost.
  const lastBurstRef = useRef(0);
  const comboRef = useRef(0);
  // {time, count, x, y} of the last combo trigger so we can render a brief
  // "COMBO ×N" flourish near the burst that earned it.
  const comboFlashRef = useRef<{ t: number; n: number; x: number; y: number } | null>(null);
  const [scoreDisplay, setScoreDisplay] = useState(0);
  const [gameOver, setGameOver] = useState(false);
  const gameOverRef = useRef(false);
  const [showLeaderboard, setShowLeaderboard] = useState(false);
  const { isInAigram, canRank, submitScore, fetchLeaderboard } = useGameScore();
  // Attract mode pending timers. Bounded — we drop one ball per palette color
  // (6 total) and then stop. Bounded because the games list preloads us in
  // the background; an unbounded drip would fill the screen if the user
  // lingers on the previous game. See `feedback_game_preload_idle.md`.
  const attractRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const [hasTouched, setHasTouched] = useState(false);
  const hasTouchedRef = useRef(false);   // mirror of hasTouched, readable from tick

  // ── Audio: synthesized chime / click — Web Audio (lazy on first gesture) ─
  function ensureAudio() {
    if (!audioCtxRef.current) {
      const Ctor: typeof AudioContext | undefined =
        window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (Ctor) audioCtxRef.current = new Ctor();
    }
    const ctx = audioCtxRef.current;
    if (ctx && ctx.state === 'suspended') void ctx.resume();
  }
  // Per-source rate limiters so simultaneous collisions don't pile up & clip.
  const lastSoundRef = useRef<Map<string, number>>(new Map());
  function playChime(freq: number, vel: number, key = `chime-${freq.toFixed(1)}`) {
    const ctx = audioCtxRef.current;
    if (!ctx || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    const last = lastSoundRef.current.get(key) ?? 0;
    if (now - last < 0.18) return;            // 180ms per pitch (was 60ms)
    // Global ceiling: don't fire more than ~10 chimes per second across all pegs
    const lastAny = lastSoundRef.current.get('any-chime') ?? 0;
    if (now - lastAny < 0.085) return;
    lastSoundRef.current.set(key, now);
    lastSoundRef.current.set('any-chime', now);
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, now);
    const v = Math.min(0.085, 0.018 + vel * 0.008);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(v, now + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.55);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.6);
  }
  // Low rumbling thud for shake
  function playThud() {
    const ctx = audioCtxRef.current;
    if (!ctx || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(90, now);
    osc.frequency.exponentialRampToValueAtTime(38, now + 0.22);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.18, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.28);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.3);
  }

  // Debug: ?seed=N auto-spawns N balls on mount (for screenshots / testing)
  useEffect(() => {
    const seed = parseInt(new URLSearchParams(window.location.search).get('seed') ?? '0', 10);
    if (!seed) return;
    const t = setTimeout(() => {
      const w = window.innerWidth, h = window.innerHeight;
      for (let i = 0; i < seed; i++) {
        spawnAt(40 + Math.random() * (w - 80), 40 + Math.random() * (h * 0.4));
      }
    }, 100);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Attract mode — drop exactly one ball per color (6 total), then idle.
  // Bounded so the screen doesn't fill up if the games-list preloader
  // mounts us minutes before the user actually swipes here.
  useEffect(() => {
    if (parseInt(new URLSearchParams(window.location.search).get('seed') ?? '0', 10)) return;
    if (new URLSearchParams(window.location.search).get('poster') === '1') return;

    // Shuffle the palette so the cascade order varies between sessions.
    const colors = PALETTE.map(c => c.hex);
    for (let i = colors.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [colors[i], colors[j]] = [colors[j], colors[i]];
    }

    // Cadence: tight at the start (catch the eye), loosening toward the end
    // so it settles into "calm" before the user touches.
    const DELAYS = [350, 850, 1450, 2400, 3900, 6000];
    attractRef.current = colors.map((color, i) =>
      setTimeout(() => {
        const w = window.innerWidth;
        spawnAtAttract(60 + Math.random() * (w - 120), -20, color);
      }, DELAYS[i])
    );

    return () => {
      attractRef.current.forEach(clearTimeout);
      attractRef.current = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Build static grain texture once
  useEffect(() => {
    const grain = document.createElement('canvas');
    const size = 220;
    grain.width = size; grain.height = size;
    const gctx = grain.getContext('2d')!;
    const imgData = gctx.createImageData(size, size);
    for (let i = 0; i < imgData.data.length; i += 4) {
      const v = Math.random() * 255;
      imgData.data[i] = imgData.data[i + 1] = imgData.data[i + 2] = v;
      imgData.data[i + 3] = 14;
    }
    gctx.putImageData(imgData, 0, 0);
    grainRef.current = grain;
  }, []);

  // Resize / DPR setup
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;

    function resize() {
      if (!canvas) return;
      const dpr = window.devicePixelRatio || 1;
      const w = window.innerWidth;
      const h = window.innerHeight;
      sizeRef.current = { w, h };
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = w + 'px';
      canvas.style.height = h + 'px';
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.scale(dpr, dpr);
    }
    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);

  // Sensor diagnostics — flipped to true the first time an event actually
  // reaches us. If still false 1.5s after first user gesture, we surface a
  // visible "ENABLE TILT & SHAKE" button so the player can retry the iOS
  // permission prompt (or know that sensors are unavailable on their device).
  const orientReceivedRef = useRef(false);
  const motionReceivedRef = useRef(false);
  const [motionStatus, setMotionStatus] = useState<'idle' | 'pending' | 'on' | 'off'>('idle');
  const motionStatusRef = useRef<typeof motionStatus>('idle');
  motionStatusRef.current = motionStatus;
  // Sensor hint — Material screen_rotation icon swinging, "TILT & SHAKE"
  // label. Visible after first touch when sensor path is available, fades
  // automatically after 7s (or never appears if no sensor path).
  const [showSensorHint, setShowSensorHint] = useState(false);
  const sensorHintDoneRef = useRef(false);

  // Trigger sensor hint after first touch — only if there's any chance the
  // device will deliver motion data. 0.9s delay so the canvas sub-hint
  // ("TAP A COLOR · DROP · MERGE · SHAKE") gets first focus.
  useEffect(() => {
    if (!hasTouched || sensorHintDoneRef.current) return;
    const hasSensorPath =
      (typeof window !== 'undefined' && (window as any).Telegram?.WebApp?.Accelerometer) ||
      (typeof DeviceMotionEvent !== 'undefined') ||
      isEmbeddedContext;
    if (!hasSensorPath) return;
    const showTimer = window.setTimeout(() => {
      if (sensorHintDoneRef.current) return;
      setShowSensorHint(true);
    }, 900);
    const hideTimer = window.setTimeout(() => {
      sensorHintDoneRef.current = true;
      setShowSensorHint(false);
    }, 900 + 7000);
    return () => {
      window.clearTimeout(showTimer);
      window.clearTimeout(hideTimer);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasTouched]);

  // Dismiss the sensor hint the moment the user actually tilts the device.
  useEffect(() => {
    if (!showSensorHint) return;
    let raf = 0;
    function check() {
      const g = gravityRef.current;
      // gx is horizontal tilt (-1..1). Anything past 0.4 is a deliberate tilt.
      if (g && Math.abs(g.gx) > 0.4) {
        sensorHintDoneRef.current = true;
        setShowSensorHint(false);
        return;
      }
      raf = window.requestAnimationFrame(check);
    }
    raf = window.requestAnimationFrame(check);
    return () => window.cancelAnimationFrame(raf);
  }, [showSensorHint]);

  // Track the most recent permission result so the debug overlay can show it
  const [lastPermResult, setLastPermResult] = useState<string>('—');
  const debugMotion = typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('debug') === '1';
  const debugRef = useRef({ beta: 0, gamma: 0, mag: 0 });
  // Once any sensor bridge (Telegram-direct or Aigram-postMessage) delivers
  // an event, lock DOM handlers as no-ops so we don't double-write gravity.
  // Also cuts Permissions Policy console spam in WebView contexts where
  // DOM motion is policy-gated.
  const tgActiveRef = useRef(false);
  // Debug strings for the Telegram-direct sensor lifecycle
  const tgAccelStateRef = useRef<string>('—');
  const tgOrientStateRef = useRef<string>('—');
  // Debug string for the Aigram postMessage bridge lifecycle
  const aigramBridgeStateRef = useRef<string>('—');
  // We're embedded inside Telegram / Aigram if any of:
  //   - Telegram WebApp launched us (initData populated by the host)
  //   - the Aigram launcher attached an `api_origin` query param
  //   - the page is in an iframe (rough proxy)
  // We check `initData` (not just `Telegram.WebApp` presence) because we now
  // load `telegram-web-app.js` in index.html — that injects `Telegram.WebApp`
  // even in plain Safari, but `initData` is only populated when the page was
  // actually launched from Telegram. In WKWebView-style embeds, DOM
  // DeviceOrientation/Motion permission prompts silently deny — showing the
  // retry pill confuses users; suppress instead. Telegram's own sensor APIs
  // (window.Telegram.WebApp.{Accelerometer, DeviceOrientation}) are wired up
  // separately below.
  const isEmbeddedContext = typeof window !== 'undefined' && (
    !!(window as unknown as { Telegram?: { WebApp?: { initData?: string } } }).Telegram?.WebApp?.initData ||
    new URLSearchParams(window.location.search).has('api_origin') ||
    (window.parent && window.parent !== window)
  );
  // Force-rerender ~5x/sec when debug overlay is on so live values refresh.
  const [, setDebugTick] = useState(0);
  useEffect(() => {
    if (!debugMotion) return;
    const id = setInterval(() => setDebugTick(t => t + 1), 200);
    return () => clearInterval(id);
  }, [debugMotion]);

  // Tilt → gravity vector (DeviceOrientation). Smoothly lerped.
  // On iOS 13+ the listener is silent until requestPermission() resolves
  // 'granted' inside a user gesture — see requestMotionPerms() below.
  useEffect(() => {
    function onOrient(e: DeviceOrientationEvent) {
      if (tgActiveRef.current) return;        // Telegram path is authoritative once active
      if (e.beta == null && e.gamma == null) return;
      orientReceivedRef.current = true;
      if (motionStatusRef.current !== 'on') setMotionStatus('on');
      // gamma: -90..90 left/right, beta: -180..180 forward/back
      const gx = Math.max(-1, Math.min(1, (e.gamma ?? 0) / 45));
      const gy = Math.max(-1, Math.min(1, (e.beta ?? 0) / 45));
      const targetX = gx * GRAVITY_BASE * 1.4;
      const targetY = Math.max(0.05, gy * GRAVITY_BASE * 1.4);
      // lerp gravity for smoothness
      gravityRef.current.gx += (targetX - gravityRef.current.gx) * 0.06;
      gravityRef.current.gy += (targetY - gravityRef.current.gy) * 0.06;
      if (debugMotion) {
        debugRef.current.beta = e.beta ?? 0;
        debugRef.current.gamma = e.gamma ?? 0;
      }
    }
    window.addEventListener('deviceorientation', onOrient);
    return () => window.removeEventListener('deviceorientation', onOrient);
  }, [debugMotion]);

  // Shake-to-spring: detect a sharp acceleration spike and trigger shakeAll().
  // We track shakeAll via a ref so the listener (set up once) always sees the
  // latest closure (gameOver state, latest stock counts, etc.).
  const shakeAllRef = useRef<() => void>(() => {});
  useEffect(() => {
    let lastFire = 0;
    function onMotion(e: DeviceMotionEvent) {
      if (tgActiveRef.current) return;        // Telegram path is authoritative once active
      motionReceivedRef.current = true;
      const accel = e.acceleration && e.acceleration.x !== null ? e.acceleration : null;
      const a = accel ?? e.accelerationIncludingGravity;
      if (!a) return;
      const ax = a.x ?? 0, ay = a.y ?? 0, az = a.z ?? 0;
      const mag = Math.sqrt(ax * ax + ay * ay + az * az);
      // `acceleration` rest ≈ 0; `accelerationIncludingGravity` rest ≈ 9.8.
      // Subtract baseline so the threshold means "above-rest jolt" either way.
      const baseline = accel ? 0 : 9.8;
      const jolt = Math.abs(mag - baseline);
      if (debugMotion) debugRef.current.mag = jolt;
      const threshold = 14;
      const now = performance.now();
      if (jolt > threshold && now - lastFire > 600) {
        lastFire = now;
        shakeAllRef.current();
      }
    }
    window.addEventListener('devicemotion', onMotion);
    return () => window.removeEventListener('devicemotion', onMotion);
  }, [debugMotion]);

  // Telegram WebApp sensors — preferred path inside Telegram / Aigram, where
  // standard DeviceOrientation / DeviceMotion are blocked at the WebView level.
  // Telegram exposes its own Accelerometer + DeviceOrientation objects (Bot API
  // 8.0+); we bridge them into the same gravityRef / shakeAllRef as the DOM path
  // so the rest of the game is sensor-source-agnostic.
  // Detection: we DO NOT gate on `Telegram.WebApp.initData`. When this iframe
  // is nested inside Aigram (which itself is the Telegram Mini App), `initData`
  // is empty in our window — Telegram populated it on Aigram's window, not
  // ours. But Aigram's Telegram bridge still services Accelerometer.start()
  // calls from descendant frames. So the only reliable detection is "try to
  // start, see if events arrive". `tgActiveRef` flips on the first event and
  // suppresses the DOM path so we don't double-write.
  // Units differ from the DOM API:
  //   - DeviceOrientation alpha/beta/gamma are RADIANS (DOM uses degrees)
  //   - Accelerometer x/y/z include gravity (rest ≈ 9.8 on the up axis); there
  //     is no gravity-removed variant, so we always use the gravity-included
  //     shake threshold path.
  // See `reference_telegram_webapp_sensors.md` for the full API.
  useEffect(() => {
    type TgSensor = {
      isStarted: boolean;
      start: (params: { refresh_rate?: number; need_absolute?: boolean }, cb?: (ok: boolean) => void) => unknown;
      stop: (cb?: (ok: boolean) => void) => unknown;
    };
    type TgEventHandler = (...args: unknown[]) => void;
    type TgWebApp = {
      initData?: string;
      onEvent: (event: string, handler: TgEventHandler) => void;
      offEvent: (event: string, handler: TgEventHandler) => void;
      Accelerometer?: TgSensor & { x: number; y: number; z: number };
      DeviceOrientation?: TgSensor & { alpha: number; beta: number; gamma: number; absolute: boolean };
    };
    const tg = (window as unknown as { Telegram?: { WebApp?: TgWebApp } }).Telegram?.WebApp;
    if (!tg?.Accelerometer && !tg?.DeviceOrientation) return;  // SDK missing or pre-8.0

    let lastShakeFire = 0;
    const RAD2DEG = 180 / Math.PI;

    const onOrient: TgEventHandler = () => {
      const o = tg.DeviceOrientation;
      if (!o) return;
      tgActiveRef.current = true;
      tgOrientStateRef.current = 'changed';
      orientReceivedRef.current = true;
      if (motionStatusRef.current !== 'on') setMotionStatus('on');
      const beta = (o.beta ?? 0) * RAD2DEG;     // radians → degrees, match DOM math
      const gamma = (o.gamma ?? 0) * RAD2DEG;
      const gx = Math.max(-1, Math.min(1, gamma / 45));
      const gy = Math.max(-1, Math.min(1, beta / 45));
      const targetX = gx * GRAVITY_BASE * 1.4;
      const targetY = Math.max(0.05, gy * GRAVITY_BASE * 1.4);
      gravityRef.current.gx += (targetX - gravityRef.current.gx) * 0.06;
      gravityRef.current.gy += (targetY - gravityRef.current.gy) * 0.06;
      if (debugMotion) {
        debugRef.current.beta = beta;
        debugRef.current.gamma = gamma;
      }
    };

    const onAccel: TgEventHandler = () => {
      const a = tg.Accelerometer;
      if (!a) return;
      tgActiveRef.current = true;
      tgAccelStateRef.current = 'changed';
      motionReceivedRef.current = true;
      const ax = a.x ?? 0, ay = a.y ?? 0, az = a.z ?? 0;
      const mag = Math.sqrt(ax * ax + ay * ay + az * az);
      const jolt = Math.abs(mag - 9.8);         // rest ≈ 9.8, threshold means "above-rest jolt"
      if (debugMotion) debugRef.current.mag = jolt;
      const threshold = 14;
      const now = performance.now();
      if (jolt > threshold && now - lastShakeFire > 600) {
        lastShakeFire = now;
        shakeAllRef.current();
      }
    };

    const onAccelStarted: TgEventHandler = () => { tgAccelStateRef.current = 'started'; };
    const onOrientStarted: TgEventHandler = () => { tgOrientStateRef.current = 'started'; };
    const onAccelFailed: TgEventHandler = (e: unknown) => {
      tgAccelStateRef.current = 'failed:' + summarizeErr(e);
      // eslint-disable-next-line no-console
      console.warn('[marbles] Telegram accel failed (likely not in Telegram):', e);
      // Don't flip motionStatus — DOM path may still deliver in Safari/iOS-native.
    };
    const onOrientFailed: TgEventHandler = (e: unknown) => {
      tgOrientStateRef.current = 'failed:' + summarizeErr(e);
      // eslint-disable-next-line no-console
      console.warn('[marbles] Telegram orient failed (likely not in Telegram):', e);
    };
    function summarizeErr(e: unknown): string {
      if (e && typeof e === 'object' && 'error' in e) return String((e as { error: unknown }).error);
      return typeof e === 'string' ? e : 'unknown';
    }

    tg.onEvent('deviceOrientationChanged', onOrient);
    tg.onEvent('accelerometerChanged', onAccel);
    tg.onEvent('deviceOrientationStarted', onOrientStarted);
    tg.onEvent('accelerometerStarted', onAccelStarted);
    tg.onEvent('deviceOrientationFailed', onOrientFailed);
    tg.onEvent('accelerometerFailed', onAccelFailed);

    // 50 ms ≈ 20 Hz — plenty for tilt/shake; saves battery vs. the 20 ms cap.
    tg.DeviceOrientation?.start({ refresh_rate: 50 }, (ok: boolean) => {
      // eslint-disable-next-line no-console
      console.info('[marbles] tg orient start cb:', ok);
    });
    tg.Accelerometer?.start({ refresh_rate: 50 }, (ok: boolean) => {
      // eslint-disable-next-line no-console
      console.info('[marbles] tg accel start cb:', ok);
    });

    return () => {
      tg.offEvent('deviceOrientationChanged', onOrient);
      tg.offEvent('accelerometerChanged', onAccel);
      tg.offEvent('deviceOrientationStarted', onOrientStarted);
      tg.offEvent('accelerometerStarted', onAccelStarted);
      tg.offEvent('deviceOrientationFailed', onOrientFailed);
      tg.offEvent('accelerometerFailed', onAccelFailed);
      tg.DeviceOrientation?.stop();
      tg.Accelerometer?.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debugMotion]);

  // Aigram System API bridge — when our game is iframed inside the Aigram
  // mini app (which is itself a Telegram Mini App), Telegram's WebApp.* sensor
  // bridge is established on Aigram's window, not ours. Aigram instead exposes
  // a postMessage relay:
  //   iframe → host: "TG.ACCELEROMETER" or "TG.ACCELEROMETER-<base64({refresh_rate})>"
  //   host → iframe: "TG.ACCELEROMETER.CHANGED-<base64({x, y, z})>"
  // Cleanup is automatic when our iframe is removed from the DOM, so we only
  // need to remove our own message listener on unmount.
  // The bridge only carries Accelerometer (no DeviceOrientation), so we derive
  // tilt by low-pass-filtering the gravity component out of the raw accel and
  // shake from the high-pass residual.
  // Protocol reference: IFRAME_GUIDE.md from the Aigram team.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!window.parent || window.parent === window) return;   // not iframed → no host

    // Light low-pass on raw accel — just enough to take the edge off sensor
    // noise without adding perceptible lag. We DON'T do the slow gravity-
    // extraction filter (was SMOOTH=0.08 ≈ 600ms) because that caused tilt
    // to lag noticeably behind the user's hand. Instead we treat the smoothed
    // accel directly as a gravity proxy — the user's deliberate tilts are
    // captured immediately, and the brief direction noise during a shake
    // doesn't matter because shake also fires the spring (balls go up
    // regardless of horizontal gravity for that ~600ms).
    const accelSmooth = { x: 0, y: 0, z: 0 };
    let primed = false;
    const SMOOTH = 0.35;          // ~70ms time constant at 50Hz
    const G_NOM = 9.8;
    // Tilt gain: divide by sin(45°)*g so a 45° tilt saturates the steering
    // signal — matches the DOM `gamma/45` feel.
    const TILT_GAIN = G_NOM * Math.SQRT1_2;   // ≈ 6.93
    const SHAKE_THRESHOLD = 14;   // m/s² above-rest jolt
    let lastShakeFire = 0;

    const onMessage = (ev: MessageEvent) => {
      const raw = ev.data;
      if (typeof raw !== 'string') return;
      const PREFIX = 'TG.ACCELEROMETER.CHANGED-';
      if (!raw.startsWith(PREFIX)) return;
      let data: { x: number; y: number; z: number };
      try {
        data = JSON.parse(atob(raw.slice(PREFIX.length))) as { x: number; y: number; z: number };
      } catch { return; }

      tgActiveRef.current = true;
      aigramBridgeStateRef.current = 'changed';
      orientReceivedRef.current = true;
      motionReceivedRef.current = true;
      if (motionStatusRef.current !== 'on') setMotionStatus('on');

      if (!primed) {
        accelSmooth.x = data.x; accelSmooth.y = data.y; accelSmooth.z = data.z;
        primed = true;
      } else {
        accelSmooth.x += (data.x - accelSmooth.x) * SMOOTH;
        accelSmooth.y += (data.y - accelSmooth.y) * SMOOTH;
        accelSmooth.z += (data.z - accelSmooth.z) * SMOOTH;
      }

      // Tilt → in-game gravity. Sign convention matches DOM path:
      // tilt right (gravity in +x device axis) → balls roll right (+gx).
      // Canvas y is down, so we flip gy. Verify on device; flip if wrong.
      const gxNorm = Math.max(-1, Math.min(1, accelSmooth.x / TILT_GAIN));
      const gyNorm = Math.max(-1, Math.min(1, accelSmooth.y / TILT_GAIN));
      const targetX = gxNorm * GRAVITY_BASE * 1.4;
      const targetY = Math.max(0.05, -gyNorm * GRAVITY_BASE * 1.4);
      // Faster downstream lerp (was 0.06) — needed because postMessage adds
      // ~one-frame latency on top of the sensor sample rate.
      gravityRef.current.gx += (targetX - gravityRef.current.gx) * 0.18;
      gravityRef.current.gy += (targetY - gravityRef.current.gy) * 0.18;

      // Shake → magnitude minus gravity baseline. Same as the DOM
      // accelerationIncludingGravity branch.
      const mag = Math.sqrt(data.x * data.x + data.y * data.y + data.z * data.z);
      const jolt = Math.abs(mag - G_NOM);
      const now = performance.now();
      if (jolt > SHAKE_THRESHOLD && now - lastShakeFire > 600) {
        lastShakeFire = now;
        shakeAllRef.current();
      }

      if (debugMotion) {
        debugRef.current.beta = -gyNorm * 45;
        debugRef.current.gamma = gxNorm * 45;
        debugRef.current.mag = jolt;
      }
    };

    window.addEventListener('message', onMessage);

    // Subscribe at Telegram's max rate (20ms ≈ 50Hz). Payload is standard
    // (not URL-safe) base64 of JSON; pure ASCII so plain btoa works.
    const sub = `TG.ACCELEROMETER-${btoa(JSON.stringify({ refresh_rate: 20 }))}`;
    window.parent.postMessage(sub, '*');
    aigramBridgeStateRef.current = 'requested';
    // eslint-disable-next-line no-console
    console.info('[marbles] aigram bridge subscribed:', sub);

    return () => window.removeEventListener('message', onMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debugMotion]);

  // iOS 13+ gates motion / orientation behind a per-session permission prompt
  // that MUST be triggered by a user gesture. We:
  //   1. Detect whether requestPermission exists (iOS Safari only)
  //   2. Call it inside the gesture, await result, log + setState
  //   3. After granting (or on non-iOS browsers), schedule a 1.5s probe — if
  //      no orientation events arrived, mark status as 'off' so the UI can
  //      surface a retry button.
  // The function is idempotent except when it has previously failed: in that
  // case a subsequent user gesture (e.g. tapping the "ENABLE" pill) retries.
  const motionPermsRef = useRef<'idle' | 'pending' | 'done'>('idle');
  // iOS Safari has "transient user activation": a tap grants permission to
  // *one* sensitive API call, and any await/microtask between the tap and the
  // call consumes the activation. Earlier we did `await O.req()` then
  // `await M.req()` — only the first was actually inside the gesture; the
  // second always failed with "requires a user gesture", and on some iOS
  // versions both reported the error. Fix: kick off BOTH requestPermission()
  // calls synchronously (no await between them), then await in parallel.
  const requestMotionPerms = () => {
    if (motionPermsRef.current === 'pending') return;
    if (motionPermsRef.current === 'done') return;

    type Reqable = { requestPermission?: () => Promise<'granted' | 'denied' | 'default'> };
    const O = DeviceOrientationEvent as unknown as Reqable;
    const M = DeviceMotionEvent as unknown as Reqable;
    const hasReqPerm = typeof O?.requestPermission === 'function' || typeof M?.requestPermission === 'function';

    const toState = (err: unknown): string =>
      'error: ' + (err instanceof Error ? err.message : String(err));

    // Fire requestPermission BEFORE any setState/ref work. Some iOS Safari
    // versions are sensitive to anything that might pump the event loop
    // between the user gesture and the permission call. Keep this path as
    // bare-bones as possible.
    const oPromise: Promise<string> =
      typeof O.requestPermission === 'function'
        ? O.requestPermission().catch(toState)
        : Promise.resolve('n/a');
    const mPromise: Promise<string> =
      typeof M.requestPermission === 'function'
        ? M.requestPermission().catch(toState)
        : Promise.resolve('n/a');

    motionPermsRef.current = 'pending';
    setMotionStatus('pending');

    Promise.all([oPromise, mPromise]).then(([oState, mState]) => {
      // eslint-disable-next-line no-console
      console.info('[marbles] motion perm — orient:', oState, ' motion:', mState, ' hasReqPerm:', hasReqPerm, ' embedded:', isEmbeddedContext);
      setLastPermResult(`o=${oState} m=${mState} req=${hasReqPerm} emb=${isEmbeddedContext}`);
      motionPermsRef.current = 'done';

      // Probe: did events actually start flowing? (works on Android too —
      // the probe just confirms sensors are alive.)
      setTimeout(() => {
        if (orientReceivedRef.current || motionReceivedRef.current) {
          setMotionStatus('on');
        } else {
          setMotionStatus('off');
          // Allow the explicit "ENABLE" pill to retry.
          motionPermsRef.current = 'idle';
        }
      }, 1500);
    });
  };

  // Main RAF loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    let raf = 0;

    const tick = () => {
      const { w, h } = sizeRef.current;
      const balls = ballsRef.current;
      const { gx, gy } = gravityRef.current;

      // ── Physics step ────────────────────────────────────────────────────
      for (const b of balls) {
        if (b.fading < 1) {
          b.fading -= 0.02;
          continue;
        }
        b.vx += gx;
        b.vy += gy;
        b.vx *= AIR_DAMP;
        b.vy *= AIR_DAMP;
        b.x += b.vx;
        b.y += b.vy;

        // Wall collisions
        if (b.x < b.r)        { b.x = b.r;     b.vx = -b.vx * WALL_REST; }
        if (b.x > w - b.r)    { b.x = w - b.r; b.vx = -b.vx * WALL_REST; }
        if (b.y < b.r)        { b.y = b.r;     b.vy = -b.vy * WALL_REST; }
        if (b.y > h - b.r)    {
          b.y = h - b.r;
          b.vy = -b.vy * FLOOR_REST;
          b.vx *= 0.985;
          if (Math.abs(b.vy) < 0.4) b.vy = 0;
        }
      }

      // Ball-peg collisions — pegs are immovable; reflect ball + chime
      for (let pi = 0; pi < PEGS.length; pi++) {
        const peg = PEGS[pi];
        const px = (peg.xPct / 100) * w;
        const py = (peg.yPct / 100) * h;
        for (const b of balls) {
          if (b.fading < 1) continue;
          const dx = b.x - px;
          const dy = b.y - py;
          const minDist = b.r + peg.r;
          const sq = dx * dx + dy * dy;
          if (sq >= minDist * minDist || sq < 0.01) continue;
          const dist = Math.sqrt(sq);
          const nx = dx / dist, ny = dy / dist;
          // Separate
          b.x = px + nx * minDist;
          b.y = py + ny * minDist;
          const vn = b.vx * nx + b.vy * ny;
          if (vn < 0) {
            const e = 0.74;
            b.vx -= (1 + e) * vn * nx;
            b.vy -= (1 + e) * vn * ny;
            // peg flash + chime only on a clear bounce, not on micro-jitter
            // from a settled pile pressing into the peg.
            if (vn < -1.6) {
              pegFlashRef.current[pi] = 1;
              playChime(peg.freq, Math.min(-vn, 9));
            }
          }
        }
      }

      // Ball-ball collisions (O(n²) is fine under MAX_BALLS=140)
      // Track same-color merge pairs to process AFTER physics resolves
      const mergePairs: Array<[number, number]> = [];
      for (let i = 0; i < balls.length; i++) {
        const a = balls[i];
        if (a.fading < 1) continue;
        for (let j = i + 1; j < balls.length; j++) {
          const b = balls[j];
          if (b.fading < 1) continue;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const minDist = a.r + b.r;
          const sq = dx * dx + dy * dy;
          if (sq < 0.01) continue;

          // Same-color: merge with 1px tolerance — covers settled stacks where
          // collision resolution leaves balls touching but not overlapping.
          if (a.color === b.color) {
            const mergeMax = minDist + 1.0;
            if (sq < mergeMax * mergeMax) {
              mergePairs.push([i, j]);
              continue;
            }
            continue;          // close-but-not-merging same-color, skip physics
          }

          // Different-color collision: needs actual overlap
          if (sq >= minDist * minDist) continue;
          const dist = Math.sqrt(sq);
          const nx = dx / dist;
          const ny = dy / dist;
          const overlap = (minDist - dist) / 2;
          a.x -= nx * overlap;
          a.y -= ny * overlap;
          b.x += nx * overlap;
          b.y += ny * overlap;
          // velocity along normal — for non-merging collisions
          const rvx = b.vx - a.vx;
          const rvy = b.vy - a.vy;
          const vn = rvx * nx + rvy * ny;
          if (vn > 0) continue; // separating
          const e = BALL_REST;
          const ma = a.r * a.r;
          const mb = b.r * b.r;
          const j_ = -(1 + e) * vn / ((1 / ma) + (1 / mb));
          const ix = j_ * nx;
          const iy = j_ * ny;
          a.vx -= (ix / ma);
          a.vy -= (iy / ma);
          b.vx += (ix / mb);
          b.vy += (iy / mb);
          a.vx *= COLL_DAMP; a.vy *= COLL_DAMP;
          b.vx *= COLL_DAMP; b.vy *= COLL_DAMP;
        }
      }

      // Process same-color merges. Each ball can be in at most one merge.
      if (mergePairs.length > 0) {
        const removed = new Set<number>();
        const created: Ball[] = [];
        for (const [i, j] of mergePairs) {
          if (removed.has(i) || removed.has(j)) continue;
          const a = balls[i], b = balls[j];
          removed.add(i); removed.add(j);
          // Conserve area: r_new = sqrt(r_a² + r_b²)
          const newR = Math.sqrt(a.r * a.r + b.r * b.r);
          const ma = a.r * a.r, mb = b.r * b.r, mt = ma + mb;
          const nx = (a.x * ma + b.x * mb) / mt;
          const ny = (a.y * ma + b.y * mb) / mt;
          if (newR > BURST_RADIUS) {
            // BURST — emit particles, drop both balls. Score +1 per burst.
            spawnBurst(nx, ny, a.color, newR);
            burstScoreRef.current += 1;
            setScoreDisplay(burstScoreRef.current);
            // ── Combo: bursts within window chain. From combo 2+ on, the
            //    player gets a free rainbow drop (one ball of every color).
            const tNow = performance.now();
            const COMBO_WINDOW = 1800;
            if (tNow - lastBurstRef.current <= COMBO_WINDOW) {
              comboRef.current += 1;
            } else {
              comboRef.current = 1;
            }
            lastBurstRef.current = tNow;
            if (comboRef.current >= 2) {
              comboFlashRef.current = { t: tNow, n: comboRef.current, x: nx, y: ny };
              // Stagger the drops slightly across the top so they don't all
              // collide on the way down.
              const w = sizeRef.current.w || 390;
              for (let k = 0; k < PALETTE.length; k++) {
                const color = PALETTE[k].hex;
                const slotX = (w / (PALETTE.length + 1)) * (k + 1);
                const jitter = (Math.random() - 0.5) * 30;
                setTimeout(() => dropFreeBall(color, slotX + jitter), k * 60);
              }
            }
          } else {
            // MERGE into a single bigger ball.
            const nvx = (a.vx * ma + b.vx * mb) / mt;
            const nvy = (a.vy * ma + b.vy * mb) / mt;
            created.push({
              id: ++ballIdRef.current,
              x: nx, y: ny,
              vx: nvx * 0.7, vy: nvy * 0.7,
              r: newR,
              color: a.color,
              born: performance.now(),
              fading: 1,
              bornGlow: 1,
            });
          }
        }
        if (removed.size > 0 || created.length > 0) {
          ballsRef.current = balls.filter((_, i) => !removed.has(i)).concat(created);
        }
      }

      // Decay born-glow on freshly-merged balls
      for (const b of ballsRef.current) {
        if (b.bornGlow > 0) b.bornGlow = Math.max(0, b.bornGlow - 0.024);
      }

      // Decay peg flashes
      for (let i = 0; i < pegFlashRef.current.length; i++) {
        if (pegFlashRef.current[i] > 0) pegFlashRef.current[i] -= 0.04;
        if (pegFlashRef.current[i] < 0) pegFlashRef.current[i] = 0;
      }

      // Burst particles physics — small gravity-affected dots that fade out
      const bursts = burstsRef.current;
      for (const p of bursts) {
        p.vy += GRAVITY_BASE * 0.6;
        p.vx *= 0.985;
        p.vy *= 0.985;
        p.x += p.vx;
        p.y += p.vy;
        p.life -= 0.022;
      }
      burstsRef.current = bursts.filter(p => p.life > 0);

      // ── Garbage collect fully faded ─────────────────────────────────────
      // IMPORTANT: filter the *current* ref (which may already have been
      // rewritten by the merge step above) — not the stale `balls` snapshot.
      ballsRef.current = ballsRef.current.filter(b => b.fading > 0);

      // ── Render ──────────────────────────────────────────────────────────
      ctx.clearRect(0, 0, w, h);

      // Background fill (warm charcoal) + radial vignette
      ctx.fillStyle = '#1c1813';
      ctx.fillRect(0, 0, w, h);
      const vg = ctx.createRadialGradient(w / 2, h * 0.42, w * 0.2, w / 2, h * 0.5, w * 0.85);
      vg.addColorStop(0, 'rgba(58, 44, 30, 0.18)');
      vg.addColorStop(1, 'rgba(0, 0, 0, 0.35)');
      ctx.fillStyle = vg;
      ctx.fillRect(0, 0, w, h);

      // Faint noise grain (tiled)
      const grain = grainRef.current;
      if (grain) {
        const pattern = ctx.createPattern(grain, 'repeat');
        if (pattern) {
          ctx.fillStyle = pattern;
          ctx.globalAlpha = 0.5;
          ctx.fillRect(0, 0, w, h);
          ctx.globalAlpha = 1;
        }
      }

      // ── Game title "MARBLES" — debossed into the warm dark surface.
      // Drawn BEFORE pegs so even the pegs sit on top of the title.
      {
        const titleX = w / 2;
        const titleY = h * 0.46;
        ctx.save();
        // Auto-fit: try 72 then shrink in steps until MARBLES fits ~84% of w.
        // measureText doesn't account for canvas letterSpacing, so we add an
        // empirical 1.18x safety factor.
        const ctx2d = ctx as CanvasRenderingContext2D & { letterSpacing?: string };
        const titleSpacingEm = 0.06;
        ctx2d.letterSpacing = `${titleSpacingEm}em`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const maxTitleW = w * 0.84;
        let titleSize = 72;
        for (; titleSize >= 40; titleSize -= 2) {
          ctx.font = `700 ${titleSize}px "Cormorant Garamond", "Times New Roman", serif`;
          const wMeasured = ctx.measureText('MARBLES').width * 1.18 + titleSize * titleSpacingEm * 6;
          if (wMeasured <= maxTitleW) break;
        }
        // Light edge below (debossed bottom-rim catches light from upper-left)
        ctx.fillStyle = 'rgba(255, 240, 220, 0.07)';
        ctx.fillText('MARBLES', titleX + 1, titleY + 1.5);
        // Dark edge above (debossed shadow into the indent)
        ctx.fillStyle = 'rgba(0, 0, 0, 0.65)';
        ctx.fillText('MARBLES', titleX, titleY - 1.5);
        // Main fill — slightly darker than bg so text reads as carved-in
        ctx.fillStyle = '#0e0a06';
        ctx.fillText('MARBLES', titleX, titleY);

        // Sub-hint, only until the user has interacted
        if (!hasTouchedRef.current) {
          ctx.font = '300 10px "JetBrains Mono", ui-monospace, monospace';
          ctx2d.letterSpacing = '0.32em';
          const breath = 0.6 + Math.sin(performance.now() * 0.0022) * 0.25;
          ctx.fillStyle = `rgba(150, 122, 90, ${breath})`;
          ctx.fillText('TAP A COLOR · DROP · MERGE · SHAKE', titleX + 4, titleY + 56);
        }
        ctx.restore();
      }

      // Render pegs — order matters: shadows BEHIND the pit, flash ring ON TOP.
      for (let pi = 0; pi < PEGS.length; pi++) {
        const peg = PEGS[pi];
        const px = (peg.xPct / 100) * w;
        const py = (peg.yPct / 100) * h;
        const flash = pegFlashRef.current[pi];

        // 1) Long "nail" tail shadow — drawn FIRST so anything else covers it.
        //    Wider + slightly tapered for a more legible "real shadow" feel.
        const tailLen = 34;
        const tailGrad = ctx.createLinearGradient(px, py + peg.r * 0.4, px, py + peg.r * 0.4 + tailLen);
        tailGrad.addColorStop(0,    'rgba(0, 0, 0, 0.65)');
        tailGrad.addColorStop(0.5,  'rgba(0, 0, 0, 0.28)');
        tailGrad.addColorStop(1,    'rgba(0, 0, 0, 0)');
        ctx.fillStyle = tailGrad;
        // Soft-edged tail via two stacked rects of decreasing alpha
        ctx.fillRect(px - 3,   py + peg.r * 0.4, 6, tailLen);          // wider, low alpha edges
        ctx.globalAlpha = 0.6;
        ctx.fillRect(px - 1.5, py + peg.r * 0.4, 3, tailLen * 0.95);   // sharper core
        ctx.globalAlpha = 1;

        // 2) Outer rim shadow ring — defines cavity edge against bg
        ctx.beginPath();
        ctx.arc(px, py, peg.r + 1.5, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
        ctx.fill();

        // 3) Concave silver pit — gradient INVERTED from balls.
        const lpx = px + peg.r * 0.38;
        const lpy = py + peg.r * 0.42;
        const pegGrad = ctx.createRadialGradient(lpx, lpy, 0, px, py, peg.r);
        pegGrad.addColorStop(0,    '#D2D0CB');
        pegGrad.addColorStop(0.5,  '#5C5A56');
        pegGrad.addColorStop(0.88, '#1F1D17');
        pegGrad.addColorStop(1,    '#15110C');
        ctx.beginPath();
        ctx.arc(px, py, peg.r, 0, Math.PI * 2);
        ctx.fillStyle = pegGrad;
        ctx.fill();

        // 4) Upper-left rim crescent — inside lip in shadow
        ctx.beginPath();
        ctx.arc(px, py, peg.r - 0.5, 1.1 * Math.PI, 1.85 * Math.PI);
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
        ctx.lineWidth = 1.2;
        ctx.stroke();

        // 5) Flash ring — drawn LAST so it appears in front of the tail shadow
        if (flash > 0) {
          const ringR = peg.r + (1 - flash) * 20;
          ctx.beginPath();
          ctx.arc(px, py, ringR, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(232, 226, 210, ${flash * 0.7})`;
          ctx.lineWidth = 2;
          ctx.stroke();
        }
      }

      // ── Top tray (holes + shake dome) — drawn here so balls render OVER them ─
      const tray = trayLayout(w);
      // Color sockets
      for (const h of tray.holes) {
        const r = HOLE_DIA / 2;
        // Outer dark cavity
        ctx.beginPath();
        ctx.arc(h.cx, h.cy, r, 0, Math.PI * 2);
        ctx.fillStyle = '#050300';
        ctx.fill();
        // Inset shadow on top of cavity (deeper at top, light catches on lower-right)
        const innerShadow = ctx.createRadialGradient(h.cx, h.cy - r * 0.5, 0, h.cx, h.cy, r);
        innerShadow.addColorStop(0,    'rgba(0, 0, 0, 0.95)');
        innerShadow.addColorStop(0.7,  'rgba(0, 0, 0, 0.4)');
        innerShadow.addColorStop(1,    'rgba(0, 0, 0, 0)');
        ctx.beginPath();
        ctx.arc(h.cx, h.cy, r - 1, 0, Math.PI * 2);
        ctx.fillStyle = innerShadow;
        ctx.fill();
        // Inner colored cup — darker tint of the marble color, slightly recessed
        const cupR = r * 0.62;
        const cupDark = shadeHex(h.color, 0.55);
        const cupGrad = ctx.createRadialGradient(h.cx, h.cy + cupR * 0.4, 0, h.cx, h.cy, cupR);
        cupGrad.addColorStop(0,   cupDark);
        cupGrad.addColorStop(0.7, shadeHex(h.color, 0.35));
        cupGrad.addColorStop(1,   shadeHex(h.color, 0.2));
        ctx.beginPath();
        ctx.arc(h.cx, h.cy, cupR, 0, Math.PI * 2);
        ctx.fillStyle = cupGrad;
        ctx.fill();
        // Bright top rim of the carved hole — catches light
        ctx.beginPath();
        ctx.arc(h.cx, h.cy + 0.5, r - 0.5, 1.05 * Math.PI, 1.95 * Math.PI);
        ctx.strokeStyle = 'rgba(255, 240, 220, 0.12)';
        ctx.lineWidth = 1;
        ctx.stroke();
        // Remaining-budget countdown below the hole — always shown.
        // When a count just decremented, briefly pulse it (scale + bright tint)
        // and float a small "−1" tick upward, so the player feels the cost.
        const remaining = colorCountsRef.current[h.color] ?? 0;
        const lastChange = colorChangeRef.current[h.color] ?? 0;
        const flashAge = performance.now() - lastChange;
        const flash = lastChange > 0 ? Math.max(0, 1 - flashAge / 380) : 0;
        const tx = h.cx;
        const ty = h.cy + r + 11;
        ctx.save();
        const scale = 1 + flash * 0.55;
        ctx.translate(tx, ty);
        ctx.scale(scale, scale);
        ctx.font = '500 11px "JetBrains Mono", ui-monospace, monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        if (remaining <= 0) {
          ctx.fillStyle = 'rgba(225, 110, 92, 0.95)';
        } else if (flash > 0) {
          // Lerp from base cream toward color-tinted bright cream
          const base = [232, 212, 181];
          const hi = [255, 240, 215];
          const lerp = (a: number, b: number) => Math.round(a + (b - a) * flash);
          const a = 0.66 + flash * 0.34;
          ctx.fillStyle = `rgba(${lerp(base[0], hi[0])}, ${lerp(base[1], hi[1])}, ${lerp(base[2], hi[2])}, ${a})`;
        } else {
          ctx.fillStyle = 'rgba(232, 212, 181, 0.66)';
        }
        ctx.fillText(String(remaining), 0, 0);
        ctx.restore();
        // Floating "−1" tick that drifts up + fades
        if (flash > 0 && remaining > 0) {
          ctx.save();
          ctx.font = '600 9px "JetBrains Mono", ui-monospace, monospace';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          const drift = (1 - flash) * 14;
          ctx.fillStyle = `rgba(${parseInt(h.color.slice(1, 3), 16)}, ${parseInt(h.color.slice(3, 5), 16)}, ${parseInt(h.color.slice(5, 7), 16)}, ${flash * 0.85})`;
          ctx.fillText('−1', tx, ty - 10 - drift);
          ctx.restore();
        }
      }

      // Shake dome — raised brass button with up-triangle icon
      {
        const cx = tray.shakeCx;
        const cy = tray.shakeCy;
        const r = HOLE_DIA / 2;
        // Drop shadow under the dome
        ctx.beginPath();
        ctx.ellipse(cx, cy + r * 0.65, r * 0.92, r * 0.32, 0, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
        ctx.fill();
        // Brass body — convex (light from upper-left)
        const lpx = cx - r * 0.32;
        const lpy = cy - r * 0.42;
        const domeGrad = ctx.createRadialGradient(lpx, lpy, 0, cx, cy, r);
        domeGrad.addColorStop(0,    '#F2D696');
        domeGrad.addColorStop(0.45, '#B89148');
        domeGrad.addColorStop(1,    '#5C4416');
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fillStyle = domeGrad;
        ctx.fill();
        // Hairline rim
        ctx.beginPath();
        ctx.arc(cx, cy, r - 0.5, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.45)';
        ctx.lineWidth = 1;
        ctx.stroke();
        // Up-arrow icon — chunky shaft + arrowhead, ink-stamp feel.
        const inkColor = 'rgba(70, 44, 10, 0.95)';
        ctx.fillStyle = inkColor;
        ctx.strokeStyle = inkColor;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        // Shaft — vertical line, drawn as a thick stroke for rounded ends
        ctx.beginPath();
        ctx.moveTo(cx, cy - 4);
        ctx.lineTo(cx, cy + 9);
        ctx.lineWidth = 5;
        ctx.stroke();
        // Arrowhead — chevron at top, also stroked round
        ctx.beginPath();
        ctx.moveTo(cx - 8, cy - 1);
        ctx.lineTo(cx, cy - 11);
        ctx.lineTo(cx + 8, cy - 1);
        ctx.lineWidth = 5;
        ctx.stroke();
      }

      // Sort balls by y so closer-to-bottom render on top (depth illusion)
      const sorted = [...ballsRef.current].sort((p, q) => p.y - q.y);

      for (const b of sorted) {
        const alpha = b.fading >= 1 ? 1 : Math.max(0, b.fading);

        // Born-glow halo for freshly merged balls — soft outer ring
        if (b.bornGlow > 0) {
          const glowR = b.r + b.bornGlow * 18;
          const glowGrad = ctx.createRadialGradient(b.x, b.y, b.r, b.x, b.y, glowR);
          glowGrad.addColorStop(0, `rgba(255, 240, 210, ${0.5 * b.bornGlow})`);
          glowGrad.addColorStop(1, 'rgba(255, 240, 210, 0)');
          ctx.beginPath();
          ctx.arc(b.x, b.y, glowR, 0, Math.PI * 2);
          ctx.fillStyle = glowGrad;
          ctx.fill();
        }

        // Cast shadow on the floor — relative to ball position + virtual light
        const shadowY = h - 4;
        const heightFromFloor = Math.max(0, shadowY - b.y);
        const shadowSpread = 1 + Math.min(1.4, heightFromFloor / (h * 0.5));
        const shadowAlpha = 0.45 - Math.min(0.32, heightFromFloor / (h * 1.6));
        ctx.beginPath();
        ctx.ellipse(b.x + heightFromFloor * 0.06, shadowY, b.r * shadowSpread, b.r * 0.28, 0, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(0, 0, 0, ${shadowAlpha * alpha})`;
        ctx.fill();

        // Body — radial gradient, light from upper-left
        const lx = b.x - b.r * 0.36;
        const ly = b.y - b.r * 0.42;
        const grad = ctx.createRadialGradient(lx, ly, b.r * 0.1, b.x, b.y, b.r);
        grad.addColorStop(0,    shadeHex(b.color, 1.32));
        grad.addColorStop(0.42, b.color);
        grad.addColorStop(1,    shadeHex(b.color, 0.66));
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
        ctx.globalAlpha = alpha;
        ctx.fillStyle = grad;
        ctx.fill();

        // Sharp specular highlight
        ctx.beginPath();
        ctx.ellipse(lx + b.r * 0.05, ly - b.r * 0.05, b.r * 0.18, b.r * 0.11, -0.6, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255, 246, 232, ${0.45 * alpha})`;
        ctx.fill();

        // Subtle rim — just a hairline darker
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.r - 0.5, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(0, 0, 0, ${0.18 * alpha})`;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      // Burst particles — small dots that spray outward when a ball pops
      for (const p of burstsRef.current) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r * p.life, 0, Math.PI * 2);
        ctx.fillStyle = p.color;
        ctx.globalAlpha = p.life;
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      // Springboard flash at the bottom (shake feedback) — quadratic arc
      const sf = shakeFlashRef.current;
      if (sf > 0) {
        const arc = Math.sin(sf * Math.PI) * 22;
        const baseY = h - 6;
        ctx.beginPath();
        ctx.moveTo(0, baseY);
        ctx.quadraticCurveTo(w / 2, baseY - arc, w, baseY);
        const grad = ctx.createLinearGradient(0, baseY - arc, 0, baseY + 4);
        grad.addColorStop(0, `rgba(232, 200, 130, ${sf * 0.85})`);
        grad.addColorStop(1, `rgba(120, 80, 40, ${sf * 0.4})`);
        ctx.strokeStyle = grad;
        ctx.lineWidth = 2.5;
        ctx.stroke();
        // Glow
        ctx.beginPath();
        ctx.moveTo(0, baseY);
        ctx.quadraticCurveTo(w / 2, baseY - arc, w, baseY);
        ctx.strokeStyle = `rgba(255, 220, 160, ${sf * 0.18})`;
        ctx.lineWidth = 8;
        ctx.stroke();
        shakeFlashRef.current = Math.max(0, sf - 0.045);
      }

      // Combo flourish — "×N" floats up + fades from the burst origin.
      const cf = comboFlashRef.current;
      if (cf) {
        const age = performance.now() - cf.t;
        const dur = 1100;
        if (age >= dur) {
          comboFlashRef.current = null;
        } else {
          const k = age / dur;
          const drift = k * 38;
          const alpha = (1 - k) * (1 - k);
          ctx.save();
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          // "COMBO" label
          ctx.font = '600 11px "JetBrains Mono", ui-monospace, monospace';
          const ctxL = ctx as CanvasRenderingContext2D & { letterSpacing?: string };
          ctxL.letterSpacing = '0.32em';
          ctx.fillStyle = `rgba(232, 212, 181, ${alpha * 0.9})`;
          ctx.fillText('COMBO', cf.x + 4, cf.y - 28 - drift);
          // "×N" big
          ctxL.letterSpacing = '0em';
          ctx.font = `700 ${28 + cf.n * 2}px "Cormorant Garamond", serif`;
          ctx.fillStyle = `rgba(255, 230, 190, ${alpha})`;
          ctx.fillText('×' + cf.n, cf.x, cf.y - 8 - drift);
          // Soft glow halo
          ctx.beginPath();
          ctx.arc(cf.x, cf.y - 14 - drift, 50 + cf.n * 4, 0, Math.PI * 2);
          const halo = ctx.createRadialGradient(cf.x, cf.y - 14 - drift, 0, cf.x, cf.y - 14 - drift, 50 + cf.n * 4);
          halo.addColorStop(0, `rgba(255, 220, 160, ${alpha * 0.18})`);
          halo.addColorStop(1, 'rgba(255, 220, 160, 0)');
          ctx.fillStyle = halo;
          ctx.fill();
          ctx.restore();
        }
      }

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // ── Spawn / clear handlers ────────────────────────────────────────────
  const spawnAt = (px: number, py: number) => {
    const r = MIN_R + Math.random() * (MAX_R - MIN_R);
    const ball: Ball = {
      id: ++ballIdRef.current,
      x: px, y: py,
      vx: (Math.random() - 0.5) * 1.4,
      vy: (Math.random() - 0.5) * 0.6,
      r,
      color: pickColor(),
      born: performance.now(),
      fading: 1,
      bornGlow: 0,
    };
    const list = ballsRef.current;
    if (list.length >= MAX_BALLS) {
      // start fading the oldest non-fading ball
      for (const b of list) { if (b.fading >= 1) { b.fading = 0.99; break; } }
    }
    list.push(ball);
    if (!hasTouched) { setHasTouched(true); hasTouchedRef.current = true; }
  };

  // Same as spawnAt but doesn't toggle hasTouched — used by attract mode.
  // Color is forced (one ball per palette color) so the cascade always
  // shows all six colors instead of repeating.
  const spawnAtAttract = (px: number, py: number, color: string) => {
    const r = MIN_R + Math.random() * (MAX_R - MIN_R);
    const ball: Ball = {
      id: ++ballIdRef.current,
      x: px, y: py,
      vx: (Math.random() - 0.5) * 0.8,
      vy: 0,
      r,
      color,
      born: performance.now(),
      fading: 1,
      bornGlow: 0,
    };
    const list = ballsRef.current;
    if (list.length >= MAX_BALLS) {
      for (const b of list) { if (b.fading >= 1) { b.fading = 0.99; break; } }
    }
    list.push(ball);
  };

  // Spawn a burst of particles at a position when a merged ball pops.
  // Particle count + speed scales with the source ball's radius for dramatic
  // scatters when a long-merged giant finally pops.
  const spawnBurst = (x: number, y: number, color: string, baseR: number) => {
    const n = Math.floor(18 + baseR * 0.7 + Math.random() * 6);
    const baseSpeed = 4 + baseR * 0.06;
    for (let i = 0; i < n; i++) {
      const angle = (Math.PI * 2 * i) / n + Math.random() * 0.5;
      const speed = baseSpeed + Math.random() * (3 + baseR * 0.05);
      burstsRef.current.push({
        x, y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 1.4,
        r: 2 + Math.random() * (baseR * 0.18),
        color,
        life: 1,
      });
    }
  };

  // Springboard shake — bounces all balls up to scramble the pile
  const shakeFlashRef = useRef(0);
  const lastShakeRef = useRef(0);
  const shakeAll = () => {
    if (gameOverRef.current) return;
    const now = performance.now();
    if (now - lastShakeRef.current < 280) return;   // rate-limit rapid taps
    lastShakeRef.current = now;
    ensureAudio();
    stopAttract();
    if (!hasTouched) { setHasTouched(true); hasTouchedRef.current = true; }
    for (const b of ballsRef.current) {
      if (b.fading < 1) continue;
      // Strong upward impulse + sideways scatter, scaled mildly with size.
      const sizeFactor = 1 + (b.r - MIN_R) / (MAX_R - MIN_R) * 0.25;
      b.vy = (-11 - Math.random() * 7) * sizeFactor;
      b.vx += (Math.random() - 0.5) * 7;
    }
    // Cost: shaking consumes one ball from every color's stock. If any color
    // would drop below zero, the run ends immediately (still a valid shake).
    let depleted = false;
    const t = performance.now();
    for (const c of PALETTE) {
      const next = (colorCountsRef.current[c.hex] ?? 0) - 1;
      colorCountsRef.current[c.hex] = next;
      colorChangeRef.current[c.hex] = t;
      if (next <= 0) depleted = true;
    }
    if (depleted) {
      gameOverRef.current = true;
      setGameOver(true);
      const final = burstScoreRef.current * 100;
      if (final > 0) submitScore(final).catch(() => { /* silent */ });
    }
    shakeFlashRef.current = 1;
    playThud();
  };
  // Keep the motion listener pointing at the latest shakeAll closure.
  shakeAllRef.current = shakeAll;

  // Wipe everything for a fresh run.
  const resetGame = () => {
    for (const c of PALETTE) {
      colorCountsRef.current[c.hex] = STARTING_BUDGET;
      colorChangeRef.current[c.hex] = 0;
    }
    burstScoreRef.current = 0;
    setScoreDisplay(0);
    ballsRef.current = [];
    burstsRef.current = [];
    lastBurstRef.current = 0;
    comboRef.current = 0;
    comboFlashRef.current = null;
    gameOverRef.current = false;
    setGameOver(false);
    setHasTouched(false);
    hasTouchedRef.current = false;
  };

  // Drop a single free ball at a given x, with a forced color, no stock cost.
  // Used by the combo "rainbow rain" reward.
  const dropFreeBall = (color: string, forcedX?: number) => {
    if (gameOverRef.current) return;
    const w = sizeRef.current.w || 390;
    const margin = HOLE_DIA;
    const x = forcedX !== undefined
      ? Math.max(margin, Math.min(w - margin, forcedX))
      : margin + Math.random() * (w - margin * 2);
    const r = MIN_R + Math.random() * (MAX_R - MIN_R);
    const ball: Ball = {
      id: ++ballIdRef.current,
      x, y: -10,
      vx: (Math.random() - 0.5) * 1.2,
      vy: 0,
      r,
      color,
      born: performance.now(),
      fading: 1,
      bornGlow: 1,
    };
    const list = ballsRef.current;
    if (list.length >= MAX_BALLS) {
      for (const b of list) { if (b.fading >= 1) { b.fading = 0.99; break; } }
    }
    list.push(ball);
  };

  // Stop attract mode permanently once user has interacted — clears any
  // pending color drops so they don't fire alongside the user's first taps.
  const stopAttract = () => {
    if (attractRef.current.length) {
      attractRef.current.forEach(clearTimeout);
      attractRef.current = [];
    }
  };

  const clearAll = () => {
    for (const b of ballsRef.current) {
      if (b.fading >= 1) b.fading = 0.99;
    }
  };

  // Pick a random color that still has stock (used by canvas-anywhere taps).
  const pickAvailableColor = (): string | null => {
    const available = PALETTE.filter(c => (colorCountsRef.current[c.hex] ?? 0) > 0);
    if (available.length === 0) return null;
    return available[Math.floor(Math.random() * available.length)].hex;
  };

  // Drop a ball from above the canvas at a given X (always from y=-10).
  // Decrements the chosen color's stock. Once any color reaches 0 → game over.
  const dropFromTop = (x: number, color?: string) => {
    if (gameOverRef.current) return;
    ensureAudio();
    stopAttract();
    const finalColor = color ?? pickAvailableColor();
    if (!finalColor) return;                      // every color exhausted
    if ((colorCountsRef.current[finalColor] ?? 0) <= 0) return;   // this color out

    const r = MIN_R + Math.random() * (MAX_R - MIN_R);
    const ball: Ball = {
      id: ++ballIdRef.current,
      x, y: -10,
      vx: 0, vy: 0,
      r,
      color: finalColor,
      born: performance.now(),
      fading: 1,
      bornGlow: 0,
    };
    const list = ballsRef.current;
    if (list.length >= MAX_BALLS) {
      for (const b of list) { if (b.fading >= 1) { b.fading = 0.99; break; } }
    }
    list.push(ball);
    colorCountsRef.current[finalColor] = (colorCountsRef.current[finalColor] ?? 0) - 1;
    colorChangeRef.current[finalColor] = performance.now();
    if (!hasTouched) { setHasTouched(true); hasTouchedRef.current = true; }
    // First color to hit zero ends the run.
    if (colorCountsRef.current[finalColor] === 0) {
      gameOverRef.current = true;
      setGameOver(true);
    }
  };

  // Tap on canvas → drop a random-color ball from the top at the touched X
  const onCanvasPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    requestMotionPerms();
    const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
    const x = e.clientX - rect.left;
    longPressFiredRef.current = false;
    longPressRef.current = setTimeout(() => {
      longPressFiredRef.current = true;
      clearAll();
    }, 700);
    dropFromTop(x);
  };
  const onCanvasPointerUp = () => {
    if (longPressRef.current) clearTimeout(longPressRef.current);
  };

  // Tap on a swatch in the tray → drop that color from the swatch's center X
  const onSwatchPress = (color: string, e: React.PointerEvent<HTMLButtonElement>) => {
    requestMotionPerms();
    const rect = e.currentTarget.getBoundingClientRect();
    dropFromTop(rect.left + rect.width / 2, color);
  };

  const isPoster = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('poster') === '1';

  return (
    <div className={`mb ${isPoster ? 'mb--poster' : ''}`}>
      <canvas
        ref={canvasRef}
        className="mb__canvas"
        onPointerDown={onCanvasPointerDown}
        onPointerUp={onCanvasPointerUp}
        onPointerCancel={onCanvasPointerUp}
      />
      {isPoster ? (
        <>
          <div className="mb__poster-title">MARBLES</div>
          <div className="mb__poster-tag">heirloom — gravity sandbox</div>
        </>
      ) : (
        <>
          <div className="mb__tray" aria-label="color tray">
            {PALETTE.map(c => (
              <button
                key={c.hex}
                type="button"
                className="mb__hole"
                onPointerDown={e => onSwatchPress(c.hex, e)}
                aria-label={`drop ${c.hex}`}
              />
            ))}
            <span className="mb__tray-divider" />
            <button
              type="button"
              className="mb__shake"
              onPointerDown={() => { requestMotionPerms(); shakeAll(); }}
              aria-label="shake to shuffle"
            />
          </div>
          <div className="mb__score">
            <span className="mb__score-label">score</span>
            <span className="mb__score-value">{(scoreDisplay * 100).toString().padStart(5, '0')}</span>
          </div>
          <div className="mb__brand">heirloom edition</div>
          {/* Sensor hint — Material Icons screen_rotation, shown after first touch.
              The icon itself is the iOS sensor-permission button: tapping it
              fires requestPermission() in a real user-gesture context. */}
          <div className={'mb__sensor-hint' + (showSensorHint ? ' is-visible' : '')}>
            <div
              className="mb__sensor-hint__icon"
              role="button"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation();
                requestMotionPerms();
                sensorHintDoneRef.current = true;
                setShowSensorHint(false);
              }}
            >
              <svg viewBox="0 0 24 24"><path d="M16.48 2.52c3.27 1.55 5.61 4.72 5.97 8.48h1.5C23.44 4.84 18.29 0 12 0l-.66.03 3.81 3.81 1.33-1.32zm-6.25-.77c-.59-.59-1.54-.59-2.12 0L1.75 8.11c-.59.59-.59 1.54 0 2.12l12.02 12.02c.59.59 1.54.59 2.12 0l6.36-6.36c.59-.59.59-1.54 0-2.12L10.23 1.75zm4.6 19.44L2.81 9.17l6.36-6.36 12.02 12.02-6.36 6.36zm-7.31.29C4.25 19.94 1.91 16.76 1.55 13H.05C.56 19.16 5.71 24 12 24l.66-.03-3.81-3.81-1.33 1.32z"/></svg>
            </div>
            <div className="mb__sensor-hint__label">Tilt &amp; Shake</div>
          </div>
          {debugMotion && (
            <div className="mb__debug">
              <div>status: {motionStatus}</div>
              <div>orient evts: {orientReceivedRef.current ? 'yes' : 'no'}</div>
              <div>motion evts: {motionReceivedRef.current ? 'yes' : 'no'}</div>
              <div>β:{Math.round(debugRef.current.beta)}° γ:{Math.round(debugRef.current.gamma)}°</div>
              <div>jolt:{debugRef.current.mag.toFixed(1)}</div>
              <div>embed: {isEmbeddedContext ? 'yes' : 'no'}</div>
              <div>tg active: {tgActiveRef.current ? 'yes' : 'no'}</div>
              <div>tg accel: {tgAccelStateRef.current}</div>
              <div>tg orient: {tgOrientStateRef.current}</div>
              <div>aigram br: {aigramBridgeStateRef.current}</div>
              <div>perm: {lastPermResult}</div>
            </div>
          )}
          {gameOver && (
            <div className="mb__game-over">
              <div className="mb__game-over__panel">
                <div className="mb__game-over__label">round complete</div>
                <div className="mb__game-over__score">{(scoreDisplay * 100).toString()}</div>
                <div className="mb__game-over__sub">{scoreDisplay} bursts × 100</div>
                <button className="mb__game-over__btn" onPointerDown={resetGame}>
                  play again
                </button>
                {canRank && (
                  <button
                    className="mb__game-over__lb"
                    onPointerDown={() => setShowLeaderboard(true)}
                  >
                    🏆 leaderboard
                  </button>
                )}
              </div>
            </div>
          )}
          {showLeaderboard && (
            <Leaderboard
              gameName="Marbles"
              isInAigram={isInAigram}
              onClose={() => setShowLeaderboard(false)}
              fetch={fetchLeaderboard}
            />
          )}
        </>
      )}
    </div>
  );
}
