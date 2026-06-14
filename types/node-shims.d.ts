declare module "node:crypto" {
  export function createHash(algorithm: string): {
    update(data: string | Uint8Array): { digest(encoding: "hex"): string };
  };
}

declare module "node:fs/promises" {
  export function mkdir(path: string, options?: { recursive?: boolean }): Promise<string | undefined>;
  export function readFile(path: string, encoding: "utf8"): Promise<string>;
  export function writeFile(path: string, data: string, encoding?: "utf8"): Promise<void>;
  export function rename(oldPath: string, newPath: string): Promise<void>;
  export function unlink(path: string): Promise<void>;
  export function copyFile(src: string, dest: string): Promise<void>;
}

declare module "node:os" {
  export function homedir(): string;
}

declare module "node:path" {
  export function dirname(path: string): string;
  export function join(...paths: string[]): string;
}

declare const process: {
  env: Record<string, string | undefined>;
  platform: string;
  pid: number;
};
