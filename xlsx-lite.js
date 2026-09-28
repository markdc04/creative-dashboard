// Just enough of the .xlsx (zip of XML) format to read cell font colors — nothing else in this
// codebase needs a real xlsx parser, and pulling in a library would break the project's
// no-dependencies convention. Google's CSV/gviz exports never carry formatting, but the .xlsx
// export does, and it's reachable from the same public "anyone with the link can view" sharing
// that the CSV exports already rely on.
const https = require('https');
const zlib = require('zlib');

function fetchBuffer(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
        res.resume();
        resolve(fetchBuffer(res.headers.location, redirectsLeft - 1));
        return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error('xlsx fetch ' + res.statusCode)); return; }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// Reads just the named entries out of a zip buffer (central directory -> local file header ->
// inflate). Good enough for the handful of small XML parts inside an xlsx; not a general zip reader.
function readZipEntries(buf, wantedNames) {
  const wanted = new Set(wantedNames);
  const out = {};
  const eocdSig = 0x06054b50;
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === eocdSig) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error('not a zip file');
  const entryCount = buf.readUInt16LE(eocd + 10);
  let cdOffset = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < entryCount; i++) {
    if (buf.readUInt32LE(cdOffset) !== 0x02014b50) break;
    const compMethod = buf.readUInt16LE(cdOffset + 10);
    const compSize = buf.readUInt32LE(cdOffset + 20);
    const nameLen = buf.readUInt16LE(cdOffset + 28);
    const extraLen = buf.readUInt16LE(cdOffset + 30);
    const commentLen = buf.readUInt16LE(cdOffset + 32);
    const localHeaderOffset = buf.readUInt32LE(cdOffset + 42);
    const name = buf.toString('utf8', cdOffset + 46, cdOffset + 46 + nameLen);
    if (wanted.has(name)) {
      const lhNameLen = buf.readUInt16LE(localHeaderOffset + 26);
      const lhExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
      const dataStart = localHeaderOffset + 30 + lhNameLen + lhExtraLen;
      const raw = buf.subarray(dataStart, dataStart + compSize);
      out[name] = compMethod === 0 ? raw.toString('utf8') : zlib.inflateRawSync(raw).toString('utf8');
    }
    cdOffset += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

// font index -> uppercase RGB hex (no leading alpha byte), or null for "no explicit color" (the
// sheet's default black).
function parseFontColors(stylesXml) {
  const fontsBlock = /<fonts[^>]*>([\s\S]*?)<\/fonts>/.exec(stylesXml);
  const fonts = fontsBlock ? fontsBlock[1].match(/<font>[\s\S]*?<\/font>/g) || [] : [];
  return fonts.map((f) => {
    const m = /<color rgb="([0-9A-Fa-f]{6,8})"/.exec(f);
    return m ? m[1].slice(-6).toUpperCase() : null;
  });
}

// cellXfs index -> fontId.
function parseCellXfFontIds(stylesXml) {
  const block = /<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml);
  const xfs = block ? block[1].match(/<xf [^>]*\/?>/g) || [] : [];
  return xfs.map((xf) => Number((/fontId="(\d+)"/.exec(xf) || [, '0'])[1]));
}

function parseSharedStrings(xml) {
  const items = xml.match(/<si>[\s\S]*?<\/si>/g) || [];
  return items.map((si) => (si.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || []).map((t) => t.replace(/<[^>]*>/g, '')).join(''));
}

// Reads one column's per-row font color from the first worksheet of a public Google Sheet's xlsx
// export. Returns a Map<rowNumber, hexColor|null> for that column (e.g. "E").
async function readColumnColors(docId, column) {
  const buf = await fetchBuffer(`https://docs.google.com/spreadsheets/d/${docId}/export?format=xlsx`);
  const files = readZipEntries(buf, ['xl/styles.xml', 'xl/sharedStrings.xml', 'xl/worksheets/sheet1.xml']);
  const fontColors = parseFontColors(files['xl/styles.xml'] || '');
  const xfFontIds = parseCellXfFontIds(files['xl/styles.xml'] || '');
  const sharedStrings = parseSharedStrings(files['xl/sharedStrings.xml'] || '');
  const sheetXml = files['xl/worksheets/sheet1.xml'] || '';
  const cellRe = new RegExp(`<c r="${column}(\\d+)"(?:\\s+s="(\\d+)")?[^>]*>`, 'g');
  const result = new Map();
  let m;
  while ((m = cellRe.exec(sheetXml))) {
    const row = Number(m[1]);
    const xf = m[2] ? Number(m[2]) : 0;
    const fontId = xfFontIds[xf] || 0;
    result.set(row, fontColors[fontId] || null);
  }
  return result;
}

module.exports = { readColumnColors };
