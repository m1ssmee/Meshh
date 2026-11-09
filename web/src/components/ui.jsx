import React from 'react';

export const STATUS_TEXT = {
  pending: 'Waiting',
  running: 'Working',
  done: 'Done',
  failed: 'Failed',
  skipped: 'Skipped',
  stopped: 'Stopped',
  planning: 'Planning',
  awaiting_approval: 'Plan ready',
  summarizing: 'Summarizing',
  review: 'Ready to review',
  applied: 'Applied',
  discarded: 'Discarded',
  interrupted: 'Interrupted',
};

export function Led({ status, size = 10, label }) {
  return (
    <span
      className={`led led-${status}`}
      style={{ width: size, height: size }}
      role="img"
      aria-label={label || STATUS_TEXT[status] || status}
      title={STATUS_TEXT[status] || status}
    />
  );
}

export function AgentMark({ agent, name, size = 26 }) {
  const color = agent?.color || '#8a94a3';
  return (
    <span className="agent-mark" style={{ '--c': color, width: size, height: size, fontSize: size * 0.5 }} aria-hidden="true">
      {agent?.icon || (name || '?')[0]}
    </span>
  );
}

export function AgentTag({ agent, name }) {
  return (
    <span className="agent-tag" style={{ '--c': agent?.color || '#8a94a3' }}>
      <span className="agent-tag-dot" />
      {name || agent?.name}
    </span>
  );
}

// Tiny, safe markdown: escapes HTML first, then supports headings, bold, italics,
// inline code, code fences, bullet and numbered lists, and paragraphs.
function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
    .replace(/(^|\W)_([^_]+)_(?=\W|$)/g, '$1<em>$2</em>');
}
export function mdToHtml(md = '') {
  const lines = md.replace(/\r/g, '').split('\n');
  let html = '';
  let list = null;
  let code = null;
  let para = [];
  const flushPara = () => {
    if (para.length) html += `<p>${inline(para.join(' '))}</p>`;
    para = [];
  };
  const closeList = () => {
    if (list) html += `</${list}>`;
    list = null;
  };
  for (const line of lines) {
    if (code !== null) {
      if (line.startsWith('```')) {
        html += `<pre><code>${esc(code.join('\n'))}</code></pre>`;
        code = null;
      } else code.push(line);
      continue;
    }
    if (line.startsWith('```')) {
      flushPara();
      closeList();
      code = [];
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)/);
    const ul = line.match(/^\s*[-*]\s+(.*)/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)/);
    if (h) {
      flushPara();
      closeList();
      const lvl = Math.min(4, h[1].length + 2);
      html += `<h${lvl}>${inline(h[2])}</h${lvl}>`;
    } else if (ul || ol) {
      flushPara();
      const tag = ul ? 'ul' : 'ol';
      if (list !== tag) {
        closeList();
        html += `<${tag}>`;
        list = tag;
      }
      html += `<li>${inline((ul || ol)[1])}</li>`;
    } else if (!line.trim()) {
      flushPara();
      closeList();
    } else {
      closeList();
      para.push(line.trim());
    }
  }
  if (code !== null) html += `<pre><code>${esc(code.join('\n'))}</code></pre>`;
  flushPara();
  closeList();
  return html;
}

export function Markdown({ text, className = '' }) {
  return <div className={`md ${className}`} dangerouslySetInnerHTML={{ __html: mdToHtml(text) }} />;
}

export function Empty({ title, children, action }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function ErrorNote({ error, onClose }) {
  if (!error) return null;
  return (
    <div className="error-note" role="alert">
      <span>{error}</span>
      {onClose && (
        <button className="btn-text" onClick={onClose} aria-label="Dismiss">
          Dismiss
        </button>
      )}
    </div>
  );
}
