import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const [name, log] = process.argv.slice(2);
const record = value => appendFileSync(log, JSON.stringify({ server: name, pid: process.pid, ...value }) + '\n');
record({ kind: 'spawn' });
const lines = createInterface({ input: process.stdin });
lines.on('line', line => {
  const request = JSON.parse(line);
  record({ kind: 'request', method: request.method });
  if (request.id === undefined) return;
  let result;
  if (request.method === 'initialize') result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name, version: '1' } };
  else if (request.method === 'tools/list') result = { tools: [{ name: 'ping', description: name + ' marker', inputSchema: { type: 'object', properties: {} } }] };
  else if (request.method === 'tools/call') { record({ kind: 'execute' }); result = { content: [{ type: 'text', text: name + ' called' }] }; }
  else if (request.method === 'ping') result = {};
  else { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'not implemented' } }) + '\n'); return; }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
});
lines.on('close', () => process.exit(0));
