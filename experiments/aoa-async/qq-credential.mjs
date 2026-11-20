import { execFileSync } from 'node:child_process';
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

export function readQqAppSecret(account, reference) {
  let secret;
  if (process.platform === 'darwin') {
    secret = execFileSync('/usr/bin/security', [
      'find-generic-password', '-a', account, '-s', reference, '-w',
    ], { encoding: 'utf8', timeout: 8_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } else {
    if (process.platform !== 'linux' || !isAbsolute(reference)) throw new Error('expected a private QQ credential file');
    const fd = openSync(reference, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.uid !== process.getuid() || stat.mode & 0o077 || stat.size > 4096) {
        throw new Error('unsafe QQ credential file');
      }
      secret = readFileSync(fd, 'utf8').trim();
    } finally { closeSync(fd); }
  }
  if (!secret || /[\s\x00-\x1f]/u.test(secret)) throw new Error('invalid QQ credential');
  return secret;
}
