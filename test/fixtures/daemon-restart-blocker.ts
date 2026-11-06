import { writeFileSync } from 'node:fs';
import path from 'node:path';

export default function (pi) {
  pi.on('message_update', () => {
    writeFileSync(path.join(process.env.DRIVER_TEST_ROOT, 'daemon-rpc-blocked'), '测试同步阻塞');
    // 保持事件循环阻塞，使 POSIX 旧 pi 无法处理 stdin EOF，必须由重启扫描清理。
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  });
}
