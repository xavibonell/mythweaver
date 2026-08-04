'use client';

/**
 * THE CHARACTER SHEET, at the table (docs/PLAYER-INTERFACE.md P2).
 *
 * A React port of the DM Lab's sheet modal — same section order and reading hierarchy, because that
 * layout was already tuned against a real sheet. Two differences that matter:
 *  · it reads the PLAYER payload, so an unidentified item arrives pre-masked from the server ("an
 *    unidentified weapon") rather than being hidden here — the client never holds the true name;
 *  · feature TEXT is rendered (collapsed), which the lab dropped: the payload always carried it.
 *
 * Every number here is ENGINE-DERIVED (modifiers, saves, passives, carry, slots). Nothing is computed
 * in the browser — the sheet is a view of the engine's truth, not a second opinion about it.
 */

import { useEffect } from 'react';

/* eslint-disable @typescript-eslint/no-explicit-any */

const signed = (n: number) => (n >= 0 ? `+${n}` : `${n}`);
const TIER_MARK: Record<string, string> = { expertise: '★', proficient: '●', half: '◐', none: '·' };
const SKILL_NAME = (k: string) => k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());

const C = {
  scrim: { position: 'fixed', inset: 0, background: 'rgba(6,7,10,0.72)', zIndex: 60, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 } as React.CSSProperties,
  modal: { width: 'min(880px, 96vw)', maxHeight: '86vh', overflow: 'auto', background: '#0f1116', border: '1px solid #23262f', borderRadius: 10, color: '#d8dbe2' } as React.CSSProperties,
  head: { display: 'flex', alignItems: 'flex-start', gap: 12, padding: '16px 18px', borderBottom: '1px solid #1d2027', position: 'sticky', top: 0, background: '#0f1116' } as React.CSSProperties,
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12, padding: 14 } as React.CSSProperties,
  card: { border: '1px solid #1d2027', borderRadius: 8, padding: 12, background: '#12141a' } as React.CSSProperties,
  cardTitle: { fontSize: 11, letterSpacing: 1.2, textTransform: 'uppercase', color: '#6b7080', marginBottom: 8 } as React.CSSProperties,
  row: { display: 'flex', justifyContent: 'space-between', gap: 10, padding: '3px 0', fontSize: 13 } as React.CSSProperties,
  sub: { color: '#6b7080', fontSize: 11 } as React.CSSProperties,
  pill: { display: 'inline-block', background: '#1d2530', border: '1px solid #2b3542', borderRadius: 10, padding: '1px 7px', margin: '2px 3px 2px 0', fontSize: 11, color: '#8fb8e0' } as React.CSSProperties,
  badge: { display: 'inline-block', borderRadius: 4, padding: '0 5px', marginLeft: 5, fontSize: 10, background: '#2a2f3a', color: '#9aa0b0' } as React.CSSProperties,
  x: { background: 'transparent', border: '1px solid #2b3542', color: '#9aa0b0', borderRadius: 6, width: 30, height: 30, cursor: 'pointer', fontSize: 14 } as React.CSSProperties,
};

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return <div style={C.row}><span style={{ color: '#9aa0b0' }}>{label}</span><span style={{ fontWeight: 600 }}>{value}</span></div>;
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return <div style={C.card}><div style={C.cardTitle}>{title}</div>{children}</div>;
}

