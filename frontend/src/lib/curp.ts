export interface MexicanStateOption {
  code: string;
  name: string;
}

export const MEXICAN_STATES: MexicanStateOption[] = [
  { code: "AS", name: "AGUASCALIENTES" },
  { code: "BC", name: "BAJA CALIFORNIA" },
  { code: "BS", name: "BAJA CALIFORNIA SUR" },
  { code: "CC", name: "CAMPECHE" },
  { code: "CL", name: "COAHUILA" },
  { code: "CM", name: "COLIMA" },
  { code: "CS", name: "CHIAPAS" },
  { code: "CH", name: "CHIHUAHUA" },
  { code: "DF", name: "CIUDAD DE MÉXICO" },
  { code: "DG", name: "DURANGO" },
  { code: "GT", name: "GUANAJUATO" },
  { code: "GR", name: "GUERRERO" },
  { code: "HG", name: "HIDALGO" },
  { code: "JC", name: "JALISCO" },
  { code: "MC", name: "ESTADO DE MÉXICO" },
  { code: "MN", name: "MICHOACÁN" },
  { code: "MS", name: "MORELOS" },
  { code: "NT", name: "NAYARIT" },
  { code: "NL", name: "NUEVO LEÓN" },
  { code: "OC", name: "OAXACA" },
  { code: "PL", name: "PUEBLA" },
  { code: "QT", name: "QUERÉTARO" },
  { code: "QR", name: "QUINTANA ROO" },
  { code: "SP", name: "SAN LUIS POTOSÍ" },
  { code: "SL", name: "SINALOA" },
  { code: "SR", name: "SONORA" },
  { code: "TC", name: "TABASCO" },
  { code: "TS", name: "TAMAULIPAS" },
  { code: "TL", name: "TLAXCALA" },
  { code: "VZ", name: "VERACRUZ" },
  { code: "YN", name: "YUCATÁN" },
  { code: "ZS", name: "ZACATECAS" },
  { code: "NE", name: "NACIDO EN EL EXTRANJERO" },
];

const IGNORED_PREFIXES = new Set([
  "DE",
  "DEL",
  "LA",
  "LAS",
  "LOS",
  "MC",
  "MAC",
  "VON",
  "VAN",
  "Y",
  "DA",
  "DAS",
  "DO",
  "DOS",
]);

const IGNORED_FIRST_NAMES = new Set(["MARIA", "MA", "MA.", "JOSE", "J", "J."]);

const INCONVENIENT_WORDS = new Set([
  "BACA",
  "BUEI",
  "BUEY",
  "CACA",
  "CACO",
  "CAGA",
  "CAGO",
  "CAKA",
  "CAKO",
  "COGE",
  "COJA",
  "COJE",
  "COJI",
  "COJO",
  "CULO",
  "FETO",
  "GUEY",
  "JOTO",
  "KACA",
  "KACO",
  "KAGA",
  "KAGO",
  "KOGE",
  "KOJO",
  "KAKA",
  "KULO",
  "MAME",
  "MAMO",
  "MEAR",
  "MEAS",
  "MEON",
  "MION",
  "MOCO",
  "MULA",
  "PEDA",
  "PEDO",
  "PENE",
  "PUTA",
  "PUTO",
  "QULO",
  "RATA",
  "RUIN",
]);

function cleanText(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z\s]/g, "")
    .trim();
}

function getMainWord(raw: string, isFirstName = false): string {
  const tokens = cleanText(raw)
    .split(/\s+/)
    .filter((t) => t.length > 0 && !IGNORED_PREFIXES.has(t));
  if (tokens.length === 0) return "";
  if (isFirstName && tokens.length > 1 && IGNORED_FIRST_NAMES.has(tokens[0])) {
    return tokens[1];
  }
  return tokens[0];
}

function firstInternalVowel(word: string): string {
  for (let i = 1; i < word.length; i++) {
    if ("AEIOU".includes(word[i])) return word[i];
  }
  return "X";
}

function firstInternalConsonant(word: string): string {
  for (let i = 1; i < word.length; i++) {
    const ch = word[i];
    if (ch >= "A" && ch <= "Z" && !"AEIOU".includes(ch)) {
      return ch;
    }
  }
  return "X";
}

function computeCheckDigit(curp17: string): string {
  const dict = "0123456789ABCDEFGHIJKLMNÑOPQRSTUVWXYZ";
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const idx = dict.indexOf(curp17[i]);
    const val = idx === -1 ? 0 : idx;
    sum += val * (18 - i);
  }
  const digit = (10 - (sum % 10)) % 10;
  return String(digit);
}

export interface CurpParams {
  nombres: string;
  apellidoPaterno: string;
  apellidoMaterno: string;
  fechaNacimiento: string; // YYYY-MM-DD
  genero: "FEMENINO" | "MASCULINO" | "";
  estadoCode: string;
}

/**
 * Genera una CURP mexicana deterministica de 18 caracteres siguiendo reglas RENAPO.
 */
export function generateDeterministicCurp(params: CurpParams): string {
  const { nombres, apellidoPaterno, apellidoMaterno, fechaNacimiento, genero, estadoCode } =
    params;

  if (!nombres.trim() || !apellidoPaterno.trim() || !fechaNacimiento || !genero || !estadoCode) {
    return "";
  }

  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(fechaNacimiento);
  if (!dateMatch) return "";
  const yearNum = Number(dateMatch[1]);
  const yy = dateMatch[1].slice(2, 4);
  const mm = dateMatch[2];
  const dd = dateMatch[3];

  const pat = getMainWord(apellidoPaterno) || "X";
  const mat = getMainWord(apellidoMaterno);
  const nom = getMainWord(nombres, true) || "X";

  let prefix4 =
    (pat[0] || "X") +
    firstInternalVowel(pat) +
    (mat ? mat[0] : "X") +
    (nom[0] || "X");

  if (INCONVENIENT_WORDS.has(prefix4)) {
    prefix4 = prefix4[0] + "X" + prefix4.slice(2);
  }

  const sexChar = genero === "FEMENINO" ? "M" : "H";
  const state2 = estadoCode.slice(0, 2).toUpperCase();

  const cons3 =
    firstInternalConsonant(pat) +
    (mat ? firstInternalConsonant(mat) : "X") +
    firstInternalConsonant(nom);

  const homoclave = yearNum >= 2000 ? "A" : "0";
  const base17 = `${prefix4}${yy}${mm}${dd}${sexChar}${state2}${cons3}${homoclave}`;
  return `${base17}${computeCheckDigit(base17)}`;
}
