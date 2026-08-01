import { describe, expectTypeOf, it } from 'vitest';

import {
  loadAllAssets,
  loadCharacters,
  loadFloors,
  loadFurniture,
  type ReadonlyAssets,
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

  it('ReadonlyLoadedCharacter is fully deep (frames, direction arrays, fields) (issue #132)', () => {
    // Inline literal pins every array and field as readonly so the contract
    // is enforced at every nesting level — any missing readonly modifier
    // fails `tsc --noEmit`. The internal `LoadedCharacter` / `SpriteFrame`
    // builder types are un-exported; the public readonly view is what
    // consumers see.
    expectTypeOf<ReadonlyLoadedCharacter>().toEqualTypeOf<{
      readonly down: readonly ReadonlySpriteFrame[];
      readonly up: readonly ReadonlySpriteFrame[];
      readonly right: readonly ReadonlySpriteFrame[];
      readonly left: readonly ReadonlySpriteFrame[];
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
});
