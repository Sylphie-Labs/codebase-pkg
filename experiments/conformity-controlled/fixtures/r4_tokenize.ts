// r4_tokenize.ts -- regex/char-scan string tokenizer returning tokens.
export function tokenize(source: string): string[] {
  const tokens: string[] = [];
  const pattern = /[A-Za-z0-9_]+|[^\sA-Za-z0-9_]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const piece = match[0].trim();
    if (piece.length > 0) {
      tokens.push(piece);
    }
  }
  return tokens;
}
