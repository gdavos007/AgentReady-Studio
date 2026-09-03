/**
 * Terminal styling and tables.
 *
 * Implemented in-package rather than pulling in `chalk` and `cli-table3`.
 * A CI gate is installed globally and runs on every build in every repo that
 * adopts it, so its transitive dependency surface is a security property, not a
 * convenience question. This is ~150 lines against three packages and their
 * upgrade treadmill, and it lets the table do the column maths this report
 * actually needs (right-aligned numerics, ANSI-aware widths).
 *
 * Colour follows the conventions users expect: `NO_COLOR` and `FORCE_COLOR`
 * are honoured, and output is plain whenever stdout is not a TTY — which is
 * what keeps piped `--format pretty` readable in CI logs.
 */

/** The ANSI Control Sequence Introducer: ESC followed by `[`. */
const CSI = '\u001B[';

/** ANSI SGR codes used by the reporter. */
const CODES = {
  reset: 0,
  bold: 1,
  dim: 2,
  italic: 3,
  underline: 4,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
  white: 37,
  gray: 90,
  brightRed: 91,
  brightGreen: 92,
  brightYellow: 93,
} as const;

export type StyleName = keyof typeof CODES;

/** Decides once whether this process should emit colour. */
export function supportsColor(stream: { isTTY?: boolean } = process.stdout): boolean {
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '') return false;
  if (process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== '0') return true;
  if (process.env.TERM === 'dumb') return false;
  return Boolean(stream?.isTTY);
}

/** A styling function bound to a colour decision. */
export interface Style {
  (value: string, ...styles: StyleName[]): string;
  readonly enabled: boolean;
}

/** Creates a styler. Pass `enabled: false` for plain output. */
export function createStyle(enabled: boolean = supportsColor()): Style {
  const style = ((value: string, ...styles: StyleName[]): string => {
    if (!enabled || styles.length === 0) return value;
    const open = styles.map((name) => `${CSI}${CODES[name]}m`).join('');
    return `${open}${value}${CSI}${CODES.reset}m`;
  }) as { (value: string, ...styles: StyleName[]): string; enabled: boolean };

  style.enabled = enabled;
  return style as Style;
}

/** Matches an SGR escape sequence. */
const ANSI_PATTERN = /\u001B\[[0-9;]*m/g;

/** Strips ANSI escapes so widths can be measured on styled text. */
export function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, '');
}

/** Visible width of a string, ignoring escape sequences. */
export function displayWidth(value: string): number {
  return stripAnsi(value).length;
}

/** Pads to `width`, measuring visible characters rather than bytes. */
export function pad(value: string, width: number, align: 'left' | 'right' = 'left'): string {
  const padding = ' '.repeat(Math.max(0, width - displayWidth(value)));
  return align === 'right' ? padding + value : value + padding;
}

/** Truncates to `width`, appending an ellipsis when it had to cut. */
export function truncate(value: string, width: number): string {
  const plain = stripAnsi(value);
  if (plain.length <= width) return value;
  if (width <= 1) return plain.slice(0, Math.max(0, width));
  // Truncating styled text would strand an unterminated escape, so cut the
  // plain form — the caller can re-style the result.
  return `${plain.slice(0, width - 1)}…`;
}

/** One column of a {@link renderTable}. */
export interface TableColumn {
  header: string;
  align?: 'left' | 'right';
  /** Hard cap on the rendered width; content beyond it is truncated. */
  maxWidth?: number;
}

export interface TableOptions {
  columns: TableColumn[];
  rows: string[][];
  /** Two spaces of gutter by default. */
  gutter?: string;
  /** Prefix every line, e.g. for indentation. */
  indent?: string;
  style?: Style;
}

/**
 * Renders a borderless, column-aligned table.
 *
 * Borderless on purpose: box-drawing characters survive a terminal but not a
 * copy-paste into an issue, and the whole point of this output is that someone
 * pastes it somewhere.
 */
export function renderTable(options: TableOptions): string {
  const { columns, rows } = options;
  const style = options.style ?? createStyle(false);
  const gutter = options.gutter ?? '  ';
  const indent = options.indent ?? '';

  const capped = rows.map((row) =>
    row.map((cell, index) => {
      const max = columns[index]?.maxWidth;
      return max ? truncate(cell ?? '', max) : (cell ?? '');
    }),
  );

  const widths = columns.map((column, index) =>
    Math.max(displayWidth(column.header), ...capped.map((row) => displayWidth(row[index] ?? ''))),
  );

  const header = columns
    .map((column, index) => style(pad(column.header, widths[index], column.align), 'dim', 'bold'))
    .join(gutter);

  const body = capped.map((row) =>
    columns.map((column, index) => pad(row[index] ?? '', widths[index], column.align)).join(gutter),
  );

  return [indent + header, ...body.map((line) => indent + line)].join('\n');
}

/** A horizontal meter, e.g. a 16-cell bar of filled and empty blocks. */
export function renderBar(value: number, max: number, width = 16): string {
  const safeMax = max > 0 ? max : 1;
  const ratio = Math.min(1, Math.max(0, Number.isFinite(value) ? value / safeMax : 0));
  const filled = Math.round(ratio * width);
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled));
}

/** A horizontal rule the width of the terminal, capped for readability. */
export function rule(width = terminalWidth()): string {
  return '─'.repeat(Math.max(8, Math.min(width, 100)));
}

/** Terminal width, with a sane default when there is no TTY. */
export function terminalWidth(): number {
  const columns = process.stdout?.columns;
  return typeof columns === 'number' && columns > 0 ? columns : 100;
}
