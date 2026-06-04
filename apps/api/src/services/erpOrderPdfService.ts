import {
  ErpOrderSyncStatus,
  Prisma,
  type Client,
  type ErpOrderSync,
  type Opportunity,
  type OpportunityItem,
  type Product,
  type User,
} from "@prisma/client";

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 36;
const BRAND_GREEN = [25, 94, 62] as const;
const BRAND_LIGHT = [239, 247, 241] as const;
const BRAND_SOFT = [245, 250, 247] as const;
const SLATE = [51, 65, 85] as const;
const MUTED = [100, 116, 139] as const;
const BORDER = [203, 213, 225] as const;

export type ErpOrderPdfRecord = ErpOrderSync & {
  opportunity: Opportunity & {
    client: Client & { rawPayload?: Prisma.JsonValue | null };
    ownerSeller: Pick<User, "name" | "erpCode">;
    items: Array<
      OpportunityItem & {
        product?: Pick<Product, "className" | "unit" | "rawErpPayload"> | null;
      }
    >;
  };
};

type PdfPage = { commands: string[] };
type PdfCell = {
  text: string;
  width: number;
  align?: "left" | "right" | "center";
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const cleanText = (value: unknown, fallback = "-") => {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return text || fallback;
};

const pickFirstString = (source: Record<string, unknown>, keys: string[]) => {
  for (const key of keys) {
    const value = cleanText(source[key], "");
    if (value) return value;
  }
  return "";
};

const formatCurrency = (value: unknown) =>
  Number(value || 0).toLocaleString("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
const formatCurrencyLabel = (value: unknown) => `R$ ${formatCurrency(value)}`;
const formatNumber = (value: unknown, minimumFractionDigits = 2) =>
  Number(value || 0).toLocaleString("pt-BR", {
    minimumFractionDigits,
    maximumFractionDigits: 3,
  });

const parseDotDate = (value: unknown) => {
  const text = cleanText(value, "");
  const match = text.match(/^(\d{2})[./-](\d{2})[./-](\d{4})$/);
  return match ? `${match[1]}/${match[2]}/${match[3]}` : text;
};

const formatDate = (value: unknown) => {
  if (!value) return "-";
  if (value instanceof Date)
    return value.toLocaleDateString("pt-BR", { timeZone: "UTC" });
  const text = cleanText(value, "");
  if (!text) return "-";
  if (/^\d{2}[./-]\d{2}[./-]\d{4}$/.test(text)) return parseDotDate(text);
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime())
    ? text
    : parsed.toLocaleDateString("pt-BR", { timeZone: "UTC" });
};

const formatDocument = (value: unknown) => {
  const digits = cleanText(value, "").replace(/\D/g, "");
  if (digits.length === 11)
    return digits.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4");
  if (digits.length === 14)
    return digits.replace(
      /(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/,
      "$1.$2.$3/$4-$5",
    );
  return cleanText(value);
};

const escapePdfText = (text: string) =>
  text
    .normalize("NFC")
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")
    .replace(/\u2013/g, "\\226")
    .replace(/\u2014/g, "\\227")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[^\x00-\xFF\\]/g, "");

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

  text(
    text: string,
    x: number,
    y: number,
    size = 10,
    color: readonly number[] = SLATE,
    font = "F1",
  ) {
    this.current.commands.push(
      `${color.map((c) => (c / 255).toFixed(3)).join(" ")} rg`,
    );
    this.current.commands.push(
      `BT /${font} ${size} Tf 1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm (${escapePdfText(text)}) Tj ET`,
    );
  }

  line(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    color: readonly number[] = BORDER,
    width = 0.8,
  ) {
    this.current.commands.push(
      `${color.map((c) => (c / 255).toFixed(3)).join(" ")} RG ${width} w ${x1.toFixed(2)} ${y1.toFixed(2)} m ${x2.toFixed(2)} ${y2.toFixed(2)} l S`,
    );
  }

  rect(
    x: number,
    y: number,
    width: number,
    height: number,
    fill: readonly number[] | null,
    stroke: readonly number[] | null = null,
  ) {
    if (fill)
      this.current.commands.push(
        `${fill.map((c) => (c / 255).toFixed(3)).join(" ")} rg`,
      );
    if (stroke)
      this.current.commands.push(
        `${stroke.map((c) => (c / 255).toFixed(3)).join(" ")} RG 0.8 w`,
      );
    this.current.commands.push(
      `${x.toFixed(2)} ${y.toFixed(2)} ${width.toFixed(2)} ${height.toFixed(2)} re ${fill && stroke ? "B" : fill ? "f" : "S"}`,
    );
  }

  buffer() {
    const objects: Buffer[] = [];
    const addObject = (body: string | Buffer) => {
      const index = objects.length + 1;
      const header = Buffer.from(`${index} 0 obj\n`, "ascii");
      const footer = Buffer.from("\nendobj\n", "ascii");
      objects.push(
        Buffer.isBuffer(body)
          ? Buffer.concat([header, body, footer])
          : Buffer.from(`${index} 0 obj\n${body}\nendobj\n`, "latin1"),
      );
      return index;
    };

    const catalogId = 1;
    const pagesId = 2;
    objects.push(Buffer.alloc(0), Buffer.alloc(0));
    const fontRegularId = addObject(
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    );
    const fontBoldId = addObject(
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
    );
    const pageIds: number[] = [];

    for (const page of this.pages) {
      const stream = Buffer.from(page.commands.join("\n"), "latin1");
      const streamId = addObject(
        Buffer.concat([
          Buffer.from(`<< /Length ${stream.length} >>\nstream\n`, "ascii"),
          stream,
          Buffer.from("\nendstream", "ascii"),
        ]),
      );
      const pageId = addObject(
        `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << /F1 ${fontRegularId} 0 R /F2 ${fontBoldId} 0 R >> >> /Contents ${streamId} 0 R >>`,
      );
      pageIds.push(pageId);
    }

    objects[catalogId - 1] = Buffer.from(
      `${catalogId} 0 obj\n<< /Type /Catalog /Pages ${pagesId} 0 R >>\nendobj\n`,
      "ascii",
    );
    objects[pagesId - 1] = Buffer.from(
      `${pagesId} 0 obj\n<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>\nendobj\n`,
      "ascii",
    );

    const header = Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n", "binary");
    const chunks: Uint8Array[] = [header];
    const offsets = [0];
    let offset = header.length;
    for (const object of objects) {
      offsets.push(offset);
      chunks.push(object);
      offset += object.length;
    }
    const xrefOffset = offset;
    const xref = [
      `xref`,
      `0 ${objects.length + 1}`,
      `0000000000 65535 f `,
      ...offsets
        .slice(1)
        .map((item) => `${String(item).padStart(10, "0")} 00000 n `),
    ].join("\n");
    const trailer = `\n${xref}\ntrailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
    chunks.push(Buffer.from(trailer, "ascii"));
    return Buffer.concat(chunks);
  }
}

const getPayload = (order: ErpOrderPdfRecord) => asRecord(order.payloadSent);

const DEMETRA_COMPANY = {
  legalName: "DEMETRA AGRONEGOCIOS EIRELI ME",
  brandName: "DEMETRA AGRO",
  cnpj: "17.477.952/0001-90",
  stateRegistration: "001.987.800.00-33",
  address: "RUA SILVESTRE FERREIRA, 570",
  city: "SÃO GOTARDO/MG",
  cep: "38800-000",
  phone: "(34) 3671-0000",
};

const ERP_ORDER_CLAUSES = [
  "As partes convencionam para cumprimento da presente as seguintes cláusulas:",
  "CLÁUSULA 1 – Após a emissão da Nota Fiscal não aceitamos devolução.",
  "CLÁUSULA 2 – Existindo restrição cadastral ou financeira, a vendedora reserva-se o direito de tornar esta operação sem efeito.",
  "CLÁUSULA 3 – Esta ordem de venda passa a ser um compromisso do comprador quanto ao volume total reservado, caso o comprador não ficar com a totalidade ou parte dos produtos reservados, independente da variação de preços dos mesmos, este pagará multa de 20% (Vinte por cento) do saldo ou totalidade dos produtos não retirados no presente pedido de venda a título de indenização pelo não cumprimento do acordo.",
  "CLÁUSULA 4 – Autorizo a emissão da Nota Fiscal de Venda Entrega Futura a partir desta data, nas condições e prazos após liberação do departamento financeiro.",
  "CLÁUSULA 5 – Não havendo pagamento, ou, havendo atraso de alguma das parcelas deste pedido de venda, a mesma poderá ser cancelada automaticamente, independentemente de notificação expressa.",
  "CLÁUSULA 6 – O comprador está de acordo com as cláusulas acima redigidas neste pedido de venda.",
];

const getClientRaw = (client: ErpOrderPdfRecord["opportunity"]["client"]) =>
  asRecord(client.rawPayload);

const getClientLegalName = (
  client: ErpOrderPdfRecord["opportunity"]["client"],
) => {
  const raw = getClientRaw(client);
  return (
    pickFirstString(raw, [
      "RAZAO_SOCIAL",
      "RAZAOSOCIAL",
      "NOME",
      "NOME_PARCEIRO",
      "name",
      "razaoSocial",
      "legalName",
    ]) || client.name
  );
};

const getClientAddressParts = (
  client: ErpOrderPdfRecord["opportunity"]["client"],
) => {
  const raw = getClientRaw(client);
  const street = pickFirstString(raw, [
    "ENDERECO",
    "LOGRADOURO",
    "RUA",
    "ADDRESS",
    "address",
    "logradouro",
  ]);
  const number = pickFirstString(raw, [
    "NUMERO",
    "NRO",
    "NUMBER",
    "addressNumber",
    "numero",
  ]);
  const complement = pickFirstString(raw, [
    "COMPLEMENTO",
    "COMPLEMENT",
    "complemento",
  ]);
  return {
    address:
      [street, number, complement].filter(Boolean).join(", ") || street || "-",
    district: pickFirstString(raw, ["BAIRRO", "DISTRICT", "bairro"]),
    city:
      pickFirstString(raw, [
        "CIDADE",
        "DSC_CIDADE",
        "MUNICIPIO",
        "cidade",
        "city",
      ]) || client.city,
    state:
      pickFirstString(raw, [
        "UF",
        "ESTADO",
        "SIGLA_UF",
        "estado",
        "state",
        "uf",
      ]) || client.state,
    cep: pickFirstString(raw, ["CEP", "ZIP", "zipCode", "cep"]),
    phone: pickFirstString(raw, [
      "FONE",
      "TELEFONE",
      "CELULAR",
      "PHONE",
      "phone",
      "telefone",
    ]),
  };
};

const getClassification = (
  item: ErpOrderPdfRecord["opportunity"]["items"][number],
) => {
  const raw = asRecord(item.product?.rawErpPayload);
  return (
    item.product?.className ||
    pickFirstString(raw, [
      "DSCPRODUTO_CLAS",
      "DESCRICAO_CLASSE",
      "DSC_CLASSIFICACAO",
    ]) ||
    item.erpProductClassCode ||
    "-"
  );
};

const drawHeader = (pdf: SimplePdf, orderNumber: string) => {
  pdf.rect(0, PAGE_HEIGHT - 112, PAGE_WIDTH, 112, BRAND_GREEN);
  pdf.rect(MARGIN, PAGE_HEIGHT - 84, 42, 42, [255, 255, 255]);
  pdf.text("D", MARGIN + 12, PAGE_HEIGHT - 70, 20, BRAND_GREEN, "F2");
  pdf.line(
    MARGIN + 30,
    PAGE_HEIGHT - 58,
    MARGIN + 37,
    PAGE_HEIGHT - 72,
    BRAND_GREEN,
    1.2,
  );
  pdf.text(
    DEMETRA_COMPANY.legalName,
    MARGIN + 54,
    PAGE_HEIGHT - 50,
    12,
    [255, 255, 255],
    "F2",
  );
  pdf.text(
    DEMETRA_COMPANY.brandName,
    MARGIN + 54,
    PAGE_HEIGHT - 66,
    17,
    [255, 255, 255],
    "F2",
  );
  pdf.text(
    `CNPJ: ${DEMETRA_COMPANY.cnpj}   IE: ${DEMETRA_COMPANY.stateRegistration}`,
    MARGIN + 54,
    PAGE_HEIGHT - 82,
    8.5,
    [221, 245, 229],
  );
  pdf.text(
    `${DEMETRA_COMPANY.address} - ${DEMETRA_COMPANY.city} - CEP ${DEMETRA_COMPANY.cep} - Fone ${DEMETRA_COMPANY.phone}`,
    MARGIN + 54,
    PAGE_HEIGHT - 96,
    8,
    [221, 245, 229],
  );
  pdf.rect(
    PAGE_WIDTH - MARGIN - 142,
    PAGE_HEIGHT - 82,
    142,
    48,
    [255, 255, 255],
  );
  pdf.text(
    "PEDIDO DE VENDA",
    PAGE_WIDTH - MARGIN - 130,
    PAGE_HEIGHT - 52,
    9,
    BRAND_GREEN,
    "F2",
  );
  pdf.text(
    `Nº ${orderNumber}`,
    PAGE_WIDTH - MARGIN - 130,
    PAGE_HEIGHT - 70,
    14,
    BRAND_GREEN,
    "F2",
  );
};

const drawFooter = (pdf: SimplePdf, pageNumber: number) => {
  pdf.line(MARGIN, 24, PAGE_WIDTH - MARGIN, 24, BORDER);
  pdf.text(`Página ${pageNumber}`, PAGE_WIDTH - MARGIN - 44, 11, 8, MUTED);
};

const drawLabelValue = (
  pdf: SimplePdf,
  label: string,
  value: string,
  x: number,
  y: number,
  width: number,
) => {
  pdf.text(label.toUpperCase(), x, y + 14, 7.5, MUTED, "F2");
  wrapText(value, Math.max(18, Math.floor(width / 5.2)))
    .slice(0, 2)
    .forEach((line, index) =>
      pdf.text(line, x, y - index * 11, 9.5, SLATE, index === 0 ? "F2" : "F1"),
    );
};

const ensureSpace = (
  pdf: SimplePdf,
  y: number,
  required: number,
  pageNumber: { value: number },
  orderNumber: string,
) => {
  if (y - required > 42) return y;
  drawFooter(pdf, pageNumber.value);
  pdf.addPage();
  pageNumber.value += 1;
  drawHeader(pdf, orderNumber);
  return PAGE_HEIGHT - 134;
};

const drawTableRow = (
  pdf: SimplePdf,
  cells: PdfCell[],
  x: number,
  y: number,
  rowHeight: number,
  fill: readonly number[] | null,
  header = false,
) => {
  if (fill)
    pdf.rect(
      x,
      y - rowHeight + 4,
      cells.reduce((sum, cell) => sum + cell.width, 0),
      rowHeight,
      fill,
    );
  let cursor = x;
  for (const cell of cells) {
    const maxChars = Math.max(4, Math.floor(cell.width / (header ? 5.2 : 4.9)));
    const lines = wrapText(cell.text, maxChars).slice(0, 2);
    lines.forEach((line, index) => {
      const textX =
        cell.align === "right"
          ? cursor +
            cell.width -
            Math.min(line.length * 4.7, cell.width - 4) -
            2
          : cell.align === "center"
            ? cursor + 2
            : cursor + 4;
      pdf.text(
        line,
        textX,
        y - 10 - index * 9,
        header ? 7.2 : 7.5,
        header ? [255, 255, 255] : SLATE,
        header ? "F2" : "F1",
      );
    });
    cursor += cell.width;
  }
  pdf.line(
    x,
    y - rowHeight + 4,
    x + cells.reduce((sum, cell) => sum + cell.width, 0),
    y - rowHeight + 4,
    BORDER,
    0.5,
  );
};

export const getErpOrderPdfFilename = (
  order: Pick<
    ErpOrderSync,
    "erpOrderNumber" | "numPedido" | "pedidoIdImportacao"
  >,
) => {
  const orderNumber = cleanText(
    order.erpOrderNumber || order.numPedido || order.pedidoIdImportacao,
    "sem-numero",
  ).replace(/[^a-zA-Z0-9._-]/g, "-");
  return `pedido-erp-${orderNumber}.pdf`;
};

export const buildErpOrderPdf = (order: ErpOrderPdfRecord) => {
  if (order.status !== ErpOrderSyncStatus.sent)
    throw Object.assign(
      new Error(
        "PDF disponível somente para pedidos ERP enviados com sucesso.",
      ),
      { status: 400 },
    );

  const payload = getPayload(order);
  const client = order.opportunity.client;
  const clientAddress = getClientAddressParts(client);
  const clientLegalName = getClientLegalName(client);
  const fantasyName = cleanText(client.fantasyName, "");
  const orderNumber = cleanText(
    order.erpOrderNumber || order.numPedido || order.pedidoIdImportacao,
  );
  const pdf = new SimplePdf();
  const pageNumber = { value: 1 };
  drawHeader(pdf, orderNumber);

  let y = PAGE_HEIGHT - 134;
  pdf.rect(MARGIN, y - 54, PAGE_WIDTH - MARGIN * 2, 58, BRAND_LIGHT, BORDER);
  drawLabelValue(
    pdf,
    "Data do pedido",
    formatDate(payload.DATA_PEDIDO || order.sentAt || order.createdAt),
    MARGIN + 12,
    y - 20,
    105,
  );
  drawLabelValue(
    pdf,
    "Data de entrega",
    formatDate(payload.DATA_PREV_ENTREGA),
    MARGIN + 136,
    y - 20,
    105,
  );
  drawLabelValue(
    pdf,
    "Número do pedido",
    orderNumber,
    MARGIN + 260,
    y - 20,
    120,
  );
  drawLabelValue(
    pdf,
    "Tabela",
    cleanText(payload.TABELA_PRECO),
    MARGIN + 402,
    y - 20,
    90,
  );
  y -= 78;

  pdf.text("Dados do cliente", MARGIN, y, 12, BRAND_GREEN, "F2");
  y -= 14;
  pdf.rect(MARGIN, y - 82, PAGE_WIDTH - MARGIN * 2, 86, null, BORDER);
  drawLabelValue(pdf, "Cliente", clientLegalName, MARGIN + 12, y - 18, 230);
  drawLabelValue(
    pdf,
    "Código ERP",
    cleanText(client.code),
    MARGIN + 260,
    y - 18,
    70,
  );
  drawLabelValue(
    pdf,
    "CNPJ/CPF",
    formatDocument(client.cnpj),
    MARGIN + 350,
    y - 18,
    150,
  );
  drawLabelValue(
    pdf,
    "Endereço",
    clientAddress.address,
    MARGIN + 12,
    y - 56,
    220,
  );
  drawLabelValue(
    pdf,
    "Bairro",
    cleanText(clientAddress.district),
    MARGIN + 248,
    y - 56,
    80,
  );
  drawLabelValue(
    pdf,
    "Cidade/UF",
    `${cleanText(clientAddress.city)}/${cleanText(clientAddress.state)}`,
    MARGIN + 345,
    y - 56,
    92,
  );
  drawLabelValue(
    pdf,
    "CEP / Telefone",
    [clientAddress.cep, clientAddress.phone].filter(Boolean).join(" / ") || "-",
    MARGIN + 455,
    y - 56,
    70,
  );
  if (fantasyName && fantasyName !== clientLegalName)
    pdf.text(`Fantasia: ${fantasyName}`, MARGIN + 12, y - 78, 8, MUTED);
  y -= 108;

  pdf.text("Dados do vendedor", MARGIN, y, 12, BRAND_GREEN, "F2");
  y -= 14;
  pdf.rect(MARGIN, y - 36, PAGE_WIDTH - MARGIN * 2, 40, BRAND_SOFT, BORDER);
  drawLabelValue(
    pdf,
    "Vendedor",
    cleanText(order.opportunity.ownerSeller.name),
    MARGIN + 12,
    y - 18,
    260,
  );
  drawLabelValue(
    pdf,
    "Código do vendedor",
    cleanText(order.opportunity.ownerSeller.erpCode),
    MARGIN + 300,
    y - 18,
    150,
  );
  y -= 62;

  pdf.text("Itens", MARGIN, y, 12, BRAND_GREEN, "F2");
  y -= 14;
  const columns: PdfCell[] = [
    { text: "Produto", width: 72 },
    { text: "Descrição", width: 218 },
    { text: "Referência", width: 66, align: "center" },
    { text: "Qtd", width: 42, align: "right" },
    { text: "Un", width: 30, align: "center" },
    { text: "Unitário", width: 62, align: "right" },
    { text: "Total", width: 51, align: "right" },
  ];
  drawTableRow(pdf, columns, MARGIN, y, 24, BRAND_GREEN, true);
  y -= 24;

  for (const item of order.opportunity.items) {
    y = ensureSpace(pdf, y, 34, pageNumber, orderNumber);
    const rawProduct = asRecord(item.product?.rawErpPayload);
    const reference = pickFirstString(rawProduct, [
      "REFERENCIA",
      "REF",
      "COD_REFERENCIA",
      "reference",
      "codigoReferencia",
    ]);
    const cells: PdfCell[] = [
      {
        text:
          [item.erpProductCode, item.erpProductClassCode]
            .filter(Boolean)
            .join("/") || "-",
        width: 72,
      },
      { text: cleanText(item.productNameSnapshot), width: 218 },
      { text: reference || "-", width: 66, align: "center" },
      { text: formatNumber(item.quantity, 2), width: 42, align: "right" },
      {
        text: cleanText(item.unit || item.product?.unit),
        width: 30,
        align: "center",
      },
      { text: formatCurrency(item.unitPrice), width: 62, align: "right" },
      { text: formatCurrency(item.netTotal), width: 51, align: "right" },
    ];
    drawTableRow(pdf, cells, MARGIN, y, 34, null);
    y -= 34;
  }

  const grossTotal = order.opportunity.items.reduce(
    (sum, item) => sum + Number(item.grossTotal || 0),
    0,
  );
  const discountTotal = order.opportunity.items.reduce(
    (sum, item) => sum + Number(item.discountTotal || 0),
    0,
  );
  const netTotal = order.opportunity.items.reduce(
    (sum, item) => sum + Number(item.netTotal || 0),
    0,
  );
  y = ensureSpace(pdf, y, 118, pageNumber, orderNumber);
  y -= 18;
  pdf.rect(PAGE_WIDTH - MARGIN - 214, y - 100, 214, 106, BRAND_LIGHT, BORDER);
  pdf.text("Totais", PAGE_WIDTH - MARGIN - 200, y - 12, 12, BRAND_GREEN, "F2");
  const totalRows = [
    ["Total Produtos", payload.VALOR_BRUTO ?? grossTotal],
    ["Acréscimos", payload.VALOR_ACRESCIMO ?? 0],
    ["Descontos", payload.VALOR_DESCONTO ?? discountTotal],
    ["Frete", payload.VALOR_FRETE ?? 0],
    ["Total Líquido", payload.VALOR_LIQUIDO ?? netTotal],
  ] as const;
  totalRows.forEach(([label, value], index) => {
    const rowY = y - 30 - index * 16;
    pdf.text(
      label,
      PAGE_WIDTH - MARGIN - 200,
      rowY,
      8.5,
      index === 4 ? BRAND_GREEN : MUTED,
      index === 4 ? "F2" : "F1",
    );
    pdf.text(
      formatCurrencyLabel(value),
      PAGE_WIDTH - MARGIN - 86,
      rowY,
      8.5,
      index === 4 ? BRAND_GREEN : SLATE,
      "F2",
    );
  });
  const rawWeights = asRecord(payload.PESOS || payload);
  pdf.text(
    `Peso Líq.: ${cleanText(rawWeights.PESO_LIQUIDO || rawWeights.PESO_LIQ || "-")}   Peso Bruto: ${cleanText(rawWeights.PESO_BRUTO || "-")}`,
    PAGE_WIDTH - MARGIN - 200,
    y - 96,
    7.5,
    MUTED,
  );

  pdf.text("Condições comerciais", MARGIN, y - 12, 12, BRAND_GREEN, "F2");
  drawLabelValue(
    pdf,
    "Forma de Pagto",
    cleanText(payload.FORMA || "DINHEIRO/CHEQUE"),
    MARGIN,
    y - 34,
    145,
  );
  drawLabelValue(
    pdf,
    "Condição",
    cleanText(payload.CODCONDREC || "A VISTA"),
    MARGIN + 165,
    y - 34,
    120,
  );
  drawLabelValue(
    pdf,
    "Tabela de preço",
    cleanText(payload.TABELA_PRECO),
    MARGIN,
    y - 74,
    160,
  );
  const notes = cleanText(
    payload.OBS_PEDIDO || order.opportunity.notes,
    "Sem observações.",
  );
  drawLabelValue(pdf, "Observações", notes, MARGIN + 165, y - 74, 160);
  y -= 130;

  y = ensureSpace(pdf, y, 78, pageNumber, orderNumber);
  pdf.line(MARGIN + 58, y - 34, MARGIN + 230, y - 34, SLATE, 0.8);
  pdf.text("Assinatura do Comprador", MARGIN + 86, y - 50, 9, SLATE, "F2");
  y -= 72;

  pdf.text("Cláusulas", MARGIN, y, 12, BRAND_GREEN, "F2");
  y -= 16;
  for (const [index, clause] of ERP_ORDER_CLAUSES.entries()) {
    const lines = wrapText(clause, 108);
    y = ensureSpace(pdf, y, lines.length * 9 + 8, pageNumber, orderNumber);
    lines.forEach((line, lineIndex) =>
      pdf.text(
        line,
        MARGIN,
        y - lineIndex * 9,
        index === 0 ? 8.5 : 7.6,
        SLATE,
        index === 0 ? "F2" : "F1",
      ),
    );
    y -= lines.length * 9 + 6;
  }

  drawFooter(pdf, pageNumber.value);
  return pdf.buffer();
};
