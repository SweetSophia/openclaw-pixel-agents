import React, { useState, useEffect, useRef } from 'react';
import { sfx } from '../audio/SoundFX';
import './SoundControls.css';

export const SoundControls: React.FC = () => {
  const [muted, setMuted] = useState(sfx.muted);
  const [volume, setVolume] = useState(sfx.volume);
  const [ambience, setAmbience] = useState(sfx.ambienceOn);
  const [expanded, setExpanded] = useState(false);
  const initRef = useRef(false);

  // Unlock AudioContext on first user interaction
  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;

    const unlock = () => {
      sfx.click(); // triggers ensureCtx → resume
      document.removeEventListener('click', unlock);
      document.removeEventListener('keydown', unlock);
    };
    document.addEventListener('click', unlock, { once: true });
    document.addEventListener('keydown', unlock, { once: true });
  }, []);

  const toggleMute = () => {
    sfx.setMuted(!muted);
    setMuted(!muted);
    if (!muted) sfx.click(); // play one more before muting
  };

  const handleVolume = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = parseFloat(e.target.value);
    sfx.setVolume(v);
    setVolume(v);
  };

  const toggleAmbience = () => {
    sfx.toggleAmbience();
    setAmbience(!ambience);
  };

  return (
    <div className={`sound-controls ${expanded ? 'expanded' : ''}`}>
      <button
        className="sound-toggle"
        onClick={toggleMute}
        title={muted ? 'Unmute' : 'Mute'}
      >
        {muted ? '🔇' : volume > 0.6 ? '🔊' : volume > 0.2 ? '🔉' : '🔈'}
      </button>

      <button
        className="sound-expand"
        onClick={() => setExpanded(!expanded)}
        title="Sound settings"
      >
        ⚙️
      </button>

      {expanded && (
        <div className="sound-panel">
          <label className="sound-slider-row">
            <span>Volume</span>
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={volume}
              onChange={handleVolume}
            />
            <span className="sound-pct">{Math.round(volume * 100)}%</span>
          </label>

          <button
            className={`sound-ambience ${ambience ? 'on' : ''}`}
            onClick={toggleAmbience}
          >
            {ambience ? '🌐 Ambience ON' : '🌐 Ambience OFF'}
          </button>
        </div>
      )}
    </div>
  );
};
