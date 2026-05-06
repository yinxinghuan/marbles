import { useEffect, useRef, useState } from 'react';
import './Marbles.less';

// ── Aesthetic palette: muted Morandi heirloom colors with one rare accent ───
interface ColorEntry { hex: string; weight: number }
const PALETTE: ColorEntry[] = [
  { hex: '#D9B391', weight: 25 }, // peach sand
  { hex: '#A98E73', weight: 20 }, // warm taupe
  { hex: '#7B8B7E', weight: 15 }, // sage gray
  { hex: '#6B7B91', weight: 12 }, // muted slate
  { hex: '#9C7187', weight: 10 }, // dusty plum
  { hex: '#C7A875', weight: 10 }, // golden ochre
  { hex: '#E8D4B5', weight: 6  }, // ivory cream
  { hex: '#B8513E', weight: 2  }, // terracotta — rare accent
];
const PALETTE_TOTAL = PALETTE.reduce((s, c) => s + c.weight, 0);
function pickColor(): string {
  let r = Math.random() * PALETTE_TOTAL;
  for (const c of PALETTE) { if ((r -= c.weight) <= 0) return c.hex; }
  return PALETTE[0].hex;
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
  x: number; y: number;
  vx: number; vy: number;
  r: number;
  color: string;
  born: number;                   // ms
  fading: number;                 // 0..1 → 0 means fading to gone
}

// ── Hex parsing helper ────────────────────────────────────────────────────
function shadeHex(hex: string, amount: number): string {
  const c = parseInt(hex.slice(1), 16);
  const r = Math.max(0, Math.min(255, Math.round(((c >> 16) & 0xff) * amount)));
  const g = Math.max(0, Math.min(255, Math.round(((c >> 8) & 0xff) * amount)));
  const b = Math.max(0, Math.min(255, Math.round((c & 0xff) * amount)));
  return `rgb(${r}, ${g}, ${b})`;
}

export default function Marbles() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ballsRef = useRef<Ball[]>([]);
  const gravityRef = useRef({ gx: 0, gy: GRAVITY_BASE });
  const sizeRef = useRef({ w: 0, h: 0 });
  const grainRef = useRef<HTMLCanvasElement | null>(null);
  const longPressRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFiredRef = useRef(false);
  const [hasTouched, setHasTouched] = useState(false);
  const [count, setCount] = useState(0);

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

  // Tilt → gravity vector (DeviceOrientation). Smoothly lerped.
  useEffect(() => {
    function onOrient(e: DeviceOrientationEvent) {
      // gamma: -90..90 left/right, beta: -180..180 forward/back
      const gx = Math.max(-1, Math.min(1, (e.gamma ?? 0) / 45));
      const gy = Math.max(-1, Math.min(1, (e.beta ?? 0) / 45));
      const targetX = gx * GRAVITY_BASE * 1.4;
      const targetY = Math.max(0.05, gy * GRAVITY_BASE * 1.4);
      // lerp gravity for smoothness
      gravityRef.current.gx += (targetX - gravityRef.current.gx) * 0.06;
      gravityRef.current.gy += (targetY - gravityRef.current.gy) * 0.06;
    }
    window.addEventListener('deviceorientation', onOrient);
    return () => window.removeEventListener('deviceorientation', onOrient);
  }, []);

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

      // Ball-ball collisions (O(n²) is fine under MAX_BALLS=140)
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
          if (sq >= minDist * minDist || sq < 0.01) continue;
          const dist = Math.sqrt(sq);
          const nx = dx / dist;
          const ny = dy / dist;
          // separate by overlap (mass-weighted by radius)
          const overlap = (minDist - dist) / 2;
          a.x -= nx * overlap;
          a.y -= ny * overlap;
          b.x += nx * overlap;
          b.y += ny * overlap;
          // velocity along normal
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

      // ── Garbage collect fully faded ─────────────────────────────────────
      ballsRef.current = balls.filter(b => b.fading > 0);

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

      // Sort balls by y so closer-to-bottom render on top (depth illusion)
      const sorted = [...ballsRef.current].sort((p, q) => p.y - q.y);

      for (const b of sorted) {
        const alpha = b.fading >= 1 ? 1 : Math.max(0, b.fading);

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

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // ── Spawn / clear handlers ────────────────────────────────────────────
  const spawnAt = (px: number, py: number) => {
    const r = MIN_R + Math.random() * (MAX_R - MIN_R);
    const ball: Ball = {
      x: px, y: py,
      vx: (Math.random() - 0.5) * 1.4,
      vy: (Math.random() - 0.5) * 0.6,
      r,
      color: pickColor(),
      born: performance.now(),
      fading: 1,
    };
    const list = ballsRef.current;
    if (list.length >= MAX_BALLS) {
      // start fading the oldest non-fading ball
      for (const b of list) { if (b.fading >= 1) { b.fading = 0.99; break; } }
    }
    list.push(ball);
    setCount(list.length);
    if (!hasTouched) setHasTouched(true);
  };

  const clearAll = () => {
    for (const b of ballsRef.current) {
      if (b.fading >= 1) b.fading = 0.99;
    }
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    longPressFiredRef.current = false;
    longPressRef.current = setTimeout(() => {
      longPressFiredRef.current = true;
      clearAll();
    }, 700);
    // Spawn immediately on tap-down for responsiveness
    const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
    spawnAt(e.clientX - rect.left, e.clientY - rect.top);
  };
  const onPointerUp = () => {
    if (longPressRef.current) clearTimeout(longPressRef.current);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    // dragging continuously spawns sparingly (every ~9 px)
    if (e.buttons === 0) return;
    const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const last = lastDragRef.current;
    if (last) {
      const dx = x - last.x, dy = y - last.y;
      if (dx * dx + dy * dy < 64) return;
    }
    lastDragRef.current = { x, y };
    if (longPressRef.current) { clearTimeout(longPressRef.current); longPressRef.current = null; }
    spawnAt(x, y);
  };
  const lastDragRef = useRef<{ x: number; y: number } | null>(null);

  const isPoster = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('poster') === '1';

  return (
    <div className={`mb ${isPoster ? 'mb--poster' : ''}`}>
      <canvas
        ref={canvasRef}
        className="mb__canvas"
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerMove={onPointerMove}
        onPointerCancel={onPointerUp}
      />
      {isPoster ? (
        <>
          <div className="mb__poster-title">MARBLES</div>
          <div className="mb__poster-tag">heirloom — gravity sandbox</div>
        </>
      ) : (
        <>
          {!hasTouched && <div className="mb__hint">tap</div>}
          <div className="mb__counter">{count.toString().padStart(4, '0')}</div>
          <div className="mb__brand">heirloom marbles</div>
        </>
      )}
    </div>
  );
}
