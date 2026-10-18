import { useEffect, useState } from 'react';
import { getCachedTickerMessages, getSharedSocket } from '../socket';
import type { TickerMessage } from '../../shared/types';
import './MessageTicker.css';

/** Actual transcript excerpts, kept separate from inferred agent activity. */
export default function MessageTicker() {
  const [messages, setMessages] = useState<TickerMessage[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    let cancelled = false;
    let receivedSocketSnapshot = false;
    const socket = getSharedSocket();
    const handleMessages = (next: TickerMessage[]) => {
      receivedSocketSnapshot = true;
      if (!cancelled) { setMessages(next); setStatus('ready'); }
    };
    socket.on('ticker:messages', handleMessages);
    const cached = getCachedTickerMessages();
    if (cached) { setMessages(cached); setStatus('ready'); }

    const controller = new AbortController();
    fetch('/api/messages', { signal: controller.signal })
      .then(response => {
        if (!response.ok) throw new Error('Messages unavailable');
        return response.json();
      })
      .then(data => {
        if (!Array.isArray(data.messages)) throw new Error('Invalid message snapshot');
        if (!cancelled && !receivedSocketSnapshot) { setMessages(data.messages); setStatus('ready'); }
      })
      .catch(() => { if (!cancelled && !receivedSocketSnapshot) setStatus('error'); });
    return () => {
      cancelled = true;
      controller.abort();
      socket.off('ticker:messages', handleMessages);
    };
  }, []);

  return (
    <section className="transcript-messages" aria-label="Transcript messages">
      <h2>Messages</h2>
      {status === 'error' && <p className="activity-empty" role="status">Messages unavailable. Waiting for the next transcript update.</p>}
      {messages.length === 0 && status !== 'error' && <p className="activity-empty">{status === 'loading' ? 'Loading transcript messages…' : 'No transcript messages available from this source.'}</p>}
      {messages.length > 0 && <ul>{messages.slice(-30).reverse().map(message => <li key={message.id}>
          <div className="transcript-meta"><strong>{message.agentName}</strong>
            <span>{message.role === 'user' ? 'User message' : 'Assistant message'}</span>
            <time dateTime={new Date(message.timestamp).toISOString()}>{new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
          </div>
          <p>{message.text}</p>
        </li>)}</ul>}
    </section>
  );
}
