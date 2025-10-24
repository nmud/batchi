export const pretty = (obj: unknown) => JSON.stringify(obj, null, 2);

export function section(title: string) {
  console.log("");
  console.log(title);
}

export function kv(
  label: string,
  value?: string | number | null,
  style?: (s: string) => string,
  width = 28,
  sep = "  "
) {
  if (value === undefined || value === null || value === "") return;
  const padded = label.padEnd(width, " ");
  const styledLabel = style ? style(padded) : padded;
  console.log(`${styledLabel}${sep}${value}`);
}

// Simple ANSI color helpers (no external deps)
const wrap = (open: string, close = "\x1b[0m") => (s: string) => `${open}${s}${close}`;
export const colors = {
  reset: wrap("\x1b[0m"),
  bold: wrap("\x1b[1m"),
  dim: wrap("\x1b[2m"),
  red: wrap("\x1b[31m"),
  green: wrap("\x1b[32m"),
  yellow: wrap("\x1b[33m"),
  blue: wrap("\x1b[34m"),
  magenta: wrap("\x1b[35m"),
  cyan: wrap("\x1b[36m"),
  gray: wrap("\x1b[90m"),
  // bright variants
  brightRed: wrap("\x1b[91m"),
  brightGreen: wrap("\x1b[92m"),
  brightYellow: wrap("\x1b[93m"),
  brightBlue: wrap("\x1b[94m"),
  brightMagenta: wrap("\x1b[95m"),
  brightCyan: wrap("\x1b[96m"),
};