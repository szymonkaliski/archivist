import { useRef, useState, useEffect, useCallback } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Cell } from "./Cell";
import type { SearchResult } from "./types";

const COLUMN_MIN_WIDTH = 280;
const GAP = 1;
const LOAD_MORE_THRESHOLD = 5;

interface GridProps {
  items: SearchResult[];
  total: number;
  onTagClick: (tag: string) => void;
  loadMore: () => void;
}

export const Grid = ({ items, total, onTagClick, loadMore }: GridProps) => {
  const parentRef = useRef<HTMLDivElement>(null);
  const [columnCount, setColumnCount] = useState(4);

  const updateColumns = useCallback(() => {
    if (!parentRef.current) return;
    const width = parentRef.current.clientWidth;
    setColumnCount(Math.max(1, Math.floor(width / COLUMN_MIN_WIDTH)));
  }, []);

  useEffect(() => {
    updateColumns();
    const observer = new ResizeObserver(updateColumns);
    if (parentRef.current) observer.observe(parentRef.current);
    return () => observer.disconnect();
  }, [updateColumns]);

  const rowCount = Math.ceil(items.length / columnCount);
  const cellSize = parentRef.current
    ? (parentRef.current.clientWidth - GAP * (columnCount - 1)) / columnCount
    : 280;

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => cellSize + GAP,
    overscan: 3,
  });

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
    <div ref={parentRef} className="grid-scroll">
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
              return <Cell key={item.id} item={item} onTagClick={onTagClick} />;
            })}
          </div>
        ))}
      </div>
    </div>
  );
};
