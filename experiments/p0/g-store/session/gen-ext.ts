// 生成会话文件用的测试扩展：通过扩展命令写出 custom、custom_message、label 条目并在会话树中导航。
// 只在 G 组实验的隔离现场里用 -e 加载。
export default function (pi: any) {
  pi.registerCommand('g-entry', {
    description: 'append a custom entry',
    handler: async (args: string) => { pi.appendEntry('g-state', { note: args || 'state' }); },
  });
  pi.registerCommand('g-msg', {
    description: 'append a custom message without triggering a turn',
    handler: async (args: string) => {
      pi.sendMessage({ customType: 'g-note', content: args || 'note', display: true, details: { by: 'g' } }, { triggerTurn: false });
    },
  });
  pi.registerCommand('g-label', {
    description: 'label an entry: <id> <label>',
    handler: async (args: string) => {
      const [id, label] = args.trim().split(/\s+/);
      pi.setLabel(id, label);
    },
  });
  pi.registerCommand('g-nav', {
    description: 'navigate the tree: <id> [summarize]',
    handler: async (args: string, ctx: any) => {
      const [id, mode] = args.trim().split(/\s+/);
      await ctx.waitForIdle();
      await ctx.navigateTree(id, { summarize: mode === 'summarize' });
    },
  });
}
