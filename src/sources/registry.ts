import type { SourceKind, SourceDefinition } from "../types";
import pinboard from "./pinboard";
import pinterest from "./pinterest";
import screenshot from "./screenshot";
import arena from "./arena";

export const SOURCES: Record<SourceKind, SourceDefinition> = {
  pinboard,
  pinterest,
  screenshot,
  arena,
};
