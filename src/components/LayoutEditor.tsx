import React, { useState } from 'react';
import type { PlacedFurniture } from '../../shared/types';
import type { LayoutDoc } from '../hooks/useLayoutStore';
import './LayoutEditor.css';

interface Props {
  catalog: string[];
  activeLayout: LayoutDoc | null;
  layouts: LayoutDoc[];
  editorMode: boolean;
  selectedFurnitureType: string | null;
  selectedFurnitureId: string | null;
  deleteMode: boolean;
  onSelectFurnitureType: (type: string | null) => void;
  onSelectFurnitureId: (id: string | null) => void;
  onPlaceFurniture: (type: string, x: number, y: number) => void;
  onMoveFurniture: (id: string, x: number, y: number) => void;
  onRotateFurniture: (id: string) => void;
  onDeleteFurniture: (id: string) => void;
  onToggleDeleteMode: () => void;
  onSave: () => void;
  onLoad: (id: string) => void;
  onCreate: (name: string) => void;
  onDeleteLayout: (id: string) => void;
  onToggleEditor: () => void;
}

const FURNITURE_ICONS: Record<string, string> = {
  DESK: '🪑',
  PC: '🖥️',
  CHAIR: '💺',
  CUSHIONED_CHAIR: '💺',
  WOODEN_CHAIR: '💺',
  SOFA: '🛋️',
  CUSHIONED_BENCH: '🛋️',
  WOODEN_BENCH: '🪵',
  LARGE_PLANT: '🌿',
  PLANT: '🌱',
  PLANT_2: '🌵',
  CACTUS: '🌵',
  HANGING_PLANT: '🌸',
  POT: '🪴',
  COFFEE: '☕',
  COFFEE_TABLE: '☕',
  SMALL_TABLE: '🪧',
  TABLE_FRONT: '📋',
  BOOKSHELF: '📚',
  DOUBLE_BOOKSHELF: '📚',
  WHITEBOARD: '📋',
  CLOCK: '🕐',
  LARGE_PAINTING: '🖼️',
  SMALL_PAINTING: '🖼️',
  SMALL_PAINTING_2: '🎨',
  BIN: '🗑️',
};

const FURNITURE_LABELS: Record<string, string> = {
  DESK: 'Desk',
  PC: 'PC',
  CUSHIONED_CHAIR: 'Cushion Chair',
  WOODEN_CHAIR: 'Wood Chair',
  SOFA: 'Sofa',
  CUSHIONED_BENCH: 'Cushion Bench',
  WOODEN_BENCH: 'Wood Bench',
  LARGE_PLANT: 'Large Plant',
  PLANT: 'Plant',
  PLANT_2: 'Plant 2',
  CACTUS: 'Cactus',
  HANGING_PLANT: 'Hanging Plant',
  POT: 'Pot',
  COFFEE: 'Coffee',
  COFFEE_TABLE: 'Coffee Table',
  SMALL_TABLE: 'Small Table',
  TABLE_FRONT: 'Table',
  BOOKSHELF: 'Bookshelf',
  DOUBLE_BOOKSHELF: 'Dbl Bookshelf',
  WHITEBOARD: 'Whiteboard',
  CLOCK: 'Clock',
  LARGE_PAINTING: 'Lg Painting',
  SMALL_PAINTING: 'Sm Painting',
  SMALL_PAINTING_2: 'Sm Painting 2',
  BIN: 'Bin',
};

// Group furniture into categories for the palette
const CATEGORIES = [
  {
    name: 'Desks & Seating',
    types: ['DESK', 'CUSHIONED_CHAIR', 'WOODEN_CHAIR', 'SOFA', 'CUSHIONED_BENCH', 'WOODEN_BENCH'],
  },
  {
    name: 'Plants',
    types: ['LARGE_PLANT', 'PLANT', 'PLANT_2', 'CACTUS', 'HANGING_PLANT', 'POT'],
  },
  {
    name: 'Electronics',
    types: ['PC', 'WHITEBOARD', 'CLOCK'],
  },
  {
    name: 'Tables & Decor',
    types: ['COFFEE', 'COFFEE_TABLE', 'SMALL_TABLE', 'TABLE_FRONT', 'BOOKSHELF', 'DOUBLE_BOOKSHELF', 'LARGE_PAINTING', 'SMALL_PAINTING', 'SMALL_PAINTING_2', 'BIN'],
  },
];

