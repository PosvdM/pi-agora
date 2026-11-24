// 由 protocol-types-s2 测试做严格类型检查：公开类型必须声明 daemon 实际返回的修订号字段。
import type { AgoraClient, SessionSnapshot, SessionSummary, SessionsPage } from "@pi-agora/protocol";

export async function revisions(client: AgoraClient): Promise<number[]> {
  const page = await client.request<SessionsPage>("GET", "/v1/sessions");
  const item: SessionSummary | undefined = page.items[0];
  if (!item) return [];
  const detail = await client.request<SessionSummary>("GET", `/v1/sessions/${item.agoraSessionId}`);
  const snapshot = await client.request<SessionSnapshot>("GET", `/v1/sessions/${item.agoraSessionId}/snapshot`);
  await client.request("POST", `/v1/sessions/${item.agoraSessionId}/archive/delete`, { expectedRevision: snapshot.revision });
  return [item.revision, item.treeRevision, detail.revision, detail.treeRevision, snapshot.revision, page.changesCursor.seq];
}
