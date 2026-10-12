import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const officialUrl = 'https://q.qq.com/';
const imageUrl = 'https://raw.githubusercontent.com/tencent-connect/bot-docs/main/docs/.vuepress/public/images/api-231017/23.png';
const markdown = (content, extra = {}) => ({ msg_type: 2, markdown: { content }, ...extra });
const button = (id, label, type, data, extra = {}) => ({
  id,
  render_data: { label, visited_label: label, style: 1 },
  action: { type, data, permission: { type: 2 }, unsupport_tips: '请更新 QQ 客户端后重试', ...extra },
});

export function buildSamples() {
  return [
    { label: 'markdown', payload: markdown('# 01 · Markdown 排版\n## 标题与正文\n**加粗** / _斜体_ / ~~删除线~~\n\n> 引用：这是一条样式演示，不是系统状态。\n\n- 接收消息\n- 整理信息\n\n1. 选择格式\n2. 查看效果\n\n***\n分割线下方的普通正文。') },
    { label: 'links', payload: markdown('## 02 · 外链\n[打开 QQ 机器人平台](https://q.qq.com/)\n\n外链是否可打开，还受平台域名配置和客户端影响。') },
    { label: 'command-links', payload: markdown('## 03 · 命令蓝链\n<qqbot-cmd-input text="/help" show="填入 /help"/>\n\n直接发送：<qqbot-cmd-enter text="/help"/>\n\n两个入口只调用帮助，不修改配置。') },
    { label: 'keyboard', payload: markdown('## 04 · 原生交互按钮\n第一行：只填入输入框，或者直接发送帮助。第二行：打开网页。', {
      keyboard: { content: { rows: [
        { buttons: [button('help-input', '填入帮助', 2, '/help', { enter: false }), button('help-send', '发送帮助', 2, '/help', { enter: true })] },
        { buttons: [button('open-site', '打开 QQ 平台', 0, officialUrl)] },
      ] } },
    }) },
    { label: 'table-native-probe', payload: markdown('## 05 · 表格语法探针\n下面是原生 Markdown 表格语法；如果显示竖线，说明当前客户端没有渲染表格。\n\n| 格式 | 用途 |\n| --- | --- |\n| 文本 | 日常交流 |\n| 按钮 | 快速操作 |\n| 图片 | 复杂排版 |') },
    { label: 'formula-native-probe', payload: markdown('## 06 · 公式语法探针\n下面是 LaTeX 原始语法，不代表 QQ 保证支持渲染。\n\n$E=mc^2$\n\n$$x=\\frac{-b\\pm\\sqrt{b^2-4ac}}{2a}$$\n\n后面另发图片版供对比。') },
    { label: 'code-native-probe', payload: markdown('## 07 · 代码语法探针\n行内：`console.log("hello")`\n\n```js\nconst format = "QQBot";\nconsole.log(format);\n```\n\n代码高亮与等宽效果需要在客户端检查。') },
    { label: 'ark-list', payload: { msg_type: 3, ark: { template_id: 23, kv: [
      { key: '#DESC#', value: '08 · ARK 文本列表' },
      { key: '#PROMPT#', value: '卡片样式演示' },
      { key: '#LIST#', obj: [
        { obj_kv: [{ key: 'desc', value: 'R2-D2 消息样式演示' }] },
        { obj_kv: [{ key: 'desc', value: 'Markdown / 按钮 / 图文' }] },
        { obj_kv: [{ key: 'desc', value: '打开 QQ 机器人平台' }, { key: 'link', value: officialUrl }] },
      ] },
    ] } } },
    { label: 'ark-thumbnail', payload: { msg_type: 3, ark: { template_id: 24, kv: Object.entries({
      '#DESC#': '09 · ARK 缩略图外链卡片', '#PROMPT#': '外链卡片演示',
      '#TITLE#': 'QQ 消息样式', '#METADESC#': '真实平台链接，不是小程序占位地址',
      '#IMG#': imageUrl, '#LINK#': officialUrl, '#SUBTITLE#': '模板 24',
    }).map(([key, value]) => ({ key, value })) } } },
    { label: 'ark-large-image', payload: { msg_type: 3, ark: { template_id: 37, kv: Object.entries({
      '#PROMPT#': '10 · ARK 大图卡片', '#METATITLE#': 'R2-D2 样式展示',
      '#METASUBTITLE#': '大图 + 标题 + 网页入口', '#METACOVER#': imageUrl, '#METAURL#': officialUrl,
    }).map(([key, value]) => ({ key, value })) } } },
    { label: 'markdown-image', payload: markdown(`## 11 · Markdown 图文混排\n图片上方可以写正文。\n\n![官方示例图 #360px #240px](${imageUrl})\n\n图片下方还可以继续写 **说明文字**。图片域名须满足平台要求。`) },
    { label: 'table-image', image: 'table.png', caption: '12 · 图片表格：复杂表格可先排版成图片；这不是 QQ 原生表格。' },
    { label: 'formula-image', image: 'formula.png', caption: '13 · 图片公式：图片中排版数学公式，不依赖 QQ 的 LaTeX 支持。' },
    { label: 'card-image-caption', image: 'card.png', caption: '14 · 文字 + 图片：图片简报搭配同条消息说明；图中的文字和入口不是可点击按钮。' },
    { label: 'gif', image: 'animation.gif', caption: '15 · GIF 动图：三帧动画，实际播放请查看客户端。' },
  ];
}

