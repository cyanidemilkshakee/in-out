export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

export const PASSWORD_REQUIREMENTS = [
  { id: "length", label: "At least 8 characters" },
  { id: "uppercase", label: "One uppercase letter" },
  { id: "lowercase", label: "One lowercase letter" },
  { id: "number", label: "One number" },
  { id: "symbol", label: "One symbol" },
] as const;

export function passwordRequirementStatus(value: string) {
  return {
    length: Array.from(value).length >= PASSWORD_MIN_LENGTH,
    uppercase: /\p{Lu}/u.test(value),
    lowercase: /\p{Ll}/u.test(value),
    number: /\p{N}/u.test(value),
    symbol: /[\p{P}\p{S}]/u.test(value),
  };
}

export function isPasswordValid(value: string) {
  return Object.values(passwordRequirementStatus(value)).every(Boolean) && value.length <= PASSWORD_MAX_LENGTH;
}

export const PASSWORD_POLICY_MESSAGE = "Use at least 8 characters, including one uppercase letter, one lowercase letter, one number, and one symbol.";
