'use client';

/**
 * THE PARTY DOCK (docs/PLAYER-INTERFACE.md P2) — the party, ambient, over the map's bottom-left.
 *
 * It replaces the HP strip that lived in the transcript rail: the rail is the table's spine (the DM's
 * voice, the roll bar, the input) and shouldn't also be a status board. Each chip carries the same ring
 * colour the token wears on the map, so "who is that blue ring?" answers itself without a legend.
 *
 * Click a chip → that character's sheet. The dock is deliberately the only always-on addition to the
 * canvas: the map stays the thing you look at.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// Same order/colours SceneCanvas draws PC rings in, so chip and token agree at a glance.
const RING = ['#5b8dd6', '#5bd68d', '#d6c25b', '#d65b8d', '#8d5bd6'];

export default function PartyDock({ party, onOpen }: { party: any[]; onOpen: (id: string) => void }) {
  if (!party?.length) return null;
  return (
    <div style={{ position: 'absolute', left: 10, bottom: 10, display: 'flex', gap: 6, flexWrap: 'wrap', zIndex: 20 }}>
      {party.map((pc, i) => {
        const cur = pc.hp?.cur ?? 0;
        const max = pc.hp?.max ?? 1;
        const pct = Math.max(0, Math.min(100, Math.round((100 * cur) / (max || 1))));
        // Colour the bar by how much trouble they're in — green → amber → red is read faster than a number.
        const bar = pc.downed ? '#8a2b2b' : pct > 60 ? '#3fa34d' : pct > 25 ? '#c9a227' : '#c0533f';
        const marks = [
          pc.concentration ? '◎' : '',
          pc.inspiration ? '★' : '',
          pc.exhaustion ? `exh${pc.exhaustion}` : '',
          ...(pc.conditions ?? []).slice(0, 2),
        ].filter(Boolean).join(' ');
        return (
          <button
            key={pc.id ?? pc.name}
            onClick={() => onOpen(pc.id ?? pc.name)}
            title={`${pc.name} — open sheet`}
            style={{
              display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer', textAlign: 'left',
              background: 'rgba(15,17,22,0.86)', border: `1px solid ${pc.downed ? '#8a2b2b' : '#23262f'}`,
              borderRadius: 8, padding: '5px 9px', color: '#d8dbe2', backdropFilter: 'blur(2px)',
            }}
          >
            <span style={{ width: 9, height: 9, borderRadius: '50%', background: RING[i % RING.length], flex: '0 0 auto' }} />
            <span style={{ minWidth: 0 }}>
              <span style={{ fontSize: 12, fontWeight: 600, display: 'block', lineHeight: 1.2 }}>
                {pc.name}{pc.downed ? <span style={{ color: '#d08f7f', fontWeight: 400 }}> · down</span> : null}
              </span>
              <span style={{ display: 'block', width: 96, height: 4, background: '#1d2027', borderRadius: 3, marginTop: 3 }}>
                <span style={{ display: 'block', width: `${pct}%`, height: '100%', background: bar, borderRadius: 3 }} />
              </span>
              {marks ? <span style={{ fontSize: 10, color: '#6b7080', display: 'block', marginTop: 2 }}>{marks}</span> : null}
            </span>
            <span style={{ fontSize: 11, color: '#8a90a0', flex: '0 0 auto' }}>{cur}/{max}</span>
          </button>
        );
      })}
    </div>
  );
}
