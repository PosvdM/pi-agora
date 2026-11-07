import { startDaemon, RpcSubprocessDriver } from '../../packages/daemon/dist/index.js';

const config = JSON.parse(process.argv[2]);
const driver = new RpcSubprocessDriver({ home: config.home, piPath: config.piPath,
  extensionPath: config.extensionPath, extraExtensions: [config.providerPath, config.blockerPath],
  env: process.env, containment: config.containment,
  stopOptions: { abortTimeoutMs: 150, graceMs: 150, termGraceMs: 150 } });
let failRecovery = config.failRecovery === true;
const recover = driver.recoverOldRun.bind(driver);
driver.recoverOldRun = async (...args) => {
  if (failRecovery) throw new Error('受控故障：旧写者尚未清理');
  return recover(...args);
};
try {
  const daemon = await startDaemon({ home: config.home, driver });
  process.on('message', async message => {
    if (message?.type === 'allowRecovery') {
      failRecovery = false;
      process.send?.({ type: 'recoveryAllowed' });
    }
    if (message?.type === 'forgetIdentity') {
      daemon.store.run('UPDATE process_runs SET identity=NULL,pid=NULL,process_start_time=NULL WHERE exited_at IS NULL');
      process.send?.({ type: 'identityForgotten' });
    }
    if (message?.type === 'close') {
      try {
        await daemon.close({ force: true, timeoutMs: 1000 });
        process.send?.({ type: 'closed' }, () => process.disconnect());
      } catch { process.send?.({ type: 'failure', message: '测试后台进程关闭失败' }); }
    }
  });
  process.send?.({ type: 'ready', url: daemon.url, instanceId: daemon.instanceId });
} catch {
  process.send?.({ type: 'failure', message: '测试后台进程启动失败' }, () => process.disconnect());
  process.exitCode = 1;
}
