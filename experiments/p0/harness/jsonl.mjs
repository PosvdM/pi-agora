import { StringDecoder } from 'node:string_decoder';

/** Split only on LF; preserve Unicode separators and split UTF-8 code points. */
export class JsonlDecoder {
  #decoder = new StringDecoder('utf8');
  #buffer = '';

  constructor(onRecord) {
    this.onRecord = onRecord;
  }

  push(chunk) {
    this.#buffer += this.#decoder.write(chunk);
    this.#flush();
  }

  #flush() {
    let index;
    while ((index = this.#buffer.indexOf('\n')) !== -1) {
      const line = this.#buffer.slice(0, index).replace(/\r$/, '');
      this.#buffer = this.#buffer.slice(index + 1);
      this.onRecord(JSON.parse(line), line);
    }
  }

  end() {
    this.#buffer += this.#decoder.end();
    this.#flush();
    if (this.#buffer.length) throw new Error(`Truncated JSONL record: ${this.#buffer}`);
  }
}
