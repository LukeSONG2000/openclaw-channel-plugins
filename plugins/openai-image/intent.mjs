const ANIMATION = /(?:动态图|动画图|动图|动态表情|GIF|动画表情|动起来|循环动画|逐帧动画|animated (?:image|sticker)|make (?:it|this) move)/iu;
const STILL_ONLY = /(?:不要|不用|别(?:做|生成)?|不需要|只要静态).{0,5}(?:动态图|动图|GIF|动画)|(?:no|not (?:an? )?)\s+(?:gif|animation)|(?:静态|PNG)\s*(?:就行|即可|版本|图)/iu;
const VISUAL = /(?:图片|图像|插图|插画|配图|图标|海报|壁纸|头像|封面|长图|表情包|动图|动态图|漫画|照片|分镜图|视觉稿|GIF|PNG|image|picture|poster|sticker|wallpaper|illustration|avatar)/iu;
const NO_ACTION = /(?:不要|不用|别|不需要|不想)(?:再|给我|帮我)?\s*(?:生成|制作|做|画|绘制|编辑|修改|精修|美化|改|转成|重画|把)|(?:怎么|如何|能不能教|教程|用什么|有没有).{0,15}(?:生成|做|画|改|制作|转)|(?:是什么|有什么区别|多少钱|怎么做|教程)(?:[?？。！! ]|$)|(?:don't|do not|how to|how do (?:i|you)|tutorial|example prompt)/iu;
const LEAD = /^(?:请|麻烦|帮忙|帮我|给我|能(?:否|不能|可以)|可以|能帮我|能给我|[，,：:\s])+/u;
const DIRECT = /^(?:生成|创作|制作|绘制|画(?:一|个|张|幅|下)?|输出|来(?:一|个|张)|做(?:一|个|张|幅|出)|(?:我)?想要|设计|弄(?:一|个|张|幅)|试着|生图|create\b|generate\b|draw\b|make\b|design\b|render\b)/iu;
const EDIT = /(?:精修|修图|修一下|改图|重绘|重画|换掉|换成|改成|改一下|替换(?:成)?|去掉|移除|抠图|加上|保留|增强|上色|转成|变成|换(?:个|一个)?背景|去水印|调亮|调色|放大|缩小|resize|retouch|edit|remove|replace|recolor)/iu;
const IMAGE_TARGET = /(?:这(?:张|个|幅)(?:图|图片|照片|人物|头像|表情)|图[中里内]|图片[中里内]|原图|上[一张条幅]|刚才的图|this (?:image|photo|picture)|the attached image)/iu;
const VISUAL_CORRECTION = /(?:毛色|花纹|品种|脸|五官|颜色|主体|构图|文字)(?:都|全|完全|已经)?(?:不对|不一样|变了|错了)/iu;
const REF = /(?:参考(?:这|图|图片|原图|附件|风格)|借鉴|照着(?:它|这|图)|仿照|根据.{0,10}(?:参考图|附件|配色|画风)|inspired by|as (?:a )?reference|same (?:palette|style))/iu;
const VIDEO = /(?:视频|短片|MP4|WebM|动效视频|video clip)/iu;
const VISUAL_AS_INPUT = /(?:图片|图像|照片|GIF|动图)(?:的)?(?:识别|压缩|转换|搜索|下载|浏览|编辑|上传|生成)(?:器|工具|脚本|网站|程序|软件|接口|应用)/iu;
const REDRAW = /(?:^|[，,。！!；;：:\n])\s*(?:(?:现在|立即|马上|那就|请|麻烦|帮我|给我)\s*)*(?:重新(?:画|绘制|生成|出图)|重画|重绘|再(?:画|生成|来)(?:一张|一幅)|再出(?:一张|一版))(?:一(?:次|张|版|幅)|一下)?(?:吧|一下吧|可以吗|好吗)?\s*(?:[，,。！!；;：:？?\n]|$)/u;
const REDRAW_NEGATED = /(?:不(?:要|用|必|需要|想)|别|无需|先别)\s*(?:现在|立即|马上|再|帮我)?\s*(?:重新(?:画|绘制|生成|出图)|重画|重绘|再画|再生成|再出图|再来)/u;

export function isImagenRedraw(text) {
  return !NO_ACTION.test(text) && !REDRAW_NEGATED.test(text) && REDRAW.test(text);
}

export function inferImagenFormat(prompt) {
  return ANIMATION.test(prompt) && !STILL_ONLY.test(prompt) ? 'gif' : 'png';
}

export function inferImagenMode(prompt, hasImages) {
  return hasImages ? ((EDIT.test(prompt) || VISUAL_CORRECTION.test(prompt) || /动起来|animate this/iu.test(prompt)) && !REF.test(prompt) ? 'edit' : 'ref') : 'text';
}

export function requiresImagenSource(prompt) {
  return VISUAL_CORRECTION.test(prompt) ||
    (IMAGE_TARGET.test(prompt) && (EDIT.test(prompt) || REF.test(prompt) || ANIMATION.test(prompt))) ||
    /^(?:请|帮我)?(?:把|将|让|给)这.{0,22}(?:放大|缩小|动起来|换成|改成)/u.test(prompt);
}

export function isImagenEditCorrection(prompt) {
  return VISUAL_CORRECTION.test(prompt);
}

export function wantsRecentImagenSource(prompt) {
  return /(?:刚才|之前|上面|前面|群里最近).{0,10}(?:图|照片|附件|表情)|(?:这张|这幅|上一张|上一幅|原图|它).{0,15}(?:动起来|换|改|放大|缩小)|(?:把|将|让|给)这.{0,22}(?:放大|缩小|动起来|换成|改成)|(?:the previous|the last|earlier) (?:image|photo|picture)/iu.test(prompt);
}

export function recognizeImagenIntent(raw, hasImages) {
  if (typeof raw !== 'string') return;
  const text = raw.trim();
  if (!text || text.length > 1800 || text.startsWith('/') || NO_ACTION.test(text) ||
      REDRAW_NEGATED.test(text) || VISUAL_AS_INPUT.test(text)) return;
  if (/^(?:我(?:想)?要(?:的)?(?:是)?|还是(?:要|做)|不是静态图[，,，。！! ]+(?:要|换成)|(?:改成|换成|做成|转成))\s*(?:一(?:张|个)?\s*)?(?:动态图|动图|GIF)(?:版(?:本)?)?[吧呀啊呢。！!，, ]*$/iu.test(text)) {
    return { kind: 'format-correction' };
  }
  if (isImagenRedraw(text)) return { kind: 'redraw', args: text };
  if ((requiresImagenSource(text) || wantsRecentImagenSource(text)) && !hasImages) return { kind: 'needs-image' };
  const request = text.replace(LEAD, '').replace(/^(?:please|can you|could you|would you)\s+/iu, '');
  const startsCreation = DIRECT.test(request) || /^(?:根据|基于|结合|按).{1,45}(?:生成|画|做|创作|制作)(?:一|个|张|幅)/u.test(request);
  const wantsEdit = EDIT.test(request) && (IMAGE_TARGET.test(request) ||
    (hasImages && /^(?:把|将|给|替|去掉|换|改|精修|修|抠|移除|retouch|edit|remove|replace)/iu.test(request)));
  const wantsAnimate = (hasImages || IMAGE_TARGET.test(request)) &&
    /^(?:把|将|让|给|做成|转成|改成|animate|turn|make)/iu.test(request) && inferImagenFormat(request) === 'gif';
  const wantsReference = REF.test(request) && /(?:生成|做(?:一|个|张)|画|创作|设计|make|create|draw)/iu.test(request) && (hasImages || VISUAL.test(request));
  const implicitImageEdit = hasImages && /^(?:把|将|让|给|帮|能不能|可以|能否|我想|试着|这(?:张|幅|个))/.test(request) &&
    /(?:风格|更[亮暗清暖冷像]|换|裁|修|像.{1,12}(?:一点|一些)|做成|弄成|变成)/u.test(request);
  if (startsCreation && VIDEO.test(request) && !/(?:封面|配图|海报|缩略图)/u.test(request) && inferImagenFormat(request) !== 'gif') return { kind: 'video' };
  if (!((startsCreation && (VISUAL.test(request) || inferImagenFormat(request) === 'gif')) || wantsEdit || wantsAnimate || wantsReference ||
      implicitImageEdit || (hasImages && (requiresImagenSource(request) || wantsRecentImagenSource(request))) ||
      /^画(?:一|个|张|幅)/u.test(request))) return;
  if (!hasImages && IMAGE_TARGET.test(request) && (wantsEdit || wantsAnimate || wantsReference)) return { kind: 'needs-image' };
  return { kind: 'generate', args: text };
}

// This only selects turns worth semantic planning; it never authorizes rendering.
export function mayInvokeImagen(raw, hasMaterial) {
  if (typeof raw !== 'string') return false;
  const text = raw.trim();
  if (!text || text.length > 1800 || text.startsWith('/') || NO_ACTION.test(text) ||
      REDRAW_NEGATED.test(text) || VISUAL_AS_INPUT.test(text)) return false;
  return /(?:配(?:一|张|个)?图|四格|条漫|迷因图|meme|能.{0,18}(?:画|插画|海报|漫画)|(?:来|整|弄|来点).{0,10}(?:封面|壁纸|表情|漫画))/iu.test(text) ||
    (hasMaterial && /(?:画|绘|可视化|做成|弄成|变成|来[张个幅]|render|illustrate|visualize)/iu.test(text));
}
