import { createLogger } from "archivist-logger";
import { loadConfig } from "archivist-cli/lib";
import { cosineSimilarity } from "archivist-embeddings";
import bm25 from "wink-bm25-text-search";
import nlp from "wink-nlp-utils";

const log = createLogger("web-ui");

let embeddingsMap = new Map<string, Float32Array>();
let textEmbeddingsMap = new Map<string, Float32Array>();
let bm25Engine: ReturnType<typeof bm25> | null = null;

const RRF_K = 60;

export const loadAllEmbeddings = async () => {
  const config = loadConfig();
  const mergedImg = new Map<string, Float32Array>();
  const mergedTxt = new Map<string, Float32Array>();

  for (const name of Object.keys(config)) {
    try {
      const mod = await import(`${name}/query`);
      if (mod.getEmbeddings) {
        const { image, text } = mod.getEmbeddings();
        for (const [id, vec] of image) {
          mergedImg.set(id, vec);
        }
        for (const [id, vec] of text) {
          mergedTxt.set(id, vec);
        }
      }
    } catch (e) {
      log.warn(`[${name}] failed to load embeddings: ${e}`);
    }
  }

  embeddingsMap = mergedImg;
  textEmbeddingsMap = mergedTxt;
  log.info(
    `loaded ${mergedImg.size} image + ${mergedTxt.size} text embeddings`,
  );
};

const getItemText = (item: any): string =>
  [
    item.meta?.title || "",
    item.meta?.note || "",
    ...(item.meta?.tags || []),
    item.link || "",
  ]
    .filter(Boolean)
    .join(" ");

export const buildBM25Index = (items: any[]) => {
  const engine = bm25();
  engine.defineConfig({ fldWeights: { text: 1 } });
  engine.definePrepTasks([
    nlp.string.lowerCase,
    nlp.string.removeExtraSpaces,
    nlp.string.tokenize0,
    nlp.tokens.removeWords,
    nlp.tokens.stem,
  ]);
  for (const item of items) {
    engine.addDoc({ text: getItemText(item) }, item.id);
  }
  engine.consolidate();
  bm25Engine = engine;
  log.info(`built BM25 index with ${items.length} documents`);
};

const rankByImageSim = (
  targetId: string,
  candidates: any[],
): Map<string, number> => {
  const targetEmb = embeddingsMap.get(targetId);
  if (!targetEmb) return new Map();

  const scored = candidates
    .map((c) => ({
      id: c.id,
      score: embeddingsMap.has(c.id)
        ? cosineSimilarity(targetEmb, embeddingsMap.get(c.id)!)
        : -1,
    }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  const ranks = new Map<string, number>();
  scored.forEach((s, i) => ranks.set(s.id, i + 1));
  return ranks;
};

const rankByTextSim = (
  targetId: string,
  candidates: any[],
): Map<string, number> => {
  const targetEmb = textEmbeddingsMap.get(targetId);
  if (!targetEmb) return new Map();

  const scored = candidates
    .map((c) => ({
      id: c.id,
      score: textEmbeddingsMap.has(c.id)
        ? cosineSimilarity(targetEmb, textEmbeddingsMap.get(c.id)!)
        : -1,
    }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  const ranks = new Map<string, number>();
  scored.forEach((s, i) => ranks.set(s.id, i + 1));
  return ranks;
};

const rankByBM25 = (target: any): Map<string, number> => {
  if (!bm25Engine) return new Map();

  const query = getItemText(target);
  if (!query.trim()) return new Map();

  const results = bm25Engine.search(query, 500) as [string, number, unknown][];
  const ranks = new Map<string, number>();
  let rank = 1;
  for (const [id] of results) {
    if (id !== target.id) {
      ranks.set(id, rank++);
    }
  }
  return ranks;
};

export const rankRelatedRRF = (
  target: any,
  candidates: any[],
  limit: number,
): any[] => {
  const others = candidates.filter((c) => c.id !== target.id);

  const imgRanks = rankByImageSim(target.id, others);
  const txtRanks = rankByTextSim(target.id, others);
  const textRanks = rankByBM25(target);

  const scores = new Map<string, number>();
  for (const c of others) {
    let score = 0;
    if (imgRanks.has(c.id)) score += 1 / (RRF_K + imgRanks.get(c.id)!);
    if (txtRanks.has(c.id)) score += 1 / (RRF_K + txtRanks.get(c.id)!);
    if (textRanks.has(c.id)) score += 1 / (RRF_K + textRanks.get(c.id)!);
    if (score > 0) scores.set(c.id, score);
  }

  const itemMap = new Map(others.map((c) => [c.id, c]));
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id]) => itemMap.get(id)!);
};
