import {
  useRef,
  useState,
  useEffect,
  useLayoutEffect,
  useCallback,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Cell } from "./Cell";
import type { SearchResult } from "./types";

const COLUMN_MIN_WIDTH = 280;
const GAP = 1;
const LOAD_MORE_THRESHOLD = 5;

/** The item at the top of the viewport and how far the viewport is scrolled past its row. */
interface ScrollAnchor {
  id: string;
  offset: number;
}

interface GridProps {
  items: SearchResult[];
  total: number;
  onTagClick: (tag: string) => void;
  onDetail?: (id: string) => void;
  loadMore: () => void;
}

export const Grid = ({
  items,
  total,
  onTagClick,
  onDetail,
  loadMore,
}: GridProps) => {
  const parentRef = useRef<HTMLDivElement>(null);
  const [columnCount, setColumnCount] = useState(4);
  const [cellSize, setCellSize] = useState(280);
  const anchorRef = useRef<ScrollAnchor | null>(null);
  const rowHeight = cellSize + GAP;

  const updateLayout = useCallback(() => {
    if (!parentRef.current) return;
    const width = parentRef.current.clientWidth;
    const cols = Math.max(2, Math.floor(width / COLUMN_MIN_WIDTH));
    setColumnCount(cols);
    setCellSize((width - GAP * (cols - 1)) / cols);
  }, []);

  useEffect(() => {
    updateLayout();
    const observer = new ResizeObserver(updateLayout);
    if (parentRef.current) observer.observe(parentRef.current);
    return () => observer.disconnect();
  }, [updateLayout]);

  const rowCount = Math.ceil(items.length / columnCount);

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => cellSize + GAP,
    overscan: 3,
  });

  useEffect(() => {
    virtualizer.measure();
  }, [cellSize, virtualizer]);

  const onScroll = () => {
    const el = parentRef.current;
    if (!el) return;
    const rowIndex = Math.floor(el.scrollTop / rowHeight);
    const item = items[rowIndex * columnCount];
    anchorRef.current = item
      ? { id: item.id, offset: el.scrollTop - rowIndex * rowHeight }
      : null;
  };

  // Keeps the anchored item at the same viewport position when the item list is
  // replaced (a refresh can prepend new items) or the row size changes.
  useLayoutEffect(() => {
    const el = parentRef.current;
    const anchor = anchorRef.current;
    if (!el || !anchor) return;
    const index = items.findIndex((item) => item.id === anchor.id);
    if (index === -1) return;
    const target = Math.floor(index / columnCount) * rowHeight + anchor.offset;
    if (el.scrollTop !== target) el.scrollTop = target;
  }, [items, columnCount, rowHeight]);

  const virtualItems = virtualizer.getVirtualItems();
  const lastVirtualRow = virtualItems[virtualItems.length - 1];

  useEffect(() => {
    if (!lastVirtualRow) return;
    const lastLoadedRow = rowCount - 1;
    if (
      lastVirtualRow.index >= lastLoadedRow - LOAD_MORE_THRESHOLD &&
      items.length < total
    ) {
      loadMore();
    }
  }, [lastVirtualRow?.index, rowCount, items.length, total, loadMore]);

  return (
    <div ref={parentRef} className="grid-scroll" onScroll={onScroll}>
      <div
        style={{
          height: virtualizer.getTotalSize(),
          position: "relative",
        }}
      >
        {virtualItems.map((virtualRow) => (
          <div
            key={virtualRow.key}
            className="grid-row"
            style={{
              position: "absolute",
              top: virtualRow.start,
              left: 0,
              right: 0,
              height: cellSize,
              gridTemplateColumns: `repeat(${columnCount}, 1fr)`,
              gap: GAP,
            }}
          >
            {Array.from({ length: columnCount }, (_, colIndex) => {
              const itemIndex = virtualRow.index * columnCount + colIndex;
              const item = items[itemIndex];
              if (!item) return null;
              return (
                <Cell
                  key={item.id}
                  item={item}
                  onTagClick={onTagClick}
                  onDetail={onDetail}
                />
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
};
