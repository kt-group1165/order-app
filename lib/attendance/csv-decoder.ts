/**
 * CP932 (Shift-JIS) エンコードのCSVファイルをデコードする
 * ブラウザ標準の TextDecoder を使用
 */
export function decodeCP932(buffer: ArrayBuffer): string {
  const decoder = new TextDecoder("shift_jis");
  return decoder.decode(buffer);
}

/**
 * CSV文字列を行の配列に分割する
 * クォート内の改行・カンマを正しく処理する
 */
export function parseCsvLines(text: string): string[][] {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentField = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const nextChar = text[i + 1];

    if (inQuotes) {
      if (char === '"') {
        if (nextChar === '"') {
          currentField += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        currentField += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === ",") {
        currentRow.push(currentField);
        currentField = "";
      } else if (char === "\r") {
        // skip
      } else if (char === "\n") {
        currentRow.push(currentField);
        currentField = "";
        rows.push(currentRow);
        currentRow = [];
      } else {
        currentField += char;
      }
    }
  }

  if (currentField || currentRow.length > 0) {
    currentRow.push(currentField);
    rows.push(currentRow);
  }

  return rows;
}

/**
 * ファイルを読み込んでCP932デコード済みのCSV行配列を返す
 */
export async function readCsvFile(file: File): Promise<string[][]> {
  const buffer = await file.arrayBuffer();
  const text = decodeCP932(buffer);
  return parseCsvLines(text);
}
