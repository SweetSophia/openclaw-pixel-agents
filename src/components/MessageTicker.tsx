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

const API_BASE = import.meta.env.VITE_API_BASE || window.location.origin;

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
    const socket = socketIO(API_BASE, { transports: ['websocket', 'polling'] });
    socketRef.current = socket;

    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));

    socket.on('ticker:messages', (msgs: TickerMessage[]) => {
      setMessages(msgs);
    });

    // Fetch initial state; abort if this effect is cleaned up before it resolves
    const controller = new AbortController();
    fetch(`${API_BASE}/api/messages`, { signal: controller.signal })
      .then(r => r.json())
      .then(data => {
        if (data.messages) setMessages(data.messages);
      })
      .catch(() => {});

    return () => {
      controller.abort();
      socket.disconnect();
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

  // Age-based opacity class
  const getAgeClass = (msg: TickerMessage) => {
    const age = Date.now() - msg.timestamp;
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
