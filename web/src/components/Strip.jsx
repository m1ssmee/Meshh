import React, { useEffect, useRef, useState } from 'react';
import { formatTokens } from '../api.js';
import { AgentMark, Led, Markdown, STATUS_TEXT } from './ui.jsx';

function LogLine({ e }) {
  switch (e.kind) {
    case 'phase':
      return <div className="log-phase">{e.text}</div>;
    case 'init':
      return <div className="log-meta">Started on {e.model}</div>;
    case 'text':
      return <Markdown className="log-text" text={e.text} />;
    case 'tool':
      return (
        <div className="log-tool">
          <span className="log-tool-name">{e.name}</span>
          <span className="log-tool-target">{e.target}</span>
        </div>
      );
    case 'tool_error':
      return (
        <div className="log-bad">
          {e.name ? `${e.name} failed: ` : ''}
          {e.text}
        </div>
      );
    case 'denied':
      return <div className="log-bad">{e.text}</div>;
    case 'warn':
      return <div className="log-warn">{e.text}</div>;
    case 'error':
      return <div className="log-bad">{e.text}</div>;
    case 'you':
      return (
        <div className="log-you">
          <span>You</span>
          {e.text}
        </div>
      );
    default:
      return <div className="log-raw">{e.text}</div>;
  }
}

export default function Strip({ title, subtitle, agent, agentName, status, logs = [], tokens, cost, files, error, canStop, onStop, canMessage, onMessage, wide }) {
  const bodyRef = useRef(null);
  const stick = useRef(true);
  const [msg, setMsg] = useState('');
  const [sending, setSending] = useState(false);

  useEffect(() => {
    const el = bodyRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [logs.length]);

  const onScroll = () => {
    const el = bodyRef.current;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  const send = async (e) => {
    e.preventDefault();
    if (!msg.trim()) return;
    setSending(true);
    try {
      await onMessage(msg.trim());
      setMsg('');
    } finally {
      setSending(false);
    }
  };

  return (
    <section className={`strip strip-${status} ${wide ? 'strip-wide' : ''}`} style={{ '--c': agent?.color || '#8a94a3' }} aria-label={`${agentName}: ${title}`}>
      <header className="strip-head">
        <AgentMark agent={agent} name={agentName} />
        <div className="strip-who">
          <span className="strip-agent">{agentName}</span>
          <span className="strip-status">
            <Led status={status} size={8} /> {STATUS_TEXT[status] || status}
          </span>
        </div>
        {canStop && (
          <button className="btn-quiet strip-stop" onClick={onStop} title="Stop this agent">
            Stop
          </button>
        )}
      </header>
      <div className="strip-task">
        {subtitle && <span className="strip-id">{subtitle}</span>}
        {title}
      </div>
      <div className="strip-body" ref={bodyRef} onScroll={onScroll}>
        {logs.length === 0 && <div className="log-meta">{status === 'pending' ? 'Waiting for its turn.' : 'No activity yet.'}</div>}
        {logs.map((e, i) => (
          <LogLine key={i} e={e} />
        ))}
        {error && status !== 'running' && <div className="log-bad">{error}</div>}
      </div>
      <footer className="strip-foot">
        <span title="Tokens used (input + output)">{formatTokens(tokens)} tokens</span>
        {cost > 0 && <span title="Estimated cost reported by Claude Code">${cost.toFixed(2)}</span>}
        {files?.length > 0 && <span title={files.join('\n')}>{files.length} file{files.length === 1 ? '' : 's'}</span>}
      </footer>
      {canMessage && (
        <form className="strip-msg" onSubmit={send}>
          <input
            value={msg}
            onChange={(e) => setMsg(e.target.value)}
            placeholder={`Follow up with ${agentName}…`}
            aria-label={`Message ${agentName}`}
            disabled={sending}
          />
          <button className="btn-quiet" disabled={sending || !msg.trim()}>
            Send
          </button>
        </form>
      )}
    </section>
  );
}
