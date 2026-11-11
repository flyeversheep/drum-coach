#!/usr/bin/env node
// 生成 Apple Music 开发者令牌（Developer Token）。只用 Node 自带模块，不联网。
// 用法：
//   node tools/make-token.mjs --team <Team ID> --key <Key ID> --p8 <AuthKey_XXXX.p8 的路径> [--days 180]
// 把输出的一长串粘贴到网页「伴奏音乐 → Apple Music → 开发者令牌」里。
import { createPrivateKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
if (!args.team || !args.key || !args.p8) {
  console.error('用法: node tools/make-token.mjs --team <Team ID> --key <Key ID> --p8 <AuthKey_XXXX.p8> [--days 180]');
  process.exit(1);
}
const days = Math.min(180, Math.max(1, Number(args.days) || 180)); // Apple 最长只接受约 6 个月
const now = Math.floor(Date.now() / 1000);
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const head = b64({ alg: 'ES256', kid: args.key });
const body = b64({ iss: args.team, iat: now, exp: now + days * 86400 });
const key = createPrivateKey(readFileSync(args.p8));
const sig = sign('sha256', Buffer.from(`${head}.${body}`), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
console.log(`${head}.${body}.${sig}`);
console.error(`\n有效期到 ${new Date((now + days * 86400) * 1000).toLocaleDateString('zh-CN')}，到期后重新运行一次即可。`);
