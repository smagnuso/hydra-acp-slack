// The transient npx cache is `~/.npm/_npx` on POSIX and `...\npm-cache\_npx` on Windows.
export function isTransientNpxPath(scriptPath: string): boolean {
  return scriptPath.replace(/\\/g, "/").includes("/_npx/");
}

export function confLockNote(platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") {
    return "# Keep this file in your user profile; Windows file modes are not applied.";
  }
  return "# Lock this file: chmod 600.";
}
