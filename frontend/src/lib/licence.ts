/*
  Is this text, read from a photo, an Indian driving licence? A deliberately shallow check: the card
  must show "driving licence" (or a licence number) and at least one more sign of a licence: a licence
  number (state code, RTO code, year, serial, for example MH12 20190001234) or one of the fields every
  licence card prints. It does not verify the licence with any authority. The text is used once and
  never stored or sent.

  Text from a phone photo is noisy: LICENCE comes back as LICENGE, MH12 as MHI2, words run together.
  So words are matched with up to two wrong letters, and letters that look like digits are accepted
  where the licence number has digits.
*/
const FIELDS = [
  "VALIDITY", "VALID TILL", "DATE OF BIRTH", "DATE OF ISSUE", "ISSUE DATE", "DATE OF FIRST ISSUE", "HOLDER'S SIGNATURE",
  "HOLDERS SIGNATURE", "BLOOD GROUP", "ORGAN DONOR", "SON/DAUGHTER/WIFE", "S/D/W", "DL NO", "NON-TRANSPORT", "INDIAN UNION",
];
// A digit, or a letter OCR often reads in its place.
const D = "[0-9OQDIL|!SBZ]";
const NUMBER = new RegExp(`(?:^|[^A-Z0-9])[A-Z]{2}[\\s.-]?${D}{2}[\\s.-]?${D}{4}[\\s.-]?${D}{7}(?![0-9])`);

export interface LicenceCheck {
  ok: boolean;
  title: boolean;
  number: boolean;
  fields: number;
}

/** Edit distance, for short words only. */
function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length];
}

/** True when some word, or a run of letters inside a longer word, is within two letters of `target`. */
function near(words: string[], target: string): boolean {
  return words.some((w) => {
    if (Math.abs(w.length - target.length) <= 2) return distance(w, target) <= 2;
    if (w.length > target.length + 2) {
      for (let i = 0; i + target.length <= w.length; i++) if (distance(w.slice(i, i + target.length), target) <= 1) return true;
    }
    return false;
  });
}

export function checkLicenceText(raw: string): LicenceCheck {
  const t = raw.toUpperCase().replace(/[‘’`´]/g, "'").replace(/\s+/g, " ");
  const words = t.split(/[^A-Z0-9|!]+/).filter((w) => w.length >= 4);
  const title = near(words, "DRIVING") && (near(words, "LICENCE") || near(words, "LICENSE"));
  const number = NUMBER.test(t);
  const fields = FIELDS.filter((f) => t.includes(f)).length;
  return { ok: (title && (number || fields > 0)) || (number && fields > 0), title, number, fields };
}
