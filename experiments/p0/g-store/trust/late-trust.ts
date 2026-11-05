// 与 pane-bridge 同时加载的另一个 project_trust 处理器（按 -e 顺序位于 pane-bridge 之后）。
// 环境变量 P0_LATE_TRUST 取值 yes / no / undecided / throw；P0_TRUST_LOG 为日志路径。
import { appendFileSync } from 'node:fs';

export default function (pi: any) {
  pi.on('project_trust', async (event: any) => {
    const mode = process.env.P0_LATE_TRUST ?? 'undecided';
    if (process.env.P0_TRUST_LOG) appendFileSync(process.env.P0_TRUST_LOG, `${JSON.stringify({ at: Date.now(), kind: 'late', eventCwd: event.cwd, mode })}\n`);
    if (mode === 'throw') throw new Error('late handler failure');
    return { trusted: mode };
  });
}
