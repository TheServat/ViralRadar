/**
 * Language and country codes, with names in whichever language the interface
 * is currently showing.
 *
 * The names come from `Intl.DisplayNames`, which every current browser ships:
 * "IR" becomes "Iran" or "ایران" depending on the locale, with no translation
 * table to maintain and no risk of the two drifting apart. Only the code lists
 * live here, because `Intl` can name a code but cannot enumerate them.
 */
import { computed, type ComputedRef } from 'vue';
import { useI18n } from 'vue-i18n';

/** ISO 3166-1 alpha-2. */
const COUNTRY_CODES =
  'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ ' +
  'CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO ' +
  'FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE ' +
  'JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO ' +
  'MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW ' +
  'PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM ' +
  'TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW';

/** ISO 639-1, restricted to languages with living written use. */
const LANGUAGE_CODES =
  'af am ar az be bg bn bs ca cs cy da de el en eo es et eu fa fi fil fr ga gl gu ha he hi hr hu hy id ig is it ja ' +
  'jv ka kk km kn ko ku ky lo lt lv mk ml mn mr ms mt my ne nl no or pa pl ps pt qu ro ru rw sd si sk sl so sq sr ' +
  'su sv sw ta te tg th ti tk tl tr tt ug uk ur uz vi xh yi yo zh zu';

export interface CodeOption {
  /** The ISO code itself, which is what the API filters on. */
  value: string;
  /** Localised name, e.g. "Iran" / "ایران". */
  title: string;
  /** How many stored items carry this code; drives the "in your data" group. */
  count: number;
  group: 'present' | 'other';
}

function names(locale: string, type: 'region' | 'language'): (code: string) => string {
  try {
    const display = new Intl.DisplayNames([locale, 'en'], { type, fallback: 'code' });
    return (code) => {
      try {
        return display.of(code) ?? code;
      } catch {
        return code;
      }
    };
  } catch {
    // Very old browsers: the code alone is still a usable label.
    return (code) => code;
  }
}

function build(
  codes: string,
  present: readonly { key: string; n: number }[],
  label: (code: string) => string,
): CodeOption[] {
  const counts = new Map(present.map((p) => [p.key, p.n]));
  const all = new Set(codes.split(/\s+/).filter((c) => c.length > 0));
  // A code seen in the data but missing from the list is still offered: the
  // data is the authority on what exists, not this file.
  for (const p of present) all.add(p.key);

  const options = [...all].map((code) => {
    const count = counts.get(code) ?? 0;
    return {
      value: code,
      title: `${label(code)} · ${code.toUpperCase()}`,
      count,
      group: count > 0 ? ('present' as const) : ('other' as const),
    };
  });

  return options.sort((a, b) => {
    if (a.count !== b.count) return b.count - a.count;
    return a.title.localeCompare(b.title);
  });
}

export function useCountryOptions(present: ComputedRef<{ key: string; n: number }[]>) {
  const { locale } = useI18n();
  return computed(() => build(COUNTRY_CODES, present.value, names(locale.value, 'region')));
}

export function useLanguageOptions(present: ComputedRef<{ key: string; n: number }[]>) {
  const { locale } = useI18n();
  return computed(() => build(LANGUAGE_CODES, present.value, names(locale.value, 'language')));
}

/** A single code rendered for display, used by cards and tables. */
export function useCodeLabel() {
  const { locale } = useI18n();
  return {
    country: (code: string | null): string => (code === null ? '' : names(locale.value, 'region')(code)),
    language: (code: string | null): string => (code === null ? '' : names(locale.value, 'language')(code)),
  };
}
