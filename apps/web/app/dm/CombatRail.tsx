'use client';

/**
 * THE INITIATIVE RAIL (docs/COMBAT-MODE.md C2) — the fight's order, on the table.
 *
 * BG3's top-center portrait strip, adapted for one shared screen: a chip per combatant in initiative
 * order, the active one lit gold, the fallen grayed with a skull. Enemy health is a WORD and a colour
 * (unharmed / wounded / bloodied / near death) — the exact numbers are the engine's business, and
 * "how hurt is it?" reading as texture instead of arithmetic is the point. Faces are the tokens' own
 * sprites (the same Portrait the Book uses), so the rail and the map are recognisably the same people.
 */

import Portrait from './Portrait';

/* eslint-disable @typescript-eslint/no-explicit-any */

const HEALTH_COLOR: Record<string, string> = {
  unharmed: '#3fa34d',
  wounded: '#d6c25b',
  bloodied: '#d08f3f',
  'near death': '#c0533f',
  down: '#6b7080',
  dead: '#494f5a',
};

export default function CombatRail({ combat, mapObjects = [] }: { combat: any; mapObjects?: any[] }) {
  if (!combat?.order?.length) return null;
  const tagFor = (id: string, name: string): string | undefined =>
    mapObjects.find((o: any) => o.id === id)?.tag ?? mapObjects.find((o: any) => o.name === name)?.tag;
  return (
    <div style={{ position: 'absolute', top: 8, left: '50%', transform: 'translateX(-50%)', zIndex: 25, display: 'flex', alignItems: 'center', gap: 6, background: 'rgba(12,14,19,0.92)', border: '1px solid #23262f', borderRadius: 10, padding: '6px 10px', backdropFilter: 'blur(3px)' }}>
      <div style={{ color: '#c9a227', fontFamily: 'ui-serif, Georgia, serif', fontSize: 12, marginRight: 4, whiteSpace: 'nowrap' }}>
        Round {combat.round}
      </div>
      {combat.order.map((c: any) => {
        const color = HEALTH_COLOR[c.healthWord] ?? '#8a90a0';
        return (
          <div
            key={c.id}
            title={`${c.name} — ${c.healthWord}${c.isActive ? ' · acting now' : ''}`}
            style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, padding: '3px 5px',
              borderRadius: 8, minWidth: 44,
              border: c.isActive ? '1px solid #c9a227' : '1px solid transparent',
              background: c.isActive ? 'rgba(201,162,39,0.14)' : 'transparent',
              transform: c.isActive ? 'scale(1.06)' : 'none',
              opacity: c.down ? 0.45 : 1,
              transition: 'transform 120ms ease, opacity 120ms ease',
            }}
          >
            <div style={{ position: 'relative' }}>
              <Portrait tag={tagFor(c.id, c.name)} size={26} />
              {c.down && <span style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', fontSize: 13 }}>💀</span>}
            </div>
            <span style={{ fontSize: 9, color: c.isActive ? '#e8d9a0' : '#9aa0b0', maxWidth: 52, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {c.name}
            </span>
            <span style={{ width: 22, height: 3, borderRadius: 2, background: color }} />
          </div>
        );
      })}
    </div>
  );
}
