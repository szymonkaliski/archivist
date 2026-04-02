import type Database from "better-sqlite3";

export type SourceKind = "pinboard" | "pinterest" | "screenshot";

export interface PinboardConfig {
  apiKey: string;
  concurrency?: number;
}

export interface PinterestConfig {
  profile: string;
  loginMethod: "cookies" | "password";
  username?: string;
  password?: string;
  concurrency?: number;
  appendOnly?: boolean;
}

export interface ScreenshotConfig {
  directory: string;
  concurrency?: number;
}

export type SourceConfigMap = {
  pinboard: PinboardConfig;
  pinterest: PinterestConfig;
  screenshot: ScreenshotConfig;
};

export type AppConfig = {
  [K in SourceKind]?: SourceConfigMap[K];
};

export interface SearchResult {
  img: string;
  thumbImg: string;
  id: string;
  link?: string;
  time: string;
  width: number;
  height: number;
  meta: {
    source: SourceKind;
    title?: string;
    note?: string;
    tags?: string[];
    static?: string;
  };
}

export interface SourceDefinition<K extends SourceKind = SourceKind> {
  kind: K;
  setupStatements: string[];
  ftsTable: string;
  dataTable: string;
  fetch(db: Database.Database, config: SourceConfigMap[K]): Promise<void>;
  toSearchResult(row: Record<string, unknown>): SearchResult;
  embeddingText(row: Record<string, unknown>): string;
  thumbPath(row: Record<string, unknown>): string;
}
