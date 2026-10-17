/**
 * Bringaterv – elrendezés-töréspont, egy helyen
 * ==============================================
 * Mobil (telefonos) elrendezés: keskeny képernyő, VAGY fekvő telefon
 * (alacsony + érintőképernyő) – ilyenkor a 620 px-es asztali elrendezés nem fér el.
 * A styles.css „MOBIL ELRENDEZÉS” blokkja ugyanezt a feltételt használja.
 * iPad (álló és fekvő) az asztali elrendezést kapja, iPad mini állóban a mobilt.
 */
export const MOBILE_QUERY = "(max-width: 768px), (max-height: 500px) and (pointer: coarse)";

export const mobileMQ = matchMedia(MOBILE_QUERY);

export function isMobileLayout() {
  return mobileMQ.matches;
}
