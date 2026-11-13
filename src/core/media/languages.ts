/**
 * Language tags for output metadata. Manifests use BCP 47 ("en", "pt-BR",
 * "fre"); MP4 stores ISO 639-2/T three-letter codes and FFmpeg's MP4 muxer
 * ignores anything else, so two-letter codes are mapped. Matroska takes the
 * same codes.
 */
const ISO_639_1_TO_2: Record<string, string> = {
  af: 'afr', am: 'amh', ar: 'ara', az: 'aze', be: 'bel', bg: 'bul', bn: 'ben', bs: 'bos', ca: 'cat', cs: 'ces',
  cy: 'cym', da: 'dan', de: 'deu', el: 'ell', en: 'eng', es: 'spa', et: 'est', eu: 'eus', fa: 'fas', fi: 'fin',
  fil: 'fil', fr: 'fra', ga: 'gle', gl: 'glg', gu: 'guj', he: 'heb', hi: 'hin', hr: 'hrv', hu: 'hun', hy: 'hye',
  id: 'ind', is: 'isl', it: 'ita', ja: 'jpn', ka: 'kat', kk: 'kaz', km: 'khm', kn: 'kan', ko: 'kor', ky: 'kir',
  lo: 'lao', lt: 'lit', lv: 'lav', mi: 'mri', mk: 'mkd', ml: 'mal', mn: 'mon', mr: 'mar', ms: 'msa', my: 'mya', nb: 'nob',
  ne: 'nep', nl: 'nld', nn: 'nno', no: 'nor', pa: 'pan', pl: 'pol', ps: 'pus', pt: 'por', ro: 'ron', ru: 'rus',
  si: 'sin', sk: 'slk', sl: 'slv', sq: 'sqi', sr: 'srp', sv: 'swe', sw: 'swa', ta: 'tam', te: 'tel', th: 'tha',
  tl: 'tgl', tr: 'tur', uk: 'ukr', ur: 'urd', uz: 'uzb', vi: 'vie', yue: 'yue', zh: 'zho', zu: 'zul',
};

/** "en-US" → "eng", "fre" → "fre", "und"/unknown → undefined. */
export function iso6392(tag: string | undefined): string | undefined {
  if (tag === undefined) return undefined;
  const primary = tag.trim().toLowerCase().split(/[-_]/)[0] ?? '';
  if (primary === '' || primary === 'und' || primary === 'mul' || primary === 'zxx') return undefined;
  const mapped = ISO_639_1_TO_2[primary];
  if (mapped !== undefined) return mapped;
  return /^[a-z]{3}$/.test(primary) ? primary : undefined;
}

/** ISO 639-2/B codes that differ from the /T ones iso6392 maps to. */
const BIBLIOGRAPHIC: Record<string, string> = {
  alb: 'sqi', arm: 'hye', baq: 'eus', bur: 'mya', chi: 'zho', cze: 'ces', dut: 'nld', fre: 'fra', geo: 'kat', ger: 'deu',
  gre: 'ell', ice: 'isl', mac: 'mkd', mao: 'mri', may: 'msa', per: 'fas', rum: 'ron', slo: 'slk', tib: 'bod', wel: 'cym',
};

const KNOWN_CODES = new Set([...Object.keys(ISO_639_1_TO_2), ...Object.values(ISO_639_1_TO_2), ...Object.keys(BIBLIOGRAPHIC)]);

/** A tag whose language is in the tables above ("zh", "pt-BR", "eng", "fre"): safe to read out of a file name. */
export function isKnownLanguage(tag: string): boolean {
  const parts = tag.split('-');
  const primary = parts[0]?.toLowerCase() ?? '';
  if (!KNOWN_CODES.has(primary)) return false;
  return parts.slice(1).every((part) => /^(?:[a-z]{2}|[0-9]{3}|[a-z]{4})$/i.test(part));
}

/** The language of a tag, to compare two tags: "fr-CA", "fra" and "fre" → "fra"; undefined as iso6392. */
export function languageKey(tag: string | undefined): string | undefined {
  const code = iso6392(tag);
  return code === undefined ? undefined : (BIBLIOGRAPHIC[code] ?? code);
}
