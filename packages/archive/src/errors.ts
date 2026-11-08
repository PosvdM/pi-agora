export class ArchiveError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ArchiveError";
  }
}

export function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    ("code" in error && error.code === "ENOENT");
}
