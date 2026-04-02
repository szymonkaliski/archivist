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

  useEffect(() => {
    const handler = () => {
      const q = new URLSearchParams(window.location.search).get("q") || "";
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
            `search… detail:… source:${sources[0]} tag:… before:… after:…`,
          );
        }
      })
      .catch(() => {});
  }, []);

  const doSearch = useCallback((q: string) => {
    lastQueryRef.current = q;
    loadingRef.current = true;
    const url = new URL(window.location.origin);
    if (q) {
      url.searchParams.set("q", q);
    }
    const currentQ = new URLSearchParams(window.location.search).get("q") || "";
    if (currentQ !== q) {
      window.history.pushState(null, "", url.toString());
    }
    fetchResults(q || undefined, 0, PAGE_SIZE)
      .then((data) => {
        if (lastQueryRef.current !== q) return;
        setResults(data.items);
        setTotal(data.total);
        setDetailItem(data.item || null);
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
    if (!initializedRef.current) {
      initializedRef.current = true;
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

  const onTagClick = useCallback((tag: string) => {
    setQuery((prev) => {
      const parsed = parseQuery(prev);
      parsed.tags = [tag];
      parsed.detail = null;
      return buildQuery(parsed);
    });
    searchRef.current?.focus();
  }, []);

  const onDetail = useCallback((id: string) => {
    const encoded = encodeId(id);
    setQuery((prev) => {
      const parsed = parseQuery(prev);
      parsed.detail = encoded;
      return buildQuery(parsed);
    });
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
