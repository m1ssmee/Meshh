// Minimal Markdown + YAML frontmatter parsing/serialising.
import YAML from 'yaml';

const FM = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parseFrontmatter(text) {
  const m = text.match(FM);
  if (!m) return { data: {}, body: text.trim() };
  let data = {};
  try {
    data = YAML.parse(m[1]) || {};
  } catch {
    data = {};
  }
  return { data, body: text.slice(m[0].length).trim() };
}

export function stringifyFrontmatter(data, body) {
  const clean = {};
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v) && v.length === 0) continue;
    clean[k] = v;
  }
  const yaml = YAML.stringify(clean, { lineWidth: 0 }).trim();
  return `---\n${yaml}\n---\n\n${(body || '').trim()}\n`;
}

// Claude Code accepts `tools: Read, Grep, Glob` or a YAML list.
export function toList(value) {
  if (!value) return null;
  if (Array.isArray(value)) return value.map(String).map((s) => s.trim()).filter(Boolean);
  return String(value)
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}
