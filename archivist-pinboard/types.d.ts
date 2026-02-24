declare module "node-pinboard" {
  class Pinboard {
    constructor(apiKey: string);
    all(): Promise<any>;
  }
  export default Pinboard;
}

declare module "is-reachable" {
  function isReachable(url: string): Promise<boolean>;
  export default isReachable;
}

declare module "jsdom" {
  export class JSDOM {
    static fromFile(path: string): Promise<JSDOM>;
    window: {
      document: {
        body: {
          textContent: string | null;
        };
      };
    };
  }
}
