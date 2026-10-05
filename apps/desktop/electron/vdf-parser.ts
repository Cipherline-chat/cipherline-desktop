/**
 * Valve Data Format (VDF) Parser
 *
 * Parses Steam's .vdf and .acf configuration files into nested objects.
 * VDF is a simple recursive key-value format used by Valve for Steam configs.
 */

export function parseVDF(text: string): Record<string, any> {
    let pos = 0;

    const skipWhitespace = () => {
        while (pos < text.length) {
            if (/\s/.test(text[pos])) { pos++; continue; }
            // Skip // line comments
            if (text[pos] === '/' && text[pos + 1] === '/') {
                while (pos < text.length && text[pos] !== '\n') pos++;
                continue;
            }
            break;
        }
    };

    const readString = (): string => {
        skipWhitespace();
        if (text[pos] === '"') {
            pos++; // opening quote
            let s = '';
            while (pos < text.length && text[pos] !== '"') {
                if (text[pos] === '\\') {
                    pos++;
                    if (pos < text.length) {
                        const esc = text[pos];
                        if (esc === 'n') s += '\n';
                        else if (esc === 't') s += '\t';
                        else if (esc === '\\') s += '\\';
                        else if (esc === '"') s += '"';
                        else s += esc;
                    }
                } else {
                    s += text[pos];
                }
                pos++;
            }
            pos++; // closing quote
            return s;
        }
        // Unquoted token (some VDF files use these)
        let s = '';
        while (pos < text.length && !/[\s{}"]/.test(text[pos])) {
            s += text[pos];
            pos++;
        }
        return s;
    };

    const readObj = (depth = 0): Record<string, any> => {
        // P2-ELEC-19: cap recursion so a malformed VDF can't stack-overflow main.
        if (depth > 64) { while (pos < text.length && text[pos] !== '}') pos++; return {}; }
        const obj: Record<string, any> = {};
        skipWhitespace();
        if (text[pos] === '{') pos++;
        while (pos < text.length) {
            skipWhitespace();
            if (pos >= text.length || text[pos] === '}') { pos++; break; }
            const key = readString();
            if (!key) break;
            skipWhitespace();
            if (text[pos] === '{') {
                obj[key] = readObj(depth + 1);
            } else {
                obj[key] = readString();
            }
        }
        return obj;
    };

    return readObj();
}
