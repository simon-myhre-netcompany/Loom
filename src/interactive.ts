/**
 * Interactive prompts, built on Node's stdlib readline — no dependencies.
 * Only used when running at a TTY (or with --interactive); agents never hit it.
 *
 * We drive readline via a line *queue* rather than sequential question() calls:
 * a single 'line' listener buffers every line, and prompts pull from the buffer.
 * This is robust both at a TTY (lines arrive as typed) and over a pipe (all
 * lines arrive at once) — the latter breaks naive question()-per-prompt code.
 */
import { createInterface, type Interface } from 'node:readline';
import { stdin, stdout, stderr } from 'node:process';

let rl: Interface | undefined;
const lineQueue: string[] = [];
let waiting: ((line: string | null) => void) | null = null;
let closed = false;

function ensure(): void {
  if (rl) return;
  rl = createInterface({ input: stdin });
  rl.on('line', (line) => {
    if (waiting) {
      const w = waiting;
      waiting = null;
      w(line);
    } else {
      lineQueue.push(line);
    }
  });
  rl.on('close', () => {
    closed = true;
    if (waiting) {
      const w = waiting;
      waiting = null;
      w(null);
    }
  });
}

/** Read the next line, or null at end of input. */
function nextLine(): Promise<string | null> {
  ensure();
  if (lineQueue.length) return Promise.resolve(lineQueue.shift()!);
  if (closed) return Promise.resolve(null);
  return new Promise((resolve) => {
    waiting = resolve;
  });
}

/** Release stdin so the process can exit. Safe to call when never opened. */
export function closeInteractive(): void {
  rl?.close();
  rl = undefined;
}

/** Free-text prompt with an optional default. */
export async function ask(question: string, def?: string): Promise<string> {
  const suffix = def ? ` [${def}]` : '';
  stdout.write(`${question}${suffix}: `);
  const line = await nextLine();
  const answer = (line ?? '').trim();
  return answer || def || '';
}

/**
 * Free-text prompt with terminal echo suppressed — for secrets. Uses raw mode
 * so nothing is shown while typing/pasting; backspace is honoured. Over a pipe
 * (no TTY) it just reads the next line.
 */
export async function askHidden(question: string): Promise<string> {
  stdout.write(`${question} (input hidden): `);
  ensure();
  const wasRaw = stdin.isTTY ? stdin.isRaw : false;
  if (stdin.isTTY) stdin.setRawMode(true);
  try {
    const line = await nextLine();
    // In raw mode backspaces arrive as DEL/BS characters — apply them.
    const out: string[] = [];
    for (const ch of line ?? '') {
      if (ch === '\u007f' || ch === '\b') out.pop();
      else out.push(ch);
    }
    return out.join('').trim();
  } finally {
    if (stdin.isTTY) stdin.setRawMode(wasRaw);
    stdout.write('\n');
  }
}

/**
 * Yes/no confirmation for a write/destructive action. Prompt goes to STDERR so
 * it never mixes into the JSON/table the command prints on stdout. Defaults to
 * "no" on a bare Enter or end-of-input — the safe choice for a write.
 */
export async function confirm(question: string): Promise<boolean> {
  stderr.write(`${question} [y/N]: `);
  const line = await nextLine();
  return /^y(es)?$/i.test((line ?? '').trim());
}

/** Numbered single-choice menu. Returns the chosen item. */
export async function select<T>(
  question: string,
  choices: T[],
  labelOf: (t: T) => string
): Promise<T> {
  stdout.write(`${question}\n`);
  choices.forEach((c, i) => stdout.write(`  ${i + 1}) ${labelOf(c)}\n`));
  while (true) {
    stdout.write('Choose a number: ');
    const line = await nextLine();
    if (line === null) throw new Error('input ended before a choice was made');
    const n = Number(line.trim());
    if (Number.isInteger(n) && n >= 1 && n <= choices.length) return choices[n - 1];
    stdout.write(`Please enter 1–${choices.length}.\n`);
  }
}
