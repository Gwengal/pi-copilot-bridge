/**
 * Known reasoning levels from weakest to strongest. Pi's "minimal" has no SDK counterpart and
 * sits at the same rank as "low"; Pi's "off" corresponds to the SDK's "none".
 */
const LEVEL_RANK: Readonly<Record<string, number>> = {
  off: 0,
  none: 0,
  minimal: 1,
  low: 1,
  medium: 2,
  high: 3,
  xhigh: 4,
  max: 5,
};

/** SDK spelling of the Pi level, where the two differ. */
const SDK_NAME: Readonly<Record<string, string>> = { off: "none", minimal: "low" };

interface RankedEffort {
  value: string;
  rank: number;
}

/** Reasoning levels only: "none" is excluded so a reasoning request never silently turns it off. */
function rankReasoning(supported: readonly string[]): RankedEffort[] {
  return supported
    .flatMap((value) => {
      const rank = LEVEL_RANK[value];
      return rank ? [{ value, rank }] : [];
    })
    .sort((a, b) => a.rank - b.rank);
}

/**
 * Maps a Pi thinking level to an SDK `reasoningEffort` the model accepts.
 *
 * Picks the requested value when supported, otherwise the strongest supported value below it,
 * otherwise the weakest supported value. "off" never falls back to a reasoning level.
 *
 * @param supported Efforts the model lists (undefined or empty: the model has no effort setting).
 * @param level Pi level: off, minimal, low, medium, high, xhigh or max.
 * @returns The SDK value, or undefined when nothing should be sent.
 */
export function resolveReasoningEffort(
  supported: readonly string[] | undefined,
  level: string | undefined,
): string | undefined {
  if (!supported?.length || level === undefined) return undefined;

  const wanted = SDK_NAME[level] ?? level;
  if (supported.includes(wanted)) return wanted;

  const wantedRank = LEVEL_RANK[level];
  if (!wantedRank) return undefined; // unknown level, or "off" on a model that cannot switch off

  const ranked = rankReasoning(supported);
  const atOrBelow = ranked.filter((entry) => entry.rank <= wantedRank);
  return (atOrBelow.at(-1) ?? ranked[0])?.value;
}
