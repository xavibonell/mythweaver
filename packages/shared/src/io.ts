/**
 * I/O seam (spec §8). Text-first in v1; voice (STT/TTS/diarization) is a later
 * phase that implements this same interface so the orchestrator/"brain" never
 * changes when the channel does.
 */

export interface InboundMessage {
  /** Which player/character is speaking (manual selection in text-first, spec §8). */
  speakerId: string;
  text: string;
}

export interface OutboundMessage {
  /** 'narration' = the DM speaking; 'roll-request' = ask a player to roll; 'system' = meta. */
  kind: 'narration' | 'roll-request' | 'system';
  text: string;
  /** Present when kind === 'roll-request'. */
  rollRequestId?: string;
}

/**
 * A bidirectional channel between the table and the orchestrator. A text web
 * client and a future voice runtime are both just implementations of this.
 */
export interface IoChannel {
  send(message: OutboundMessage): Promise<void>;
  /** Resolves with the next inbound message from the table. */
  receive(): Promise<InboundMessage>;
}
