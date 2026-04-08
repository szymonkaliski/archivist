import { useState, useEffect } from "react";
import type { SearchResult } from "./types";

const shorten = (text: string, length: number) =>
  text.length <= length ? text : text.slice(0, length - 1).trim() + "…";

const useProgressiveImage = (thumb: string, full: string) => {
  const [src, setSrc] = useState(thumb);
  useEffect(() => {
    setSrc(thumb);
    if (!full || full === thumb) return;
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (!cancelled) setSrc(full);
    };
    img.src = full;
    return () => {
      cancelled = true;
    };
  }, [thumb, full]);
  return src;
};

interface CellProps {
  item: SearchResult;
  onTagClick: (tag: string) => void;
  onDetail?: (id: string) => void;
  fullImage?: boolean;
}

export const Cell = ({ item, onTagClick, onDetail, fullImage }: CellProps) => {
  const hasImage = !!(item.img || item.thumbImg);
  const displaySrc = useProgressiveImage(
    item.thumbImg || item.img,
    fullImage ? item.img : item.thumbImg,
  );

  return (
    <div className="cell">
      {hasImage ? (
        <img loading="lazy" src={displaySrc} alt={item.meta.title || ""} />
      ) : (
        <div className="cell-no-image">no image</div>
      )}
      <div className="cell-overlay">
        {(item.meta.title || item.link) && (
          <a
            className="cell-title"
            href={item.link || "#"}
            target="_blank"
            rel="noopener noreferrer"
          >
            {item.meta.title || item.link}
          </a>
        )}

        {item.meta.note && (
          <div className="cell-note">{shorten(item.meta.note, 200)}</div>
        )}

        {item.meta.tags && item.meta.tags.length > 0 && (
          <div className="cell-tags">
            {item.meta.tags.map((tag) => (
              <a
                key={tag}
                className="cell-tag"
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  onTagClick(tag);
                }}
              >
                {tag}
              </a>
            ))}
          </div>
        )}

        <div className="cell-footer">
          <div className="cell-actions">
            {onDetail && (
              <a
                href={`/?q=detail:${item.id}`}
                onClick={(e) => {
                  if (e.metaKey || e.ctrlKey) return;
                  e.preventDefault();
                  onDetail(item.id);
                }}
              >
                detail
              </a>
            )}
            {hasImage && (
              <a href={item.img} target="_blank" rel="noopener noreferrer">
                full
              </a>
            )}
            {item.meta.static && (
              <a
                href={item.meta.static}
                target="_blank"
                rel="noopener noreferrer"
              >
                html
              </a>
            )}
          </div>
          <div className="cell-date">
            {item.meta.source} /{" "}
            {new Date(item.time).toISOString().slice(0, 10)}
          </div>
        </div>
      </div>
    </div>
  );
};
