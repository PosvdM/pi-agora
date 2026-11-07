import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/compat';

// 真实受管父子会话共用本地 provider，通过任务书区分层级，不访问模型服务。
export default function (pi) {
  pi.registerProvider('agora-tree', {
    baseUrl: 'http://127.0.0.1:1/never-requested', apiKey: 'local-test', api: 'agora-tree-scripted',
    models: [{ id: 'scripted', name: '多层任务测试', reasoning: true, input: ['text'], contextWindow: 200000, maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      const text = message => typeof message?.content === 'string' ? message.content : message?.content?.filter(item => item.type === 'text').map(item => item.text).join('\n') ?? '';
      const leaf = context.messages.some(m => m.role === 'user' && text(m) === 'TREE_LEAF');
      const results = context.messages.filter(m => m.role === 'toolResult' && m.toolName === 'agora_task');
      const notice = context.messages.some(m => m.role === 'user' && text(m).includes('agora 子代理事件'));
      const content = leaf ? [{ type: 'text', text: '真实下级检查完成' }]
        : !results.length ? [{ type: 'toolCall', id: 'tree-spawn', name: 'agora_task', arguments: { action: 'spawn', model: 'agora-tree/scripted', profile: 'explore', prompt: 'TREE_LEAF', title: '真实孙代理' } }]
        : [{ type: 'text', text: notice ? '父任务核对下级后的最终结果' : '父任务等待下级，尚未交付最终结果' }];
      setTimeout(() => {
        const message = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content,
          stopReason: content[0].type === 'toolCall' ? 'toolUse' : 'stop',
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        stream.push({ type: 'start', partial: { ...message, content: [] } });
        stream.push({ type: 'done', reason: message.stopReason, message }); stream.end();
      }, leaf ? 350 : 0);
      return stream;
    },
  });
}
