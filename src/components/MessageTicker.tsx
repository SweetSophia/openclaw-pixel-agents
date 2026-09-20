/**
 * MessageTicker — horizontal scrolling feed of recent agent messages
 *
 * Displays a news-ticker style bar at the bottom of the pixel office
 * showing the latest messages from all active agents. Pauses on hover.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { getCachedTickerMessages, getSharedSocket } from '../socket';
import type { TickerMessage } from '../../shared/types';
import './MessageTicker.css';

/** Format timestamp to HH:MM */
function fmtTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Truncate text with ellipsis */
function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + '…';
}

export default function MessageTicker() {
  const [messages, setMessages] = useState<TickerMessage[]>([]);
  const [connected, setConnected] = useState(false);
  const [now, setNow] = useState(Date.now());

  const trackRef = useRef<HTMLDivElement>(null);

  // Tick every 30s so age-based opacity updates even when no new messages arrive
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  // Connect to WebSocket
  useEffect(() => {
    let isCancelled = false;
    // Issue #218: reuse the shared module-level socket instead of opening
    // a fresh connection. The dashboard previously maintained three
    // WebSocket connections per browser; the singleton collapses that to one.
    const socket = getSharedSocket();

    const handleConnect = () => { if (!isCancelled) setConnected(true); };
    const handleDisconnect = () => { if (!isCancelled) setConnected(false); };
    const handleMessages = (msgs: TickerMessage[]) => { if (!isCancelled) setMessages(msgs); };

    socket.on('connect', handleConnect);
    socket.on('disconnect', handleDisconnect);
    socket.on('ticker:messages', handleMessages);

    // Issue #218: a consumer mounting after the shared singleton has
    // already connected would miss the initial `connect` event. Run
    // the handler immediately if the socket is already connected.
    if (socket.connected) {
      handleConnect();
    }

    // Issue #218 (singleton + late consumers): if another consumer has
    // already received a `ticker:messages` snapshot, this consumer
    // missed it. Seed from the cached payload so we render the latest
    // ticker immediately rather than waiting for the next broadcast.
    const cachedMessages = getCachedTickerMessages();
    if (cachedMessages) {
      setMessages(cachedMessages);
    }

    // Fetch initial state; abort if this effect is cleaned up before it resolves
    const controller = new AbortController();
    fetch("/api/messages", { signal: controller.signal })
      .then(r => r.json())
      .then(data => {
        if (!isCancelled && data.messages) setMessages(data.messages);
      })
      .catch(() => {});

    return () => {
      isCancelled = true;
      controller.abort();
      socket.off('connect', handleConnect);
      socket.off('disconnect', handleDisconnect);
      socket.off('ticker:messages', handleMessages);
      // Do NOT call socket.disconnect() — the socket is shared with
      // useAgentStore and useLiveSync.
    };
  }, []);

  // Calculate scroll duration and width based on content
  const updateScrollParams = useCallback(() => {
    if (!trackRef.current) return;
    const track = trackRef.current;

    // Total distance the track must travel (content width + viewport width so
    // items fully exit on the left before looping)
    const totalDistance = track.scrollWidth + (track.parentElement?.clientWidth ?? 0);
    const duration = Math.max(20, totalDistance / 40); // ~40px per second

    track.style.setProperty('--ticker-width', `-${totalDistance}px`);
    track.style.setProperty('--ticker-duration', `${duration}s`);
  }, [messages]);

  useEffect(() => {
    // Delay to let DOM update
    const timer = setTimeout(updateScrollParams, 100);
    return () => clearTimeout(timer);
  }, [messages, updateScrollParams]);

  // Age-based opacity class — uses `now` state so it re-evaluates every 30s
  // even when no new messages arrive, ensuring old messages actually fade
  const getAgeClass = (msg: TickerMessage) => {
    const age = now - msg.timestamp;
    if (age < 180000) return 'visible'; // < 3 min: full opacity
    return 'fading'; // > 3 min: fading
  };

  return (
    <div className="ticker-container">
      <div className="ticker-label">
        {connected ? '📡 Live' : '⏳'}
      </div>
      <div className="ticker-track">
        {messages.length === 0 ? (
          <span className="ticker-empty">Waiting for agent activity…</span>
        ) : (
          <div className="ticker-messages" ref={trackRef}>
            {messages.map((msg) => (
              <span key={msg.id} className={`ticker-msg ${getAgeClass(msg)}`}>
                <span className={`ticker-msg-name ${msg.role === 'user' ? 'user-msg' : ''}`}>
                  {msg.role === 'user' ? '👤' : '🤖'} {msg.agentName}
                </span>
                <span className={`ticker-msg-text ${msg.role === 'user' ? 'user-msg' : ''}`}>
                  {truncate(msg.text, 120)}
                </span>
                <span className="ticker-msg-time">{fmtTime(msg.timestamp)}</span>
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
