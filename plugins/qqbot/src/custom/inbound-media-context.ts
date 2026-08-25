export interface CustomInboundMediaContext {
  uniqueVoicePaths: string[];
  uniqueVoiceUrls: string[];
  uniqueVoiceAsrReferTexts: string[];
  sttTranscriptCount: number;
  asrFallbackCount: number;
  fallbackCount: number;
  hasAsrReferFallback: boolean;
  dynamicContext: string;
  localMediaPaths: string[];
  localMediaTypes: string[];
  remoteMediaUrls: string[];
  remoteMediaTypes: string[];
}

export function buildCustomInboundMediaContext(params: {
  imageUrls?: readonly string[];
  imageMediaTypes?: readonly string[];
  voiceAttachmentPaths?: readonly string[];
  voiceAttachmentUrls?: readonly string[];
  voiceAsrReferTexts?: readonly string[];
  voiceTranscriptSources?: readonly string[];
}): CustomInboundMediaContext {
  const imageUrls = [...(params.imageUrls ?? [])];
  const imageMediaTypes = [...(params.imageMediaTypes ?? [])];
  const uniqueVoicePaths = uniqueStrings(params.voiceAttachmentPaths);
  const uniqueVoiceUrls = uniqueStrings(params.voiceAttachmentUrls);
  const uniqueVoiceAsrReferTexts = uniqueStrings(params.voiceAsrReferTexts).filter(Boolean);
  const voiceTranscriptSources = [...(params.voiceTranscriptSources ?? [])];
  const sttTranscriptCount = voiceTranscriptSources.filter((source) => source === "stt").length;
  const asrFallbackCount = voiceTranscriptSources.filter((source) => source === "asr").length;
  const fallbackCount = voiceTranscriptSources.filter((source) => source === "fallback").length;
  const media = splitLocalAndRemoteMedia(imageUrls, imageMediaTypes);

  return {
    uniqueVoicePaths,
    uniqueVoiceUrls,
    uniqueVoiceAsrReferTexts,
    sttTranscriptCount,
    asrFallbackCount,
    fallbackCount,
    hasAsrReferFallback: asrFallbackCount > 0,
    dynamicContext: buildDynamicMediaContext({
      imageUrls,
      uniqueVoicePaths,
      uniqueVoiceUrls,
      uniqueVoiceAsrReferTexts,
    }),
    ...media,
  };
}

export function formatCustomInboundVoiceSummary(params: {
  media: Pick<
    CustomInboundMediaContext,
    | "uniqueVoicePaths"
    | "uniqueVoiceUrls"
    | "uniqueVoiceAsrReferTexts"
    | "sttTranscriptCount"
    | "asrFallbackCount"
    | "fallbackCount"
  >;
  voiceAttachmentPaths?: readonly string[];
  voiceAttachmentUrls?: readonly string[];
  voiceTranscriptCount: number;
}): string | null {
  if (
    !params.voiceAttachmentPaths?.length
    && !params.voiceAttachmentUrls?.length
    && params.media.uniqueVoiceAsrReferTexts.length === 0
  ) {
    return null;
  }
  const asrPreview = params.media.uniqueVoiceAsrReferTexts[0]
    ? formatAsrPreview(params.media.uniqueVoiceAsrReferTexts[0])
    : "";
  return [
    `Voice input summary: local=${params.media.uniqueVoicePaths.length}, remote=${params.media.uniqueVoiceUrls.length}, `,
    `asrReferTexts=${params.media.uniqueVoiceAsrReferTexts.length}, transcripts=${params.voiceTranscriptCount}, `,
    `source(stt/asr/fallback)=${params.media.sttTranscriptCount}/${params.media.asrFallbackCount}/${params.media.fallbackCount}`,
    asrPreview ? `, asr_preview="${asrPreview}"` : "",
  ].join("");
}

function buildDynamicMediaContext(params: {
  imageUrls: string[];
  uniqueVoicePaths: string[];
  uniqueVoiceUrls: string[];
  uniqueVoiceAsrReferTexts: string[];
}): string {
  const lines: string[] = [];
  if (params.imageUrls.length > 0) {
    lines.push(`- 图片: ${params.imageUrls.join(", ")}`);
  }
  const voices = [...params.uniqueVoicePaths, ...params.uniqueVoiceUrls];
  if (voices.length > 0) {
    lines.push(`- 语音: ${voices.join(", ")}`);
  }
  if (params.uniqueVoiceAsrReferTexts.length > 0) {
    lines.push(`- ASR: ${params.uniqueVoiceAsrReferTexts.join(" | ")}`);
  }
  return lines.length > 0 ? `${lines.join("\n")}\n\n` : "";
}

function splitLocalAndRemoteMedia(
  imageUrls: readonly string[],
  imageMediaTypes: readonly string[],
): Pick<CustomInboundMediaContext, "localMediaPaths" | "localMediaTypes" | "remoteMediaUrls" | "remoteMediaTypes"> {
  const localMediaPaths: string[] = [];
  const localMediaTypes: string[] = [];
  const remoteMediaUrls: string[] = [];
  const remoteMediaTypes: string[] = [];
  for (let i = 0; i < imageUrls.length; i += 1) {
    const url = imageUrls[i]!;
    const type = imageMediaTypes[i] ?? "image/png";
    if (url.startsWith("http://") || url.startsWith("https://")) {
      remoteMediaUrls.push(url);
      remoteMediaTypes.push(type);
    } else {
      localMediaPaths.push(url);
      localMediaTypes.push(type);
    }
  }
  return { localMediaPaths, localMediaTypes, remoteMediaUrls, remoteMediaTypes };
}

function uniqueStrings(values: readonly string[] | undefined): string[] {
  return [...new Set(values ?? [])].filter((value) => Boolean(value));
}

function formatAsrPreview(text: string): string {
  const preview = text.slice(0, 50);
  return `${preview}${text.length > 50 ? "..." : ""}`;
}
