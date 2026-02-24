declare module "dateformat" {
  function dateFormat(date: Date, mask: string): string;
  export default dateFormat;
}

declare module "gif-frames" {
  function gifFrames(
    options: any,
    callback: (err: any, frameData: any) => void,
  ): void;
  export default gifFrames;
}

declare module "mktemp" {
  export function createFileSync(template: string): string;
}

declare module "node-wget" {
  function wget(
    options: { url: string; dest: string },
    callback: (error: any, response: any, body: string) => void,
  ): void;
  export default wget;
}

declare module "image-size" {
  function sizeOf(path: string, callback: (err: any, size: any) => void): void;
  export default sizeOf;
}

declare module "chrome-cookies-secure" {
  export function getCookies(
    url: string,
    format: string,
    callback: (err: any, cookies: any[]) => void,
  ): void;
}
