import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const signers = new WeakMap();

/** 仅用于测试：通过公开配对与签名端点确认，不直接修改生产数据库或伪造身份。 */
export async function confirmUser(client, response) {
  const confirmation = response.confirmation;
  if (!confirmation?.confirmationId) throw new Error('测试操作没有返回待确认');
  let signer = signers.get(client);
  if (!signer) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const deviceId = randomUUID(), spki = publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
    signer = challenge => ({ deviceId, publicKey: spki, alg: 'ECDSA-P256-SHA256', signature: sign('sha256', Buffer.from(canonical({ domain: 'pi-pane/user-presence/v1', payload: challenge })), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url') });
    const paired = await client.request('POST', '/v1/devices/pair', { deviceId, publicKey: spki, label: '自动化测试设备' });
    await client.request('POST', `/v1/confirmations/${paired.confirmation.confirmationId}/sign`, signer(paired.confirmation.challenge));
    signers.set(client, signer);
  }
  return client.request('POST', `/v1/confirmations/${confirmation.confirmationId}/sign`, signer(confirmation.challenge));
}
