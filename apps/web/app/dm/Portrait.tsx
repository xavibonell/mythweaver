'use client';

import { SPRITES, DEFAULT_SPRITE } from '../play/manifest';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * A PORTRAIT is the person's own map sprite, blown up — the pixel art the table is already looking
 * at, so a face in the Book and a token on the green are recognisably the same villager. Frame 0 of
 * the idle sheet: the box is one frame wide and the sheet is scaled by height, so frames 1..n stay
 * outside the box. Falls back to a plain silhouette tag if the library hasn't loaded yet.
 */
export default function Portrait({ tag, size = 34 }: { tag?: string; size?: number }) {
  const s = SPRITES[tag ?? ''] ?? SPRITES[DEFAULT_SPRITE];
  const scale = s ? size / s.frameH : 2;
  return (
    <div
      style={{
        flex: '0 0 auto', width: s ? s.frameW * scale : size, height: size,
        border: '1px solid #2b3542', borderRadius: 4, background: '#171a21',
        ...(s ? {
          backgroundImage: `url(${s.src})`,
          backgroundSize: `auto ${s.frameH * scale}px`,
          backgroundPosition: '0 0',
          backgroundRepeat: 'no-repeat',
          imageRendering: 'pixelated' as const,
        } : {}),
      }}
    />
  );
}
