import {
  type FSWatcher,
  mkdirSync,
  readFileSync,
  watch,
  writeFileSync,
} from "node:fs";
import { basename, dirname } from "node:path";
import { logger } from "../util/log.js";

const log = logger("channels");

// JSON file mapping absolute project path -> Slack channel ID.
// Example: { "/home/me/code/foo": "C123ABC", ... }
//
// startWatching() (called once from index.ts) sets up an fs.watch on
// the parent directory and filters by filename. Editing the file with
// any editor — including ones that do atomic rename-over (vim, emacs
// auto-save, jq -i, etc.) — triggers a reload, debounced 100ms to
// coalesce burst writes. Failures during reload (bad JSON, missing
// file) keep the previous in-memory state and log a warning rather
// than crashing.
export class ChannelMap {
  private map = new Map<string, string>();
  private watcher: FSWatcher | undefined;
  private reloadTimer: NodeJS.Timeout | undefined;

  constructor(private readonly path: string) {
    this.load();
  }

  private load(): void {
    const next = new Map<string, string>();
    try {
      const text = readFileSync(this.path, "utf8");
      const obj = JSON.parse(text);
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        for (const [k, v] of Object.entries(obj)) {
          if (typeof v === "string") {
            next.set(k, v);
          }
        }
      }
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") {
        // No file yet — the watcher will pick up the first write.
        this.map = next;
        return;
      }
      // Bad JSON / permission / anything else: keep the old map so a
      // typo in the file doesn't blow away routing for active sessions.
      log.warn(
        `reload of ${this.path} failed, keeping previous map: ${e.message}`,
      );
      return;
    }
    this.map = next;
  }

  startWatching(): void {
    if (this.watcher) {
      return;
    }
    const dir = dirname(this.path);
    const name = basename(this.path);
    try {
      mkdirSync(dir, { recursive: true });
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "EEXIST") {
        log.warn(`cannot create ${dir}: ${e.message}`);
      }
    }
    try {
      this.watcher = watch(dir, (_eventType, filename) => {
        if (filename !== name) {
          return;
        }
        if (this.reloadTimer) {
          clearTimeout(this.reloadTimer);
        }
        this.reloadTimer = setTimeout(() => {
          this.reloadTimer = undefined;
          const before = this.map.size;
          this.load();
          log.info(
            `reloaded ${this.path} (${before} → ${this.map.size} entries)`,
          );
        }, 100);
      });
      this.watcher.on("error", (err) => {
        log.warn(`watch error on ${dir}: ${err.message}`);
      });
    } catch (err) {
      log.warn(`cannot watch ${dir}: ${(err as Error).message}`);
    }
  }

  stopWatching(): void {
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = undefined;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = undefined;
    }
  }

  get(projectPath: string): string | undefined {
    return this.map.get(projectPath);
  }

  values(): string[] {
    return [...this.map.values()];
  }

  set(projectPath: string, channelId: string): void {
    this.map.set(projectPath, channelId);
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const obj: Record<string, string> = {};
      for (const [k, v] of this.map) {
        obj[k] = v;
      }
      writeFileSync(this.path, JSON.stringify(obj, null, 2));
    } catch (err) {
      log.warn(`failed to save ${this.path}: ${(err as Error).message}`);
    }
  }
}