export const LayoutEditor: React.FC<Props> = ({
  catalog,
  activeLayout,
  layouts,
  editorMode,
  selectedFurnitureType,
  selectedFurnitureId,
  deleteMode,
  onSelectFurnitureType,
  onSelectFurnitureId,
  onRotateFurniture,
  onDeleteFurniture,
  onToggleDeleteMode,
  onSave,
  onLoad,
  onCreate,
  onDeleteLayout,
  onToggleEditor,
}) => {
  const [showPalette, setShowPalette] = useState(false);
  const [showLayouts, setShowLayouts] = useState(false);
  const [newName, setNewName] = useState('');

  if (!editorMode) return null;

  const selectedFurniture = activeLayout?.furniture.find(f => f.id === selectedFurnitureId);

  return (
    <div className="layout-editor">
      {/* Toolbar */}
      <div className="editor-toolbar">
        <button
          className={`toolbar-btn ${showPalette ? 'active' : ''}`}
          onClick={() => { setShowPalette(!showPalette); setShowLayouts(false); }}
          title="Furniture palette"
        >
          📦 Furniture
        </button>
        <button
          className={`toolbar-btn ${deleteMode ? 'active danger' : ''}`}
          onClick={onToggleDeleteMode}
          title="Delete mode — click placed items to remove them"
        >
          🗑️ Delete
        </button>
        <button
          className={`toolbar-btn ${showLayouts ? 'active' : ''}`}
          onClick={() => { setShowLayouts(!showLayouts); setShowPalette(false); }}
          title="Layout manager"
        >
          📐 Layouts
        </button>
        <div className="toolbar-separator" />
        <button className="toolbar-btn save-btn" onClick={onSave} title="Save layout">
          💾 Save
        </button>
        <button className="toolbar-btn" onClick={onToggleEditor} title="Exit editor">
          ✖ Close
        </button>
      </div>

      {/* Selected furniture info */}
      {selectedFurniture && (
        <div className="selected-info">
          <span className="selected-name">
            {FURNITURE_LABELS[selectedFurniture.type] || selectedFurniture.type}
          </span>
          <span className="selected-pos">
            ({selectedFurniture.x}, {selectedFurniture.y}) r{selectedFurniture.rotation}°
          </span>
          <button className="action-btn" onClick={() => onRotateFurniture(selectedFurniture.id)} title="Rotate (R)">🔄</button>
          <button className="action-btn danger" onClick={() => onDeleteFurniture(selectedFurniture.id)} title="Delete (Del)">🗑️</button>
          <button className="action-btn" onClick={() => onSelectFurnitureId(null)} title="Deselect">✖</button>
        </div>
      )}

      {/* Placement hint when type selected but nothing placed */}
      {selectedFurnitureType && !selectedFurnitureId && (
        <div className="placement-hint">
          Click on the office to place {FURNITURE_LABELS[selectedFurnitureType] || selectedFurnitureType}
          <button className="action-btn" onClick={() => onSelectFurnitureType(null)}>✖ Cancel</button>
        </div>
      )}

      {/* Delete mode hint */}
      {deleteMode && !selectedFurnitureType && (
        <div className="placement-hint danger">
          🗑️ Click on placed furniture to delete it
          <button className="action-btn" onClick={onToggleDeleteMode}>✖ Cancel</button>
        </div>
      )}

      {/* Furniture palette */}
      {showPalette && (
        <div className="furniture-palette">
          <h3>📦 Furniture</h3>
          {CATEGORIES.map(cat => (
            <div key={cat.name} className="palette-category">
              <h4>{cat.name}</h4>
              <div className="palette-items">
                {cat.types.filter(t => catalog.includes(t)).map(type => (
                  <button
                    key={type}
                    className={`palette-item ${selectedFurnitureType === type ? 'selected' : ''}`}
                    onClick={() => onSelectFurnitureType(selectedFurnitureType === type ? null : type)}
                    title={FURNITURE_LABELS[type] || type}
                  >
                    <span className="palette-icon">{FURNITURE_ICONS[type] || '📦'}</span>
                    <span className="palette-label">{FURNITURE_LABELS[type] || type}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Layout manager */}
      {showLayouts && (
        <div className="layout-manager">
          <h3>📐 Layouts</h3>
          <div className="layout-list">
            {layouts.map(layout => (
              <div
                key={layout.id}
                className={`layout-item ${activeLayout?.id === layout.id ? 'active' : ''}`}
              >
                <span className="layout-name">{layout.name}</span>
                <span className="layout-meta">
                  {layout.furniture.length} items · {new Date(layout.updatedAt).toLocaleDateString()}
                </span>
                <div className="layout-actions">
                  <button onClick={() => onLoad(layout.id)}>📂</button>
                  {layout.id !== 'default' && (
                    <button className="danger" onClick={() => onDeleteLayout(layout.id)}>🗑️</button>
                  )}
                </div>
              </div>
            ))}
          </div>
          <div className="layout-create">
            <input
              type="text"
              placeholder="New layout name..."
              value={newName}
              onChange={e => setNewName(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && newName.trim()) {
                  onCreate(newName.trim());
                  setNewName('');
                }
              }}
            />
            <button onClick={() => { if (newName.trim()) { onCreate(newName.trim()); setNewName(''); } }}>
              ➕ Create
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
