import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("../..", import.meta.url));

const SKIP_DIRS = new Set(["node_modules", "dist", "coverage", ".git", ".vitest"]);

export function walk(dir: string, accept: (file: string) => boolean = () => true): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full, accept));
    else if (accept(full)) out.push(full);
  }
  return out;
}

export const rel = (file: string): string => relative(ROOT, file).split(sep).join("/");
export const read = (file: string): string => readFileSync(file, "utf8");
export const isSource = (file: string): boolean => /\.(ts|tsx)$/.test(file);

/** Removes block and line comments (a line comment must follow whitespace, so "http://" survives). */
export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
}

export function importSpecifiers(source: string): string[] {
  const code = stripComments(source);
  const found: string[] = [];
  const patterns = [/\bfrom\s+["']([^"']+)["']/g, /\bimport\s+["']([^"']+)["']/g, /\bimport\(\s*["']([^"']+)["']\s*\)/g, /\brequire\(\s*["']([^"']+)["']\s*\)/g];
  for (const pattern of patterns) for (const match of code.matchAll(pattern)) found.push(match[1] as string);
  return found;
}

export const srcDir = (pkg: string): string => join(ROOT, pkg, "src");
export const sourcesIn = (pkg: string): string[] => walk(srcDir(pkg), isSource);

/** Every production source file in the repo (not tests). */
export const ALL_SRC_DIRS = ["packages/core", "packages/adapters", "apps/api", "apps/web"] as const;
export const allProductionSources = (): string[] => ALL_SRC_DIRS.flatMap(sourcesIn);
