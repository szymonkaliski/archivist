declare module "bplist-parser" {
  export function parseBuffer(buf: Buffer): any[];
}

declare module "mdfind" {
  function mdfind(options: {
    query: string;
    attributes: string[];
    limit?: number;
    directories: string[];
  }): { output: NodeJS.EventEmitter };
  export default mdfind;
}
