import { basename } from "node:path";

const EXTENSION_LANGUAGES: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  cs: "csharp",
  swift: "swift",
  m: "objectivec",
  mm: "objectivec",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  fish: "bash",
  md: "markdown",
  markdown: "markdown",
  json: "json",
  jsonc: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  xml: "xml",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  less: "less",
  sql: "sql",
  php: "php",
  pl: "perl",
  lua: "lua",
  r: "r",
  dart: "dart",
  vim: "vim",
  el: "lisp",
  clj: "clojure",
  ex: "elixir",
  exs: "elixir",
  hs: "haskell",
  ml: "ocaml",
  fs: "fsharp",
  scala: "scala",
  proto: "protobuf",
  graphql: "graphql",
  gql: "graphql",
  diff: "diff",
  patch: "diff",
  env: "bash",
  conf: "ini",
  ini: "ini",
};

const BASENAME_LANGUAGES: Record<string, string> = {
  makefile: "makefile",
  dockerfile: "dockerfile",
  "cmakelists.txt": "cmake",
};

export function languageForPath(path: string): string | undefined {
  if (path.length === 0) {
    return undefined;
  }

  const base = basename(path).toLowerCase();
  const baseHit = BASENAME_LANGUAGES[base];
  if (baseHit) {
    return baseHit;
  }

  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) {
    return undefined;
  }

  const ext = base.slice(dot + 1);
  return EXTENSION_LANGUAGES[ext];
}
