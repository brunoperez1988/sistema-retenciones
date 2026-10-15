'use strict';

// Exportación a Excel (.xlsx real, sin dependencias) y CSV pensado para Excel en español.

const zlib = require('node:zlib');

// ── CSV ──
// Separador ";" y coma decimal para que Excel (configuración es-UY) lo abra en columnas.

function csv(columnas, filas) {
  const celda = (v, col) => {
    if (v == null) return '';
    if (col.tipo === 'moneda' && typeof v === 'number') return (v / 100).toFixed(2).replace('.', ',');
    const s = String(v);
    return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lineas = [columnas.map((c) => celda(c.titulo, {})).join(';')];
  for (const f of filas) {
    const valores = Array.isArray(f) ? f : f.celdas;
    lineas.push(columnas.map((c, i) => celda(valores[i], c)).join(';'));
  }
  return Buffer.from('﻿' + lineas.join('\r\n') + '\r\n', 'utf8');
}

// ── XLSX ──

const TABLA_CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = TABLA_CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zip(archivos) {
  const locales = [];
  const centrales = [];
  let offset = 0;
  for (const { nombre, datos } of archivos) {
    const nombreBuf = Buffer.from(nombre, 'utf8');
    const comprimido = zlib.deflateRawSync(datos);
    const crc = crc32(datos);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // nombres en UTF-8
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comprimido.length, 18);
    local.writeUInt32LE(datos.length, 22);
    local.writeUInt16LE(nombreBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locales.push(local, nombreBuf, comprimido);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comprimido.length, 20);
    central.writeUInt32LE(datos.length, 24);
    central.writeUInt16LE(nombreBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrales.push(central, nombreBuf);
    offset += local.length + nombreBuf.length + comprimido.length;
  }
  const dir = Buffer.concat(centrales);
  const fin = Buffer.alloc(22);
  fin.writeUInt32LE(0x06054b50, 0);
  fin.writeUInt16LE(archivos.length, 8);
  fin.writeUInt16LE(archivos.length, 10);
  fin.writeUInt32LE(dir.length, 12);
  fin.writeUInt32LE(offset, 16);
  return Buffer.concat([...locales, dir, fin]);
}

function xml(s) {
  return String(s)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function columna(i) {
  let s = '';
  for (i += 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
}

// Estilos: 0 normal · 1 encabezado · 2 moneda · 3 negrita · 4 moneda en negrita · 5 título
const ESTILOS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="&quot;$&quot; #,##0.00"/></numFmts>
<fonts count="4">
<font><sz val="11"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><name val="Calibri"/></font>
<font><b/><sz val="14"/><color rgb="FF1F6F68"/><name val="Calibri"/></font>
</fonts>
<fills count="4">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF2F8F86"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFDF1D8"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="6">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="2" fillId="3" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
<xf numFmtId="164" fontId="2" fillId="3" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1"/>
<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

// columnas: [{ titulo, tipo: 'texto'|'moneda'|'numero', ancho }]
// filas: arrays de valores, u objetos { celdas: [...], negrita: true } para subtotales.
// Los importes de tipo 'moneda' llegan en centésimos.
function xlsx({ hoja = 'Reporte', titulo, subtitulo, columnas, filas }) {
  const filasXml = [];
  let nFila = 0;
  const fila = (celdas) => {
    nFila += 1;
    filasXml.push(`<row r="${nFila}">${celdas.join('')}</row>`);
  };
  const celdaTexto = (ref, v, s = 0) => `<c r="${ref}" t="inlineStr"${s ? ` s="${s}"` : ''}><is><t xml:space="preserve">${xml(v)}</t></is></c>`;
  const celdaNum = (ref, v, s = 0) => `<c r="${ref}"${s ? ` s="${s}"` : ''}><v>${v}</v></c>`;

  if (titulo) fila([celdaTexto(`A${nFila + 1}`, titulo, 5)]);
  if (subtitulo) fila([celdaTexto(`A${nFila + 1}`, subtitulo)]);
  if (titulo || subtitulo) fila([]);
  const filaEncabezado = nFila + 1;
  fila(columnas.map((c, i) => celdaTexto(`${columna(i)}${nFila + 1}`, c.titulo, 1)));

  for (const f of filas) {
    const valores = Array.isArray(f) ? f : f.celdas;
    const negrita = !Array.isArray(f) && f.negrita;
    const r = nFila + 1;
    fila(columnas.map((c, i) => {
      const v = valores[i];
      const ref = `${columna(i)}${r}`;
      if (v == null || v === '') return negrita ? celdaTexto(ref, '', 3) : '';
      if (c.tipo === 'moneda' && typeof v === 'number') return celdaNum(ref, (v / 100).toFixed(2), negrita ? 4 : 2);
      if (c.tipo === 'numero' && typeof v === 'number') return celdaNum(ref, v, negrita ? 3 : 0);
      return celdaTexto(ref, v, negrita ? 3 : 0);
    }).filter(Boolean));
  }

  const ultima = columna(columnas.length - 1);
  const anchos = columnas.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.ancho || 16}" customWidth="1"/>`).join('');
  const hojaXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="${filaEncabezado}" topLeftCell="A${filaEncabezado + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<cols>${anchos}</cols>
<sheetData>${filasXml.join('')}</sheetData>
<autoFilter ref="A${filaEncabezado}:${ultima}${Math.max(nFila, filaEncabezado)}"/>
</worksheet>`;

  const nombreHoja = xml(hoja.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31));
  const archivos = [
    { nombre: '[Content_Types].xml', datos: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>` },
    { nombre: '_rels/.rels', datos: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>` },
    { nombre: 'xl/workbook.xml', datos: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="${nombreHoja}" sheetId="1" r:id="rId1"/></sheets>
<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'${nombreHoja}'!$A$${filaEncabezado}:$${ultima}$${Math.max(nFila, filaEncabezado)}</definedName></definedNames>
</workbook>` },
    { nombre: 'xl/_rels/workbook.xml.rels', datos: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>` },
    { nombre: 'xl/styles.xml', datos: ESTILOS },
    { nombre: 'xl/worksheets/sheet1.xml', datos: hojaXml },
  ].map((a) => ({ nombre: a.nombre, datos: Buffer.from(a.datos, 'utf8') }));
  return zip(archivos);
}

module.exports = { csv, xlsx };
