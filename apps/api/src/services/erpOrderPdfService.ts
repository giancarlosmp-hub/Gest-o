import { ErpOrderSyncStatus, Prisma, type Client, type ErpOrderSync, type Opportunity, type OpportunityItem, type Product, type User } from "@prisma/client";

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 42;
const BRAND_GREEN = [25, 94, 62] as const;
const BRAND_LIGHT = [239, 247, 241] as const;
const SLATE = [51, 65, 85] as const;
const MUTED = [100, 116, 139] as const;
const BORDER = [203, 213, 225] as const;

export type ErpOrderPdfRecord = ErpOrderSync & {
  opportunity: Opportunity & {
    client: Client & { rawPayload?: Prisma.JsonValue | null };
    ownerSeller: Pick<User, "name" | "erpCode">;
    items: Array<OpportunityItem & { product?: Pick<Product, "className" | "unit" | "rawErpPayload"> | null }>;
  };
};

type PdfPage = { commands: string[] };
type PdfCell = { text: string; width: number; align?: "left" | "right" | "center" };

const asRecord = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

const cleanText = (value: unknown, fallback = "-") => {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text || fallback;
};

const pickFirstString = (source: Record<string, unknown>, keys: string[]) => {
  for (const key of keys) {
    const value = cleanText(source[key], "");
    if (value) return value;
  }
  return "";
};

const formatCurrency = (value: unknown) => Number(value || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const formatNumber = (value: unknown) => Number(value || 0).toLocaleString("pt-BR", { maximumFractionDigits: 3 });

const parseDotDate = (value: unknown) => {
  const text = cleanText(value, "");
  const match = text.match(/^(\d{2})[./-](\d{2})[./-](\d{4})$/);
  return match ? `${match[1]}/${match[2]}/${match[3]}` : text;
};

const formatDate = (value: unknown) => {
  if (!value) return "-";
  if (value instanceof Date) return value.toLocaleDateString("pt-BR", { timeZone: "UTC" });
  const text = cleanText(value, "");
  if (!text) return "-";
  if (/^\d{2}[./-]\d{2}[./-]\d{4}$/.test(text)) return parseDotDate(text);
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? text : parsed.toLocaleDateString("pt-BR", { timeZone: "UTC" });
};

const formatDocument = (value: unknown) => {
  const digits = cleanText(value, "").replace(/\D/g, "");
  if (digits.length === 11) return digits.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4");
  if (digits.length === 14) return digits.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, "$1.$2.$3/$4-$5");
  return cleanText(value);
};

const escapePdfText = (text: string) => text
  .normalize("NFC")
  .replace(/[\u2013\u2014]/g, "-")
  .replace(/[\u2018\u2019]/g, "'")
  .replace(/[\u201C\u201D]/g, '"')
  .replace(/[^\x00-\xFF]/g, "")
  .replace(/\\/g, "\\\\")
  .replace(/\(/g, "\\(")
  .replace(/\)/g, "\\)");

const wrapText = (text: string, maxChars: number) => {
  const words = cleanText(text).split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > maxChars && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : ["-"];
};

class SimplePdf {
  private pages: PdfPage[] = [{ commands: [] }];
  private current = this.pages[0];

  addPage() {
    this.current = { commands: [] };
    this.pages.push(this.current);
  }

  text(text: string, x: number, y: number, size = 10, color: readonly number[] = SLATE, font = "F1") {
    this.current.commands.push(`${color.map((c) => (c / 255).toFixed(3)).join(" ")} rg`);
    this.current.commands.push(`BT /${font} ${size} Tf 1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm (${escapePdfText(text)}) Tj ET`);
  }

  line(x1: number, y1: number, x2: number, y2: number, color: readonly number[] = BORDER, width = 0.8) {
    this.current.commands.push(`${color.map((c) => (c / 255).toFixed(3)).join(" ")} RG ${width} w ${x1.toFixed(2)} ${y1.toFixed(2)} m ${x2.toFixed(2)} ${y2.toFixed(2)} l S`);
  }