export function resolveAdministrator(config) {
  if (!config?.appId || !config.clientSecret || config.enabled === false) throw new Error('QQBot default account is not enabled/configured');
  const admins = [...new Set(config.customRuntime?.admins ?? [])];
  if (admins.length !== 1 || typeof admins[0] !== 'string' || !admins[0]) throw new Error('Require exactly one bound administrator; refusing to choose a recipient');
  return admins[0];
}

export async function runSamples({ samples, api, token, admin, assets, onResult, delayMs = 1500, secrets = [] }) {
  const results = [];
  for (const sample of samples) {
    let result;
    try {
      let response;
      if (sample.image) {
        const localPath = path.join(assets, sample.image);
        const mime = sample.image.endsWith('.gif') ? 'image/gif' : 'image/png';
        const data = await fs.readFile(localPath);
        response = await api.sendC2CImageMessage(token, admin, `data:${mime};base64,${data.toString('base64')}`, undefined, sample.caption, localPath);
      } else {
        response = await api.apiRequest(token, 'POST', `/v2/users/${admin}/messages`, sample.payload);
      }
      result = { label: sample.label, accepted: true, messageId: response.id, timestamp: response.timestamp, renderingVerified: false };
    } catch (error) {
      let message = String(error.bizMessage ?? error.message ?? 'Unknown error');
      for (const secret of [admin, token, ...secrets]) if (secret) message = message.replaceAll(secret, '[redacted]');
      result = { label: sample.label, accepted: false, status: error.status, code: error.bizCode, message };
    }
    results.push(result);
    await onResult(result, results);
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return results;
}

async function main() {
  const { values } = parseArgs({ options: {
    send: { type: 'boolean', default: false }, root: { type: 'string', default: path.join(os.homedir(), '.openclaw') },
    assets: { type: 'string' }, report: { type: 'string' }, only: { type: 'string' },
  } });
  let samples = buildSamples();
  if (values.only) {
    const selected = new Set(values.only.split(','));
    if ([...selected].some((label) => !samples.some((sample) => sample.label === label))) throw new Error('Unknown sample label');
    samples = samples.filter((sample) => selected.has(sample.label));
  }
  if (!values.send) {
    console.log(JSON.stringify({ mode: 'preview', target: 'bound-administrator-private-chat', samples }, null, 2));
    return;
  }
  if (!values.assets) throw new Error('--assets is required for sending');
  // Reserve the report before sending: an existing report blocks accidental batch replay.
  const reportPath = values.report ?? path.join(values.assets, 'results.json');
  const report = { startedAt: new Date().toISOString(), target: 'bound-administrator-private-chat', results: [] };
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
  const config = JSON.parse(await fs.readFile(path.join(values.root, 'openclaw.json'), 'utf8')).channels?.qqbot;
  const admin = resolveAdministrator(config);
  const api = await import(pathToFileURL(path.join(values.root, 'extensions/openclaw-qqbot/dist/src/api.js')).href);
  api.setApiLogger({ info() {}, error() {}, warn() {}, debug() {} });
  const token = await api.getAccessToken(config.appId, config.clientSecret);
  await runSamples({ samples, api, token, admin, assets: values.assets, secrets: [config.clientSecret],
    async onResult(result, results) {
      report.results = results;
      await fs.writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
      console.log(JSON.stringify(result));
    },
  });
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ total: report.results.length, accepted: report.results.filter((result) => result.accepted).length, reportPath }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
