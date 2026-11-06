// 独立宿主用于强杀后恢复；HOME、会话文件和 provider 都由测试现场提供。
import { RpcSubprocessDriver } from "../../packages/daemon/dist/driver.js";
const args = JSON.parse(process.env.DRIVER_HOST_ARGS);
const driver = new RpcSubprocessDriver(args.options);
const handle = await driver.start(args.spec);
const state = await handle.send({ type: "get_state" });
if (!state.success) throw new Error(state.error);
handle.markReady();
if (args.message) await handle.send({ type: "prompt", message: args.message });
process.stdout.write(`${JSON.stringify({ identity: handle.identity })}\n`);
process.stdin.resume();
