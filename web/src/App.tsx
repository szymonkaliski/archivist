import { useState, useEffect, useRef, useCallback } from "react";
import { Grid } from "./Grid";
import { Detail } from "./Detail";
import { SearchBar } from "./SearchBar";
import { fetchResults, encodeId } from "./api";
import { parseQuery, buildQuery } from "./query";
import type { SearchResult } from "./types";

const PAGE_SIZE = 100;

const getInitialQuery = () => {
  const params = new URLSearchParams(window.location.search);
  return params.get("q") || "";
};

const getScrollTop = () =>
  document.querySelector(".grid-scroll")?.scrollTop ?? 0;

const setScrollTop = (value: number) => {
  const el = document.querySelector(".grid-scroll");
  if (el) el.scrollTop = value;
};

interface SavedState {
  scrollTop: number;
  itemCount: number;
}

export const App = () => {
  const [results, setResults] = useState<SearchResult[]>([]);
  const [detailItem, setDetailItem] = useState<SearchResult | null>(null);
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState(getInitialQuery);
  const [placeholder, setPlaceholder] = useState("search...");
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const lastQueryRef = useRef("");
  const loadingRef = useRef(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const pendingRestoreRef = useRef<SavedState | null>(null);
  const resultsRef = useRef<SearchResult[]>([]);
  resultsRef.current = results;
  const skipDebounceRef = useRef(false);

  useEffect(() => {
    const handler = (e: PopStateEvent) => {
      const q = new URLSearchParams(window.location.search).get("q") || "";
      const saved = e.state as SavedState | null;
      pendingRestoreRef.current = saved ?? null;
      skipDebounceRef.current = true;
      setQuery(q);
    };
    window.addEventListener("popstate", handler);
    return () => window.removeEventListener("popstate", handler);
  }, []);

  useEffect(() => {
    fetch("/api/sources")
      .then((r) => r.json())
      .then((sources: string[]) => {
        if (sources.length > 0) {
          setPlaceholder(
            `search... detail:... source:${sources[0]} tag:... before:... after:...`,
          );
        }
      })
      .catch(() => {});
  }, []);

  const doSearch = useCallback((q: string) => {
    lastQueryRef.current = q;
    loadingRef.current = true;

    const url = new URL(window.location.origin);
    if (q) url.searchParams.set("q", q);
    const currentQ = new URLSearchParams(window.location.search).get("q") || "";
    if (currentQ !== q) {
      window.history.pushState(null, "", url.toString());
    }

    const restore = pendingRestoreRef.current;
    pendingRestoreRef.current = null;
    const limit = restore ? Math.max(PAGE_SIZE, restore.itemCount) : PAGE_SIZE;

    fetchResults(q || undefined, 0, limit)
      .then((data) => {
        if (lastQueryRef.current !== q) return;
        setResults(data.items);
        setTotal(data.total);
        setDetailItem(data.item || null);

        if (restore) {
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              setScrollTop(restore.scrollTop);
            });
          });
        }
      })
      .catch((err) => console.error("search failed", err))
      .finally(() => {
        loadingRef.current = false;
      });
  }, []);

  const totalRef = useRef(0);
  totalRef.current = total;
  const resultsLenRef = useRef(0);
  resultsLenRef.current = results.length;

  const loadMore = useCallback(() => {
    if (loadingRef.current) return;
    if (resultsLenRef.current >= totalRef.current) return;
    loadingRef.current = true;
    const q = lastQueryRef.current;
    fetchResults(q || undefined, resultsLenRef.current, PAGE_SIZE)
      .then((data) => {
        if (lastQueryRef.current !== q) return;
        setResults((cur) => [...cur, ...data.items]);
        setTotal(data.total);
      })
      .catch((err) => console.error("load more failed", err))
      .finally(() => {
        loadingRef.current = false;
      });
  }, []);

  const initializedRef = useRef(false);

  useEffect(() => {
    if (!initializedRef.current || skipDebounceRef.current) {
      initializedRef.current = true;
      skipDebounceRef.current = false;
      clearTimeout(debounceRef.current);
      doSearch(query);
      return;
    }

    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => doSearch(query), 200);
    return () => clearTimeout(debounceRef.current);
  }, [query, doSearch]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "/" && !(e.target instanceof HTMLInputElement)) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  useEffect(() => {
    const handler = () => {
      if (document.visibilityState === "visible") {
        doSearch(lastQueryRef.current);
      }
    };
    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  }, [doSearch]);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    let lastHeight = vv.height;
    const handler = () => {
      if (vv.height > lastHeight) {
        const el = document.querySelector(".grid-scroll");
        if (el instanceof HTMLElement) {
          const top = el.scrollTop;
          el.style.overflow = "hidden";
          void el.offsetHeight;
          el.style.overflow = "";
          el.scrollTop = top;
        }
      }
      lastHeight = vv.height;
    };
    vv.addEventListener("resize", handler);
    return () => vv.removeEventListener("resize", handler);
  }, []);

  const onTagClick = useCallback((tag: string) => {
    skipDebounceRef.current = true;
    setDetailItem(null);
    setResults([]);
    setQuery((prev) => {
      const parsed = parseQuery(prev);
      parsed.tags = [tag];
      parsed.detail = null;
      return buildQuery(parsed);
    });
    searchRef.current?.focus();
  }, []);

  const onDetail = useCallback((id: string) => {
    history.replaceState(
      {
        scrollTop: getScrollTop(),
        itemCount: resultsLenRef.current,
      } satisfies SavedState,
      "",
      window.location.href,
    );

    const clickedItem = resultsRef.current.find((r) => r.id === id);
    skipDebounceRef.current = true;
    setDetailItem(clickedItem ?? null);
    setResults([]);

    const encoded = encodeId(id);
    setQuery((prev) => {
      const parsed = parseQuery(prev);
      parsed.detail = encoded;
      return buildQuery(parsed);
    });

    window.scrollTo(0, 0);
    setScrollTop(0);
  }, []);

  const isDetail = parseQuery(query).detail !== null;

  return (
    <div className="app">
      {isDetail ? (
        <Detail
          item={detailItem}
          related={results}
          onTagClick={onTagClick}
          onDetail={onDetail}
        />
      ) : (
        <Grid
          items={results}
          total={total}
          onTagClick={onTagClick}
          onDetail={onDetail}
          loadMore={loadMore}
        />
      )}
      <SearchBar
        ref={searchRef}
        value={query}
        onChange={setQuery}
        placeholder={placeholder}
      />
    </div>
  );
};
