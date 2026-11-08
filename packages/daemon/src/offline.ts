import { Security } from "./security.js";

export async function offline(home: string, words: string[]): Promise<unknown> {
  return Security.offline(home, words);
}
