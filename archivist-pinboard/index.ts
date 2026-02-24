import fetch from "./fetch";
import query from "./query";

export interface PinboardOptions {
  apiKey: string;
  concurrency?: number;
}

export default (options: PinboardOptions) => ({
  fetch: () => fetch(options),
  get: () => query(options),
  query: (...args: [string?, number?]) => query(options, ...args),
});
