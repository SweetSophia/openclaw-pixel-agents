import React, { useState, useEffect } from 'react';
import type { Room } from '../../shared/types';
import { TAG_COLORS, type AgentTag } from '../hooks/useAgentStore';
import './RoomSwitcher.css';

interface Props {
  activeRoomId: string;
  onRoomChange: (roomId: string) => void;
  agents: { roomId?: string; active: boolean; pixelEnabled: boolean; tags: string[] }[];
}

export const RoomSwitcher: React.FC<Props> = ({ activeRoomId, onRoomChange, agents }) => {
  const [rooms, setRooms] = useState<Room[]>([]);

  useEffect(() => {
    fetch('/api/rooms')
      .then(r => r.json())
      .then(data => setRooms(data.rooms || []))
      .catch((err) => console.error('[RoomSwitcher] Failed to fetch rooms:', err));
  }, []);

  return (
    <nav className="room-switcher">
      {rooms.map(room => {
        const isActive = room.id === activeRoomId;
        const roomAgents = agents.filter(a => a.roomId === room.id && a.pixelEnabled);
        const activeInRoom = roomAgents.filter(a => a.active).length;

        return (
          <button
            key={room.id}
            className={`room-tab ${isActive ? 'active' : ''}`}
            onClick={() => onRoomChange(room.id)}
            title={`${room.name} — ${room.primaryTag}`}
          >
            <span className="room-icon">{room.icon}</span>
            <span className="room-name">{room.name}</span>
            <span
              className="room-tag-dot"
              style={{ backgroundColor: TAG_COLORS[room.primaryTag as AgentTag] || '#666' }}
            />
            <span className="room-count">
              {activeInRoom}/{roomAgents.length}
            </span>
          </button>
        );
      })}
    </nav>
  );
};
