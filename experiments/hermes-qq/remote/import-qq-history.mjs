import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { inbox } from '../../aoa-async/qq-receive-only.mjs';

const [input, policyFile, output] = process.argv.slice(2);
if (!input || !policyFile || !output) throw new Error('expected source, policy and inbox paths');
process.umask(0o077);
const snapshot = JSON.parse(readFileSync(input, 'utf8'));
const { verifiedNames } = JSON.parse(readFileSync(policyFile, 'utf8'));
if (snapshot.accountId !== 'default' || !snapshot.state?.peers || !verifiedNames) {
  throw new Error('invalid QQ history snapshot');
}
const db = new DatabaseSync(output);
const start = Date.now();
let time = start;
const recorder = inbox(db, { mode: 'all-groups', now: () => time });
let imported = 0;
try {
  for (const [groupId, peer] of Object.entries(snapshot.state.peers)) {
    if (!Object.hasOwn(verifiedNames, groupId)) continue;
    const rows = [...(peer.readHistory ?? []), ...(peer.history ?? [])].sort((a, b) => a.timestamp - b.timestamp);
    for (const row of rows.slice(-2000)) {
      if (typeof row.body !== 'string' || !row.body.trim() ||
          !Number.isSafeInteger(row.timestamp) || row.timestamp < start - 86_400_000 || row.timestamp >= start) continue;
      time = row.timestamp;
      const body = row.body.replace(/https?:\/\/\S+|\bsk-[\w-]{10,}|<@!?[^>]+>/gi, ' ').trim();
      if (/密钥|验证码|密码|api[_ -]?key|app[_ -]?secret|\bBearer\s+/iu.test(body) || !body) continue;
      if (recorder.record({ kind: 'group', groupOpenid: groupId, senderId: row.actorId, messageId: row.messageId,
        senderIsBot: row.actorIsBot === true, rawEventType: 'GROUP_MESSAGE_CREATE', content: body })) imported++;
    }
  }
} finally { db.close(); }
console.log(JSON.stringify({ imported }));
