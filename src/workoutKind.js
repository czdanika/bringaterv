/**
 * Edzés vagy terv? – egyetlen szabály az egész appban (Könyvtár, Kezdőlap, Statisztika, Rekordok).
 * A szerver gondoskodik róla, hogy a „type” megbízható legyen: rögzített edzés (importált,
 * FIT-tel vagy időadattal mentett) „workout”, minden más terv (utils.is_recorded_entry, v21 migráció).
 * Terv sosem számít a statisztikába.
 */
export const isWorkout = (r) => r?.type === "workout";
export const countsInStats = (r) => isWorkout(r) && r.include_in_stats !== false;