  rect(x: number, y: number, width: number, height: number, fill: readonly number[] | null, stroke: readonly number[] | null = null) {
    if (fill) this.current.commands.push(`${fill.map((c) => (c / 255).toFixed(3)).join(" ")} rg`);
    if (stroke) this.current.commands.push(`${stroke.map((c) => (c / 255).toFixed(3)).join(" ")} RG 0.8 w`);
    this.current.commands.push(`${x.toFixed(2)} ${y.toFixed(2)} ${width.toFixed(2)} ${height.toFixed(2)} re ${fill && stroke ? "B" : fill ? "f" : "S"}`);
  }

  buffer() {
    const objects: Buffer[] = [];
    const addObject = (body: string | Buffer) => {
      const index = objects.length + 1;
      const header = Buffer.from(`${index} 0 obj\n`, "ascii");
      const footer = Buffer.from("\nendobj\n", "ascii");
      objects.push(Buffer.isBuffer(body) ? Buffer.concat([header, body, footer]) : Buffer.from(`${index} 0 obj\n${body}\nendobj\n`, "latin1"));
      return index;
    };

    const catalogId = 1;
    const pagesId = 2;
    objects.push(Buffer.alloc(0), Buffer.alloc(0));
    const fontRegularId = addObject("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
    const fontBoldId = addObject("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
    const pageIds: number[] = [];

    for (const page of this.pages) {
      const stream = Buffer.from(page.commands.join("\n"), "latin1");
      const streamId = addObject(Buffer.concat([Buffer.from(`<< /Length ${stream.length} >>\nstream\n`, "ascii"), stream, Buffer.from("\nendstream", "ascii")]));
      const pageId = addObject(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << /F1 ${fontRegularId} 0 R /F2 ${fontBoldId} 0 R >> >> /Contents ${streamId} 0 R >>`);
      pageIds.push(pageId);
    }

    objects[catalogId - 1] = Buffer.from(`${catalogId} 0 obj\n<< /Type /Catalog /Pages ${pagesId} 0 R >>\nendobj\n`, "ascii");
    objects[pagesId - 1] = Buffer.from(`${pagesId} 0 obj\n<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>\nendobj\n`, "ascii");

    const header = Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n", "binary");
    const chunks = [header];
    const offsets = [0];
    let offset = header.length;
    for (const object of objects) {
      offsets.push(offset);
      chunks.push(object);
      offset += object.length;
    }
    const xrefOffset = offset;
    const xref = [`xref`, `0 ${objects.length + 1}`, `0000000000 65535 f `, ...offsets.slice(1).map((item) => `${String(item).padStart(10, "0")} 00000 n `)].join("\n");
    const trailer = `\n${xref}\ntrailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
    chunks.push(Buffer.from(trailer, "ascii"));
    return Buffer.concat(chunks);
  }
}

const getPayload = (order: ErpOrderPdfRecord) => asRecord(order.payloadSent);

const getClientAddress = (client: ErpOrderPdfRecord["opportunity"]["client"]) => {
  const raw = asRecord(client.rawPayload);
  const address = pickFirstString(raw, ["address", "ENDERECO", "LOGRADOURO", "RUA"]);
  return [address, client.city, client.state].filter(Boolean).join(" - ") || "-";
};

const getClassification = (item: ErpOrderPdfRecord["opportunity"]["items"][number]) => {
  const raw = asRecord(item.product?.rawErpPayload);
  return item.product?.className || pickFirstString(raw, ["DSCPRODUTO_CLAS", "DESCRICAO_CLASSE", "DSC_CLASSIFICACAO"]) || item.erpProductClassCode || "-";
};

const drawHeader = (pdf: SimplePdf, orderNumber: string) => {
  pdf.rect(0, PAGE_HEIGHT - 118, PAGE_WIDTH, 118, BRAND_GREEN);
  pdf.rect(MARGIN, PAGE_HEIGHT - 86, 58, 38, [255, 255, 255]);
  pdf.text("DE", MARGIN + 14, PAGE_HEIGHT - 72, 18, BRAND_GREEN, "F2");
  pdf.text("DEMETRA AGRO", MARGIN + 72, PAGE_HEIGHT - 60, 18, [255, 255, 255], "F2");
  pdf.text("Pedido comercial para envio ao cliente", MARGIN + 72, PAGE_HEIGHT - 78, 9, [221, 245, 229]);
  pdf.text(`Pedido de Venda Nº ${orderNumber}`, MARGIN, PAGE_HEIGHT - 106, 21, [255, 255, 255], "F2");
};

const drawFooter = (pdf: SimplePdf, pageNumber: number) => {
  pdf.line(MARGIN, 38, PAGE_WIDTH - MARGIN, 38, BORDER);
  pdf.text("Pedido sujeito à confirmação interna, disponibilidade de estoque e validação fiscal.", MARGIN, 24, 8.5, MUTED);
  pdf.text(`Página ${pageNumber}`, PAGE_WIDTH - MARGIN - 44, 24, 8.5, MUTED);
};

const drawLabelValue = (pdf: SimplePdf, label: string, value: string, x: number, y: number, width: number) => {
  pdf.text(label.toUpperCase(), x, y + 14, 7.5, MUTED, "F2");
  wrapText(value, Math.max(18, Math.floor(width / 5.2))).slice(0, 2).forEach((line, index) => pdf.text(line, x, y - index * 11, 9.5, SLATE, index === 0 ? "F2" : "F1"));
};

const ensureSpace = (pdf: SimplePdf, y: number, required: number, pageNumber: { value: number }, orderNumber: string) => {
  if (y - required > 58) return y;
  drawFooter(pdf, pageNumber.value);
  pdf.addPage();
  pageNumber.value += 1;
  drawHeader(pdf, orderNumber);
  return PAGE_HEIGHT - 145;
};

const drawTableRow = (pdf: SimplePdf, cells: PdfCell[], x: number, y: number, rowHeight: number, fill: readonly number[] | null, header = false) => {
  if (fill) pdf.rect(x, y - rowHeight + 4, cells.reduce((sum, cell) => sum + cell.width, 0), rowHeight, fill);
  let cursor = x;
  for (const cell of cells) {
    const maxChars = Math.max(4, Math.floor(cell.width / (header ? 5.2 : 4.9)));
    const lines = wrapText(cell.text, maxChars).slice(0, 2);
    lines.forEach((line, index) => {
      const textX = cell.align === "right" ? cursor + cell.width - Math.min(line.length * 4.7, cell.width - 4) - 2 : cell.align === "center" ? cursor + 2 : cursor + 4;
      pdf.text(line, textX, y - 10 - index * 9, header ? 7.2 : 7.5, header ? [255, 255, 255] : SLATE, header ? "F2" : "F1");
    });
    cursor += cell.width;
  }
  pdf.line(x, y - rowHeight + 4, x + cells.reduce((sum, cell) => sum + cell.width, 0), y - rowHeight + 4, BORDER, 0.5);
};

export const getErpOrderPdfFilename = (order: Pick<ErpOrderSync, "erpOrderNumber" | "numPedido" | "pedidoIdImportacao">) => {
  const orderNumber = cleanText(order.erpOrderNumber || order.numPedido || order.pedidoIdImportacao, "sem-numero").replace(/[^a-zA-Z0-9._-]/g, "-");
  return `pedido-erp-${orderNumber}.pdf`;
};

export const buildErpOrderPdf = (order: ErpOrderPdfRecord) => {
  if (order.status !== ErpOrderSyncStatus.sent) throw Object.assign(new Error("PDF disponível somente para pedidos ERP enviados com sucesso."), { status: 400 });

  const payload = getPayload(order);
  const client = order.opportunity.client;
  const orderNumber = cleanText(order.erpOrderNumber || order.numPedido || order.pedidoIdImportacao);
  const pdf = new SimplePdf();
  const pageNumber = { value: 1 };
  drawHeader(pdf, orderNumber);

  let y = PAGE_HEIGHT - 145;
  pdf.rect(MARGIN, y - 96, PAGE_WIDTH - MARGIN * 2, 96, BRAND_LIGHT, BORDER);
  drawLabelValue(pdf, "Data do pedido", formatDate(payload.DATA_PEDIDO || order.sentAt || order.createdAt), MARGIN + 14, y - 26, 110);
  drawLabelValue(pdf, "Entrega prevista", formatDate(payload.DATA_PREV_ENTREGA), MARGIN + 145, y - 26, 120);
  drawLabelValue(pdf, "Vendedor", cleanText(order.opportunity.ownerSeller.name), MARGIN + 286, y - 26, 190);
  drawLabelValue(pdf, "Cliente", cleanText(client.fantasyName || client.name), MARGIN + 14, y - 70, 200);
  drawLabelValue(pdf, "CNPJ/CPF", formatDocument(client.cnpj), MARGIN + 238, y - 70, 130);
  drawLabelValue(pdf, "Cidade/UF/endereço", getClientAddress(client), MARGIN + 385, y - 70, 120);
  y -= 122;

  pdf.text("Condições comerciais", MARGIN, y, 13, BRAND_GREEN, "F2");
  y -= 22;
  pdf.rect(MARGIN, y - 46, PAGE_WIDTH - MARGIN * 2, 50, null, BORDER);
  drawLabelValue(pdf, "Forma de pagamento", cleanText(payload.FORMA), MARGIN + 12, y - 18, 130);
  drawLabelValue(pdf, "Condição de recebimento", cleanText(payload.CODCONDREC), MARGIN + 190, y - 18, 150);
  drawLabelValue(pdf, "Tabela de preço", cleanText(payload.TABELA_PRECO), MARGIN + 395, y - 18, 120);
  y -= 76;

  pdf.text("Itens do pedido", MARGIN, y, 13, BRAND_GREEN, "F2");
  y -= 14;
  const columns: PdfCell[] = [
    { text: "Cód.", width: 43 },
    { text: "Produto", width: 140 },
    { text: "Classificação/linha", width: 100 },
    { text: "Qtd.", width: 46, align: "right" },
    { text: "Un.", width: 34, align: "center" },
    { text: "Preço unit.", width: 75, align: "right" },
    { text: "Total", width: 73, align: "right" },
  ];
  drawTableRow(pdf, columns, MARGIN, y, 24, BRAND_GREEN, true);
  y -= 24;

  for (const item of order.opportunity.items) {
    y = ensureSpace(pdf, y, 34, pageNumber, orderNumber);
    const cells: PdfCell[] = [
      { text: cleanText(item.erpProductCode), width: 43 },
      { text: cleanText(item.productNameSnapshot), width: 140 },
      { text: getClassification(item), width: 100 },
      { text: formatNumber(item.quantity), width: 46, align: "right" },
      { text: cleanText(item.unit || item.product?.unit), width: 34, align: "center" },
      { text: formatCurrency(item.unitPrice), width: 75, align: "right" },
      { text: formatCurrency(item.netTotal), width: 73, align: "right" },
    ];
    drawTableRow(pdf, cells, MARGIN, y, 34, null);
    y -= 34;
  }

  y = ensureSpace(pdf, y, 118, pageNumber, orderNumber);
  y -= 18;
  const totalsX = PAGE_WIDTH - MARGIN - 210;
  pdf.rect(totalsX, y - 80, 210, 86, BRAND_LIGHT, BORDER);
  pdf.text("Totais", totalsX + 14, y - 14, 12, BRAND_GREEN, "F2");
  pdf.text("Valor bruto", totalsX + 14, y - 34, 9, MUTED);
  pdf.text(formatCurrency(payload.VALOR_BRUTO ?? order.opportunity.items.reduce((sum, item) => sum + Number(item.grossTotal || 0), 0)), totalsX + 124, y - 34, 9, SLATE, "F2");
  pdf.text("Desconto", totalsX + 14, y - 52, 9, MUTED);
  pdf.text(formatCurrency(payload.VALOR_DESCONTO ?? order.opportunity.items.reduce((sum, item) => sum + Number(item.discountTotal || 0), 0)), totalsX + 124, y - 52, 9, SLATE, "F2");
  pdf.text("Valor líquido", totalsX + 14, y - 70, 10, BRAND_GREEN, "F2");
  pdf.text(formatCurrency(payload.VALOR_LIQUIDO ?? order.opportunity.items.reduce((sum, item) => sum + Number(item.netTotal || 0), 0)), totalsX + 124, y - 70, 10, BRAND_GREEN, "F2");

  const notes = cleanText(payload.OBS_PEDIDO || order.opportunity.notes, "Sem observações.");
  pdf.text("Observações", MARGIN, y - 14, 12, BRAND_GREEN, "F2");
  wrapText(notes, 58).slice(0, 5).forEach((line, index) => pdf.text(line, MARGIN, y - 34 - index * 11, 9, SLATE));

  drawFooter(pdf, pageNumber.value);
  return pdf.buffer();
};
