import type { Server } from "node:http";
import { isFetchForbiddenPort } from "@pi-agora/protocol";

export const MAX_PORT_ATTEMPTS = 10;

// 每轮使用独立 server，使 close 绑定的资源清理不会影响下一轮。
export async function listenOnFetchPort(createServer: () => Server): Promise<{ server: Server; port: number }> {
  for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt++) {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("daemon 监听地址无效");
    if (!isFetchForbiddenPort(address.port)) return { server, port: address.port };
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
  }
  throw new Error(`daemon 连续 ${MAX_PORT_ATTEMPTS} 次分配到被 Fetch 禁止的端口，无法启动`);
}
