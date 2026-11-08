import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { openStore } from '../packages/daemon/dist/store.js';
import { openArchive } from '../packages/archive/dist/index.js';

test('在线与离线关系投影保持中立，并跟随父任务当前会话', async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'agora-relations-'));
  const store = await openStore(home);
  let reader;
  t.after(async () => { reader?.close(); store.close(); await rm(home, { recursive: true, force: true }); });
  const at = new Date().toISOString();
  store.run("INSERT INTO principals(id,type,label,pi_session_id,created_at) VALUES('main','agent:main','主会话','pi_main',?)", at);
  async function seed(taskId, sessionId, convener, parentTask = null) {
    const file = path.join(home, 'sessions', sessionId, 'session.jsonl'), principal = 'child_' + sessionId;
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ type: 'session', version: 3, id: 'pi_' + sessionId, timestamp: at }) + '\n');
    store.run("INSERT INTO principals(id,type,label,created_at) VALUES(?,'agent:child','子会话',?)", principal, at);
    store.run("INSERT INTO agora_sessions(id,task_id,principal_id,convener_id,parent_principal_id,session_file,profile,model,thinking,cwd,status,created_at) VALUES(?,?,?,?,?,?,'explore','test/model','high',?,'completed',?)", sessionId, taskId, principal, convener, convener, file, home, at);
    store.run("INSERT INTO tasks(id,agora_session_id,convener_id,requested_by,title,prompt,model,thinking,profile,cwd,notify,status,created_at,updated_at,parent_task_id) VALUES(?,?,?,?,?,'任务','test/model','high','explore',?,'wake','completed',?,?,?)", taskId, sessionId, convener, convener, taskId, home, at, at, parentTask);
  }
  await seed('tk_root', 'as_root', 'main');
  await seed('tk_nested', 'as_nested', 'child_as_root', 'tk_root');
  await seed('tk_user', 'as_user', 'user');
  reader = await openArchive({ home, apiVersion: 1 });
  const expected = {
    as_root: { kind: 'main', piSessionId: 'pi_main' },
    as_nested: { kind: 'task', taskId: 'tk_root', sessionId: 'as_root' },
    as_user: { kind: 'user' },
  };
  const list = await reader.listSessions();
  for (const [sessionId, parent] of Object.entries(expected)) {
    assert.deepEqual(store.sessionParent(sessionId), parent);
    assert.deepEqual((await reader.getSession(sessionId)).parent, parent);
    assert.deepEqual(list.items.find(item => item.agoraSessionId === sessionId).parent, parent);
  }
  const file = path.join(home, 'sessions', 'as_reopened', 'session.jsonl');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ type: 'session', version: 3, id: 'pi_reopened', timestamp: at }) + '\n');
  store.run("INSERT INTO principals(id,type,label,created_at) VALUES('child_reopened','agent:child','重开',?)", at);
  store.run("INSERT INTO agora_sessions(id,task_id,principal_id,convener_id,parent_principal_id,session_file,profile,model,thinking,cwd,status,created_at,inherits_from,inherit_reason) SELECT 'as_reopened',task_id,'child_reopened',convener_id,parent_principal_id,?,profile,model,thinking,cwd,'completed',created_at,id,'reopen' FROM agora_sessions WHERE id='as_root'", file);
  store.run("UPDATE tasks SET agora_session_id='as_reopened' WHERE id='tk_root'");
  const parent = { kind: 'task', taskId: 'tk_root', sessionId: 'as_reopened' };
  assert.deepEqual(store.sessionParent('as_nested'), parent);
  assert.deepEqual((await reader.getSession('as_nested')).parent, parent);
  assert.equal((await reader.getSession('as_reopened')).inheritsFrom, 'as_root');
  assert.equal((await reader.getSession('as_reopened')).inheritReason, 'reopen');
  assert.equal((await reader.getSession('as_reopened')).isCurrent, true);
  assert.equal((await reader.getSession('as_root')).isCurrent, false);
  for (const [sessionId, runId, context] of [['as_root', 'pr_old', 40], ['as_reopened', 'pr_new', 80]]) {
    store.run("INSERT INTO process_runs(id,agora_session_id,daemon_instance_id,state,started_at,exited_at) VALUES(?,?,'in_test','exited',?,?)", runId, sessionId, at, at);
    store.run("INSERT INTO usage_records(task_id,generation,agora_session_id,run_id,request_id,input_tokens,cache_read_tokens,cache_write_tokens,output_tokens,reasoning_tokens,context_tokens,created_at) VALUES('tk_root',1,?,?,?, ?,0,0,2,0,?,?)", sessionId, runId, runId, context, context, at);
  }
  assert.equal(store.sessionUsage('as_root').contextTokens, 40);
  assert.equal(store.sessionUsage('as_reopened').contextTokens, 80);
  assert.equal((await reader.getSession('as_root')).usage.contextTokens, 40);
  assert.equal((await reader.getSession('as_reopened')).usage.contextTokens, 80);
  assert.equal((await reader.getSession('as_root')).usage.requests, 1);
});
