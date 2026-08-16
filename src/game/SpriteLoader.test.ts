import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  getComposedCharacter,
  getSpriteFrame,
  loadAllAssets,
  loadCharacters,
  loadFloors,
  loadFurniture,
  recomposeAgent,
  type ReadonlyAssets,
  type ReadonlyComposedCharacter,
  type ReadonlyLoadedCharacter,
  type ReadonlyLoadedFloor,
  type ReadonlyLoadedFurnitureItem,
  type ReadonlySpriteFrame,
} from './SpriteLoader';

describe('SpriteLoader public API contracts (issue #132)', () => {
  it('loadCharacters returns a readonly view per element (issue #132)', () => {
    // The public loader path is the only application path into the cache
    // (the getters have no callers). The return type must be the readonly
    // view so consumers cannot reassign `characters[0]`, `.down`, or any
    // frame field. Compare against the explicit `ReadonlyLoadedCharacter`
    // shape so a future regression that widens back to the mutable builder
    // type fails `tsc --noEmit`.
    expectTypeOf(loadCharacters).returns.toEqualTypeOf<
      Promise<readonly ReadonlyLoadedCharacter[]>
    >();
  });

  it('loadFloors returns a readonly view per element (issue #132)', () => {
    expectTypeOf(loadFloors).returns.toEqualTypeOf<
      Promise<readonly ReadonlyLoadedFloor[]>
    >();
  });

  it('loadFurniture returns a readonly map of readonly values (issue #132)', () => {
    // Both the map and the values must be readonly — `ReadonlyMap` locks
    // the map shape, `ReadonlyLoadedFurnitureItem` locks the entry shape.
    expectTypeOf(loadFurniture).returns.toEqualTypeOf<
      Promise<ReadonlyMap<string, ReadonlyLoadedFurnitureItem>>
    >();
  });

  it('loadAllAssets returns a readonly bundle (issue #132)', () => {
    expectTypeOf(loadAllAssets).returns.toEqualTypeOf<Promise<ReadonlyAssets>>();
  });

  it('recomposeAgent returns a readonly view per element (issue #132)', () => {
    // The single-character recompose path must enforce the same readonly
    // contract as the bulk loaders. If a future regression widens this
    // back to the mutable `LoadedCharacter` builder type, callers would
    // receive a type that lets them mutate `sprite.down`, `.splice(0)`,
    // and `frame.width` — the exact defect Sophie flagged in the
    // 2026-08-01 Fagan inspection (issuecomment-5152033381, finding #1).
    expectTypeOf(recomposeAgent).returns.toEqualTypeOf<
      ReadonlyLoadedCharacter | null
    >();
  });

  it('getComposedCharacter returns a readonly composed view (issue #132)', () => {
    // `getComposedCharacter` exposes the underlying `cachedComposed`
    // entry. Without the readonly view, a caller could reassign
    // `composed.down`, `.splice(0)` the direction array, mutate frame
    // canvas dimensions through the cached array, or replace the
    // portrait — escaping the cache boundary that this PR hardens
    // (Sophie's final review 2026-08-01, issuecomment-5152941112,
    // blocking finding on `getComposedCharacter()`).
    expectTypeOf(getComposedCharacter).returns.toEqualTypeOf<
      ReadonlyComposedCharacter | null
    >();
  });

  it('ReadonlyComposedCharacter is independently deep (issue #132)', () => {
    // Keep the expected shape inline so it cannot drift with the named
    // interface under test. This catches a dropped readonly modifier even
    // when getComposedCharacter and its return-type oracle change together.
    expectTypeOf<ReadonlyComposedCharacter>().toEqualTypeOf<{
      readonly down: readonly HTMLCanvasElement[];
      readonly up: readonly HTMLCanvasElement[];
      readonly right: readonly HTMLCanvasElement[];
      readonly portrait: HTMLCanvasElement;
    }>();
  });

  it('getComposedCharacter mutation probes are type-rejected (issue #132)', () => {
    // Compile-time negative controls. Each `@ts-expect-error` line
    // suppresses a known TS2540 / TS2339 error that is *expected* to
    // occur against the readonly view. If a future regression widens
    // the return type back to `ComposedCharacter | null`, or drops
    // `readonly` from any field of `ReadonlyComposedCharacter`, the
    // corresponding directive becomes unused and `tsc` emits TS2578
    // ("Unused '@ts-expect-error' directive"), failing
    // `npm run typecheck`. Probes are type-only — never executed.
    const probe = (composed: ReadonlyComposedCharacter) => {
      // @ts-expect-error TS2540 — 'down' is readonly
      composed.down = [];
      // @ts-expect-error TS2540 — 'up' is readonly
      composed.up = [];
      // @ts-expect-error TS2540 — 'right' is readonly
      composed.right = [];
      // @ts-expect-error TS2339 — no `splice` on readonly array
      composed.down.splice(0);
      // @ts-expect-error TS2540 — 'portrait' is readonly
      composed.portrait = document.createElement('canvas');
    };
    void probe;
  });

  it('recomposeAgent mutation probes — every assignment is type-rejected (issue #132)', () => {
    // Compile-time negative controls. Each `@ts-expect-error` line
    // suppresses a known TS2540 / TS2551 error that is *expected* to
    // occur against the readonly view. If a future regression removes
    // `readonly` from `ReadonlyLoadedCharacter.down`, from the
    // `readonly ReadonlySpriteFrame[]` shape, or from the
    // `readonly canvas / width / height` fields of `ReadonlySpriteFrame`,
    // the corresponding `@ts-expect-error` directive will have nothing
    // to suppress and `tsc` will emit TS2578 ("Unused '@ts-expect-error'
    // directive"), failing `npm run typecheck`. The probes are
    // type-only — they are never executed at runtime.
    type _ProbeSprite = ReadonlyLoadedCharacter | null;
    const probe = (sprite: _ProbeSprite) => {
      if (!sprite) return;
      // @ts-expect-error TS2540 — 'down' is readonly
      sprite.down = [];
      // @ts-expect-error TS2551 — 'splice' on readonly array
      sprite.down.splice(0);
      // @ts-expect-error TS2540 — 'width' is readonly
      sprite.down[0]!.width = 0;
    };
    void probe;
  });

  it('ReadonlySpriteFrame is independently deep (issue #132)', () => {
    // Independent oracle pinned with INLINE object literals. If this
    // assertion compared the named type against `ReadonlySpriteFrame`
    // itself, a future regression that drops `readonly` from any field
    // of `ReadonlySpriteFrame` would move both sides together and the
    // assertion would still pass. Inline literals break that coupling
    // — the named type's readonly modifiers are checked against the
    // literal's readonly modifiers, and any mismatch fails
    // `tsc --noEmit`.
    expectTypeOf<ReadonlySpriteFrame>().toEqualTypeOf<{
      readonly canvas: HTMLCanvasElement;
      readonly width: number;
      readonly height: number;
    }>();
  });

  it('ReadonlySpriteFrame field-level mutation probes are type-rejected (issue #132)', () => {
    // Compile-time negative controls for each individual field of
    // `ReadonlySpriteFrame`. As with `recomposeAgent` above, each line
    // is expected to produce a TS2540 error; the `@ts-expect-error`
    // directive suppresses it. If `canvas`, `width`, or `height` loses
    // `readonly`, the corresponding directive becomes unused and `tsc`
    // fails with TS2578, catching the regression.
    const probeCanvas = (s: ReadonlySpriteFrame) => {
      // @ts-expect-error TS2540 — 'canvas' is readonly
      s.canvas = {} as HTMLCanvasElement;
    };
    const probeWidth = (s: ReadonlySpriteFrame) => {
      // @ts-expect-error TS2540 — 'width' is readonly
      s.width = 0;
    };
    const probeHeight = (s: ReadonlySpriteFrame) => {
      // @ts-expect-error TS2540 — 'height' is readonly
      s.height = 0;
    };
    void probeCanvas;
    void probeWidth;
    void probeHeight;
  });

  it('ReadonlyLoadedCharacter is fully deep (frames, direction arrays, fields) (issue #132)', () => {
    // Inline frame literals pin every array and field as readonly so
    // the contract is enforced at every nesting level — any missing
    // readonly modifier anywhere in the chain (frame level, field
    // level, array level, direction level) fails `tsc --noEmit`. The
    // internal `LoadedCharacter` / `SpriteFrame` builder types are
    // un-exported; the public readonly view is what consumers see.
    expectTypeOf<ReadonlyLoadedCharacter>().toEqualTypeOf<{
      readonly down: readonly {
        readonly canvas: HTMLCanvasElement;
        readonly width: number;
        readonly height: number;
      }[];
      readonly up: readonly {
        readonly canvas: HTMLCanvasElement;
        readonly width: number;
        readonly height: number;
      }[];
      readonly right: readonly {
        readonly canvas: HTMLCanvasElement;
        readonly width: number;
        readonly height: number;
      }[];
      readonly left: readonly {
        readonly canvas: HTMLCanvasElement;
        readonly width: number;
        readonly height: number;
      }[];
    }>();
  });

  it('ReadonlyLoadedFurnitureItem is fully deep (issue #132)', () => {
    expectTypeOf<ReadonlyLoadedFurnitureItem>().toEqualTypeOf<{
      readonly id: string;
      readonly canvas: HTMLCanvasElement;
      readonly width: number;
      readonly height: number;
      readonly footprintW: number;
      readonly footprintH: number;
    }>();
  });

  it('ReadonlyLoadedFloor is fully deep (issue #132)', () => {
    expectTypeOf<ReadonlyLoadedFloor>().toEqualTypeOf<{
      readonly canvas: HTMLCanvasElement;
    }>();
  });

  it('ReadonlyAssets is fully deep (issue #132)', () => {
    expectTypeOf<ReadonlyAssets>().toEqualTypeOf<{
      readonly characters: readonly ReadonlyLoadedCharacter[];
      readonly floors: readonly ReadonlyLoadedFloor[];
      readonly furniture: ReadonlyMap<string, ReadonlyLoadedFurnitureItem>;
    }>();
  });

  it('getSpriteFrame rejects a zero-size source canvas (issue #172)', () => {
    const canvas = document.createElement('canvas');
    canvas.width = 0;
    canvas.height = 0;
    const frame: ReadonlySpriteFrame = { canvas, width: 16, height: 32 };
    const character: ReadonlyLoadedCharacter = {
      down: [frame],
      up: [frame],
      right: [frame],
      left: [frame],
    };

    expect(getSpriteFrame(character, 'idle', 'down', 0)).toBeNull();
  });
});
