import { toUtc } from "../domain/time.ts";
import type { MedalTallyRow, MedalWin } from "../domain/types.ts";
import type { RawMedalEvent, RawMedalStanding } from "../source/types.ts";
import { mapSafe, num, str, toMedal } from "./common.ts";

export function toTallyRow(raw: RawMedalStanding): MedalTallyRow | null {
  const orgCode = str(raw.Org);
  if (!orgCode) return null;

  const c = raw.Count ?? {};
  const gold = num(c.ME_GOLD?.total);
  const silver = num(c.ME_SILVER?.total);
  const bronze = num(c.ME_BRONZE?.total);

  return {
    orgCode,
    orgName: str(raw.OrgDesc) || orgCode,
    gold,
    silver,
    bronze,
    // Prefer the source's own total; fall back to the sum if it is missing.
    total: num(c.total?.total, gold + silver + bronze),
    rankByGold: num(raw.RkPo),
    rankByTotal: num(raw.RkPoTotal),
  };
}

export function toTally(raw: RawMedalStanding[] | undefined): MedalTallyRow[] {
  return mapSafe(raw, "medals.standings", toTallyRow).sort((a, b) => a.rankByGold - b.rankByGold);
}

export function toMedalWin(raw: RawMedalEvent): MedalWin | null {
  const medal = toMedal(raw.Medal, "medals.win");
  if (!medal) return null;

  const wonAt = toUtc(raw.DateRaw);
  if (!wonAt) return null;

  const members = mapSafe(raw.Members, "medals.Members", (m) => ({
    regId: str(m.Reg),
    name: str(m.Name),
    bib: str(m.Bib),
  }));

  return {
    orgCode: str(raw.Org),
    orgName: str(raw.OrgDesc),
    medal,
    sportCode: str(raw.Disc),
    sportName: str(raw.DiscDesc),
    eventName: str(raw.EventDesc),
    wonAt,
    // For team events upstream puts the country name here, not an athlete name.
    name: str(raw.Name),
    gender: str(raw.Gender),
    isTeam: str(raw.Type).toUpperCase() === "T",
    members,
  };
}

export function toMedalWins(raw: RawMedalEvent[] | undefined): MedalWin[] {
  return mapSafe(raw, "medals.events", toMedalWin).sort((a, b) => b.wonAt.localeCompare(a.wonAt));
}
