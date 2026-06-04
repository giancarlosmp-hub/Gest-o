import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { normalizeErpParameterCode } from "@salesforce-pro/shared";
import {
  ErpOrderSyncStatus,
  Prisma,
  type Client,
  type ErpOrderSync,
  type Opportunity,
  type OpportunityItem,
  type Product,
  type User,
  type PrismaClient,
} from "@prisma/client";

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 24;
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
        product?: Pick<Product, "name" | "className" | "unit" | "rawErpPayload"> | null;
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

type PdfPngImage = {
  name: string;
  width: number;
  height: number;
  colorSpace: "DeviceGray" | "DeviceRGB";
  colors: number;
  bitsPerComponent: number;
  data: Buffer;
};

export type ErpOrderPdfCompany = {
  legalName: string;
  brandName: string;
  cnpj: string;
  stateRegistration: string;
  address: string;
  district: string;
  city: string;
  state: string;
  cep: string;
  phone: string;
};

export type ErpOrderPdfMetadata = {
  branch?: Record<string, unknown>;
  paymentMethod?: Record<string, unknown> | null;
  paymentMethodDescription?: string;
  receivingCondition?: Record<string, unknown> | null;
  receivingConditionDescription?: string;
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

const pickFirstNumber = (source: Record<string, unknown>, keys: string[]) => {
  for (const key of keys) {
    const value = source[key];
    if (value == null || value === "") continue;
    const parsed = Number(String(value).replace(",", "."));
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
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

const readPngImageFromSvg = (svgPath: string, name: string): PdfPngImage | null => {
  if (!existsSync(svgPath)) return null;
  const svg = readFileSync(svgPath, "utf8");
  const base64 = svg.match(/base64,([^\"]+)/)?.[1];
  if (!base64) return null;
  const png = Buffer.from(base64, "base64");
  if (png.toString("ascii", 1, 4) !== "PNG") return null;

  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const bitsPerComponent = png[24];
  const colorType = png[25];
  const colorMap: Record<number, Pick<PdfPngImage, "colorSpace" | "colors">> = {
    0: { colorSpace: "DeviceGray", colors: 1 },
    2: { colorSpace: "DeviceRGB", colors: 3 },
  };
  const color = colorMap[colorType];
  if (!color || bitsPerComponent !== 8) return null;

  const idatChunks: Buffer[] = [];
  let offset = 8;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    if (type === "IDAT") idatChunks.push(png.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  if (!idatChunks.length) return null;

  return {
    name,
    width,
    height,
    bitsPerComponent,
    colorSpace: color.colorSpace,
    colors: color.colors,
    data: Buffer.concat(idatChunks),
  };
};

const loadDemetraLogo = () => {
  const candidates = [
    resolve(process.cwd(), "apps/web/public/brand/demetra-logo-dark.svg"),
    resolve(process.cwd(), "../web/public/brand/demetra-logo-dark.svg"),
    resolve(process.cwd(), "public/brand/demetra-logo-dark.svg"),
  ];
  for (const candidate of candidates) {
    const image = readPngImageFromSvg(candidate, "ImDemetraLogo");
    if (image) return image;
  }
  return null;
};

const DEMETRA_LOGO = loadDemetraLogo();

class SimplePdf {
  private pages: PdfPage[] = [{ commands: [] }];
  private current = this.pages[0];
  private images = DEMETRA_LOGO ? [DEMETRA_LOGO] : [];

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

  image(name: string, x: number, y: number, width: number, height: number) {
    if (!this.images.some((image) => image.name === name)) return;
    this.current.commands.push(
      `q ${width.toFixed(2)} 0 0 ${height.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)} cm /${name} Do Q`,
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
    const imageObjectIds = new Map<string, number>();
    for (const image of this.images) {
      const stream = Buffer.concat([
        Buffer.from(
          `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /${image.colorSpace} /BitsPerComponent ${image.bitsPerComponent} /Filter /FlateDecode /DecodeParms << /Predictor 15 /Colors ${image.colors} /BitsPerComponent ${image.bitsPerComponent} /Columns ${image.width} >> /Length ${image.data.length} >>\nstream\n`,
          "ascii",
        ),
        image.data,
        Buffer.from("\nendstream", "ascii"),
      ]);
      imageObjectIds.set(image.name, addObject(stream));
    }
    const xObjectResources = Array.from(imageObjectIds.entries())
      .map(([name, id]) => `/${name} ${id} 0 R`)
      .join(" ");
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
        `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << /F1 ${fontRegularId} 0 R /F2 ${fontBoldId} 0 R >>${xObjectResources ? ` /XObject << ${xObjectResources} >>` : ""} >> /Contents ${streamId} 0 R >>`,
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

const BRANCH_CODE_KEYS = [
  "CODFILIAL",
  "FILIAL",
  "COD_FILIAL",
  "CODIGO",
  "code",
  "codigo",
  "id",
  "ID",
  "value",
];

const normalizeBranchRows = (value: unknown): Record<string, unknown>[] => {
  if (Array.isArray(value)) return value.map(asRecord).filter((row) => Object.keys(row).length);
  const record = asRecord(value);
  for (const key of ["items", "data", "rows", "results", "content"]) {
    const rows = record[key];
    if (Array.isArray(rows)) return rows.map(asRecord).filter((row) => Object.keys(row).length);
  }
  return Object.keys(record).length ? [record] : [];
};

const parseAppConfigJson = (value: string | null | undefined) => {
  if (!value) return [];
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return [];
  }
};

const getBranchRawCode = (branch: Record<string, unknown>) =>
  pickFirstString(branch, BRANCH_CODE_KEYS);

const findPdfBranch = (
  branches: Record<string, unknown>[],
  branchCode: unknown,
) => {
  const normalizedTarget = normalizeErpParameterCode(cleanText(branchCode, ""));
  if (normalizedTarget) {
    const matched = branches.find((branch) =>
      normalizeErpParameterCode(getBranchRawCode(branch)) === normalizedTarget,
    );
    if (matched) return matched;
  }
  return branches[0] || {};
};

const getBranchAddress = (branch: Record<string, unknown>) => {
  const directAddress = pickFirstString(branch, [
    "ENDERECO",
    "ADDRESS",
    "address",
    "endereco",
  ]);
  const street = pickFirstString(branch, [
    "LOGRADOURO",
    "RUA",
    "street",
    "logradouro",
  ]);
  const number = pickFirstString(branch, ["NUMERO", "NRO", "number", "numero"]);
  const complement = pickFirstString(branch, [
    "COMPLEMENTO",
    "COMPLEMENT",
    "complemento",
  ]);
  return directAddress || [street, number, complement].filter(Boolean).join(", ");
};

const toPdfCompany = (branch: Record<string, unknown>): ErpOrderPdfCompany => ({
  legalName: pickFirstString(branch, [
    "RAZAO_SOCIAL",
    "RAZAOSOCIAL",
    "RAZAO",
    "NOME",
    "NOME_FILIAL",
    "name",
    "razaoSocial",
    "legalName",
  ]),
  brandName: pickFirstString(branch, [
    "FANTASIA",
    "NOME_FANTASIA",
    "NOMEFANTASIA",
    "fantasyName",
    "nomeFantasia",
    "brandName",
    "DESCRICAO",
    "DSCFILIAL",
  ]),
  cnpj: formatDocument(pickFirstString(branch, ["CGC", "cgc", "CNPJ", "cnpj", "DOCUMENTO", "document"])),
  stateRegistration: pickFirstString(branch, [
    "INSCESTADUAL",
    "inscEstadual",
    "IE",
    "INSCRICAO_ESTADUAL",
    "INSCRICAO",
    "stateRegistration",
    "inscricaoEstadual",
  ]),
  address: getBranchAddress(branch),
  district: pickFirstString(branch, ["BAIRRO", "DISTRICT", "bairro", "district"]),
  city: pickFirstString(branch, ["CIDADE", "MUNICIPIO", "city", "cidade"]),
  state: pickFirstString(branch, ["UF", "ESTADO", "state", "uf"]),
  cep: pickFirstString(branch, ["CEP", "ZIP", "zipCode", "cep"]),
  phone: pickFirstString(branch, [
    "FONE",
    "TELEFONE",
    "CELULAR",
    "PHONE",
    "phone",
    "telefone",
    "fone",
  ]),
});

const getStoredReferenceRows = async (
  prisma: Pick<PrismaClient, "appConfig">,
  key: string,
) => {
  const stored = await prisma.appConfig.findUnique({
    where: { key },
    select: { value: true },
  });
  return normalizeBranchRows(parseAppConfigJson(stored?.value));
};

export const getErpOrderPdfBranch = async (
  prisma: Pick<PrismaClient, "appConfig">,
  order: ErpOrderPdfRecord,
) => {
  const branches = await getStoredReferenceRows(prisma, "erp.ultrafv3.branches");
  return findPdfBranch(branches, getPayload(order).CODFILIAL);
};

export const getErpOrderPdfCompany = async (
  prisma: Pick<PrismaClient, "appConfig">,
  order: ErpOrderPdfRecord,
): Promise<ErpOrderPdfCompany> => toPdfCompany(await getErpOrderPdfBranch(prisma, order));

const findReferenceByCode = (
  rows: Record<string, unknown>[],
  code: unknown,
  codeKeys: string[],
) => {
  const normalizedTarget = normalizeErpParameterCode(cleanText(code, ""));
  if (!normalizedTarget) return null;
  return (
    rows.find((row) =>
      normalizeErpParameterCode(pickFirstString(row, codeKeys)) === normalizedTarget,
    ) || null
  );
};

const getReferenceDescription = (
  row: Record<string, unknown> | null,
  nameKeys: string[],
) => (row ? pickFirstString(row, nameKeys) : "");

export const getErpOrderPdfMetadata = async (
  prisma: Pick<PrismaClient, "appConfig">,
  order: ErpOrderPdfRecord,
): Promise<ErpOrderPdfMetadata> => {
  const payload = getPayload(order);
  const [branch, paymentRows, receivingRows] = await Promise.all([
    getErpOrderPdfBranch(prisma, order),
    getStoredReferenceRows(prisma, "erp.ultrafv3.paymentMethods"),
    getStoredReferenceRows(prisma, "erp.ultrafv3.receivingConditions"),
  ]);
  const paymentMethod = findReferenceByCode(
    paymentRows,
    payload.FORMA,
    ["FORMA", "CODFORMA", "COD_FORMA", "CODIGO", "code", "codigo", "id", "ID", "value"],
  );
  const receivingCondition = findReferenceByCode(
    receivingRows,
    payload.CODCONDREC,
    ["CODCONDREC", "CONDICAO", "COD_CONDICAO", "CODIGO", "code", "codigo", "id", "ID", "value"],
  );
  return {
    branch,
    paymentMethod,
    paymentMethodDescription: getReferenceDescription(paymentMethod, [
      "DESCRICAO",
      "DSCFORMA",
      "DSC_FORMA",
      "dscForma",
      "NOME",
      "name",
      "description",
      "descricao",
      "label",
    ]),
    receivingCondition,
    receivingConditionDescription: getReferenceDescription(receivingCondition, [
      "DESCRICAO",
      "DSCCONDREC",
      "DSC_CONDICAO",
      "dscCondRec",
      "NOME",
      "name",
      "description",
      "descricao",
      "label",
    ]),
  };
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


const getClientFantasyName = (client: ErpOrderPdfRecord["opportunity"]["client"]) => {
  const raw = getClientRaw(client);
  return (
    pickFirstString(raw, ["FANTASIA", "NOME_FANTASIA", "fantasia", "fantasyName"]) ||
    cleanText(client.fantasyName, "")
  );
};

const getClientDocument = (client: ErpOrderPdfRecord["opportunity"]["client"]) => {
  const raw = getClientRaw(client);
  return formatDocument(
    pickFirstString(raw, ["CNPJ", "CPF", "CGC", "cnpj", "cpf", "documento"]) || client.cnpj,
  );
};

const getProductDescription = (
  item: ErpOrderPdfRecord["opportunity"]["items"][number],
) => {
  const raw = asRecord(item.product?.rawErpPayload);
  const name =
    pickFirstString(raw, ["DSCPRODUTO", "DESCRICAO", "NOME", "dscProduto", "name"]) ||
    item.product?.name ||
    item.productNameSnapshot;
  const classification =
    pickFirstString(raw, [
      "DSCPRODUTO_CLAS",
      "DESCRICAO_CLASSIFICACAO",
      "DESCRICAO_CLASSE",
      "DSC_CLASSIFICACAO",
      "dscProdutoClas",
      "classification",
    ]) || item.product?.className || "";
  return [cleanText(name, ""), cleanText(classification, "")]
    .filter(Boolean)
    .join(" ") || "-";
};

const getProductWeight = (
  item: ErpOrderPdfRecord["opportunity"]["items"][number],
) => {
  const raw = asRecord(item.product?.rawErpPayload);
  return pickFirstNumber(raw, [
    "PESO_PRODUTO",
    "PESOPRODUTO",
    "pesoProduto",
    "PESO_BRUTO",
    "pesoBruto",
    "PESO_EMBALAGEM",
    "pesoEmbalagem",
    "PESO_LIQUIDO",
    "pesoLiquido",
  ]);
};

const drawHeader = (
  pdf: SimplePdf,
  orderNumber: string,
  company: ErpOrderPdfCompany,
) => {
  pdf.rect(0, PAGE_HEIGHT - 94, PAGE_WIDTH, 94, BRAND_GREEN);
  pdf.rect(MARGIN, PAGE_HEIGHT - 84, 66, 52, [255, 255, 255]);
  if (DEMETRA_LOGO) {
    pdf.image(DEMETRA_LOGO.name, MARGIN + 3, PAGE_HEIGHT - 80, 60, 42);
  } else {
    pdf.text("D", MARGIN + 25, PAGE_HEIGHT - 62, 18, BRAND_GREEN, "F2");
  }
  const companyCity = [company.city, company.state].filter(Boolean).join("/");
  pdf.text(
    cleanText(company.legalName),
    MARGIN + 78,
    PAGE_HEIGHT - 42,
    11.2,
    [255, 255, 255],
    "F2",
  );
  pdf.text(
    cleanText(company.brandName),
    MARGIN + 78,
    PAGE_HEIGHT - 57,
    10,
    [221, 245, 229],
    "F2",
  );
  pdf.text(
    `${cleanText(company.address)} - ${cleanText(company.district)} - ${companyCity} - CEP ${cleanText(company.cep)}`,
    MARGIN + 78,
    PAGE_HEIGHT - 71,
    7.2,
    [221, 245, 229],
  );
  pdf.text(
    `CNPJ: ${cleanText(company.cnpj)}   IE: ${cleanText(company.stateRegistration)}   Fone: ${cleanText(company.phone)}`,
    MARGIN + 78,
    PAGE_HEIGHT - 83,
    7.2,
    [221, 245, 229],
  );
  const emittedAt = new Date().toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
  });
  pdf.rect(
    PAGE_WIDTH - MARGIN - 132,
    PAGE_HEIGHT - 78,
    122,
    42,
    [255, 255, 255],
  );
  pdf.text("Emissão", PAGE_WIDTH - MARGIN - 122, PAGE_HEIGHT - 50, 7, MUTED, "F2");
  pdf.text(emittedAt, PAGE_WIDTH - MARGIN - 122, PAGE_HEIGHT - 63, 7, BRAND_GREEN, "F2");
  pdf.text("Página 1", PAGE_WIDTH - MARGIN - 122, PAGE_HEIGHT - 75, 7, BRAND_GREEN, "F2");
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
  company: ErpOrderPdfCompany,
) => {
  if (y - required > 42) return y;
  drawFooter(pdf, pageNumber.value);
  pdf.addPage();
  pageNumber.value += 1;
  drawHeader(pdf, orderNumber, company);
  return PAGE_HEIGHT - 108;
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

export const buildErpOrderPdf = (
  order: ErpOrderPdfRecord,
  company: ErpOrderPdfCompany,
  metadata: ErpOrderPdfMetadata = {},
) => {
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
  const fantasyName = getClientFantasyName(client);
  const orderNumber = cleanText(
    order.erpOrderNumber || order.numPedido || order.pedidoIdImportacao,
  );
  const pdf = new SimplePdf();
  const pageNumber = { value: 1 };
  drawHeader(pdf, orderNumber, company);

  let y = PAGE_HEIGHT - 108;
  pdf.text(`Pedido de Venda Nº: ${orderNumber}`, 206, y + 12, 13, BRAND_GREEN, "F2");
  y -= 14;
  pdf.rect(MARGIN, y - 32, PAGE_WIDTH - MARGIN * 2, 36, BRAND_LIGHT, BORDER);
  drawLabelValue(
    pdf,
    "Data do pedido",
    formatDate(payload.DATA_PEDIDO || order.sentAt || order.createdAt),
    MARGIN + 110,
    y - 13,
    130,
  );
  drawLabelValue(
    pdf,
    "Data de entrega",
    formatDate(payload.DATA_PREV_ENTREGA),
    MARGIN + 330,
    y - 13,
    130,
  );
  y -= 48;

  pdf.text("Dados do cliente", MARGIN, y, 10, BRAND_GREEN, "F2");
  y -= 12;
  pdf.rect(MARGIN, y - 66, PAGE_WIDTH - MARGIN * 2, 70, null, BORDER);
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
    getClientDocument(client),
    MARGIN + 350,
    y - 18,
    150,
  );
  drawLabelValue(
    pdf,
    "Endereço",
    clientAddress.address,
    MARGIN + 12,
    y - 50,
    220,
  );
  drawLabelValue(
    pdf,
    "Bairro",
    cleanText(clientAddress.district),
    MARGIN + 248,
    y - 50,
    80,
  );
  drawLabelValue(
    pdf,
    "Cidade/UF/CEP",
    `${cleanText(clientAddress.city)}/${cleanText(clientAddress.state)} - CEP: ${cleanText(clientAddress.cep)}`,
    MARGIN + 345,
    y - 50,
    92,
  );
  drawLabelValue(
    pdf,
    "Fone",
    cleanText(clientAddress.phone),
    MARGIN + 455,
    y - 50,
    70,
  );
  if (fantasyName && fantasyName !== clientLegalName)
    pdf.text(`Fantasia: ${fantasyName}`, MARGIN + 12, y - 62, 7, MUTED);
  drawLabelValue(
    pdf,
    "Vendedor",
    `${cleanText(order.opportunity.ownerSeller.name)} (${cleanText(order.opportunity.ownerSeller.erpCode)})`,
    MARGIN + 345,
    y - 50,
    160,
  );
  y -= 88;

  pdf.text("Itens", MARGIN, y, 10, BRAND_GREEN, "F2");
  y -= 12;
  const columns: PdfCell[] = [
    { text: "Produto", width: 72 },
    { text: "Descrição", width: 218 },
    { text: "Referência", width: 66, align: "center" },
    { text: "Qtd", width: 42, align: "right" },
    { text: "Un", width: 30, align: "center" },
    { text: "Unitário", width: 62, align: "right" },
    { text: "Total", width: 51, align: "right" },
  ];
  drawTableRow(pdf, columns, MARGIN, y, 20, BRAND_GREEN, true);
  y -= 20;

  for (const item of order.opportunity.items) {
    y = ensureSpace(pdf, y, 24, pageNumber, orderNumber, company);
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
      { text: getProductDescription(item), width: 218 },
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
    drawTableRow(pdf, cells, MARGIN, y, 24, null);
    y -= 24;
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
  y = ensureSpace(pdf, y, 96, pageNumber, orderNumber, company);
  y -= 10;
  pdf.rect(MARGIN, y - 72, PAGE_WIDTH - MARGIN * 2, 78, BRAND_LIGHT, BORDER);
  pdf.text("Totais", MARGIN + 12, y - 10, 10, BRAND_GREEN, "F2");
  const totalRows = [
    ["Total Produtos", payload.VALOR_BRUTO ?? grossTotal],
    ["Acréscimos", payload.VALOR_ACRESCIMO ?? 0],
    ["Descontos", payload.VALOR_DESCONTO ?? discountTotal],
    ["Frete", payload.VALOR_FRETE ?? 0],
    ["Total Líquido", payload.VALOR_LIQUIDO ?? netTotal],
  ] as const;
  totalRows.forEach(([label, value], index) => {
    const column = index < 3 ? 0 : 1;
    const row = index < 3 ? index : index - 3;
    const labelX = MARGIN + 12 + column * 178;
    const rowY = y - 26 - row * 14;
    pdf.text(
      label,
      labelX,
      rowY,
      7.6,
      index === 4 ? BRAND_GREEN : MUTED,
      index === 4 ? "F2" : "F1",
    );
    pdf.text(
      formatCurrencyLabel(value),
      labelX + 82,
      rowY,
      7.8,
      index === 4 ? BRAND_GREEN : SLATE,
      "F2",
    );
  });
  const paymentMethodLabel = cleanText(
    metadata.paymentMethodDescription || payload.FORMA,
  );
  const receivingConditionLabel = cleanText(
    metadata.receivingConditionDescription || payload.CODCONDREC,
  );
  pdf.text(
    `Forma de Pagto: ${paymentMethodLabel}   Condição: ${receivingConditionLabel}`,
    MARGIN + 12,
    y - 66,
    7.5,
    SLATE,
    "F2",
  );
  const totalWeight = order.opportunity.items.reduce(
    (sum, item) => sum + getProductWeight(item) * Number(item.quantity || 0),
    0,
  );
  y -= 84;

  pdf.text("Transportadora", MARGIN, y, 9.5, BRAND_GREEN, "F2");
  y -= 12;
  pdf.rect(MARGIN, y - 18, PAGE_WIDTH - MARGIN * 2, 22, null, BORDER);
  pdf.text(
    `Peso Bruto: ${formatNumber(totalWeight, 2)} KG   |   Peso Líquido: ${formatNumber(totalWeight, 2)} KG`,
    MARGIN + 12,
    y - 10,
    8,
    SLATE,
    "F2",
  );
  y -= 32;

  const notes = cleanText(
    payload.OBS_PEDIDO || order.opportunity.notes,
    "Sem observações.",
  );
  pdf.rect(MARGIN, y - 34, PAGE_WIDTH - MARGIN * 2, 38, null, BORDER);
  drawLabelValue(pdf, "Observações", notes, MARGIN + 12, y - 16, 500);
  y -= 48;

  pdf.text("Cláusulas", MARGIN, y, 9.5, BRAND_GREEN, "F2");
  y -= 12;
  for (const [index, clause] of ERP_ORDER_CLAUSES.entries()) {
    const lines = wrapText(clause, 132);
    y = ensureSpace(pdf, y, lines.length * 6.6 + 4, pageNumber, orderNumber, company);
    lines.forEach((line, lineIndex) =>
      pdf.text(
        line,
        MARGIN,
        y - lineIndex * 6.6,
        index === 0 ? 6.8 : 6.4,
        SLATE,
        index === 0 ? "F2" : "F1",
      ),
    );
    y -= lines.length * 6.6 + 4;
  }

  y = ensureSpace(pdf, y, 42, pageNumber, orderNumber, company);
  pdf.line(196, y - 20, 398, y - 20, SLATE, 0.8);
  pdf.text("Assinatura do Comprador", 238, y - 34, 8, SLATE, "F2");

  drawFooter(pdf, pageNumber.value);
  return pdf.buffer();
};
