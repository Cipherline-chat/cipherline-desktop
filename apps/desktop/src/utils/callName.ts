/** Characters the API accepts in a call name; anything else is stripped on commit. */
export const CALL_NAME_STRIP = /[^a-zA-Z0-9 '\-_.]/g;
export const cleanCallName = (raw: string): string => raw.replace(CALL_NAME_STRIP, '').trim();
