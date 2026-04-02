import type { SourceKind, SourceDefinition } from "../types";
import pinboard from "./pinboard";
import pinterest from "./pinterest";
import screenshot from "./screenshot";

export const SOURCES: Record<SourceKind, SourceDefinition> = {
  pinboard,
  pinterest,
  screenshot,
};
