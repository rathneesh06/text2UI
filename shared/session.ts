// shared/session.ts — the Context Manager's data model. SessionSummary is a rolling,
// compact record of the deck session's accepted state (audience/tone/theme/topics) plus
// the recent user decisions; ChatTurn is the persisted conversation. Both are fed back to
// the planners so multi-turn editing stays coherent instead of drifting.
export interface ChatTurn { role: "user" | "assistant"; text: string; at: number }

export interface SessionSummary {
  audience?: string;
  tone?: string;
  theme?: string;
  slideCount: number;
  topics: string[];      // derived from slide titles
  decisions: string[];   // rolling list of what the user has asked for/changed
}