import type { Participant, Sport } from "../domain/types.ts";
import type { RawContingent, RawDiscipline, RawEntriesByOrg, RawPartic } from "../source/types.ts";
import { mapSafe, str, toParticipantType } from "./common.ts";

/**
 * Sports the tracked country has entered, from the contingent summary.
 * This is the polling allow-list: the country is in 37 of 59 disciplines, so the
 * rest never need a schedule request.
 */
export function toTrackedSportCodes(raw: RawContingent | undefined): string[] {
  return mapSafe(raw?.Count, "entries.contingent", (row) => {
    const code = str(row.Disc);
    return code ? code : null;
  });
}

export function toContingentTotals(raw: RawContingent | undefined) {
  const t = raw?.Totals ?? {};
  return {
    men: typeof t.M === "number" ? t.M : 0,
    women: typeof t.W === "number" ? t.W : 0,
    total: typeof t.Total === "number" ? t.Total : 0,
    bySport: mapSafe(raw?.Count, "entries.bySport", (row) => ({
      sportCode: str(row.Disc),
      sportName: str(row.DiscDesc),
      count: typeof row.Total === "number" ? row.Total : 0,
    })),
  };
}

function toParticipant(
  raw: RawPartic,
  sportCode: string,
  eventKey: string,
): Participant | null {
  const regId = str(raw.Reg);
  if (!regId) return null;

  return {
    // Numeric-looking for individuals, a composite code for teams - always a string.
    regId,
    orgCode: str(raw.Org),
    orgName: str(raw.OrgDesc),
    sportCode,
    eventKey,
    // Upstream name order is "FAMILY Given".
    name: str(raw.Name),
    shortName: str(raw.NameS),
    givenName: str(raw.GivenName),
    familyName: str(raw.FamilyName),
    gender: str(raw.Gender),
    birthDate: str(raw.BirthDateRaw) || null,
    type: toParticipantType(raw.Type, "entries.Type"),
    bib: str(raw.Bib),
  };
}

/** Flatten one sport's roster (grouped by event upstream) into Participant rows. */
export function toParticipants(raw: RawEntriesByOrg | undefined): Participant[] {
  const sportCode = str(raw?.Disc);
  const out: Participant[] = [];

  for (const event of raw?.Events ?? []) {
    const eventKey = str(event.EvKey);
    out.push(
      ...mapSafe(event.Partics, "entries.Partics", (p) =>
        toParticipant(p, sportCode || str(event.Disc), eventKey),
      ),
    );
  }
  return out;
}

export function toSports(raw: RawDiscipline[] | undefined, trackedCodes: ReadonlySet<string>): Sport[] {
  return mapSafe(raw, "disc.data", (d) => {
    const code = str(d.Disc);
    if (!code) return null;
    return {
      code,
      name: str(d.DiscDesc) || code,
      tracked: trackedCodes.has(code),
      competitionDays: mapSafe(d.Days, "disc.Days", (day) => str(day.raw) || null),
    };
  });
}
