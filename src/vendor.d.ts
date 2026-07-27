declare module "*.css" {}

declare module "node-pinboard" {
  class Pinboard {
    constructor(apiKey: string);
    all(): Promise<any>;
  }
  export default Pinboard;
}

declare module "chrome-cookies-secure" {
  export function getCookies(
    url: string,
    format: string,
    callback: (err: any, cookies: any[]) => void,
  ): void;
}

declare module "puppeteer-extra" {
  import type { Browser } from "puppeteer";
  const puppeteer: {
    use(plugin: any): void;
    launch(options?: any): Promise<Browser>;
  };
  export default puppeteer;
}

declare module "puppeteer-extra-plugin-stealth" {
  function StealthPlugin(): any;
  export default StealthPlugin;
}

declare module "bplist-parser" {
  const bplist: {
    parseBuffer(buffer: Buffer): any[];
  };
  export default bplist;
}
