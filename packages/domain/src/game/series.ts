/**
 * Best-of-3 / Best-of-5 (update §4): the side that wins the most rounds — a majority — wins.
 * Only decided rounds are tallied here; how a drawn round is handled is pending owner decision G8.
 */
export type BestOf = 3 | 5;

export interface SeriesTally {
  winsA: number;
  winsB: number;
  needed: number;
  winner: 'a' | 'b' | null;
}

export function tallySeries(bestOf: BestOf, roundWinners: readonly ('a' | 'b')[]): SeriesTally {
  const needed = Math.floor(bestOf / 2) + 1;
  let winsA = 0;
  let winsB = 0;
  for (const w of roundWinners) {
    if (winsA >= needed || winsB >= needed)
      throw new Error('round played after series was decided');
    if (w === 'a') winsA++;
    else winsB++;
  }
  const winner = winsA >= needed ? 'a' : winsB >= needed ? 'b' : null;
  return { winsA, winsB, needed, winner };
}
