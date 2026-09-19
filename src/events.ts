// machine-readable progress for the ui. silent unless BEELINE_EVENTS is set,
// so the cli output stays clean for humans.

export type Event =
  | { type: "stage"; name: string; n: number; of: number }
  | { type: "run-start"; run: number; of: number; input: Record<string, string>; liveUrl?: string }
  | { type: "exchange"; run: number; method: string; path: string; status: number }
  | { type: "run-done"; run: number; exchanges: number; ms: number; sessionUrl?: string }
  | { type: "spec"; flow: string }
  | { type: "client"; flow: string; lines: number }
  | { type: "verified"; ok: boolean; httpMs: number; browserMs: number; speedup: number; detail: string }
  | { type: "failed"; message: string }
  | { type: "log"; line: string };

const on = !!process.env.BEELINE_EVENTS;

export function emit(event: Event) {
  if (on) console.log(`::beeline ${JSON.stringify(event)}`);
}
