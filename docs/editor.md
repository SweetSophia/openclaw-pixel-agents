# Office editor

Open **Editor** to arrange furniture. View navigation and editing are separate: turn Pan off before selecting agents or placing items. Changing editor tools exits Pan automatically.

| Action | Control |
| --- | --- |
| Find furniture | Open Furniture; search by label or canonical type, e.g. `large plant` or `LARGE_PLANT`. |
| Place | Choose a type, then click the grid; touch placement commits on release. |
| Select | Click a placed item. |
| Move | Drag an item. |
| Rotate | Right-click or use Rotate in the info bar. |
| Delete | Use Delete in the info bar, or enable Delete mode and select an item. |
| Save | Wait for autosave, or use Save explicitly. |
| Manage designs | Open Layouts to create, switch or delete layouts. |

Search ignores case and outer whitespace and matches a single substring. Clear or Escape resets the query without cancelling the selected furniture type. Search survives panel changes within one editor session and clears when the editor closes. Rotate and Delete are click controls, not keyboard shortcuts.

## Footprint previews

The outline shows the loaded sprite's rotated grid footprint and its anchor. Amber indicates overlap, border contact or extent outside the canvas. Overlap is allowed for intentional table/decor layering. A missing sprite uses the same conservative 2×1 footprint as rendering/pathfinding.

The preview describes the rendered 24×16 canvas; it is informational and does not guarantee a valid save. An anchor outside the allowed map can still be rejected by the server. Alpha-aware picking and existing mouse/touch placement rules remain separate from drawing order.

On touch, small movement retains the touch-start placement cell; movement beyond the placement threshold cancels placement. Two-finger gestures navigate instead of placing. Cancellation, leaving the canvas or changing tools clears the preview.

## Layout persistence

Furniture edits auto-save after two seconds. Layout revisions prevent a stale browser from silently overwriting newer edits. A deleted layout is not recreated by a late save. The built-in default layout cannot be deleted.

The layouts directory has a capacity of 100 entries, including stray non-layout files. Delete unused layouts before creating another when the limit is reached. If the warning persists, inspect that directory as the operator; malformed files require operator cleanup.

Keep `DATA_DIR` persistent across upgrades. See the [configuration reference](configuration.md#persistent-storage).
