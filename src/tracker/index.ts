// Announces to a torrent's trackers, following the BEP 12 tier rules: try the
// trackers of each tier in order, and move a tracker that answers to the
// front of its tier so it is tried first next time.

import { announceHttp } from './http.ts';
import { announceUdp } from './udp.ts';
import { TrackerError, type AnnounceOptions, type AnnounceParams, type AnnounceResult } from './types.ts';

export * from './types.ts';

export function announceTo(
  url: string,
  params: AnnounceParams,
  options: AnnounceOptions = {},
): Promise<AnnounceResult> {
  const scheme = url.slice(0, url.indexOf(':')).toLowerCase();
  if (scheme === 'http' || scheme === 'https') return announceHttp(url, params, options);
  if (scheme === 'udp') return announceUdp(url, params, options);
  return Promise.reject(new TrackerError(`unsupported tracker scheme: ${url}`));
}

export interface TierResult extends AnnounceResult {
  url: string;
}

export class TrackerList {
  readonly tiers: string[][];

  constructor(tiers: string[][]) {
    this.tiers = tiers.map((tier) => [...tier]);
  }

  get empty(): boolean {
    return this.tiers.length === 0;
  }

  /**
   * Announces to every tier at once (one tracker at a time within a tier) and
   * calls onResult as each tier answers, so peers arrive as soon as the first
   * working tracker replies. Resolves with every successful reply, or rejects
   * when no tracker answers.
   */
  async announce(
    params: AnnounceParams,
    options: AnnounceOptions = {},
    onResult?: (result: TierResult) => void,
  ): Promise<TierResult[]> {
    if (this.empty) throw new TrackerError('torrent has no HTTP or UDP trackers');
    const errors: string[] = [];
    const results = await Promise.all(
      this.tiers.map(async (tier) => {
        for (const [i, url] of tier.entries()) {
          try {
            const result = { ...(await announceTo(url, params, options)), url };
            tier.splice(i, 1);
            tier.unshift(url);
            onResult?.(result);
            return result;
          } catch (err) {
            errors.push((err as Error).message);
            if (options.signal?.aborted) return null;
          }
        }
        return null;
      }),
    );
    const ok = results.filter((result): result is TierResult => result !== null);
    if (ok.length === 0) throw new TrackerError(`all trackers failed: ${errors.join('; ')}`);
    return ok;
  }
}
