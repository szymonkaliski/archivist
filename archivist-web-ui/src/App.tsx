import { useState, useEffect, useRef, useCallback } from "react";
import { Grid } from "./Grid";
import { SearchBar } from "./SearchBar";
import { fetchResults } from "./api";
import type { SearchResult } from "./types";

const PAGE_SIZE = 100;

const getInitialQuery = () => {
  const params = new URLSearchParams(window.location.search);
  return params.get("q") || "";
};

export const App = () => {
  const [results, setResults] = useState<SearchResult[]>([]);
  const [total, setTotal] = useState(0);
  const initialQuery = getInitialQuery();
  const [query, setQuery] = useState(initialQuery);
  const [isSearching, setIsSearching] = useState(!!initialQuery);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const lastQueryRef = useRef("");
  const loadingRef = useRef(false);

  const doSearch = useCallback((q: string) => {
    lastQueryRef.current = q;
    loadingRef.current = true;
    const url = new URL(window.location.href);
    if (q) {
      url.searchParams.set("q", q);
    } else {
      url.searchParams.delete("q");
    }
    window.history.replaceState(null, "", url.toString());
    fetchResults(q || undefined, 0, PAGE_SIZE)
      .then((data) => {
        if (lastQueryRef.current !== q) return;
        setResults(data.items);
        setTotal(data.total);
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
      if (isSearching) {
        if (e.key === "Escape") {
          setIsSearching(false);
          setQuery("");
        }
        return;
      }
      if (e.key === "/" && !(e.target instanceof HTMLInputElement)) {
        e.preventDefault();
        setIsSearching(true);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [isSearching]);

  const onTagClick = useCallback((tag: string) => {
    setQuery(tag);
    setIsSearching(true);
  }, []);

  return (
    <div className="app">
      <Grid
        items={results}
        total={total}
        onTagClick={onTagClick}
        loadMore={loadMore}
      />
      {isSearching && (
        <SearchBar
          value={query}
          onChange={setQuery}
          onClose={() => {
            setIsSearching(false);
            setQuery("");
            window.history.replaceState(null, "", window.location.pathname);
          }}
        />
      )}
    </div>
  );
};
