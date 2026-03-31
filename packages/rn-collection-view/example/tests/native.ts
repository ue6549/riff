/**
 * Typed accessor for the C++ JSI objects exposed by the native module.
 * Import `native` in every test screen instead of casting inline.
 */
import type { LayoutAttributes, Rect, Size } from '@riff/types';
import NativeCollectionViewModule from '../components/NativeCollectionViewModule';

type NativeModule = {
  ping(): string;
  layoutCache: {
    setAttributes(a: LayoutAttributes): void;
    getAttributes(key: string): LayoutAttributes | null;
    removeAttributes(key: string): void;
    getAll(): LayoutAttributes[];
    getAttributesInRect(rect: Rect): LayoutAttributes[];
    getTotalContentSize(): Size;
    getSectionOffsets(): number[];
    clear(): void;
    version(): number;
  };
  listLayout: {
    computeListLayout(params: object): void;
    invalidateListLayoutFrom(key: string, params: object): void;
    computeSections(sections: object[]): void;
    invalidateSectionsFrom(sectionIndex: number, sections: object[]): void;
  };
  masonryLayout: {
    computeMasonryLayout(params: object): { positions: number[]; contentHeight: number };
  };
  gridLayout: {
    computeGridLayout(params: object): { positions: number[]; contentHeight: number };
  };
  flowLayout: {
    computeFlowLayout(params: object): { positions: number[]; contentHeight: number };
  };
  windowController: {
    updateScrollPosition(y: number, x: number): void;
    getScrollPosition(): { y: number; x: number };
    attachScrollView(reactTag: number): void;
    getWindowState(
      scrollY: number,
      vpWidth: number,
      vpHeight: number,
      renderMultiplier: number,
    ): { visibleKeys: string[]; renderKeys: string[] };
  };
};

export const native = NativeCollectionViewModule as unknown as NativeModule;
