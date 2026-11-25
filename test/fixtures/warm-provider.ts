import { appendFileSync } from 'node:fs';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/compat';

// 缓存预热测试：声明 11 秒缓存寿命（pi 每 1 秒刷新一次）和很高的缓存写入价，让 pi 的经济性判断选择预热；不访问模型服务。
// 第一轮调用 ls，第二轮延迟 4 秒返回，使 pi 在 agent 运行期间发出预热请求。maxTokens 为 1 的请求是预热。
export default function (pi) {
  pi.registerProvider('agora-warm', {
    baseUrl: 'http://127.0.0.1:1/never-requested', apiKey: 'local-test', api: 'agora-warm-scripted',
    models: [{ id: 'cached', name: '缓存预热测试', reasoning: true, input: ['text'], contextWindow: 200000, maxTokens: 4096,
      promptCache: { short: 11 }, cost: { input: 3, output: 15, cacheRead: 1, cacheWrite: 2000 } }],
    streamSimple(model, context, options) {
      const warm = options?.maxTokens === 1;
      const toolDone = context.messages.some(m => m.role === 'toolResult');
      appendFileSync(process.env.FAKE_REQUEST_LOG!, `${JSON.stringify({ at: Date.now(), warm, toolDone })}\n`);
      const stream = createAssistantMessageEventStream();
      const content = warm ? [{ type: 'text', text: '.' }]
        : toolDone ? [{ type: 'text', text: 'WARM_DONE' }]
        : [{ type: 'toolCall', id: 'warm-ls', name: 'ls', arguments: { path: '.' } }];
      const usage = warm ? { input: 0, output: 1, cacheRead: 500, cacheWrite: 0, totalTokens: 501 }
        : toolDone ? { input: 20, output: 3, cacheRead: 500, cacheWrite: 10, totalTokens: 533 }
        : { input: 10, output: 5, cacheRead: 0, cacheWrite: 500, totalTokens: 515 };
      const message = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content,
        stopReason: content[0].type === 'toolCall' ? 'toolUse' : 'stop',
        usage: { ...usage, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      setTimeout(() => {
        stream.push({ type: 'start', partial: { ...message, content: [] } });
        stream.push({ type: 'done', reason: message.stopReason, message }); stream.end();
      }, !warm && toolDone ? 4000 : 0);
      return stream;
    },
  });
}
