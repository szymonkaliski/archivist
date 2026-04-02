import dateFormat from "dateformat";
import type { SearchResult } from "./types";

const shorten = (text: string, length: number) =>
  text.length <= length ? text : text.slice(0, length - 1).trim() + "…";

interface CellProps {
  item: SearchResult;
  onTagClick: (tag: string) => void;
  onDetail?: (id: string) => void;
  fullImage?: boolean;
}

export const Cell = ({ item, onTagClick, onDetail, fullImage }: CellProps) => {
  return (
    <div className="cell">
      <img
        loading="lazy"
        src={fullImage ? item.img : item.thumbImg}
        alt={item.meta.title || ""}
      />
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
            <a href={item.img} target="_blank" rel="noopener noreferrer">
              full
            </a>
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
            {item.meta.source} / {dateFormat(new Date(item.time), "yyyy-mm-dd")}
          </div>
        </div>
      </div>
    </div>
  );
};
