import { useState, useEffect, useRef } from "react";
import { Grid } from "./Grid";
import { Cell } from "./Cell";
import type { SearchResult } from "./types";

const COLUMN_MIN_WIDTH = 280;
const noop = () => {};

interface DetailProps {
  item: SearchResult | null;
  related: SearchResult[];
  onTagClick: (tag: string) => void;
  onDetail: (id: string) => void;
}

export const Detail = ({
  item,
  related,
  onTagClick,
  onDetail,
}: DetailProps) => {
  const [totalCols, setTotalCols] = useState(6);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const update = () => {
      if (!containerRef.current) return;
      const width = containerRef.current.clientWidth;
      setTotalCols(Math.max(2, Math.floor(width / COLUMN_MIN_WIDTH)));
    };
    update();
    const observer = new ResizeObserver(update);
    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  const isMobile = totalCols <= 2;
  const mainCols = Math.max(1, Math.floor(totalCols / 2));

  if (isMobile) {
    return (
      <div className="detail-mobile" ref={containerRef}>
        <div className="detail-main-mobile">
          {item && (
            <Cell
              item={item}
              onTagClick={onTagClick}
              onDetail={onDetail}
              fullImage
            />
          )}
        </div>
        <div className="detail-related-mobile">
          <Grid
            items={related}
            total={related.length}
            onTagClick={onTagClick}
            onDetail={onDetail}
            loadMore={noop}
          />
        </div>
      </div>
    );
  }

  return (
    <div
      className="detail-split"
      ref={containerRef}
      style={{
        gridTemplateColumns: `${mainCols}fr ${totalCols - mainCols}fr`,
      }}
    >
      <div className="detail-main">
        {item && (
          <Cell
            item={item}
            onTagClick={onTagClick}
            onDetail={onDetail}
            fullImage
          />
        )}
      </div>
      <div className="detail-related">
        <Grid
          items={related}
          total={related.length}
          onTagClick={onTagClick}
          onDetail={onDetail}
          loadMore={noop}
        />
      </div>
    </div>
  );
};
