import fetch from "./fetch";
import query from "./query";

export interface PinterestOptions {
  profile: string;
  loginMethod: "cookies" | "password";
  username?: string;
  password?: string;
  concurrency?: number;
  appendOnly?: boolean;
}

export default (options: PinterestOptions) => ({
  fetch: () => fetch(options),
  get: () => query(options),
  query: (...args: [string?, number?]) => query(options, ...args),
});
