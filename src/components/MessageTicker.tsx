/**
 * MessageTicker — horizontal scrolling feed of recent agent messages
 *
 * Displays a news-ticker style bar at the bottom of the pixel office
 * showing the latest messages from all active agents. Pauses on hover.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { io as socketIO, Socket } from 'socket.io-client';
import type { TickerMessage } from '../../shared/types';
import './MessageTicker.css';

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || 'http://localhost:3001';

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
  const socketRef = useRef<Socket | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);

  // Connect to WebSocket
  useEffect(() => {
    const socket = socketIO(SOCKET_URL, { transports: ['websocket', 'polling'] });
    socketRef.current = socket;

    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));

    socket.on('ticker:messages', (msgs: TickerMessage[]) => {
      setMessages(msgs);
    });

    // Fetch initial state
    fetch(`${SOCKET_URL}/api/messages`)
      .then(r => r.json())
      .then(data => {
        if (data.messages) setMessages(data.messages);
      })
      .catch(() => {});

    return () => {
      socket.disconnect();
    };
  }, []);

  // Calculate scroll duration and width based on content
  const updateScrollParams = useCallback(() => {
    if (!trackRef.current) return;
    const track = trackRef.current;

    // Measure total content width
    const contentWidth = track.scrollWidth;
    const containerWidth = track.parentElement?.clientWidth || 800;

    // Total distance = content width (starts off-screen right) + container width
    const totalDistance = contentWidth;
    const duration = Math.max(20, totalDistance / 40); // ~40px per second

    track.style.setProperty('--ticker-width', `-${totalDistance}px`);
    track.style.setProperty('--ticker-duration', `${duration}s`);
  }, [messages]);

  useEffect(() => {
    // Delay to let DOM update
    const timer = setTimeout(updateScrollParams, 100);
    return () => clearTimeout(timer);
  }, [messages, updateScrollParams]);

  // Age-based opacity class
  const getAgeClass = (msg: TickerMessage) => {
    const age = Date.now() - msg.timestamp;
    if (age < 60000) return 'visible'; // < 1 min: full
    if (age < 180000) return 'visible'; // < 3 min: full
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