export default function SheetModal({ pc, onClose }: { pc: any; onClose: () => void }) {
  // Esc closes. The table keeps playing behind the sheet, so this must not trap anything else.
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  if (!pc) return null;

  const xpPct = pc.xpNext && pc.xpNext > pc.xpThis ? Math.max(0, Math.min(100, Math.round((100 * (pc.xp - pc.xpThis)) / (pc.xpNext - pc.xpThis)))) : 100;
  const xpLabel = pc.xpNext ? `${pc.xp} / ${pc.xpNext} XP` : `${pc.xp} XP (max level)`;
  const sc = pc.spellcasting;
  const chips = (arr?: string[]) => (arr?.length ? arr.map((x, i) => <span key={i} style={C.pill}>{x}</span>) : <span style={C.sub}>—</span>);

  return (
    <div style={C.scrim} onClick={onClose}>
      <div style={C.modal} onClick={(e) => e.stopPropagation()}>
        <div style={C.head}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 22, fontWeight: 700, color: '#f0e6d2' }}>{pc.name}</div>
            <div style={C.sub}>
              {pc.ancestry} · {pc.className} · Level {pc.level}
              {pc.inspiration ? ' · ★ Inspiration' : ''}{pc.exhaustion ? ` · Exhaustion ${pc.exhaustion}` : ''}
            </div>
            <div style={{ height: 4, background: '#1d2027', borderRadius: 3, marginTop: 8 }}><div style={{ width: `${xpPct}%`, height: '100%', background: '#c9a227', borderRadius: 3 }} /></div>
            <div style={{ ...C.sub, marginTop: 4 }}>{xpLabel}</div>
          </div>
          <button style={C.x} onClick={onClose} aria-label="close">✕</button>
        </div>

        <div style={C.grid}>
          <Card title="Core">
            <Stat label="Hit Points" value={`${pc.hp?.cur} / ${pc.hp?.max}${pc.hp?.temp ? ` (+${pc.hp.temp} temp)` : ''}`} />
            <Stat label="Armor Class" value={pc.ac} />
            <Stat label="Speed" value={`${pc.speed} ft`} />
            <Stat label="Initiative" value={signed(pc.initiative)} />
            <Stat label="Proficiency" value={signed(pc.prof)} />
            {pc.hitDice && <Stat label="Hit Dice" value={`${pc.hitDice.remaining} / ${pc.hitDice.max} d${pc.hitDice.size}`} />}
            {pc.passives && <Stat label="Passive Per / Inv / Ins" value={`${pc.passives.perception} / ${pc.passives.investigation} / ${pc.passives.insight}`} />}
            {/* A dying PC is the one thing the table must never miss. */}
            {pc.downed && <Stat label="DOWNED" value={pc.deathSaves ? `saves ${pc.deathSaves.successes}✓ / ${pc.deathSaves.failures}✗` : 'dying'} />}
            {pc.conditions?.length ? <Stat label="Conditions" value={pc.conditions.join(', ')} /> : null}
            {pc.concentration && <Stat label="Concentrating on" value={pc.concentration} />}
          </Card>

          <Card title="Abilities">
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
              {(pc.abilities ?? []).map((a: any) => (
                <div key={a.key} style={{ border: `1px solid ${a.saveProf ? '#3d5a80' : '#1d2027'}`, borderRadius: 6, padding: '7px 4px', textAlign: 'center', background: '#0f1116' }}>
                  <div style={{ ...C.sub, textTransform: 'uppercase' }}>{a.key}</div>
                  <div style={{ fontSize: 20, fontWeight: 700 }}>{signed(a.mod)}</div>
                  <div style={C.sub}>{a.score}</div>
                  <div style={C.sub}>save {signed(a.save)}</div>
                </div>
              ))}
            </div>
          </Card>

          <Card title="Skills">
            {(pc.skills ?? []).map((s: any) => (
              <div key={s.key} style={{ ...C.row, color: s.tier !== 'none' ? '#d8dbe2' : '#8a90a0' }}>
                <span><span style={{ color: '#c9a227', marginRight: 6 }}>{TIER_MARK[s.tier] ?? '·'}</span>{SKILL_NAME(s.key)}</span>
                <span><span style={{ ...C.sub, textTransform: 'uppercase', marginRight: 8 }}>{s.ability}</span><b>{signed(s.mod)}</b></span>
              </div>
            ))}
          </Card>

          {pc.attacks?.length ? (
            <Card title="Attacks">
              {pc.attacks.map((at: any, i: number) => <Stat key={i} label={at.name} value={`${signed(at.attackBonus)} · ${at.damage} ${at.damageType}`} />)}
            </Card>
          ) : null}

          {sc ? (
            <Card title="Spellcasting">
              <Stat label="Spell Save DC" value={sc.saveDc} />
              <Stat label="Spell Attack" value={signed(sc.attack)} />
              {sc.preparedMax != null && <Stat label="Prepared" value={`${sc.prepared?.length ?? 0} / ${sc.preparedMax}`} />}
              <div style={{ ...C.sub, margin: '8px 0 3px' }}>Slots</div>
              {pc.slots?.length ? pc.slots.map((s: any) => <span key={s.level} style={C.pill}>L{s.level} {s.cur}/{s.max}</span>) : <span style={C.sub}>no slots</span>}
              <div style={{ ...C.sub, margin: '8px 0 3px' }}>Cantrips</div>{chips(sc.cantrips)}
              <div style={{ ...C.sub, margin: '8px 0 3px' }}>Prepared</div>{chips(sc.prepared)}
              {sc.rituals?.length ? (<><div style={{ ...C.sub, margin: '8px 0 3px' }}>Rituals <span style={{ color: '#6b7080' }}>(no slot)</span></div>{chips(sc.rituals)}</>) : null}
            </Card>
          ) : null}

          {pc.resources?.length ? (
            <Card title="Class Resources">
              {pc.resources.map((r: any) => <Stat key={r.id} label={`${r.id} (${r.recharge} rest)`} value={`${r.current} / ${r.max}`} />)}
            </Card>
          ) : null}

          <Card title="Inventory">
            <div style={{ marginBottom: 8 }}>
              <span style={C.pill}><b>{pc.currency?.gp ?? 0}</b> gp</span><span style={C.pill}><b>{pc.currency?.sp ?? 0}</b> sp</span><span style={C.pill}><b>{pc.currency?.cp ?? 0}</b> cp</span>
            </div>
            {pc.carry && (
              <div style={{ ...C.sub, color: pc.carry.over ? '#d08f7f' : '#6b7080', marginBottom: 7 }}>
                Carry {pc.carry.lb} / {pc.carry.cap} lb{pc.carry.over ? ' — OVERLOADED' : ''}
                {pc.attunement ? ` · Attuned ${pc.attunement.used}/${pc.attunement.max}` : ''}
              </div>
            )}
            {pc.items?.length ? pc.items.map((it: any, i: number) => (
              <div key={i} style={C.row}>
                <span style={{ flex: 1 }}>
                  {it.name}{it.qty > 1 ? ` ×${it.qty}` : ''}
                  {it.equippedSlot && <span style={C.badge}>{it.equippedSlot}</span>}
                  {it.attuned && <span style={C.badge}>attuned</span>}
                  {it.charges && <span style={C.badge}>{it.charges.remaining}/{it.charges.max} chg</span>}
                </span>
                <span style={C.sub}>{it.weightLb} lb</span>
              </div>
            )) : <span style={C.sub}>(nothing carried)</span>}
          </Card>

          {(pc.backstory || pc.features?.length) ? (
            <Card title="Story & Features">
              {pc.backstory && <div style={{ fontSize: 13, lineHeight: 1.5, marginBottom: 10, color: '#c3c8d4' }}>{pc.backstory}</div>}
              {(pc.features ?? []).map((f: any, i: number) => (
                <details key={i} style={{ marginTop: 4 }}>
                  <summary style={{ cursor: 'pointer', color: '#c9a227', fontSize: 12 }}>{f.name ?? f}</summary>
                  {f.text && <div style={{ ...C.sub, marginTop: 3, lineHeight: 1.5 }}>{f.text}</div>}
                </details>
              ))}
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  );
}
