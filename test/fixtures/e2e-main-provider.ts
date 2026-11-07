import { appendFileSync } from "node:fs";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";

// 主会话通过真实工具派任务；收到通知后主动取结果，不调用外部模型服务。
export default function (pi) {
  pi.registerProvider("agora-e2e", {
    baseUrl: "http://127.0.0.1:1/never-requested",
    apiKey: "local-test",
    api: "agora-e2e-scripted",
    models: [{ id: "scripted", name: "协作闭环测试", reasoning: true, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 8192 }],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        try {
          const results = context.messages.filter((item) => item.role === "toolResult" && item.toolName === "agora_task");
          const text = (message) => typeof message?.content === "string" ? message.content : message?.content?.filter((item) => item.type === "text").map((item) => item.text).join("\n") ?? "";
          const parsed = results.map((result) => {
            if (result.details?.taskId) return result.details;
            try { return JSON.parse(text(result)); } catch { return {}; }
          });
          const task = parsed.find((item) => item.taskId);
          const lastUser = text(context.messages.findLast((item) => item.role === "user"));
          const completed = parsed.find((item) => item.resultText || item.result?.resultText || item.result?.text);
          let content;
          if (!task) content = [{ type: "toolCall", id: "e2e-spawn", name: "agora_task", arguments: {
            action: "spawn", model: "p0-fake/scripted", profile: "explore", thinking: "high", prompt: "读取 evidence.txt，给出只读检查结果", title: "只读检查",
          } }];
          else if (lastUser.includes("agora") && !completed) content = [{ type: "toolCall", id: "e2e-result", name: "agora_task", arguments: { action: "result", taskId: task.taskId } }];
          else content = [{ type: "text", text: completed ? `主会话已获取结果：${JSON.stringify(completed)}` : "已派出子代理，等待完成通知。" }];
          if (process.env.E2E_MAIN_REQUEST_LOG) appendFileSync(process.env.E2E_MAIN_REQUEST_LOG, `${JSON.stringify({ context, content })}\n`);
          const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content,
            stopReason: content[0].type === "toolCall" ? "toolUse" : "stop",
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
          stream.push({ type: "start", partial: { ...message, content: [] } });
          stream.push({ type: "done", reason: message.stopReason, message });
        } catch (error) {
          stream.push({ type: "error", reason: "error", error: { role: "assistant", content: [], errorMessage: String(error), stopReason: "error" } });
        } finally { stream.end(); }
      });
      return stream;
    },
  });
}
