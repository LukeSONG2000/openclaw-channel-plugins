export interface CustomFallbackDeliverPayload {
  text?: string;
  mediaUrls?: string[];
  mediaUrl?: string;
  isReasoning?: boolean;
  isReasoningSnapshot?: boolean;
  isStatusNotice?: boolean;
  isFallbackNotice?: boolean;
  isCompactionNotice?: boolean;
}

export interface CustomFallbackDispatchStateSnapshot {
  hasResponse: boolean;
  hasBlockResponse: boolean;
  hasModelBlockOutput: boolean;
  dispatchTimedOut: boolean;
  toolDeliverCount: number;
  toolTextCount: number;
  toolMediaCount: number;
  toolFallbackSent: boolean;
  toolRenewalCount: number;
}

export interface CustomFallbackToolDeliverObservation {
  toolDeliverCount: number;
  toolTextChars: number;
  toolMediaCount: number;
}

export class CustomFallbackDispatchState {
  private responseSeen = false;
  private blockResponseSeen = false;
  private modelBlockOutputSeen = false;
  private modelSkipOutputSeen = false;
  private timedOut = false;
  private fallbackSent = false;
  private renewalCount = 0;
  private toolDeliverTotal = 0;
  private readonly collectedToolTexts: string[] = [];
  private readonly collectedToolMediaUrls: string[] = [];
  private readonly blockDeliveredMediaUrls = new Set<string>();

  get hasResponse(): boolean {
    return this.responseSeen;
  }

  get hasBlockResponse(): boolean {
    return this.blockResponseSeen;
  }

  get hasModelBlockOutput(): boolean {
    return this.modelBlockOutputSeen;
  }

  get hasModelSkipOutput(): boolean {
    return this.modelSkipOutputSeen;
  }

  get dispatchTimedOut(): boolean {
    return this.timedOut;
  }

  get toolDeliverCount(): number {
    return this.snapshot().toolDeliverCount;
  }

  get toolTexts(): string[] {
    return this.collectedToolTexts;
  }

  get toolMediaUrls(): string[] {
    return this.collectedToolMediaUrls;
  }

  get toolFallbackSent(): boolean {
    return this.fallbackSent;
  }

  markResponse(): void {
    this.responseSeen = true;
  }

  markBlockResponse(options: { modelOutput?: boolean } = {}): void {
    this.responseSeen = true;
    this.blockResponseSeen = true;
    if (options.modelOutput !== false) {
      this.modelBlockOutputSeen = true;
    }
  }

  markModelSkipOutput(): void {
    this.responseSeen = true;
    this.modelSkipOutputSeen = true;
  }

  markDispatchTimedOut(): void {
    this.timedOut = true;
  }

  markToolFallbackSent(): void {
    this.fallbackSent = true;
  }

  observeToolDeliver(payload: CustomFallbackDeliverPayload): CustomFallbackToolDeliverObservation {
    this.toolDeliverTotal += 1;
    const toolText = (payload.text ?? "").trim();
    if (toolText) {
      this.collectedToolTexts.push(toolText);
    }
    if (payload.mediaUrls?.length) {
      this.collectedToolMediaUrls.push(...payload.mediaUrls);
    }
    if (payload.mediaUrl && !this.collectedToolMediaUrls.includes(payload.mediaUrl)) {
      this.collectedToolMediaUrls.push(payload.mediaUrl);
    }
    return {
      toolDeliverCount: this.snapshot().toolDeliverCount,
      toolTextChars: toolText.length,
      toolMediaCount: this.collectedToolMediaUrls.length,
    };
  }

  shouldRenewToolOnlyTimer(maxRenewals: number): { renew: boolean; renewalCount: number } {
    if (this.renewalCount >= maxRenewals) {
      return { renew: false, renewalCount: this.renewalCount };
    }
    this.renewalCount += 1;
    return { renew: true, renewalCount: this.renewalCount };
  }

  recordBlockDeliveredMedia(payload: CustomFallbackDeliverPayload): void {
    if (payload.mediaUrl) this.blockDeliveredMediaUrls.add(payload.mediaUrl);
    if (payload.mediaUrls) {
      for (const url of payload.mediaUrls) {
        this.blockDeliveredMediaUrls.add(url);
      }
    }
  }

  consumeToolMediaForImmediateForward(): { urlsToSend: string[]; skippedCount: number } {
    const urlsToSend = this.collectedToolMediaUrls.filter((url) => !this.blockDeliveredMediaUrls.has(url));
    const skippedCount = this.collectedToolMediaUrls.length - urlsToSend.length;
    this.collectedToolMediaUrls.length = 0;
    return { urlsToSend, skippedCount };
  }

  shouldSendToolFallbackOnComplete(): boolean {
    return this.toolDeliverCount > 0 && !this.blockResponseSeen && !this.fallbackSent;
  }

  snapshot(): CustomFallbackDispatchStateSnapshot {
    return {
      hasResponse: this.responseSeen,
      hasBlockResponse: this.blockResponseSeen,
      hasModelBlockOutput: this.modelBlockOutputSeen,
      dispatchTimedOut: this.timedOut,
      toolDeliverCount: this.toolDeliverTotal,
      toolTextCount: this.collectedToolTexts.length,
      toolMediaCount: this.collectedToolMediaUrls.length,
      toolFallbackSent: this.fallbackSent,
      toolRenewalCount: this.renewalCount,
    };
  }
}
