import fetch from "./fetch";
import query from "./query";

export interface ScreenshotOptions {
  directory: string;
  concurrency?: number;
}

export default (options: ScreenshotOptions) => ({
  fetch: () => fetch(options),
  get: () => query(options),
  query: (...args: [string?, number?]) => query(options, ...args),
});
