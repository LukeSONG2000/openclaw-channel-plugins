export const OPENAI_PROBE = 'https://api.openai.com/v1/models';
export const IMAGE_PROXY_ROUTES = [1, 2].map((index) => ({
  provider: `image-${index}`,
  group: `OPENAI-IMAGE-${index}`,
  port: 17978 + index,
}));

export function rankImageProxyRoutes(providers, now = Date.now()) {
  const eligible = IMAGE_PROXY_ROUTES.flatMap((route) => {
    const provider = providers?.[route.provider];
    if (!provider?.proxies?.length) return [];
    const quota = provider.subscriptionInfo;
    if (Number.isSafeInteger(quota?.Expire) && quota.Expire > 0 && quota.Expire * 1000 <= now) return [];
    let remaining = -1;
    if ([quota?.Total, quota?.Upload, quota?.Download].every((value) => Number.isSafeInteger(value) && value >= 0)
        && quota.Total > 0) {
      remaining = quota.Total - quota.Upload - quota.Download;
      if (remaining <= 0) return [];
    }
    return [{ ...route, remaining }];
  });
  return eligible.sort((a, b) => b.remaining - a.remaining);
}
