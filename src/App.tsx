import React from 'react';
import { PixelOffice } from './components/PixelOffice';
import { AgentSidebar } from './components/AgentSidebar';
import { useAgentStore } from './hooks/useAgentStore';
import './App.css';

export const App: React.FC = () => {
  const { agents, connected, toggleAgent, toggleAll } = useAgentStore();

  return (
    <div className="app">
      <header className="app-header">
        <h1>🖥️ OpenClaw Pixel Agents</h1>
        <span className={`connection-status ${connected ? 'connected' : 'disconnected'}`}>
          {connected ? '● Connected' : '○ Disconnected'}
        </span>
      </header>
      <main className="app-main">
        <PixelOffice agents={agents} />
        <AgentSidebar agents={agents} onToggle={toggleAgent} onToggleAll={toggleAll} />
      </main>
    </div>
  );
};
