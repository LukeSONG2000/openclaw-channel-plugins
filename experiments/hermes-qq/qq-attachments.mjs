import { execFile } from 'node:child_process';
import { posix } from 'node:path';

const maxBytes = 12 * 1024 * 1024;
const extensions = /\.(pdf|txt|md|csv|json|zip|docx|xlsx|pptx|png|jpe?g|webp|gif)$/i;
const store = '/opt/data/kanban/attachments';

export function completionFiles(id, rows) {
  if (!/^t_[a-f0-9]{8,32}$/.test(id) || !Array.isArray(rows)) throw new Error('invalid Kanban attachments');
  const files = [], names = new Set();
  let size = 0;
  for (const row of rows) {
    if (row?.uploaded_by !== 'kanban_complete') continue;
    const name = row.filename, path = row.stored_path;
    if (typeof name !== 'string' || !extensions.test(name) || !/^[\p{L}\p{N}][\p{L}\p{N} ._()-]{0,119}$/u.test(name) ||
        names.has(name.toLowerCase()) || typeof path !== 'string' || posix.dirname(path) !== `${store}/${id}` ||
        !/^[\p{L}\p{N}_. ()-]{1,255}$/u.test(posix.basename(path)) || posix.basename(path).startsWith('.') ||
        !Number.isSafeInteger(row.size) || row.size < 1) throw new Error('invalid completion file');
    size += row.size;
    if (size > maxBytes || files.length >= 12) throw new Error('completion file budget exceeded');
    names.add(name.toLowerCase());
    files.push({ name, storedName: posix.basename(path), size: row.size });
  }
  return files;
}

// Read only the native task's adopted files in the worker. Neither agent paths nor host credentials cross this boundary.
const exportScript = `
import io, json, os, stat, sys, zipfile
root = os.open('${store}', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
task = os.open(sys.argv[1], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root)
files = json.load(sys.stdin)
def read(item):
    fd = os.open(item['storedName'], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=task)
    with os.fdopen(fd, 'rb') as f:
        info = os.fstat(f.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size != item['size']:
            raise ValueError('completion file changed')
        data = f.read(item['size'] + 1)
        if len(data) != item['size'] or (item['name'].lower().endswith('.pdf') and not data.startswith(b'%PDF-')):
            raise ValueError('invalid completion file bytes')
        return data
if len(files) == 1:
    sys.stdout.buffer.write(read(files[0]))
else:
    out = io.BytesIO()
    with zipfile.ZipFile(out, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        for item in files:
            archive.writestr(item['name'], read(item))
    sys.stdout.buffer.write(out.getbuffer())
`;

export function readCompletionFiles(engine, workerArgs, id, rows) {
  const files = completionFiles(id, rows);
  if (!files.length) return;
  return new Promise((resolve, reject) => {
    const child = execFile(engine, [...workerArgs, 'python3', '-c', exportScript, id], {
      encoding: 'buffer', maxBuffer: maxBytes + 65_536, timeout: 15_000,
    }, (error, stdout) => {
      if (error || !stdout.length || stdout.length > maxBytes) return reject(new Error('unable to export Kanban completion files'));
      resolve({ name: files.length === 1 ? files[0].name : 'attachments.zip', bytes: stdout });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(files));
  });
}

export async function sendQqFile(bot, target, file, seq, canSend) {
  const upload = await bot.uploadMedia({ target, fileType: 4, buffer: file.bytes, fileName: file.name, srvSendMsg: false })
    .catch(() => null);
  if (!upload?.file_info || !await canSend()) return { retryable: true };
  return bot.send({ target, msgType: 7, media: { file_info: upload.file_info }, extra: { msg_seq: seq } });
}
