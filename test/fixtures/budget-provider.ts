import { appendFileSync } from 'node:fs';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/compat';

// 父子会话通过本地脚本验证预算唤醒，不访问模型服务。
export default function (pi) {
  pi.registerProvider('agora-budget', {
    baseUrl: 'http://127.0.0.1:1/never-requested', apiKey: 'local-test', api: 'agora-budget-scripted',
    models: [{ id: 'scripted', name: '预算唤醒测试', reasoning: true, input: ['text'], contextWindow: 200000, maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      const text = message => typeof message?.content === 'string' ? message.content : message?.content?.filter(item => item.type === 'text').map(item => item.text).join('\n') ?? '';
      const leaf = context.messages.some(m => m.role === 'user' && /(?:^|\n)BUDGET_LEAF$/.test(text(m)));
      const results = context.messages.filter(m => m.role === 'toolResult' && m.toolName === 'agora_task');
      const notices = context.messages.filter(m => m.role === 'user' && text(m).includes('agora 子代理事件'));
      const notice = notices.length > 0;
      const childId = results.map(text).join('\n').match(/"taskId"\s*:\s*"([^"]+)"/)?.[1];
      const raised = results.some(m => m.toolCallId === 'budget-limits');
      const resumed = results.some(m => m.toolCallId === 'budget-resume');
      const stopped = results.some(m => m.toolCallId === 'budget-stop');
      const content = leaf ? [{ type: 'text', text: '子任务请求已消耗预算' }]
        : !results.length ? [{ type: 'toolCall', id: 'budget-spawn', name: 'agora_task', arguments: { action: 'spawn', model: 'agora-budget/scripted', profile: 'explore', prompt: 'BUDGET_LEAF', title: '小预算下级', maxTokens: 30, notify: 'silent' } }]
        : notice && childId && !raised ? [{ type: 'toolCall', id: 'budget-limits', name: 'agora_task', arguments: { action: 'limits', taskId: childId, maxTokens: 60 } }]
        : raised && childId && !resumed ? [{ type: 'toolCall', id: 'budget-resume', name: 'agora_task', arguments: { action: 'recover', taskId: childId, mode: 'resume' } }]
        : notices.length >= 2 && childId && !stopped ? [{ type: 'toolCall', id: 'budget-stop', name: 'agora_task', arguments: { action: 'stop', taskId: childId } }]
        : [{ type: 'text', text: stopped ? '父任务已处理两次预算暂停并停止下级' : '父任务等待预算事件' }];
      appendFileSync(process.env.FAKE_REQUEST_LOG!, `${JSON.stringify({ leaf, notices: notices.length, raised, resumed, stopped, childId, content })}\n`);
      setTimeout(() => {
        const message = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content,
          stopReason: content[0].type === 'toolCall' ? 'toolUse' : 'stop',
          usage: { input: 0, output: leaf ? 40 : 0, cacheRead: 0, cacheWrite: 0, totalTokens: leaf ? 40 : 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        stream.push({ type: 'start', partial: { ...message, content: [] } });
        stream.push({ type: 'done', reason: message.stopReason, message }); stream.end();
      }, leaf ? 750 : 0);
      return stream;
    },
  });
}
